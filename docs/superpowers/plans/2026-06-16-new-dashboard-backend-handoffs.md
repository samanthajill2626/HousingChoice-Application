# New Dashboard — Backend Handoff Prompts (for a separate agent)

These are **self-contained prompts**. Dispatch them **in series** (each depends on the
prior where noted). Paste one prompt to a fresh agent; when it reports done + green +
reviewed, dispatch the next. Each prompt bakes in the **builder → reviewer →
adversarial-review** orchestration this project uses.

The shared **API Contract** (exact wire shapes C1–C7) and the design rationale live in:
- `docs/superpowers/plans/2026-06-16-new-dashboard-build.md` (§API Contract)
- `docs/superpowers/specs/2026-06-16-new-dashboard-design.md` (backend dependencies)

The agent MUST read both before coding, and implement the contract types **verbatim**
(the frontend imports the same shapes — do not rename fields).

---

## SHARED PREAMBLE (prepend to every prompt below)

> You are working in the HousingChoice monorepo (`w:\AI Projects\Housing Choice\HC Application`),
> on branch `main` (Windows; Bash + PowerShell available). The backend is the
> Express app in `app/` (TypeScript, DynamoDB single-table-ish repos under
> `app/src/repos/`, routes under `app/src/routes/`, SSE events in `app/src/lib/events.ts`,
> Vitest tests in `app/test/`). Read `.claude/CLAUDE.md`, `documentation/GLOSSARY.md`,
> and the two design docs named above FIRST.
>
> Rules: extend existing repos/routes; don't break the legacy dashboard's existing
> endpoints (the legacy app still ships). Keep the wire field names EXACTLY as the
> contract specifies (the frontend depends on them). Follow existing repo/test
> patterns. Account-guard + dev-only gating conventions are unchanged. Use TDD.
> Commit per task with clear messages. Never weaken auth/origin-secret/CSRF guards.
>
> **Orchestration (required):** Act as the orchestrator. Use a **builder** subagent to
> implement, a **reviewer** subagent to verify spec-compliance + completeness +
> that tests actually pass (evidence not assertions), and a final **adversarial
> reviewer** subagent to hunt: security issues, data-model/migration hazards, race
> conditions, missed call-sites, and breakage of the legacy endpoints. YOU are
> responsible for confirming each adversarial finding is real before acting; drop
> anything pedantic with a one-line rationale. Fix confirmed issues and re-verify
> before declaring done. Report: files changed, commit SHAs, test output, and the
> triaged findings.

---

## BE1 — Contact ↔ multiple phone numbers  (contract C1)  ·  do FIRST

**Scope:** A contact can own multiple phone numbers; inbound from any of them resolves
to the same contact. Implements contract **C1** (`ContactPhone`, `Contact.phones[]`).

**Build:**
- Extend `contactsRepo` so a contact carries `phones: ContactPhone[]` (phone, label?,
  primary, firstSeenAt?, lastSeenAt?). Keep legacy `phone` = the primary (back-compat).
- Number→contact resolution: extend the inbound lookup (where SMS/calls map a number to
  a contact — see `app/src/routes/webhooks/*` and the contact-capture path) so a new
  number observed for an existing contact is **attachable** to that contact (and updates
  `lastSeenAt`), rather than always minting a new contact.
- Endpoints: `GET /api/contacts/:id` returns `phones`; add `POST /api/contacts/:id/phones`
  `{phone,label?}` and `PATCH /api/contacts/:id/phones/:phone {primary?,label?}` and
  `DELETE …` for manual curation/merge. Exactly one `primary`.
- Migration/back-compat: contacts without `phones` are served as `[{phone, primary:true}]`.

**Tests:** repo round-trip (add/promote/remove number, single-primary invariant);
inbound from a second known number resolves to the same contact; `GET /api/contacts/:id`
shape. **Verify:** `npm test -w app`, `npm run typecheck`.

---

## BE2 — Activity-event log + person-centric merged timeline  (contract C2)  ·  needs BE1

**Scope:** The biggest slice. (a) Record **milestone/activity events**; (b) serve a
contact's **merged timeline** (messages + calls + milestones) across all their numbers.
Implements contract **C2** (`TimelineItem`, `GET /api/contacts/:id/timeline`).

**Build:**
- **Event log:** a table/stream of activity events keyed by contact (+ optional case/unit
  refs). Emit events from the existing flows where they already happen: case opened/closed,
  stage changed, tour scheduled/took place (see `casesRepo`/cases routes), listing sent
  (broadcast send + individual), listing reviewed (the response signal — coordinate with
  BE4), number added (BE1), added/removed from group text (relay membership — `relay_group`).
  Reuse `app/src/lib/events.ts` SSE emission where live update is wanted.
