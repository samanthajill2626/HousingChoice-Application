<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-03).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Activity Coverage — Top-Level Plan

> **Status:** APPROVED (human review, 2026-07-03). This is a *top-level* plan (scope,
> surfaces, decisions). The detailed, task-by-task TDD breakdown is intentionally
> deferred to the orchestrator that will research + build this — see "Handoff" at the
> end.

**Goal:** Make every entity's activity surface actually reflect the state changes
that matter — tenant/landlord status + opt-out on the contact timeline, placement
stage changes and tour lifecycle where they belong, broadcasts on the property, and
a landlord's *properties'* activity on the landlord page — so staff can see, at a
glance, what's happened while they're texting someone.

**Architecture:** Two existing systems already back these surfaces; we extend their
*writers* (and, for cross-entity views, their *reads*) rather than invent a third.
No new storage model unless a decision below says so.

---

## Background — the two systems (verified on `main`)

| System | Keyed by | Written by | Rendered on |
|---|---|---|---|
| **Activity events** (`activityEventsRepo`) | **contactId** | route handlers via `activityEvents.record(...)` | Contact page **"Communications & activity"** timeline (milestone pins), merged in `app/src/routes/contactTimeline.ts` |
| **Audit trail** (`auditRepo`) | `<entity>#<id>` (`placements#`, `units#`, `contacts#`) | `audit.append(...)` + the status-transition service | **Placement "History"** panel; **Property "Activity"** card (`GET /api/units/:id/activity`) |

**Current live coverage (what actually fires today, ignoring seeded data):**

- **Tenant timeline** gets: `placement_opened`, `listing_sent`, `listing_reviewed`,
  `tour_took_place`, `number_added`, group-text add/remove. It does **not** get
  contact status changes, opt-out, placement stage changes, or any tour event except
  "toured".
- **Placement History** gets stage changes + closure (audit). Works.
- **Property Activity** gets `unit_created/updated`, roster add/remove,
  `listing_response_set`, `listing_status_changed` (audit). Works. Does **not** show
  broadcasts (audited under `broadcasts#`) or tours.
- **Landlord page**: the landlord's own contact timeline only (sparse — number/group
  text). Their properties' activity is **not** aggregated anywhere.
- **Tours**: only `tour_took_place` is recorded (→ tenant timeline). No tour audit at
  all; scheduling/confirm/no-show/cancel/reschedule/exit-gate are recorded nowhere.

**ADR-ish decision:** extend the **activity-event emitters** to cover the wanted
contact-facing changes (this also resolves the open issue
[`transition-service-no-activity-milestones`](../../issues/transition-service-no-activity-milestones.md)),
and extend the **audit-backed reads** (+ writers) for the property/landlord views.

## Global Constraints (from CLAUDE.md — apply to every task)

- **Vocabulary:** the entity is `unit` in code/data; UI copy is **"property"** for
  staff/landlord, **"home"** for tenant. Labels shown here follow that.
- **PII (doc §9):** never log a phone number or message body; activity labels may
  carry a name but names/labels/payloads must not be logged.
- **Best-effort writes:** an activity/audit write must **never** fail the operator's
  action (the state change is already persisted) — try/catch + log, like the existing
  `recordPlacementMilestone` / `record*` neighbors.
- **Idempotency:** emit once per real transition (mirror the `tour_took_place`
  "only on transition INTO toured" guard); never on a no-op re-write.
- **Tokens-only CSS**, accessibility-first selectors, and **verify in the e2e
  harness** before "done". Branch off `main`, sync before finishing, **no merge
  without human approval**, explicit sub-agent models.

## Scope

**In:** contact-timeline coverage for status + opt-out + placement stage + tour
lifecycle; property Activity coverage for broadcasts + tours; landlord status +
landlord-property activity aggregation; issues for the gaps we're deferring.

**Explicitly OUT (per the human):** do **not** surface routine edit changes —
tenant or landlord **name / voucher / other field edits / delete / restore** — on any
activity timeline. (They stay in the audit trail as provenance, unsurfaced.)

---

## Design decisions (recommendations — confirm on review)

- **D1 — New activity-event types.** Add to the `ActivityEventType` enum
  (`app/src/repos/activityEventsRepo.ts`): `contact_status_changed`,
  `opt_out_changed` (covers SMS Do-Not-Contact **and**, recommended, voice
  Do-Not-Call), and tour types `tour_scheduled` (already reserved),
  `tour_canceled`, `tour_no_show`, `tour_outcome` (+ reuse `tour_took_place`).
  Reuse the existing `stage_changed` type for placement stage moves. Pin a
  pill-colour per new type in `Timeline.tsx`'s `milestoneVariant`.
