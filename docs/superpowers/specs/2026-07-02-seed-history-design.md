# Seed data — entity lifecycle history / trails

**Date:** 2026-07-02 · **Status:** design (approved in brainstorm; implementation follows)
**Follows:** `docs/superpowers/specs/2026-07-02-seed-data-clean-slate-design.md` (the merged
clean-slate seed this extends). **Related code:** `app/src/lib/seed/{index,lean,matrix,cast,live}.ts`,
`app/src/services/statusTransition.ts`, `app/src/repos/auditRepo.ts`,
`app/src/repos/activityEventsRepo.ts`, `app/src/lib/statusModel.ts`, `app/src/lib/toursModel.ts`.
**Grounding research (read first):** `.superpowers/sdd/seed-history-research.md`
(SURFACES / WRITE-SHAPES / SEED-GAP — exact file:line, table shapes, canonical enum orders).

## 1. Why

The merged clean-slate seed sets every entity to its **END state** but writes essentially
**no history**: across `lean + matrix + cast + live` the whole seed contains exactly **2
`audit_events` rows + 4 `activity_events` rows** (research §SEED-GAP). Every non-start
placement, tenant, landlord, unit, and tour is a flat snapshot with no trail showing how it
got there. Three dashboard history surfaces render blank as a result. The user's requirement:

> "Anything that's not at the beginning of the entire process should show how it got from the
> beginning of the process to where it is."

So a `--seeded` (full-profile) dev boot must populate a realistic, self-consistent lifecycle
trail for every entity past step 1 of its lifecycle.

## 2. The three history surfaces and their feeds (research §SURFACES)

| Surface | Endpoint | Feed table | Row event_types the surface renders |
|---|---|---|---|
| **Placement "History" panel** (`PlacementDetail`) | `GET /api/placements/:id/history` | `audit_events` `placements#<id>` | `placement_stage_changed` (+ any) |
| **Property "Activity" card** (`ListingDetail` `/listings/:unitId`) | `GET /api/units/:id/activity` | `audit_events` `units#<id>` | `listing_status_changed`, `unit_created/updated`, roster, `listing_response_set` |
| **Contact Timeline** (milestones merged with messages) | `GET /api/contacts/:id/timeline` | `activity_events` (PK `contactId`) | `placement_opened/closed`, `stage_changed`, `listing_sent/reviewed`, `tour_scheduled/tour_took_place`, `number_added`, `added_to_group_text` |

- **Tour detail has NO history surface** — it renders current tour state only. Out of scope.
  Tour milestones ride the **tenant timeline** as `tour_scheduled` / `tour_took_place`
  `activity_events`.
- **`tenant_status_changed` audit rows (`contacts#<id>`) render nowhere today** (the contact
  page reads `activity_events`, not `contacts#` audit). We still write them — see §4.4.

## 3. Canonical journeys = the model's ordered enums (research §SEED-GAP.1)

The trail for any entity is the ordered slice of its canonical enum from the start element up
to its current element, one hop per consecutive pair. **Import the enums — never hardcode.**

- **Placements** — `PLACEMENT_STAGES` (`statusModel.ts:37`, 18 entries). Journey to stage X =
  `PLACEMENT_STAGES.slice(0, indexOf(X)+1)`. `lost` is a terminal reachable from any stage: a
  `lost` placement walks a plausible active prefix then `→ lost` with `lost_reason_category`
  on the final hop. `STAGE_PHASE` (`statusModel.ts:70`) gives each stage's phase.
- **Tenants** — `TENANT_STATUSES` (`statusModel.ts:140`). Linear `needs_review → onboarding →
  searching → placing → placed`; `on_hold`/`inactive` are override branches (`source:'manual'`).
- **Landlords** — `LANDLORD_STATUSES` (`statusModel.ts:173`). `needs_review → interested →
  active`; `parked` = prefix then `→ parked` with `park_reason`.
