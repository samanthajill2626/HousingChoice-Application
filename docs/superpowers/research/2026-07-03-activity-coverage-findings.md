# Activity Coverage — Phase 1 Research Findings

> Feeds the detailed TDD plan. All `file:line` refs are against `main` @ `eed67e0`
> (worktree `w:/tmp/activity-coverage`). Four read-only research agents; findings
> cross-checked and consistent.

## Headline confirmations

- **No new tables or GSIs.** The audit `<entity>#<id>` partition and the units
  `byLandlord` GSI both already exist (`app/src/lib/tables.ts:103` byLandlord;
  `:209-219` `audit_events` PK `entityKey`/SK `ts`). `units#<id>` audit rows are
  already written + read today (`statusTransition.ts:217,484`; `units.ts:641`).
- **Audit `event_type` is an OPEN string** — no closed union, no validation
  (`auditRepo.ts:21,43`). New audit types (`broadcast_sent` under `units#`, tour
  kinds) append freely.
- **Activity `ActivityEventType` IS a closed union** shared verbatim with the
  frontend (`activityEventsRepo.ts:33-43` ↔ `dashboard/src/api/types.ts:1082-1092`).
  New members must be added in **lockstep** or the frontend won't render them.
- **Activity repo has NO dedupe** (fresh `evt-<uuid>` → unique SK, plain Put,
  `activityEventsRepo.ts:124-125`). Idempotency is the **caller's** job — mirror the
  `tour_took_place` "only on transition INTO" guard.
- **`activityEventsRepo` is already injected** in `contacts.ts` (dep :75, used :1470)
  and `tours.ts` (dep :124). It is **NOT** in the transition service — that service
  needs a new dep threaded through.

---

## WS0 — Enum / type widening (shared foundation, land first)

| Add member | Where | Notes |
|---|---|---|
| `contact_status_changed` | `activityEventsRepo.ts:33-43` **and** `types.ts:1082-1092` | new |
| `opt_out_changed` | both unions | new (covers SMS + voice) |
| `tour_canceled`, `tour_no_show`, `tour_outcome` | both unions | new |
| reuse `tour_scheduled`, `tour_took_place`, `stage_changed` | — | already present |