- **D2 — Placement stage changes → tenant timeline.** Inject `activityEventsRepo`
  into the transition service (`app/src/services/statusTransition.ts`) and emit a
  `stage_changed` milestone (terminal `moved_in`/`lost` → `placement_closed`)
  **alongside** the existing `placements#` audit write — exactly the fix the open
  issue proposes. *Recommendation:* emit on every transition (parity with the
  Placement History panel); revisit noise only if it proves chatty.
- **D3 — Landlord's property activity on the landlord page.** *Recommendation:*
  **interleave** it into the landlord's "Communications & activity" stream as
  milestones (property-deep-linked), so it reads chronologically next to the texts
  ("at a glance during text conversations"). Mechanism: in `contactTimeline.ts`,
  when the contact is a **landlord**, also gather their owned units
  (`unitsRepo` by landlord) and merge each unit's audit (`auditRepo.listByEntity
  units#<id>`) as milestones. *Alternative:* a dedicated "Property activity" card
  (simpler, less glanceable). **← key call for review.**
- **D4 — Broadcast on the property Activity.** A broadcast targets a **single**
  property (`BroadcastItem.unitId` optional-but-single; there's a `byUnit` GSI +
  `listByUnit`) — so "Broadcast to N tenants" is unambiguous: **N = the broadcast's
  total recipients**. On fan-out (`app/src/jobs/broadcastFanOut.ts`) write a
  `units#<unitId>` audit row `broadcast_sent { broadcastId, tenantCount }` (count from
  the broadcast's stats). `describeUnitActivity` renders **"Broadcast to N tenants"**
  → `/broadcasts/:id`. *Why write to the unit audit rather than read-merge
  `listByUnit`:* it makes the property Activity **and** the landlord aggregation (WS3)
  read ONE source (unit audit), keeping both reads to a single per-unit Query.
  Forward-only (existing broadcasts won't appear — accepted, see Resolved #5).
- **D5 — Tour lifecycle → tenant + property.** On tour transitions
  (`app/src/routes/tours.ts`), write to **both** surfaces the existing views read:
  (a) a tenant `activityEvents.record(...)` milestone (contactId = `tour.tenantId`),
  and (b) a `units#<unitId>` audit row for the property Activity. Transitions to
  surface: `scheduled`, `rescheduled`, `toured`, `no_show`, `canceled`, and the
  exit-gate `outcome` (move-forward / not-a-fit). **No separate `confirmed` event** —
  a scheduled tour already reads as confirmed (Resolved #2); the tour entity keeps its
  `confirmed` status for its own workflow, we just don't emit a milestone for it. Keep
  the tour **detail page unchanged** for now.
- **D6 — Contact status + opt-out (tenant AND landlord).** Emit
  `contact_status_changed` from the tenant status path (transition service,
  `tenant_status_changed` already audited) and from the **landlord** status path
  (wherever landlord `status` is written) — landlord statuses exist
  (`needs_review | interested | active | parked`). Emit `opt_out_changed` from the
  opt-out routes (`app/src/routes/contacts.ts` `contact_opt_out_changed` /
  `contact_voice_opt_out_changed`). Label examples: "Status → Placing", "Marked Do
  Not Contact", "Do Not Contact cleared".

## Resolved (human review, 2026-07-03)

1. **Voice opt-out:** YES — surface **both** Do-Not-Contact (SMS) and Do-Not-Call
   (voice) changes on the timeline. (The two flags are separate *channels* with
   separate opt-out regimes — a "STOP" text opts out of SMS only; a verbal "don't
   call me" opts out of voice only — so a contact can be textable-but-not-callable or
   vice versa. Both are contactability status worth showing.)
2. **Tour `confirmed`:** SKIP — `scheduled`/`rescheduled` covers it (a scheduled tour
   reads as confirmed). Reflected in D5.
3. **Broadcast count:** N = the broadcast's **total recipients** (a broadcast is
   single-property, so this equals "recipients for that property"). Reflected in D4.
4. **Landlord property activity:** INTERLEAVE into the landlord's timeline (D3).
5. **Backfill:** NONE — forward-only.

## Access patterns / query cost (the landlord-aggregation question)

**No full scan, no unbounded scans.** The landlord-property aggregation (D3/WS3) is a
**bounded fan-out**, the same shape the contact timeline already uses (per phone →
`conversations.findByParticipantPhone`, per conversation → messages):

- **1 Query** — `unitsRepo.listByLandlord(landlordId)` via the **`byLandlord` GSI**
  (units carry `landlordId` as a GSI hash key). Gets the landlord's N properties.
- **N Queries** — for each unit, `auditRepo.listByEntity('units#'+unitId, {limit})`,
  a **bounded partition Query** on the audit table (newest-first), NOT a scan.
- **Total: N+1 bounded Queries**, N = the landlord's property count (small — a handful).

Because tours and broadcasts are written **into the unit audit** (D4/D5), the unit
audit is the *single* source for both the property Activity card and this landlord
aggregation — no extra per-unit broadcast/tour queries. Bound the per-unit `limit`
and cap N (log-if-capped, mirroring `today.ts`'s `warnIfCapped`). No new tables; the
`byLandlord` GSI and the audit partition already exist.

---

## Workstreams

Each is independently shippable and independently testable (unit + e2e). Ordering
reflects dependencies; WS4 feeds WS1 and WS2.

### WS1 — Tenant contact timeline coverage
- **Backend:** emit `contact_status_changed` (transition service) and
  `opt_out_changed` (contacts opt-out routes); emit `stage_changed`/`placement_closed`
  from the transition service (D2). Tour events land here via WS4.
- **Frontend:** extend `Timeline.tsx` `milestoneVariant` + any label mapping for the
  new types; verify they render as milestone pins with correct deep-links.
- **Files:** `app/src/services/statusTransition.ts`, `app/src/routes/contacts.ts`,
  `app/src/repos/activityEventsRepo.ts` (enum), `dashboard/src/routes/contact/Timeline.tsx`,
  `dashboard/src/api/types.ts` (milestone type additions).

### WS2 — Property (unit) Activity coverage
- **Backend:** `broadcast_sent` unit-audit row on fan-out (D4); tour unit-audit rows
  via WS4; extend `toUnitActivityEvent` whitelist + `describeUnitActivity` for the new
  event kinds; render the broadcast entry as a deep-link.
- **Files:** `app/src/jobs/broadcastFanOut.ts`, `app/src/routes/units.ts`
  (`toUnitActivityEvent`), `dashboard/src/routes/listing/listingFormat.ts`
  (`describeUnitActivity`), `dashboard/src/routes/listing/ListingDetail.tsx`.

### WS3 — Landlord contact coverage
- **Backend:** landlord `contact_status_changed` emission (D6). Landlord property
  aggregation in the timeline builder (D3): detect landlord kind → gather owned units
  → merge unit-audit milestones (property-deep-linked). Decide interleave vs. card
  (Q4) — the plan assumes interleave.
- **Files:** `app/src/routes/contactTimeline.ts` (landlord branch + unit fan-out),
  wherever landlord status is written, `dashboard/src/routes/contact/LandlordFile.tsx`
  / `Timeline.tsx` (rendering + optional filter).

### WS4 — Tour → tenant/property propagation (feeds WS1 + WS2)
- **Backend:** on tour transitions, dual-write: tenant `activityEvents.record(...)`
  milestone + `units#<unitId>` audit row, for the transitions in D5, idempotent per
  transition. New enum members (D1).
- **Files:** `app/src/routes/tours.ts`, `app/src/repos/activityEventsRepo.ts` (enum),
  `app/src/routes/units.ts` (whitelist for the tour kinds).
- **Note:** the **tour detail page is untouched** in this plan (its own history panel
  is deferred → issue in WS5).

### WS5 — Issues for deferred/uncovered gaps
- File `docs/issues/tour-activity-no-tour-page-surface.md` — the tour page shows no
  history of its own lifecycle (we're only propagating to tenant/property here); pairs
  with [`scheduled-message-visibility`](../../issues/scheduled-message-visibility.md)
  (the tour reminder ladder panel).
- Update [`transition-service-no-activity-milestones`](../../issues/transition-service-no-activity-milestones.md)
  → resolved by WS1/D2 (or in-progress) once landed.
- File any additional gap surfaced during research (e.g. contact-audit still
  unsurfaced for the intentionally-excluded edit events — a "wontfix/decision" note so
  it's a recorded choice, not an oversight).

## Testing strategy

- **Unit:** each emitter asserts it fires once on a real transition, not on a no-op,
  and never throws out of the operator action (best-effort). Enum/label/variant maps
  covered.
- **e2e (Playwright harness):** drive real flows and assert the surface —
  opt-out toggle → milestone on the tenant timeline; a placement transition →
  stage milestone on the tenant timeline **and** the placement History; a landlord
  status change + a unit status change → both on the landlord page; a broadcast →
  "Broadcast to N tenants" on the property, click → broadcast page; tour scheduled +
  toured + canceled → tenant timeline and property Activity (use the tours dev seams).

## Dependencies / phasing

WS4 (tour propagation) and D1 (enum) underpin the tour parts of WS1/WS2, so land the
enum first, then WS1/WS2/WS3/WS4 can proceed largely in parallel; WS5 issues filed
alongside. No new tables expected; new GSIs unlikely (reads reuse `listByEntity` /
`listByContact` / units-by-landlord). Confirm during research.

## Handoff

Per the agreed flow: after human review of this top-level plan, produce an
**orchestrator prompt** (research → detailed TDD task breakdown → build with
subagents → verify in the e2e harness → file/refresh issues), following CLAUDE.md.
The orchestrator owns the bite-sized task decomposition; this document fixes the
scope, the surfaces, and the decisions above.