- **Units** — `LISTING_STATUSES` (`statusModel.ts:208`). `setup → available → under_application
  → finalizing → occupied`; `on_hold`/`off_market` override branches. The **`setup → available`
  hop is the one explicit `source:'manual'` publish**; `available → … → occupied` hops are
  `source:'derived'` side-effects of the linked placement's stage hops.
- **Tours** — `TOUR_STATUSES` (`toursModel.ts:27`). Materialize as tenant-timeline
  `activity_events` only (`tour_scheduled` at `scheduled`, `tour_took_place` at `toured`); no
  tour audit table exists.

## 4. Approved design

New module **`app/src/lib/seed/history.ts`**, invoked by `seedAll` **only in the FULL
profile**, as a **pure post-pass over the assembled full item set**. The **lean profile is
never touched** — `seedAll(endpoint,'lean')` does NOT call history, so `/__dev/reseed` + the
e2e session keep their byte-identical world (this is the load-bearing regression gate, exactly
as the clean-slate seed's profile split; see [[seed-data-clean-slate]]).

### 4.1 Authoring method: deterministic generator (not service replay)

Approved decision (user): **write trail rows directly from a deterministic generator**, NOT by
replaying `statusTransition.ts`. Rationale: the transition service stamps `new Date()`
internally for both the entity fields and the audit SK (`<ISO>#<randomUUID slice>`) with **no
clock injection** — replaying it produces now-dated, non-byte-stable rows and cannot reproduce
fixed historical dates. The generator walks the canonical enum order and emits rows with
**fixed monotonic past timestamps**.

Fidelity to the real write path is guaranteed instead by a **fidelity test** (§5) that runs the
real service once and asserts the generator's row shape matches.

### 4.2 Timeline realism: plausible per-stage durations

Approved decision (user): **plausible per-stage durations**, not uniform spacing. A fixed
duration table assigns each transition a realistic gap (e.g. application steps ~2–4 days, RTA
authority review ~1 week, inspection scheduling ~10 days, HAP/paperwork ~a few days). Hop
timestamps are computed by walking **backward** from each entity's existing anchor
(`stage_entered_at` for placements; `created_at`/consent anchor for contacts; `created_at`/
`updatedAt` for units/tours) so **the final hop's timestamp equals the entity's stored anchor**
and all earlier hops are strictly increasing before it. Deterministic ⇒ fixed anchors (matrix/
cast/lean) yield byte-stable rows; the live showcase's now-relative anchors yield now-relative
rows automatically (§4.6).

### 4.3 Placement audit trails

For every full-profile placement past `send_application`, emit the `placement_stage_changed`
audit trail on `placements#<id>`, oldest-first, mirroring the real shape
(`statusTransition.ts:300`): `{ actor?, from, to, source, reason?, lost_reason_category? }`,
SK `ts = <ISO>#<deterministic-suffix>`, top-level `actorId` hoisted from `payload.actor`.
`lost` placements carry `lost_reason_category` (already stored on the placement doc) on the
final `→ lost` hop.

### 4.4 Derived tenant/unit audit side-effects

At each placement hop, compare `deriveStatuses(from)` vs `deriveStatuses(to)`
(`statusModel.ts:357`). When the coarse **tenant** status flips, emit a `tenant_status_changed`
row on `contacts#<tenantId>` with `source:'derived'` (no actor); when the coarse **unit**
status flips, emit `listing_status_changed` on `units#<unitId>` `source:'derived'`. **These
derived rows share the placement hop's timestamp** so the placement drawer, the (invisible)
tenant audit, and the unit Activity card tell one same-clock story. A no-op flip (status
unchanged, or an override-pinned status) emits no row — matching the service's skip semantics.

These `tenant_status_changed` rows currently render nowhere; per approved decision (user:
"write them anyway — faithful mirror") we still write them for DB honesty.

### 4.5 Unit publish hop + standalone status trails

- **Units:** the explicit `setup → available` publish hop (`listing_status_changed`,
  `source:'manual'`) sits before the derived hops. A unit that never had a placement
  (`available`-only tourables) gets just this one publish row.
- **Standalone tenants / landlords** (matrix rows covering each status ×2 that are NOT
  placement-linked) get their own linear status audit trail on `contacts#<id>`. Override
  branches (`on_hold`/`inactive`/`parked`) show the progression prefix then the branch hop
  (`source:'manual'`). **The implementer must verify the real event_type the landlord-status
  write path emits** (the tenant path emits `tenant_status_changed`; a generic contact PATCH
  emits `contact_updated` with `payload.fields`) and match it — do not invent an event_type the
  app never writes (faithful-mirror principle).

### 4.6 Contact activity_events milestone timelines

For every full-profile contact with a lifecycle, emit `activity_events` milestones mirroring
its journey (shape `activityEventsRepo.ts:49`, `{contactId, tsEventId:'<ISO at>#<eventId>', at,
type, label, refType?, refId?, created_at}`, deterministic `evt-*` ids like matrix's pattern):

- Placement-linked tenant: `placement_opened` (hop 0) → `stage_changed` per phase boundary →
  `placement_closed` at `moved_in`/terminal.
- Tour-owning tenant: `tour_scheduled` (at `scheduled`) → `tour_took_place` (at `toured`).
- Where the story has them: `listing_sent`/`listing_reviewed`, `number_added`,
  `added_to_group_text`.

### 4.7 Single source of truth (no duplicate/contradictory rows)

In the full profile, `history.ts` is the **authoritative source of lifecycle-trail rows**. It
must not produce rows that duplicate or contradict the pre-existing hand-authored rows (lean's
2 audit rows, matrix's 4 `activity_events`). Achieve this by **deduping**: when the generator
emits a trail for an `entityKey`/contact, it supersedes any pre-merged lifecycle rows of the
same class for that key (or the pre-existing emitter stands down in the full assembly). Lean's
non-lifecycle `contact.profile_edited` row is out of scope — leave it. **The lean profile's own
output must remain byte-identical** (verified by the existing `seedData.test.ts` contract).

### 4.8 Live showcase

The live entities (`live.ts`, ~6 now-relative items) get now-relative trails by running the
**same generator** against their now-anchored entities (mirroring how `live.ts` already replays
`armTourReminders` for the reminder ladder). Non-byte-stable by design, consistent with the
rest of `live.ts`.

No new tables, schema, IAM, or infra.

## 5. Tests

- **Fidelity test** (the anti-drift pin): construct the real `statusTransition` service against
  DynamoDB Local, transition one sample placement one hop, capture the written `audit_events`
  row, and assert the generator's row for that same hop matches (event_type + payload keys +
  source). Drift in the real shape fails this test.
- **Coverage tests:** every non-start placement's audit trail equals its
  `PLACEMENT_STAGES.slice(0, idx+1)` consecutive-pair sequence; derived tenant/unit rows appear
  exactly at the phase boundaries where `deriveStatuses` flips and share timestamps; every
  non-start tenant/landlord/unit has a status trail; every lifecycle contact has a non-empty
  `activity_events` timeline; monotonic strictly-increasing timestamps ending at the anchor.
- **Lean byte-stability:** `seedAll(_,'lean')` output unchanged (existing contract) — history
  never applied to lean.
- **e2e full suite green = the lean-regression proof** (e2e/reseed seed lean; a green suite
  proves history never floods the hermetic world).

## 6. Out of scope

- Tour status-history UI or a `tours#` audit table (no surface exists).
- Any change to the lean profile's world or the e2e suite's expectations.
- Rendering the `tenant_status_changed` audit rows on the contact page (a separate feature).
- Correcting lean's dead `contact.profile_edited` row.
- Seeding deployed AWS envs (guards unchanged; live mode never seeds).