Also widen the **local literal union** in `recordPlacementMilestone`
(`placements.ts:339`) if any new tour type is emitted through that helper (it is a
hardcoded subset of `ActivityEventType`; won't type-check otherwise). New emitters
will more likely call `activityEvents.record(...)` directly, so this may not be
needed — confirm per emitter.

`ActivityEventRefType` (`activityEventsRepo.ts:46`) already has `unit|tour|broadcast|
placement|conversation` — **no new refType needed.** Deep-links are the `refType`+
`refId` pair (there is NO `href` field); the frontend builds the URL.

`milestoneVariant` colour map (`Timeline.tsx:101-114`) — add a pill colour per new
type (default is neutral; pick green for positive tour events, amber/neutral for
status/opt-out). `milestoneHref` (`Timeline.tsx:119-135`) already covers `tour`,
`broadcast`, `unit` refTypes — no change.

---

## WS1 — Tenant contact timeline coverage

### Contact status (tenant) — transition service
- **Write site:** `statusTransition.ts:setTenantStatus` (:438-472); audit at
  **:462-468** (`contacts#<id>`, `tenant_status_changed`, payload `{from,to,source,
  reason?}`). Derived variant `deriveTenantStatus` :186-202 (audit :194-198) with
  no-op/override guards :191-192.
- **DI gap:** the service (`StatusTransitionDeps` :52-72, factory :167-172) does NOT
  have `activityEventsRepo`. Must extend the interface + factory + the router wiring
  in `routes/statusTransition.ts:40-56,68-81` (default via `createActivityEventsRepo`,
  mirroring tours.ts:143 / contacts.ts:728).
- **Emit:** `contact_status_changed` on the real move (guard `from !== to`, source
  filter to avoid derived-noise if desired). Label e.g. "Status → Placing".
  refType `placement`? No — status is contact-level; emit with **no refType** (or
  refType omitted) → milestoneHref returns null, renders as a plain pin. **Decision
  point for plan:** whether derived status changes also emit (recommend: emit only on
  explicit `setTenantStatus`, not derived, to avoid churn — confirm).

### Placement stage → tenant timeline
- **Write site:** `statusTransition.ts:transitionPlacement` (:272-436); audit
  `placements#<id>` `placement_stage_changed` at **:320-329**. No activity emitted
  here today (the coverage gap — the person-centric `stage_changed` milestones live
  in legacy `placements.ts:717-733` CRUD, NOT the transition pipeline).
- **Emit:** alongside the audit, `activityEvents.record({contactId: tenantId, type:
  terminal? 'placement_closed' : 'stage_changed', label, refType:'placement', refId:
  placementId})`. Terminal `moved_in`/`lost` → `placement_closed` (mirror
  `placements.ts:696-726` logic incl. lost-reason in label). tenantId is on the
  placement item. **Resolves `transition-service-no-activity-milestones`.**

### Opt-out (SMS + voice) — contacts routes
- **SMS:** `POST /api/contacts/:id/opt-out` handler `contacts.ts:1265-1297`; audit
  `contact_opt_out_changed` :1290. **Voice:** `POST /:id/voice-opt-out` :1304-1333;
  audit `contact_voice_opt_out_changed` :1327. Both audit-only today.
- **Emit:** `opt_out_changed` on each. `activityEvents` already injected (:75). Labels:
  "Marked Do Not Contact" / "Do Not Contact cleared" / "Marked Do Not Call" / "Do Not
  Call cleared" — the label distinguishes channel + direction. Guard: emit
  unconditionally after the existing existence check (the toggle already implies a
  change; there's no cheap pre-read of the flag — a pre-read to guard no-ops is
  optional, recommend emit-on-request since the routes are explicit toggles).

### Frontend
- `Timeline.tsx` renders milestones via `MilestonePin`/`StreamItem` case `'milestone'`
  (:339). Label is verbatim `ms.label`. Only `milestoneVariant` (:101) + the two type
  unions need touching. `commsOnly` filter (:391) already hides all milestones when on.

---

## WS4 — Tour lifecycle → tenant + property (feeds WS1 + WS2)

- **Single transition choke point:** `PATCH /api/tours/:tourId` handler
  `tours.ts:271-485`; applies via `tours.patch(tourId, patch)` :429. No per-status
  sub-handlers — `scheduled/confirmed/rescheduled/toured/no_show/canceled` are all
  `b['status']` values through this one handler; exit-gate `outcome`/`moveForward`
  at :420-425 (only when `currentStatus === 'toured'`).
- **Existing emit + guard to mirror:** `tour_took_place` at :469-481, guarded
  `newStatus === 'toured' && currentStatus !== 'toured'` (only INTO toured).
- **Tour shape:** `tenantId`, `unitId` present; **NO `landlordId`** — landlord is
  `unitsRepo.getById(tour.unitId).landlordId` (`resolveTourMembers` :504-514). For the
  property audit write we only need `unitId` (already on the tour) — no unit read.
- **Dual-write per surfaced transition** (idempotent, INTO-status guards):
  - Tenant: `activityEvents.record({contactId: tour.tenantId, type, label, refType:
    'tour', refId: tourId})`.
  - Property: `audit.append('units#'+tour.unitId, <tour_audit_type>, {tourId, ...})`.
    **⚠ `auditRepo` is NOT currently a dep of tours.ts** — must inject it (default
    `createAuditRepo`). Confirmed no audit.append in tours.ts today except the relay
    provisioning path.
  - Transitions to surface (per plan D5): `scheduled` (booking auto-advance :413-419),
    `rescheduled`, `toured` (reuse existing), `no_show`, `canceled`, and exit-gate
    `outcome`. **No `confirmed` milestone.**
- **Enum:** new `tour_canceled`, `tour_no_show`, `tour_outcome` (WS0). `tour_scheduled`
  reused for scheduled/rescheduled (label distinguishes).

---

## WS2 — Property (unit) Activity coverage

### Broadcast → unit audit
- **Fan-out:** `broadcastFanOut.ts`; totals known in `finalize()` :469-494 (`total =
  Object.keys(fresh.recipients).length`, `fresh.stats`). `activityEventsRepo` already a
  dep (:148) but **no `auditRepo`** — inject it.
- **BroadcastItem carries `unitId?`** (`broadcastsRepo.ts:110`). Write
  `audit.append('units#'+unitId, 'broadcast_sent', {broadcastId, tenantCount})` in
  `finalize` **only when `unitId` is present** (unit-less broadcasts skip). Guard once
  per completion (finalize runs once at terminal). Count = total recipients (plan D4).
- Note the send route already audits `broadcasts#<id>` `broadcast_sent` (`broadcasts.ts:529`)
  — the NEW row is a **different entityKey** (`units#`), same type name. Fine (open type).

### Whitelist + render
- **Projection whitelist:** `toUnitActivityEvent` (`units.ts:138-162`) is a fixed-key
  payload lift; it maps ALL returned rows (no type filter) but only pulls known keys.
  Add `broadcastId`, `tenantCount`, `tourId`, `outcome` (tour) to the projected keys so
  the frontend can build labels/links. Doc-comment whitelist at :111-114 to update.
- **Render:** `describeUnitActivity` (`listingFormat.ts:86-130`) — add cases:
  - `broadcast_sent` → `{label:'Broadcast to N tenants', to:'/broadcasts/'+broadcastId}`.
  - tour kinds → `{label:'Tour scheduled|rescheduled|took place|no-show|canceled|outcome …',
    to:'/tours/'+tourId}` (need `UnitActivityEvent` frontend type to gain `broadcastId?`,
    `tenantCount?`, `tourId?`, `outcome?` — search `UnitActivityEvent` in types).
  - `ListingDetail.tsx:346-376` renders `{to,label,sub}` through `<Row to=…>` already —
    deep-links work with no structural change.

---

## WS3 — Landlord status + property-activity aggregation

### Landlord status
- Landlord `status` (needs_review|interested|active|parked) is written via the SAME
  `setTenantStatus` path (`statusTransition.ts:438`, route validates against
  `statusAllowlistFor(stored.type)`) AND via the generic edit `PATCH /api/contacts/:id`
  (`contacts.ts:1061-1210`, write :1137, generic `contact_updated` audit :1177 — NOT
  status-specific). Emit `contact_status_changed` from the transition-service path
  (covers both tenant + landlord — the WS1 emitter already fires for landlords since it's
  the same setter). **For the generic-edit path (:1137), if `status` changed, also emit**
  — OR document that the kanban/explicit path is the supported one. **Decision point:**
  the plan's D6 says "wherever landlord status is written"; recommend emitting from BOTH
  the transition-service setter (primary) and the generic edit path when `status` is in
  the changed fields, to avoid a silent gap. Confirm in plan review.

### Property-activity interleave (D3)
- **Injection point:** `contactTimeline.ts`, after the milestone gather at **:378**,
  before merge at :383, inside `if (wantMilestone)`. Detect `contact.type === 'landlord'`
  (ContactItem carries `.type`).
- **Fan-out (bounded, N+1, no scan):** `units.listByLandlord(contactId, {limit})` (1
  Query on byLandlord GSI) → for each unit `audit.listByEntity('units#'+unitId, {limit:
  limit+1, before: boundaryKey})` → project each audit row into a `TimelineMilestone`
  candidate (`globalKey: <audit.ts>#<id>`), mirroring the per-conversation loop
  :353-367. Cap N with a `warnIfCapped`-style log (mirror `today.ts`).
- **DI gap:** `contactTimeline.ts` router does NOT import `unitsRepo`/`auditRepo` — add
  to `ContactTimelineRouterDeps` (:63-70) + construct (:283-289).
- **Projection:** reuse the same audit→label mapping as `describeUnitActivity` server-
  side? No — that's frontend. Build a small server-side audit→milestone mapper (label +
  refType `unit`/`tour`/`broadcast` + refId) so these render through the existing
  `MilestonePin` path. **The label mapping must live server-side** (contactTimeline emits
  `label` to the wire). Decide which audit types to interleave (property lifecycle:
  broadcast_sent, tour_*, listing_status_changed, unit_contact_added/removed — recommend
  the meaningful subset, not unit_updated field-edits which are excluded per plan).
