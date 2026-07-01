<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-01).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Broadcasts dashboard surface — design spec

> Date: 2026-06-30 · Status: approved (brainstorm) → ready for implementation plan
> Rebuilds the stubbed **Broadcasts** surface on the new dashboard (:5174): a
> **list**, a **composer** (extensible audience filter → editable curated
> recipient list → send), and a **live results** view — wired from the nav and
> the property "📣 Broadcast to tenants" button. Unlike Settings, this needs real
> **backend additions** (delete-draft, send-by-explicit-selection, full preview
> list + already-sent-this-property annotation, a prior-recipients lookup).

## 1. Goal & decisions

`/broadcasts` is a `Placeholder` stub; the property detail already has an inert
"📣 Broadcast to tenants" button. The M1.8 "Share Listings" backend is fully built
(`app/src/routes/broadcasts.ts`: draft → preview → send → results + list, the
`broadcast.send` fan-out, delivery rollup, `broadcast.updated` SSE). Rebuild the
UI and extend the backend for the curated-recipient flow. Decisions:

1. **VA-accessible** (no admin gate — matches the backend; VAs run broadcasts daily).
2. **Three views:** **Broadcasts list** (nav), **Composer**, **Results**.
3. **Audience filter (the centerpiece):** prominent **voucher size** (the tenant's
   approved bedroom size; the backend matches tenant `voucherSize` to the chosen
   size) + **housing authority**. Composing from a property pre-fills voucher size
   from the unit's beds (overridable — a 2-BR home may suit other sizes), shown
   with a "matches this 2-bedroom property" tag. Built as an **extensible filter
   framework** ("+ Add filter" seam) so future criteria (neighborhood,
   accessibility, income…) slot in. Opted-out / unreachable are ALWAYS hard-excluded
   server-side and never appear.
4. **Preview = editable curated recipient list:** every candidate is listed
   **individually + selectable** (no collapsing). The operator can **uncheck**
   anyone, **add** tenants the filter didn't catch (tenant search), and **remove**
   filter matches. Scrollable, with a **search-within-recipients** and bulk
   **Select all / Deselect all**. Anyone **already sent a broadcast for this
   property** is **flagged + left unchecked** (soft — opt-in to resend, NOT a hard
   gate); "Select all" skips them.
5. **Send uses the explicit checked selection** (not a filter re-resolve). Server
   re-enforces opt-out/unreachable + the recipient cap defensively.
6. **Delete an unsent draft;** a sending/sent/failed broadcast is permanent.
7. **Results:** stat chips + per-recipient delivery status, live via
   `broadcast.updated` SSE. **Every recipient row links to that tenant's
   contact/comms page** (`/contacts/:contactId`). **Failure disposition is
   conversation-only** — a broadcast lands in the tenant's 1:1 thread, so a failure
   is a failed bubble there with the dashboard's existing **Retry** + manual
   follow-up; Results stays read-only (NO inline retry/dismiss, NO new backend).
   A **failed row carries the error class AND a clear affordance hinting the click
   resolves it** (e.g. a chevron + "↗ open conversation to retry") so the operator
   knows the row is the disposition path.
8. **Naming:** nav "Broadcasts"; the property action stays "📣 Broadcast to
   tenants". The dwelling is "property" to staff (relabel merged); the audience is
   tenants. The internal `broadcast` entity / routes are unchanged.

## 2. Backend additions (the new work)

Existing endpoints keep their contracts except where noted. New / changed:

- **`DELETE /api/broadcasts/:id`** — deletes ONLY when `status === 'draft'`. `404`
  when missing; **`409 broadcast_not_draft`** when sending/sent/failed (sent is
  permanent). Audited (`broadcast_deleted`, IDs only). New `broadcastsRepo.delete`
  is a `DeleteCommand` conditional on `status = 'draft'` (a concurrent send →
  ConditionalCheckFailed → 409, never a silent delete of a sent broadcast).
- **Send by explicit selection** — `POST /api/broadcasts/:id/send` gains an
  optional body `{ recipientContactIds: string[] }`. When present, the send builds
  the recipients map from THAT set (resolve each contact; **re-enforce
  opt-out/unreachable**; drop unknowns) instead of re-resolving the filter; still
  caps at `MAX_BROADCAST_RECIPIENTS` and refuses an empty effective set
  (`400 empty_audience`). When ABSENT, the existing filter-resolve path is kept
  (back-compat). The dashboard always sends the explicit list.
