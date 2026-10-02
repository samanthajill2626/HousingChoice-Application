# Slice report - S3 (activity types + shared tour-event writer) and S4 (staff PATCH)

- Date: 2026-10-02. Implementer: Claude Opus 5.5 (child of the build
  orchestrator). Branch `feat/tour-auto-close`, worktree `W:\tmp\tour-auto-close`,
  starting HEAD b0138a36 (S1-S2 report commit).
- Sources followed: plan sections 0, 1, S3 (Tasks 3.1, 3.2), S4 (Tasks 4.2,
  4.3); spec 5.2, 5.3, 8, 10.1, 12; the S1-S2 contracts
  (`slices/s1-s2-report.md` section 6); the binding corrections in
  `research/drift-s3-s7-routes-jobs.md` (1, 2, 4, 5, 11, 14 + Confirmations)
  and the orchestrator rulings F4, D-c, D-d in `research/worklist.md`.
- Scope held: only the seven files the brief allowed were touched (listed
  under "Files"). No spec, plan or other docs edits besides this report.

## 1. Commits

| hash | task | one-liner |
|---|---|---|
| 377a67e8 | 3.1 | feat(tours): tour_auto_closed and tour_reopened activity types |
| 6e018720 | 3.2 | refactor(tours): extract recordTourEvent into lib/tourEvents.ts |
| 85c332da | 4.2 | feat(tours): PATCH status precondition - consistent read, 409 tour_changed |
| 95ea9e7d | 4.3 | feat(tours): PATCH stamps lastMarkedAt on a status change or a new time |
| (this) | records | docs(records): this report |

Every commit: bare `git status` read first in its own call, MERGE_HEAD
checked absent (`git rev-parse --git-path MERGE_HEAD`; `.git` is a file in
a worktree), explicit paths staged, ASCII message, `Co-Authored-By: Claude
Opus 5.5` trailer, committed through Bash with a heredoc. No survivor-pin
commit was needed (section 6).

Files: `app/src/repos/activityEventsRepo.ts` (union only),
`dashboard/src/api/types.ts` (union + the unit-activity doc comment only),
`app/src/routes/tours.ts`, `app/src/routes/units.ts` (doc comment only), new
`app/src/lib/tourEvents.ts`, new `app/test/tourEvents.test.ts`,
`app/test/toursApi.test.ts`.

## 2. Per task: RED reason, GREEN result

Baseline before any edit: toursApi 205 passed; `npx eslint` on the files to
be touched exit 0.

| task | RED (run, confirmed reason) | GREEN |
|---|---|---|
| 3.1 | none by plan design (declarations + doc comments only); typecheck is the gate | typecheck exit 0 |
| 3.2 | tourEvents suite failed to load: `Cannot find module '../src/lib/tourEvents.js'` (the writer did not exist yet) | tourEvents 6 + toursApi 205 UNCHANGED = 211 passed |
| 4.2 | 3 failed, 1 PIN passed: the sweep race `expected 200 to be 409` (the PATCH merged onto the closed tour); the opts capture `expected [ undefined, undefined, undefined ]`; the staff race `expected 200 to be 409`. The 404 PIN passed on unchanged code. | toursApi 209 + tourEvents 6 = 215 passed |
| 4.3 | 5 failed, every one `expected undefined to be '2026-07-10T12:00:00.000Z'` (no stamp; the two "unchanged" cases fail at their earlier toured mark) | toursApi 214 + tourEvents 6 = 220 passed |

App test files run after Task 4.2 (every file `grep -l "api/tours" test/*.ts`
lists, plus placementConvert.test.ts, which wraps `toursRepo.patch`, and the
new file) - 10 files, 504 passed, exit 0:

| file | tests |
|---|---|
| devGating.test.ts | 41 |
| phone.test.ts | 15 |
| placementsApi.test.ts | 56 |
| scheduledUpdatedEvent.test.ts | 7 |
| tourRemindersApi.test.ts | 69 |
| toursApi.test.ts | 209 |
| toursRepo.integration.test.ts | 54 |
| toursRepoFakeConditions.test.ts | 28 |
| placementConvert.test.ts | 19 |
| tourEvents.test.ts | 6 |