- **Render:** shared `Timeline.tsx` already renders landlord milestones (ContactDetail
  uses the same `<Timeline>` for all kinds, :415-429). LandlordFile.tsx needs no change.
  Deep-links: `unit`→/listings, `tour`→/tours, `broadcast`→/broadcasts all in
  `milestoneHref`.

---

## E2E seams (Phase 4)

- **Opt-out:** no Scenario verb → `POST /api/contacts/:id/opt-out` + `/voice-opt-out`,
  or drive `ContactActionsMenu.tsx` ("Mark Do-Not-Contact"/"Allow SMS"; do-not-call).
- **Placement stage:** `Scenario.teamMovesPlacementTo(stageLabel,{lostReason?})`
  (`steps.ts:1929`); assert `expectPlacementStage` (:1959). API choke `POST
  /api/placements/:id/transition`.
- **Tours:** `teamBooksTour` (:1533), `teamReschedulesTour` (:1647),
  `teamMarksToured`/`teamMarksNoShow` (via `tourStatusAction` :2279). **⚠ NO
  `teamMarksCanceled` verb** — add one or `PATCH /api/tours/:id {status:'canceled'}`.
  Tours dev tick `POST /__dev/tour-reminders/tick` is REMINDERS only (not status).
- **Broadcast:** compose→preview→send via UI (`broadcasts.spec.ts:102-152`) or API
  `POST /api/broadcasts/:id/send`. **⚠ Fan-out has NO dev tick** — rides the live worker
  + SQS; assert by polling fake-twilio threads (worker is up in e2e:session). This means
  the `broadcast_sent` unit-audit assertion must poll for arrival, not tick.
