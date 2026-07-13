# Seeded tours: lifecycle audit trails (tours# rows in the seed history post-pass)

Date: 2026-07-13
Status: APPROVED (Cameron's mission brief, 2026-07-13) - ready for implementation
Branch: feat/seed-tour-audit-trails (worktree w:/tmp/seed-tour-trails, cut from main 67e25da)

## 1. Problem (verified, settled)

The tour detail page interleaves the tour's lifecycle into all three conversation
panes (group / tenant 1:1 / landlord 1:1) and the Activity card, reading the
`tours#<tourId>` audit trail that the tours API writes on every real action. The
feature works; the DATA is missing: no seed profile writes `tours#` audit rows,
so every seeded tour shows comms-only panes, a no-op All|Comms toggle, and an
empty Activity card. The seed history post-pass (`historyItems`) already
materializes trails for placements, tenants, landlords, and units - tours were
never included. This change includes them.

## 2. The live writer's contract (derived from code, the ONLY event vocabulary)

From app/src/routes/tours.ts (recordTourEvent + call sites, ~:217-315, ~:631-656,
~:869) and app/src/routes/placements.ts (~:733):

| auditType          | payload shape                                | written when                                   |
|--------------------|----------------------------------------------|------------------------------------------------|
| tour_scheduled     | { tourId }                                   | create WITH time, or PATCH -> scheduled         |
| tour_rescheduled   | { tourId }                                   | scheduledAt change while scheduled              |
| tour_took_place    | { tourId }                                   | PATCH -> toured                                 |
| tour_no_show       | { tourId }                                   | PATCH -> no_show                                |
| tour_canceled      | { tourId }                                   | PATCH -> canceled                               |
| tour_outcome       | { tourId }                                   | exit gate: outcome newly set (toured tours)     |
| tour_group_opened  | { tourId, conversationId, actor? }           | group thread provisioned                        |
| tour_converted     | { tourId, placementId, actor? }              | placement created from the tour                 |

A timeless `requested` create emits NOTHING (tours.ts:313 comment) - that is the
runtime truth the seed must mirror.

All 8 types have real labels in dashboard tourActivityFormat.ts
(TOUR_EVENT_LABELS) and milestone-type mappings (MILESTONE_TYPE). Seeded rows
must use ONLY these types so no unknown-type fallback ever renders.

## 3. Per-status trail sequences (coherent by construction)

Given a seeded tour row (status, createdAt, scheduledAt?, updatedAt?, outcome?,
groupThreadId?, convertedPlacementId?):

- requested: ZERO rows (mirrors the runtime writer AND the existing
  "requested tours have zero reminder rows" invariant). Documented: a requested
  tour's panes legitimately show comms only and "No activity yet".
- scheduled: [tour_scheduled @ booking].
- toured: [tour_scheduled @ booking, tour_took_place @ scheduledAt].
- no_show: [tour_scheduled @ booking, tour_no_show @ scheduledAt].
- canceled: [tour_scheduled @ booking, tour_canceled @ cancel instant].
- closed: [tour_scheduled @ booking, tour_took_place @ scheduledAt] - a closed
  tour necessarily happened (exit gate 409s unless toured first).
- PLUS, appended per-field regardless of status:
  - outcome set on the tour row -> tour_outcome @ outcome instant (after
    took_place; use updatedAt when it is later than scheduledAt, else
    scheduledAt + a small fixed offset).
  - groupThreadId set -> tour_group_opened @ group instant (at/near booking -
    groups are provisioned at coordination time, before the visit), payload
    { tourId, conversationId: <groupThreadId> }, NO actor (archive write).
  - convertedPlacementId set -> tour_converted @ conversion instant (after
    took_place), payload { tourId, placementId }. (No current seed tour carries
    convertedPlacementId - implement the branch anyway, coherent-by-construction,
    and unit-test it synthetically.)

Instant definitions (the ONE clock, aligned with the existing contact-timeline
tourMilestones in history.ts, which books at createdAt and takes-place at
scheduledAt):
- booking = the tour row's createdAt (seed tours are created already-scheduled;
  identical to tourMilestones' bookedAt). Must satisfy createdAt <= booking <
  scheduledAt where a schedule exists.
- took_place / no_show = scheduledAt (same instant tourMilestones uses).
- cancel instant = the tour's own cancellation timestamp where the row has one
  (matrix canceled tours advance updatedAt); else a deterministic instant
  strictly between booking and scheduledAt (canceled before it would have
  happened). Never after scheduledAt.
- Ordering invariant per tour: every row's ISO instant is monotonically
  non-decreasing in sequence order, and distinct SKs (suffix) keep newest-first
  reads stable.

## 4. Where the rows come from (the post-pass, three clocks)

Extend `historyItems(tables)` in app/src/lib/seed/history.ts with a
`tourTrail(tour)` generator (exported for tests), following the module's
existing conventions exactly:

- audit SK ts = `<ISO>#<deterministic 8-hex FNV-1a suffix>` seeded on row
  identity (byte-stable for fixed inputs - the cast tours' fixed ISO clocks
  produce byte-identical rows across reseeds; matrix/live rows are functions of
  the injected `now`, so same now -> same rows).
- Dedupe: entity-scoped supersede, same as the module's audit convention - a
  pre-existing `tours#<id>` row is dropped only for tourIds the generator emits
  rows for; foreign rows preserved verbatim. (Reseed idempotency: /__dev/reseed
  resets tables first in dev; the dedupe covers assembled-map duplicates.)
- Coverage: ALL tours in the assembled full map flow through - cast.ts
  (fixed clocks), matrix.ts buildToursMatrix (now-relative), and live.ts
  (seedLive already calls historyItems over its staticItems, so live tours get
  trails with no live.ts change - verify, do not assume).
- FULL profile only (historyItems is only invoked there); the lean profile
  stays byte-identical - the e2e world is the regression gate.

## 5. Deliberate scope choices (documented, not accidents)

- tours#-ONLY: the runtime recordTourEvent triple-writes (tenant activity_events
  + units#<unitId> + tours#<tourId>). The seed ALREADY covers the tenant
  activity milestones (historyItems tourMilestones) and deliberately does NOT
  add tour rows to units# in this change - the property Activity card has
  listing_status content, and the mission scope is the tour page's empty
  surfaces. If full triple-write fidelity is wanted later, it is a follow-up.
- The new tours# instants MUST agree with the existing tourMilestones instants
  (booking = createdAt, took place = scheduledAt) so the tenant timeline and
  the tour trail tell one same-clock story.
- Archive posture: these rows describe actions the API never ran - same stance
  as seeded reminder rows carrying sentAt directly.
- No new tables/GSIs/schema/infra. No lean changes. No dashboard changes (the
  renderer already labels all 8 types).

## 6. Tests (TDD - failing first)

Extend the seed guard suites (mimic seedMatrixCoherence.test.ts /
seedRosterShape.test.ts conventions; DB-free over the in-memory map, plus the
existing DB round-trip where cheap):

- Every seeded NON-requested tour (cast + matrix + live-shaped fixtures) has a
  non-empty tours# trail; every REQUESTED tour has ZERO tours# rows.
- Every generated row's type is a key of the dashboard TOUR_EVENT_LABELS map
  (import the literal list into the test as a pinned mirror - the dashboard
  module is not importable from app tests; a drift test pins the 8 types).
- Sequence coherence per status (section 3 exactly), incl. closed -> took_place,
  outcome/group/converted appendices, and payload shapes ({ tourId } baseline;
  conversationId on group_opened; placementId on converted; NO actor).
- Timestamp coherence: booking in [createdAt, scheduledAt); took_place/no_show
  == scheduledAt; canceled <= scheduledAt; monotonic sequence; all instants <=
  now for matrix/live fixtures.
- Byte-stability: tourTrail over a fixed cast tour deep-equals itself across
  two calls; matrixItems(fixedNow) still deep-equals across two calls with the
  trails included.
- Alignment: for a tour with both, the tours# booking/took-place instants equal
  the tourMilestones activity instants.
- Lean untouched: existing seedData contract green UNCHANGED.

## 7. Gates + self-QA

- Bare, real exit codes, from the worktree: npm run typecheck; npm test;
  npm run e2e (playwright ONLY from the e2e/ workspace directory - a repo-root
  run silently targets the live dev stack at :5174).
- Live self-QA on a hermetic lane (e2e:session + reseed?profile=full): open a
  seeded SCHEDULED tour and a seeded TOURED or CANCELED tour; lifecycle pins
  render in ALL THREE panes; the Activity card counts them; All|Comms toggle
  now does something; a REQUESTED tour still shows comms-only (correct).
  Screenshots for the report.
- Merge latest main into the branch before declaring done; re-run all gates.
  Do NOT merge to main (Cameron's explicit go required).