The same 10 files after Task 4.3: 509 passed (toursApi 214). Final run on
the clean tree after the mutant check, the same list plus
personEvents.test.ts (3): 11 files, 512 passed, exit 0. No `[dynamoAdmin]`
line appeared in any run. No existing test turned red under the
precondition or the stamp (drift #1's prediction held).

## 3. Gates run (scope: touched files + typecheck, per the brief)

- `npm run typecheck`: exit 0 after 3.1, 3.2, 4.2, 4.3 and on the final
  committed state (covers the dashboard union edit and the test tsconfig).
- `npx eslint app/src/repos/activityEventsRepo.ts dashboard/src/api/types.ts
  app/src/routes/tours.ts app/src/routes/units.ts app/src/lib/tourEvents.ts
  app/test/tourEvents.test.ts app/test/toursApi.test.ts`: exit 0 (also exit 0
  per task on that task's files).
- ASCII: after every edit `git diff -U0 -- <file> | grep '^+' | grep -P
  '[^\x00-\x7F]'` printed nothing; the two new files have 0 non-ASCII bytes
  (`tr` check); a final scan of `git diff -U0 b0138a36..HEAD` added lines
  printed nothing. Untouched non-ASCII lines remain (tours.ts header
  :1/:5/:6/:8/:10/:11, the closed-terminal comment, units.ts :158/:164,
  dashboard types.ts :2897) - the ratchet allows them.
- NOT run (outside this brief): `npm test`, `npm run smoke`, `npm run e2e`.

## 4. Divergences from the plan, and why

Binding corrections applied:

1. D-c (Task 3.2): `TourEventDeps` re-declares `activityEvents:
   Pick<ActivityEventsRepo, 'record'>` as REQUIRED (PersonMilestoneDeps
   keeps it optional, drift #5 - nothing to export). Pinned at compile time:
   tourEvents.test.ts builds deps without it under `@ts-expect-error`, so
   making the field optional again fails `npm run typecheck` (TS2578, mutant
   e below).
2. Drift #4 (Task 3.2): the closure's 8-line comment AND the hoisted
   `async function recordTourEvent` were replaced by the plan's 2-line
   comment + delegating const. The `recordPersonMilestone` import (its only
   use was the old closure) was replaced IN PLACE by
   `import { recordTourEvent as recordTourEventShared } from '../lib/tourEvents.js';`
   (tours.ts:126). No other importer of either name exists in app/src
   (`seed/history.ts` only mentions "routes/tours.ts recordTourEvent" in
   comments - still true, the local name is kept; not touched, out of scope).
3. D-d + drift #1/#2 (Task 4.2): `opts` is forwarded at the two parked
   staff-PATCH wrappers only (now toursApi.test.ts:2307 and :2385); the
   create-path zero-argument stub (:2505) and the relay-stamp wrapper (:3565)
   are untouched; placementConvert.test.ts is untouched (optional per D-d and
   not in the brief's file list). Every new wrapper / recorder is installed
   only AFTER the create resolves (POST /api/tours calls `tours.patch` for
   its ladder pointer; the past-dated create in the race case does arm
   booked_too_late rows - asserted > 0).
4. F4 (Task 4.3): the stamp condition is exactly
   `(patch['status'] !== undefined && patch['status'] !== currentStatus) ||
   patch['scheduledAt'] !== undefined`, placed after the patch is built
   (after the moveForward block) and before `effectiveStatus`; the plan's
   comment is kept and extended with the change test.
5. Drift #11 (Task 3.1): only ASCII lines were edited. units.ts :163 and
   dashboard types.ts :2901 (the last ASCII list line) lost their closing
   punctuation and one new ASCII line was added after each; tours.ts :446
   (activity route comment) was split into two ASCII lines. The non-ASCII
   neighbours were not touched.

Additions beyond the plan's case lists (all additive, no plan case dropped):

6. tourEvents.test.ts has 6 cases where the plan named 3 assertions: all
   three plan assertions are in case 1/3 (tenant AND landlord pins with
   type, label, refType, refId; `units#` and `tours#` rows with
   `event_type` and payload `{ tourId }` - asserted with `toEqual` on the
   whole audit list, so order and shape are pinned; `failAuditAppendFor`
   still resolves and still pins). Added: the activity-type / audit-type
   split (the reschedule shape), the two error log lines with the tourId and
   the label never logged, an independent `units#` guard (a failing
   `units#` append still writes `tours#` - the route suite cannot see this,
   mutant i), a failing timeline write still writes both audit rows, and the
   D-c compile-time pin. The unit is seeded with a copy of toursApi's local
   `seedUnitWithLandlord` (fixture ids `contact-tenant-1`, `unit-abc`,
   landlord `c-ll`, tour `tour-x`).
7. Task 4.2 has a 4th case beyond the plan's three: both reads are
   CONSISTENT (a `get` recorder sees `[{ consistentRead: true }, {
   consistentRead: true }]` - the guard read and the race re-read), and a
   race with ANOTHER PATCH (a person's cancel landing between read and
   write) is a 409 the same way, the other write standing. Without it the
   consistent-read half of spec 8.2 had no test (mutants f, g).
8. Task 4.2 case 1 asserts more than the plan: the exact 409 body, the
   refused PATCH's pointer rotation never landed (`currentLadderId` is still
   the sweep's `rot-race`), no reminder row was swept, no `tour_took_place`
   on any surface (activity AND audit), no `tour.updated` emit. The plan's
   case 3 is a recording wrapper (the file's idiom) rather than `vi.spyOn`,
   so the import line was not touched.
9. Task 4.3 "unchanged" cases (outcome-only exit gate, same-status
   restatement) mark the tour toured at MARK_1 through the route, move the
   injected clock to MARK_2, then PATCH - so they are RED on unstamped code
   and also kill an over-stamping mutant (c2).
10. The PATCH guard-read comment gained one sentence on WHY the read is
    consistent (its status is the write's precondition).

No STOP condition was hit: no unexpected importer, no import cycle
(tourEvents.ts imports types plus personEvents.ts, which imports types
only), no contract mismatch with the reference quotes or the S1-S2 report,
no unpredicted red in an existing test.

## 5. Observations for the orchestrator (no action taken)

- F4 refines STATUS only, per its text: a same-instant `scheduledAt`
  restatement (`{ scheduledAt: <the stored time> }` on a scheduled tour) is
  still `patch['scheduledAt'] !== undefined`, so it stamps and restarts the
  clock, although spec 5.2 says "changed ... time". Not pinned either way.
  A `scheduledAtIso !== current.scheduledAt` term would close it if wanted.
- `log.info({ fields: Object.keys(patch).length }, 'tour patched via api')`
  now counts `lastMarkedAt` when stamped. No test reads it.
- `TourEventDeps.audit` is the full `AuditRepo` (the plan's type), not a
  `Pick<..., 'append'>`: S5's deps must supply a full repo (world.auditRepo
  does).

## 6. Mutant check (applied with Edit, reverted with Edit; final `git diff --quiet` clean)

| id | mutant | result |
|---|---|---|
| a | precondition catch: `fresh === undefined` -> `fresh !== undefined` (404 / 409 branches swapped) | KILLED by 3: sweep race (`404` for `409`), the 404 PIN (`409` for `404`), staff race |
| b | main write `tours.patch(tourId, patch)` (third argument removed) | KILLED by 3: sweep race (`200`), opts capture (`[undefined x3]`), staff race (`200`) |
| c | stamp `patch['status'] !== currentStatus` -> `=== currentStatus` | KILLED by 3: status change, outcome-only, restatement (each at the toured mark) |
| d | tourEvents.ts: the `tours#` append block deleted | KILLED by 5 tourEvents + 10 toursApi tests (tours# trail + activity route) |
| c2 (extra) | stamp `patch['status'] !== undefined` alone (the plan's pre-F4 rule) | KILLED by 1: the same-status restatement case (`MARK_2` for `MARK_1`) |
| c3 (extra) | stamp without the `scheduledAt` term | KILLED by 1: the reschedule case |
| e (extra) | tourEvents.ts `activityEvents?:` (D-c undone) | KILLED by typecheck: `tourEvents.test.ts(154,5): error TS2578: Unused '@ts-expect-error' directive.` |
| f (extra) | guard read without `{ consistentRead: true }` | KILLED by 1: the consistent-read case |
| g (extra) | race re-read without `{ consistentRead: true }` | KILLED by 1: the consistent-read case |
| i (extra) | one shared try around both audit appends | KILLED by 2 tourEvents cases (toursApi alone does NOT catch it) |

Totals: 10 mutants (4 required + 6 extra), 10 killed, 0 survivors. Post
revert: all 11 files green (512), typecheck exit 0, eslint exit 0.

## 7. Contracts the downstream slices consume (final, as committed)

`app/src/lib/tourEvents.ts` (S5 and S6 call it):

```ts
import type { ActivityEventsRepo, ActivityEventType } from '../repos/activityEventsRepo.js'; // :8
import type { AuditRepo } from '../repos/auditRepo.js';                                      // :9
import type { Logger } from './logger.js';                                                   // :10
import { recordPersonMilestone, type PersonMilestoneDeps } from './personEvents.js';         // :11

export interface TourEventDeps extends PersonMilestoneDeps {          // :13
  activityEvents: Pick<ActivityEventsRepo, 'record'>;                 // :19 REQUIRED (D-c)
  audit: AuditRepo;                                                   // :20 full repo
  // inherited: units: Pick<UnitsRepo, 'getById'>; log: Logger;
}
export interface TourEventSubject { tenantId: string; unitId: string; tourId: string; } // :23
export async function recordTourEvent(                                // :29
  deps: TourEventDeps,
  tour: TourEventSubject,
  activityType: ActivityEventType,
  auditType: string,
  label: string,
): Promise<void>;
```

Behavior: (1) `recordPersonMilestone` - the tenant's pin, then the unit
landlord's (point-in-time `unit.landlordId`; skipped when absent, missing or
equal to the tenant), each best-effort; (2) `audit.append('units#<unitId>',
auditType, { tourId })`; (3) `audit.append('tours#<tourId>', auditType, {
tourId })` - (2) and (3) each in its own try, logging `<auditType> unit audit
failed (best-effort)` / `<auditType> tour audit failed (best-effort)` at
error with `{ err, tourId }`. Never throws; never logs the label. Rows are
stamped by the repos' own clocks (wall clock). S5 call:
`recordTourEvent({ activityEvents, units, audit, log }, tour, 'tour_auto_closed',
'tour_auto_closed', 'Tour closed automatically: no outcome recorded after two weeks')`.

Inside `app/src/routes/tours.ts` the delegating const keeps the old local
name - `recordTourEvent(tour, activityType, auditType, label)` at :253-259
(`recordTourEventShared({ activityEvents, units, audit, log }, ...)`), so
S6's reopen route can call `recordTourEvent(t, 'tour_reopened',
'tour_reopened', 'Tour reopened')` directly. Activity types
`'tour_auto_closed'` / `'tour_reopened'` are in `ActivityEventType`
(activityEventsRepo.ts :43-44) and `TimelineMilestoneType` (dashboard
types.ts :2507-2508).

The PATCH 409 (exact body, tours.ts :1240-1243):

```ts
res.status(409).json({
  error: 'tour_changed',
  detail: 'This tour changed while you were saving - reload and try again.',
});
```

The same exception's other branch answers 404 `{ error: 'tour_not_found' }`
when the consistent re-read finds no tour.

Anchors after S3-S4:

- `app/src/routes/tours.ts`: tourEvents import :126; delegating const
  :251-259; PATCH handler `router.patch('/:tourId'` :984; consistent guard
  read :1032 (comment :1029-1031); `currentStatus` :1038; `lastMarkedAt`
  stamp :1153-1163; `effectiveStatus` :1177; `let tour: TourItem` :1223,
  main write :1229, re-read :1235, 409 :1240-1243; `tour.updated` emit
  :1464; PATCH handler closes `});` at :1468. REOPEN ROUTE SLOT: insert after
  :1468 (blank :1469), before the relay comment at :1470 - that comment line
  carries a non-ASCII em dash, so ADD lines above it rather than editing it;
  `router.post('/:tourId/relay'` :1495. Header route-list lines :1-11
  unchanged (add a new ASCII line for the reopen route, drift #11).
- `app/test/toursApi.test.ts`: describe 'PATCH status precondition' :452
  (its wrappers :480, :516, :539, :575), describe 'PATCH stamps
  lastMarkedAt' :602; local `seedUnitWithLandlord` :937; describe
  'currentLadderId' :1908; parked staff-PATCH wrappers :2307 and :2385 (now
  forward opts), zero-arg create stub :2505, relay-stamp wrapper :3565
  (restored :3574). Every pre-existing line after :442 moved +241 (+151 from
  Task 4.2's describe, +90 from Task 4.3's).
- `app/test/helpers/twilioWebhookHarness.ts`: untouched in S3-S4 - fake
  `toursRepo` literal :3464, `patch` :3514, `autoCloseIf` :3623, `reopenIf`
  :3652, `deleteSupersededForTour` :3768 (as the S1-S2 report states).