- **Existing specs to extend:** `contact-detail.spec.ts`, `listing-activity.spec.ts`,
  `placement-history.spec.ts`, `tours.spec.ts`/`tours-page.spec.ts`, `broadcasts.spec.ts`,
  `a2p-compliance.spec.ts`.
- **Lane:** auto-picked by djb2 hash of this worktree's gitdir + free-probe
  (`lane.mjs`). Just run `npm run e2e` here; warm containers first
  (`npm run db:start && npm run s3:start`) given 4 other worktrees running.

## Cross-file sync checklist (every new milestone/activity kind)
1. `activityEventsRepo.ts:33-43` — `ActivityEventType`.
2. `dashboard/src/api/types.ts:1082-1092` — `TimelineMilestoneType` (lockstep).
3. `Timeline.tsx:101-114` — `milestoneVariant` colour.
4. `units.ts:138-162` — `toUnitActivityEvent` projected keys (+ doc-comment :111-114).
5. `listingFormat.ts:86-130` — `describeUnitActivity` case + deep-link.
6. `placements.ts:339` — local literal union, IF emitting a new type through that helper.

## Open decisions to surface at plan review
1. **Derived status changes** — emit `contact_status_changed` only on explicit
   `setTenantStatus`, not on `deriveTenantStatus`? (recommend: explicit only.)
2. **Landlord status from generic edit path** (`contacts.ts:1137`) — emit there too, or
   only from the transition-service setter? (recommend: both, guard on status-in-changed-fields.)
3. **Which audit types interleave** into the landlord timeline — the meaningful subset
   (broadcast_sent, tour_*, listing_status_changed, roster add/remove) vs. all. Excluded
   per plan: unit field-edits.
4. **Opt-out no-op guard** — pre-read the flag to skip re-emit on same-value toggle, or
   emit on every explicit request? (recommend: emit on request; routes are explicit.)