- **Full preview list + annotations** — `POST /api/broadcasts/:id/preview` returns
  the **full** candidate list (bounded by the cap, not the 25-sample), each:
  `{ contactId, firstName?, phone, voucherSize?, housingAuthority?,
  alreadySentThisProperty }`. It also returns `priorRecipientContactIds: string[]`
  (the set already sent for this unit) so the composer can annotate
  **manually-added** tenants locally. `alreadySentThisProperty` is true only when
  the broadcast has a `unitId` and a prior **sent/sending** broadcast for that unit
  included the contact. (The existing `count` / `truncated` stay.) The audience
  resolver's contact projection gains `voucherSize` + `housingAuthority` for the
  row display.
- **Prior-recipients lookup** — given a `unitId`, return the set of contactIds
  already sent a broadcast for that unit. Implemented via a **sparse `byUnit` GSI**
  on the `broadcasts` table (partition = `unitId`, present only when a broadcast
  has a unit) → query sent/sending broadcasts for the unit → union their
  `recipients` keys. ⚠️ **New GSI = operator `terraform apply`** (broadcasts table
  in both envs' `tables.auto.tfvars.json`), same posture as Settings Phase B. The
  feature degrades safely without it (the lookup returns empty → nothing flagged)
  but the apply is needed for the already-sent protection to work on deployed envs.

PII (doc §9): the preview/results responses carry phones (authed/internal — the
operator must see the audience), but LOG LINES stay IDs/counts only; bodies/templates
are never logged.

## 3. API client + types (dashboard)

- `endpoints.ts`: `listBroadcasts({status?,cursor?})`, `createBroadcast(body)`,
  `previewBroadcast(id)`, `sendBroadcast(id, recipientContactIds)`,
  `getBroadcastResults(id)`, `deleteBroadcast(id)`. (Tenant search for "add a
  tenant" reuses the existing `getContacts`/contact-search endpoint, scoped to
  `tenant`.)
- `types.ts`: `BroadcastSummary`, `BroadcastResults`, `BroadcastRecipientView`,
  `AudienceFilter`, `PreviewCandidate` (+ `alreadySentThisProperty`),
  `PreviewResponse` (+ `priorRecipientContactIds`). Mirror the backend.

## 4. Frontend — views & components

New `dashboard/src/routes/broadcasts/`:

- **`BroadcastsList`** — the nav surface: rows (status chip · audience summary ·
  delivered/total · date), optional `?status=` filter, "New broadcast" button →
  composer; a row → Results (or, for a `draft`, the composer's review/send step).
  Cursor pagination via the list endpoint.
- **`BroadcastComposer`** (route `/broadcasts/new`, optionally `?unitId=`):
  - **`AudienceFilters`** — the extensible framework: a prominent **VoucherSize**
    control (chips Studio/1/2/3/4+; pre-filled + "matches this N-BR property" tag
    when `unitId`) + **HousingAuthority** select; an "+ Add filter" seam (disabled
    placeholder in v1) and the "always excluded: opted-out · unreachable" note. A
    live **reach count** (debounced `previewBroadcast`/draft estimate) with the
    `truncated` warning.
  - **`MessageEditor`** — template textarea (≤1600), merge-field insert chips
    (`[TenantName]`/`[Beds]`/`[Address]`/`[Rent]`/`[FlyerLink]`); when `unitId` is
    set the flyer link is attached + the property shown.
  - Flow: fill audience + message → (create draft to get an id) → **Preview**.
- **`RecipientPreview`** — the editable curated list (every candidate individual +
  checkbox): uncheck/remove, **add a tenant** (search → append, annotated via
  `priorRecipientContactIds`), **already-sent** rows amber + unchecked,
  scroll + **search-within-recipients** + **Select all / Deselect all** (select-all
  skips already-sent). A selected-count + **Send to N tenants** (handles 400
  empty/`audience_too_large`, 409 not-draft) + **Delete draft**.
- **`BroadcastResults`** (route `/broadcasts/:id`) — header (property/audience +
  status pill + started-by/at), **stat chips** (Recipients / Delivered / Sent /
  Queued / Failed), **per-recipient** rows with a `DeliveryBadge`
  (queued→sent→delivered | failed + error class), live via **`onBroadcastUpdated`**
  (overlay status + stats + per-recipient) + a manual Refresh. **Each row is a link
  to `/contacts/:contactId`** (the tenant's comms). **Failed rows** show the error
  class plus an explicit **"↗ open conversation to retry"** affordance (chevron +
  hover) — disposition is conversation-only (the existing in-thread Retry); Results
  adds no retry/dismiss of its own.

Entry points: the **nav** "Broadcasts" route (replace the `Placeholder`); the
property detail's existing **"📣 Broadcast to tenants"** button → `/broadcasts/new?unitId=…`.

## 5. Data flow

open composer (maybe `?unitId`) → set audience (voucher size + authority) + message
→ create draft → **preview** (full annotated candidate list + prior-recipients) →
curate the selection (add/remove; already-sent unchecked) → **send** with the
explicit `recipientContactIds` → backend snapshots + enqueues `broadcast.send` →
**results** roll up live via `broadcast.updated`. An unsent draft can be **deleted**.

## 6. Validation & errors

- Composer: `body_template` required/≤1600; audience filter validated server-side;
  the reach/`truncated` warning surfaces an incomplete/over-cap audience BEFORE send.
- Send: `empty_audience` (nothing checked) / `audience_too_large` (>cap) → inline;
  `409 broadcast_not_draft` (already sent / raced) → inline; the send list is the
  curated selection.
- Delete: only a draft; `409` otherwise → inline (the row falls back to Results).
- Already-sent is a SOFT flag (unchecked, opt-in) — never a hard block.

## 7. Components (each one job)

`endpoints.*` (the calls) · `BroadcastsList` · `BroadcastComposer` (orchestrates
audience + message + draft) · `AudienceFilters` (extensible filter model) ·
`MessageEditor` · `RecipientPreview` (the curated list) · `BroadcastResults`
(+ `StatChips`, `DeliveryBadge`) · backend: `broadcastsRepo.delete` +
`listByUnit` (byUnit GSI) + the preview/send route changes + the
audience-resolver projection.

## 8. Testing

- **Component (dashboard):** audience filter pre-fills + overrides from `unitId`;
  reach updates; preview lists every candidate, add/remove + search-within + bulk
  select (select-all skips already-sent); already-sent rows render unchecked +
  flagged; send posts the exact checked `recipientContactIds`; 400/409 inline;
  delete only on a draft; results render stats + per-recipient + live
  `broadcast.updated` overlay; a recipient row navigates to the tenant's contact
  page; a failed row shows the error class + the "open conversation to retry"
  affordance.
- **Backend:** DELETE draft-only (409 on sent, conditional-delete race);
  send-by-selection builds recipients from the list + re-enforces opt-out/cap +
  empty→400; preview returns the full annotated list + `priorRecipientContactIds`;
  `alreadySentThisProperty` true only for a prior sent/sending broadcast of that
  unit; `byUnit` GSI query; audience projection includes voucherSize/housingAuthority.
  DynamoDB-Local integration coverage for the GSI + conditional delete.
- **e2e:** from a property → "Broadcast to tenants" → audience pre-filled → preview
  → uncheck one + add one + see an already-sent flag → send → land on Results with
  the right count; plus delete an unsent draft from the list. (Local/console: the
  send fans out through the console driver; assert via the existing fake-twilio /
  results, not real SMS.)

## 9. Phasing

- **Phase A — backend:** DELETE-draft, send-by-selection, full preview list +
  `alreadySentThisProperty` + `priorRecipientContactIds`, the `byUnit` GSI
  (⚠️ operator `terraform apply`), audience-projection fields. App-test-covered.
- **Phase B — frontend:** the four views + API client/types + entry points + SSE
  wiring + e2e. Degrades safely before the GSI apply (nothing flagged as already-sent).

## 10. Notes / future

- "+ Add filter" is a deliberate seam — only voucher size + housing authority ship
  now; the audience-filter model is shaped so a new criterion is additive
  (backend `AudienceFilter` field + a resolver clause + a control).
- Deferred: editing a draft's template/filter (no backend update — recreate
  instead), broadcast scheduling, non-tenant audiences, a public flyer HTML page
  (the flyer link is still the JSON endpoint until the public-pages surface lands).
- If the `broadcasts` table grows large, the `byUnit` GSI keeps already-sent O(matches)
  rather than a scan.