- **Timeline endpoint:** `GET /api/contacts/:id/timeline?cursor=&kinds=` merges, for the
  contact, all conversations across `phones` (messages + call entries) UNION the event log,
  sorted by `at`, paginated by an opaque cursor. `kinds=message,call` excludes milestones
  ("Comms only"). Messages return FULL body (no truncation). Calls include
  `recording_s3_key?`/`transcript?` only on founder-bridge calls (never masked).
- PII rules unchanged (no raw counterpart phone leakage beyond the contact's own numbers;
  masked calls have no transcript).

**Tests:** event emission on each source action; timeline merge ordering across two numbers
+ a milestone; `kinds` filter; cursor pagination; PII (masked call has no transcript).

---

## BE3 — Unit ↔ contacts roster + related units  (contract C3)  ·  independent

**Scope:** A unit has a roster of landlord/PM contacts (many-to-many); related-unit lookups.
Implements contract **C3** (`UnitContact`, `Unit.contacts[]`, `RelatedUnit`,
`GET /api/units/:id/related`).

**Build:**
- Extend `unitsRepo`: `contacts: UnitContact[]` (contactId, role, primaryVoice, denormalized
  name/company). Keep legacy `landlordId` = the primary landlord (back-compat); the primary
  landlord must appear in `contacts`.
- Endpoints: `GET /api/units/:id` includes `contacts`; `POST /api/units/:id/contacts`
  `{contactId, role, primaryVoice?}`; `DELETE /api/units/:id/contacts/:contactId`.
- Related: introduce a lightweight **property/group** link (an optional `propertyId` on a
  unit for duplex/building siblings) AND a same-landlord query; `GET /api/units/:id/related`
  returns both (`relation: 'same_property' | 'same_landlord'`).

**Tests:** roster add/remove + single-primaryVoice; legacy `landlordId` stays consistent;
related returns same-property siblings + same-landlord units; legacy unit endpoints unchanged.

---

## BE4 — Sent-to-tenants / listings-sent + response capture  (contract C4)  ·  pairs with BE2

**Scope:** Record which tenants a listing was sent to and their response; serve both query
directions. Implements contract **C4** (`ListingSendRow`, `GET /api/units/:id/recipients`,
`GET /api/contacts/:id/listings-sent`).

**Build:**
- Capture a "listing sent" record on every broadcast send (`broadcastsRepo`/broadcasts
  routes — a broadcast targets a `unitId` to a tenant audience) AND on an individual flyer
  send. Store `{contactId, unitId, response, sentAt, via, broadcastId?}`.
- Response signal: `response` defaults `no_reply`; provide `PATCH` to set
  `interested|not_a_fit` (manual now; inference later). Emit a `listing_reviewed` event
  (BE2) when it changes.
- Endpoints: `GET /api/units/:id/recipients` and `GET /api/contacts/:id/listings-sent`
  (same rows, two directions).

**Tests:** a broadcast send creates recipient rows; both query directions return them;
response PATCH updates + emits the event.

---

## BE5 — Contact media aggregation + similar listings  (contracts C5, C6)  ·  independent

**Scope:** Two small read endpoints. Implements **C5** (`GET /api/contacts/:id/media`) and
**C6** (`GET /api/units/:id/similar`).

**Build:**
- Media: scan the contact's conversations (across `phones`) for `media_attachments`, return
  `ContactMediaItem[]` newest-first (auth-gated; reuse the media-store key→URL path).
- Similar: rank `available` units by attribute similarity to the target (beds, area/subzone,
  rent band, accepted programs); return top N with `matchPct` + a `summary`. Pure ranking
  fn, unit-tested.

**Tests:** media aggregation across two numbers; similar ranking determinism + excludes
non-available + excludes self.

---

## BE6 — Today action-queue endpoint  (contract C7)  ·  OPTIONAL (frontend has a fallback)

**Scope:** Server-side aggregation for the Today queue. Implements **C7**
(`GET /api/today → TodayResponse`).

**Build:** aggregate `needs_you_now` (case `next_deadline_*` due/overdue + `attention` +
untriaged inbounds), `tours_today` (cases with today's `tour_date`), `unreplied`
(conversations with `unread_count>0` / inbound-last), `follow_ups` (stuck cases / due
follow-ups). Each item → `{group, refType, refId, who, why, urgency?, tag?, attention?}`.

**Note:** the frontend ships a client-side fallback assembling this from `/api/cases` +
`/api/conversations`, so this slice is a **performance/cleanliness** improvement, not a
blocker — do it last (or skip until needed).

**Tests:** grouping + urgency thresholds; ordering (most-urgent first).

---

## Dispatch order

BE1 → BE2 → BE4 → BE3 → BE5 → BE6. (BE3/BE5 are independent and can slot anywhere; BE2 and
BE4 are paired via the `listing_reviewed`/event seam; BE6 last.) After each, the frontend
panels that consume that contract slice light up automatically (they degrade gracefully
until then).
