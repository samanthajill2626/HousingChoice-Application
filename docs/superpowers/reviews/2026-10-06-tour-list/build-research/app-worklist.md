# Tour list - build research, app side: drift worklist for plan S1-S7

Reader: app build-research reader (read-only), 2026-10-06.
Plan: `docs/superpowers/plans/2026-10-06-tour-list.md` (v3), sections 0-2,
S1-S7, 16. Tree: `feat/tour-list` @ b3ac0306. Its app/, dashboard/ and e2e/
are byte-identical to main @d839494a (`git diff --stat d839494a HEAD` is empty
there); main's two later commits (13b64f60, a5eabcb3) touch only dashboard
CSS, one dashboard component, one e2e spec and docs - no S1-S7 file.

Byte-exact quotations for every citation: `.superpowers/sdd/build-research/app-reference.md`
(gitignored).

## How the GREEN code was checked (no worktree edits, no test runs)

- Compile: `app/src` + `app/test/helpers` were COPIED to the session
  scratchpad, the plan's S1-S7 GREEN blocks were applied to the copy by a
  script reading the plan's fenced blocks, and `tsc` ran with the repo's
  strict + noUncheckedIndexedAccess + NodeNext options against the worktree's
  real `@aws-sdk/lib-dynamodb` / express types. Result: NO new error versus
  the unmodified copy; planted errors in all six new/edited files and in the
  harness literal were caught, so the check covered them.
- Lint: the repo's app eslint rules (typescript-eslint recommended, the `_`
  no-unused-vars options, the readFileSync ban) on the seven touched files:
  exit 0 (a planted unused const was caught).
- RED vs GREEN: a scratch tsx script encoding Task 4.1 cases 1-8, 4.2 cases
  1-10, 4.3 cases 1-5, Task 6.1 cases 1-12 (engine over
  `queryListPhaseFromItems`) and the fake's out-of-bounds rejection: every
  case agrees with the GREEN code.

So nothing below is "the plan's code does not compile". The corrections are
about the TEST instructions, citations, sequencing and house rules.

Severity tags: [BREAKS] = following the plan literally breaks a build, a gate
or a test; [PRECISION] = citation or instruction detail; [DECIDE] = an
orchestrator call; [ASCII] = a touched line holds non-ASCII today.

Totals: 20 numbered items - 7 [BREAKS] (1, 6, 10, 11, 13, 14, 16), 9
[PRECISION] (2, 3, 4, 5, 7, 9, 17, 18, 19), 1 [DECIDE] (8 = G2), 1 [GAP]
(15 = G1), 1 [ASCII] (20), 1 optional (12); plus gaps G1-G7 below.

---

## Task 1.1 - listByScheduledRange walks every page

Anchors verified: ToursRepo method doc + signature `toursRepo.ts:202-206`
(signature :206); implementation :399-416; `queryAll` import :34, signature
`queryAll<T>(doc, input, opts?)` at `dynamoPaging.ts:29-33`, 100-page cap
`DEFAULT_MAX_PAGES` :20 with its own WARN :51-59; factory locals `doc` :322,
`table` :323, `log` :324; harness fake `listByScheduledRange(from, to)`
`twilioWebhookHarness.ts:3507-3513` (stays valid with the optional third
parameter - scratch tsc). `QueryCommand` / `QueryCommandInput` stay used by
listByStatus (:424, :432) after the rewrite.

1. [BREAKS] `app/test/toursRepo.integration.test.ts:10` imports only
   afterAll, beforeAll, describe, expect, it - no `vi` (vitest `globals` is
   off in `app/vitest.config.ts`), and :11 imports GetCommand, UpdateCommand,
   type DynamoDBDocumentClient - no QueryCommand. As written,
   `vi.spyOn(doc, 'send')` is a ReferenceError and a typecheck error. Fix:
   use the file's own idiom at :549-558 - a spying doc whose `send` records
   then forwards to the shared `doc`, and a second repo
   `createToursRepo({ doc: spyingDoc, env: testEnv, logger })` - counting
   `command instanceof QueryCommand && command.input.IndexName === 'byScheduledAt'`
   (add QueryCommand to the :11 import). No `vi`, nothing to restore;
   queryAll sends through the repo's doc, so the wrapper sees every page.
   (Or add `vi` to :10 and restore the spy in a finally.)
2. [PRECISION] "the file already writes 2026-07 to 2026-10 dates" - it writes
   2026-07 through 2026-11 (2026-11-01..05 at :466, :480, :499, :517, :545)
   and reads 2026-01-01..2026-12-31 (:336-337) besides all time (:125). The
   March 2027 window is still clear of every other case; keep all eight new
   rows `scheduled` and outside 2026.

## Task 1.2 - Today's stale tours_today cap warning

Anchors verified: `today.ts:550` (the read), `:551` (the warnIfCapped line to
delete); warnIfCapped :412-416 logs `{ group, count }` with msg
'today: group fetch hit the cap - results truncated' (so the plan's
`includes('hit the cap') && l['group'] === 'tours_today'` filter matches);
GROUP_FETCH_LIMIT :174 stays used (:438-439, :484-485, :592-593, :872-900,
:955-956). `todayApi.test.ts`: cap filter :1165-1169, `let harness` :31,
beforeEach :33-38, `seedTour` :112-126, `todayYmd` :104, `getItems` :128.

3. [PRECISION] Seed through the file's `seedTour` helper (world.toursRepo.create
   with unitId 'unit-1', tourType 'self_guided') and keep all 100 instants
   inside today's UTC day, e.g. `${todayYmd()}T10:00:00.000Z` plus i minutes
   for i < 100 (ends 11:39) - with no query string the route uses the UTC-day
   fallback window. No test asserts that the tours_today warning fires
   (git grep), so the deletion breaks nothing.

## Task 2.1 - stamp _schedPartition on the four unstamped seed rows

Anchors verified: `cast.ts` TOUR_SEARCHING object :548-561 (`status: 'requested',`
:552), TOUR_TOURED object :799-817 (`status: 'toured',` :803, scheduledAt
:805), castItems tours :1560-1563; `matrix.ts` loop :930, dated rows already
stamped :998; `live.ts` stamps :366, :378, :391 (builder :102 unexported);
`performance.ts:655` stamps; `seed/index.ts` seedAll :110-160 with the raw
PutCommand at :153; `seedRosterShape.test.ts` imports :16-19, FIXED_NOW :22,
PROFILES :27-31 (SEED = lean, castItems(), matrixItems(FIXED_NOW)); lean SEED
has no `tours` key; `seedMatrixCoherence.test.ts` TOURS = matrixItems(NOW)
tours :32-34, the case :410-417 with the absence assertion on :415;
`seedLive.test.ts` case :495-510 (GetCommand read :499-502, existence
assertion :503, pointer assertion :506 - add the new assertion beside :506).

4. [PRECISION] The matrix requested branch is `matrix.ts:940-947` and the
   object literal is on :943 (plan says :940-946). Only
   `seedMatrixCoherence.test.ts:415` asserts the absence (git grep
   `_schedPartition` over app/test); no snapshot or hash pins seed rows.

## Task 3.1 - unitsRepo.getDisplaysByIds and its fake

Anchors verified: `createUnitsRepo` :433 with locals `doc` :434, `table` :435,
`log` :436 (the plan's names - no adaptation needed); lib-dynamodb import
:19-27 holds GetCommand, PutCommand, QueryCommand, QueryCommandInput,
ScanCommand, ScanCommandInput, UpdateCommand (no BatchGetCommand - the plan
adds it); `UnitItem.address?: Address` :165; interface :330-431 (last member
`list` :430); implementation's last method `list` :930-948; model walk
`contactsRepo.ts:849-892` (projection :895-904, interface :636, impl
:1116-1118); `ContactDisplayItem` :311-317 (firstName?/lastName? unknown,
phone?: string, deleted_at?: string); RepoDeps `{ doc?, env?, logger? }`
`conversationsRepo.ts:530-536`; `tableName` = TABLE_PREFIX + base
(`config.ts:512-514`), so the stub's table key is 'hc-test-x-units'; harness
`units` Map :2688 and `const unitsRepo: UnitsRepo` :2690.

5. [PRECISION] `app/test/unitsRepo.integration.test.ts` EXISTS. RED 2 goes
   into its DynamoDB Local describe (:64; repo built at :69 as
   `createUnitsRepo({ doc, env: testEnv, logger })`; one shared table, which
   by-id reads do not care about). `units.create` needs `landlordId` and
   `status` (CreateUnitInput :328); the soft delete is
   `units.softDelete(unitId, at)` (interface :346, impl :614-628 - stamps
   `deleted_at` and `updated_at`). No new integration file.
6. [BREAKS] RED 1's stub must be cast to the client type - a bare `{ send }`
   object fails `npm run typecheck` (RepoDeps.doc is DynamoDBDocumentClient).
   House forms: `as unknown as DynamoDBDocumentClient`
   (`contactsBatchIncomplete.test.ts:54-82`, the closest precedent: same
   withhold-and-retry stub shape) or `unitsRepo.integration.test.ts:53`.
7. [PRECISION] With the GREEN code, a chunk whose send THROWS logs TWO warns:
   'units: BatchGet chunk failed - keys dropped' and then, because its keys
   count as unprocessed, 'units: BatchGet left keys unprocessed after
   retries'. Assert each by msg; never assert a total of one WARN. The
   real-timer backoff costs 25+50+100 ms per fully withheld chunk.
8. [DECIDE] Placement versus the parallel branch - see G2.

## Tasks 4.1-4.3 - tourListQuery.ts

Anchors verified: `toursModel.ts` TOUR_STATUSES :42-49, TourStatus :51
(literal union), `isTourStatus(x: unknown): x is TourStatus` :65-67,
TOUR_TYPES :112, TourType :114, `isTourType` :125-127 - exactly the names
the GREEN imports. Beware `toursRepo.ts:52` exports a DIFFERENT
`type TourStatus = string`; keep importing from toursModel as the plan does.
No corrections (compiles; every RED case agrees with the GREEN code).

## Task 5.1 - toursRepo.queryListPhase

Anchors verified: ToursRepo interface ends `toursRepo.ts:314-315` (reopenIf),
the returned object ends :820-821; QueryCommand imported :28; create honors an
explicit `tourId` (:357), `createdAt` (:347) and `status` (:359 - caller
status wins), always stamps `_schedPartition` (:358) and omits an absent
scheduledAt (:363); patch accepts `{ status }` and `{ scheduledAt }`
(PatchTourInput :168-170 collapses to the index signature, :126-129);
`import type { TourListPhase }` creates no cycle (tourListQuery imports only
toursModel and node:crypto). GSIs `tables.ts:536-549`: byScheduledAt hash
`_schedPartition` range `scheduledAt` (sparse), byStatus hash `status` range
`createdAt`.

9. [PRECISION] "copy the main describe's setup at :1-54" - only :39-54 is
   per-describe (describe.skipIf, testEnv, client, doc, logger, repo,
   beforeAll ensureTable, afterAll delete + destroy). :1-37 (imports,
   endpointReachable, `reachable`) is module level; duplicating it is a
   duplicate-identifier error.
10. [BREAKS - silently] Write every fixture instant in canonical
    toISOString form (`2028-01-01T10:00:00.000Z`, not the plan's shorthand
    `2028-01-01T10:00Z`). The repo stores scheduledAt RAW (create :363 never
    canonicalizes; only POST `tours.ts:314` and PATCH :1135-1137 do), while
    every bound, pinned instant and cursor value is canonical: a short-form
    row sorts after a canonical value of the same minute (':' 0x3A < 'Z'
    0x5A), so range cases would pick the wrong subset. Same rule for the
    harness rows in Task 7.1.
11. [BREAKS - typecheck between commits] Adding queryListPhase to the
    interface in 5.1 makes `npm run typecheck` fail at the harness literal
    (`twilioWebhookHarness.ts:3470`, missing property) until 5.2 adds it.
    Either move the harness line (and the fake helper it calls) into 5.1's
    commit, or accept one red typecheck between the two commits (vitest is
    unaffected). Task 3.1 already keeps interface + fake in one task.
12. [optional] The undated toured fixture can be created directly:
    `tours.create({ ..., status: 'toured', createdAt })` with no scheduledAt.
    The plan's create-then-patch also works.

## Task 5.2 - the shared fake, the harness fake, the mirror

Anchors verified: harness `toursMap` :3462, `const toursRepo: ToursRepo`
:3470, listByStatus :3514-3519 (put queryListPhase after it), helper imports
:217-220; house mirror `unreadIndexFakeMirror.integration.test.ts`
(prefix :102); house fakes `unreadIndexFake.ts`, `contactsPartitionFake.ts`.

13. [BREAKS] The harness needs
    `import { queryListPhaseFromItems } from './tourListIndexFake.js';`
    (beside :220). The plan shows only the method line.
14. [BREAKS - npm test, if the prefix is fixed] The new mirror file creates
    container tables, so its TABLE_PREFIX must carry randomUUID:
    `dynamoAccessKeyGuard.test.ts:347-395` fails any unmarked table-creating
    suite without a per-run random component. Use
    `hc-test-<name>-${randomUUID().slice(0, 8)}-` as the house mirror does.
    No marker; the per-file database is automatic
    (`setup/dynamoAccessKey.ts:43-54, 110-123`).
15. [GAP] No tie guard - see G1.

## Task 6.1 - listTourPage

Pure. No corrections; cases 1-12 agree with the GREEN engine on the shared
fake (scratch run).

## Task 6.2 - the engine over DynamoDB Local

Same setup rules as 5.1 (items 9 and 10). See G5 for one cheap assertion
spec 9 asks for on DynamoDB Local.

## Task 7.1 - GET /api/tours/list

Anchors verified: `createToursRouter` `tours.ts:231`; locals `log` (deps.logger)
:232, `tours` :234, `contacts` :241, `units` :242, `getNow` :249
(`deps.now ?? (() => new Date().toISOString())`); `now` dep doc :224-228;
GET '/' :367-403 (its comment :363-366); GET '/:tourId' :406 (comment :405);
`type TourItem` already imported :63 (add the new imports after it); header
route table :5-12. Mount
`api.ts:938-960` forwards logger, toursRepo, `now: deps.toursNow` (:945),
contactsRepo, unitsRepo. Harness: `toursNow` option :5003, forwarded :5176;
world.toursRepo passed by reference :5151; app logger is the capture stream
at level info (:5119). `authed(app)` `toursApi.test.ts:48-59`;
`world.contacts: ContactItem[]` (contactId + type required),
`world.units: Map<string, UnitItem>` (unitId, landlordId, status required);
the harness contacts fake projects the display fields (:2151-2157,
getDisplaysByIds :2187-2193). Express 5.2.1 forwards async rejections to
`createExpressErrorHandler` (`errors.ts:171-201`).

16. [BREAKS - test 10] The 'tours list page' line also carries the logger
    mixin's request context (`logger.ts:245-250`): requestId
    (`correlation.ts:15`), userId (`auth.ts:213`), correlationId, and
    traceparent only when the request sends one. "keys are a subset of
    [counts, when, ...pino standard keys]" fails if "standard" is read as
    level/time/pid/hostname/msg (the `aiRunsRepo.test.ts:984-987` idiom,
    which has no request context). Allowed set: level, time, pid, hostname,
    msg, requestId, userId, correlationId, traceparent, returned, evaluated,
    calls, phases, when. The no-id check still holds (userId is the session
    user, not a fixture id).
17. [PRECISION] `harness.capture.atLevel(n)` keeps lines whose level EQUALS
    n (`logCapture.ts:35-37`) though its doc says "at or above" (:10). Use
    atLevel(30) for the info line, or filter `capture.lines` by msg.
18. [PRECISION] Test 9 without a cursor: 500 with body
    `{ error: 'internal server error' }` (`errors.ts:200`) and one level-50
    line 'unhandled error while handling request: GET /api/tours/list'.
    `toursApi.test.ts:11` imports no `vi`: add it for
    `vi.spyOn(world.toursRepo, 'queryListPhase')`, or assign the method
    directly - the route calls through the same object at request time (its
    arrow wrapper; harness :5151 -> api.ts:943).
19. [PRECISION] Test 2's "does NOT have roster / currentLadderId /
    conversionClaimedAt" can fail only if some fixture tour HAS them - set
    them in the world.toursRepo.create input (CreateTourInput is
    Partial<TourItem> & ...). `_schedPartition` is always present on harness
    rows (:3479).
20. [ASCII] `tours.ts:225` - the `now` doc comment line the plan widens -
    holds an em dash; the rewritten line must be ASCII. The new header-table
    line sits among non-ASCII neighbors (:5, :6, :8, :10, :11 carry arrows)
    and the new route lands just above :405 (em dash) - leave those lines
    untouched.

Notes (no action): `convertedPlacementId` is not a declared TourItem field
(index signature, `unknown`); toTourListRow copies it as unknown and compiles.
The S7 preamble's "narrows spec 5.4's 'injectable through the router's deps'"
is stale wording - spec 5.4 already says "injectable into the paging engine".

---

## Still-compiles checklist (S3 and S5 interface additions)

Must gain the new method (typecheck fails otherwise):

| interface | implementation | file:line | plan task |
|---|---|---|---|
| UnitsRepo.getDisplaysByIds | createUnitsRepo | app/src/repos/unitsRepo.ts:433 | 3.1 |
| UnitsRepo.getDisplaysByIds | harness literal | app/test/helpers/twilioWebhookHarness.ts:2690 | 3.1 |
| ToursRepo.queryListPhase | createToursRepo | app/src/repos/toursRepo.ts:321 | 5.1 |
| ToursRepo.queryListPhase | harness literal | app/test/helpers/twilioWebhookHarness.ts:3470 | 5.2 (see item 11) |

Compile unchanged (verified by grep + reading; src and test/helpers also by
the scratch tsc):

| site | file:line | why safe |
|---|---|---|
| makeFakeUnitsRepo | app/test/placementNudges.test.ts:176-183 | `as unknown as UnitsRepo` |
| `{ ...tours, get }` | app/test/tourReminders.test.ts:5607-5611 | spreads a real repo |
| RelayComposeDeps | app/src/jobs/relayFanOut.ts:371, :373 | Pick<ToursRepo,'get'>, Pick<UnitsRepo,'getById'> |
| literals into RelayComposeDeps | app/test/relayFanOut.test.ts:3101, :3106, :3213, :3230, :3237, :3246, :3256 | Pick-typed |
| personEvents deps | app/src/lib/personEvents.ts:56; app/test/personEvents.test.ts:50 | Pick<UnitsRepo,'getById'> |
| roster resolution deps | app/src/lib/rosterResolution.ts:133, :156; app/test/rosterResolution.test.ts:57 | Pick-typed |
| fake-parity params | app/test/toursRepoFakeConditions.test.ts:167, :346, :426 | parameter types only |
| FakeWorld fields | twilioWebhookHarness.ts:390, :432 | field types |
| deps fields (UnitsRepo) | broadcastFanOut.ts:289, placementNudges.ts:249, relayFanOut.ts:708, rosterActions.ts:72, tourAutoClose.ts:49, tourReminders.ts:708, api.ts:345, broadcasts.ts:84, contactTimeline.ts:144/806, routes/placementNudges.ts:90, placements.ts:123, public.ts:155, relayGroups.ts:134, routes/statusTransition.ts:51, routes/tourReminders.ts:109, tours.ts:218, units.ts:76, rosterProvision.ts:70, services/statusTransition.ts:59 | declarations, no literal |
| deps fields (ToursRepo) | relayFanOut.ts:709, rosterActions.ts:89, tourAutoClose.ts:46, tourReminders.ts:684, api.ts:351, contactTimeline.ts:160/802, contacts.ts:126, placements.ts:127, relayGroups.ts:130, today.ts:140, routes/tourReminders.ts:95, tours.ts:207, units.ts:94, rosterProvision.ts:79 | declarations, no literal |

No ToursRepo/UnitsRepo implementer exists in dashboard/, e2e/, fake-twilio/
or scripts.

---

## Invariant sweep

### Writers of a tour row (app/src), and whether each writes scheduledAt / _schedPartition

| writer | file:line | scheduledAt | _schedPartition |
|---|---|---|---|
| repo create | toursRepo.ts:345-375 | optional, stored RAW (:363) | always 'tours' (:358) |
| repo patch | toursRepo.ts:439-492 | SET when supplied; explicit null REMOVEs | never (type-omitted :168-170) |
| repo autoCloseIf | toursRepo.ts:685-765 | no (conditions on it :717-722) | no |
| repo reopenIf | toursRepo.ts:767-820 | no | no |
| repo claim/release/setLadderIdIf/setRoster/clearRoster | toursRepo.ts:494-683 | no | no |
| POST /api/tours | tours.ts:265-361 (create :309, canonical :314; pointer patch :334) | yes, canonical | via create |
| PATCH /api/tours/:id | tours.ts:986+ (patch :1234; canonical :1135-1137; booking/revival advance :1139-1149; null refused by isValidIso :1014-1016); setLadderIdIf :1306 | yes, canonical | no |
| POST /:tourId/reopen | tours.ts:1482+ (reopenIf :1504) | no | no |
| roster plan edits | tours.ts:607-608, :717 | no | no |
| auto-close job | jobs/tourAutoClose.ts:98 (autoCloseIf) | no | no |
| conversion | routes/placements.ts:716, :750, :771-775 (status closed, convertedPlacementId, currentLadderId), :778 | no | no |
| roster provision | services/rosterProvision.ts:335, :364, :398 (groupThreadId), :401, :424 | no | no |
| seed cast | lib/seed/cast.ts:548-561 (requested, undated), :799-817 (toured, dated :805) | as listed | MISSING on both (S2 adds) |
| seed matrix | lib/seed/matrix.ts:943 (requested x2, undated), :988-999 (dated) | dated rows only | MISSING on :943 (S2 adds); dated :998 |
| seed live | lib/seed/live.ts:357-396 (3 scheduled); re-Put :516-523 | yes | yes :366, :378, :391 |
| seed performance | lib/seed/performance.ts:637-668 (written by lib/performanceSeed.ts:219) | unless requested (:658) | always :655 |
| seed lean | lib/seed/lean.ts | no tours table | - |
| seed writer / reseeds | seed/index.ts:110-160 (raw Put :153); dev reseed routes/dev.ts:327 -> devReset.ts:107; app/scripts/db-seed.ts:27 | as the rows | as the rows |

No other writer: tourRemindersRepo only ConditionChecks the tours table
(`tourRemindersRepo.ts:265-268`, :526); app/scripts writes no tour row
(retire-paused-tour-reminders.ts writes the reminders table); the importer
skips Tours (`lib/import/airtableSource.ts:189-196`); e2e creates tours only
through POST /api/tours; the dev router only runs jobs. Every stored
scheduledAt is canonical: the routes canonicalize (since f76a9774, the day
after the route landed), and every seed uses toISOString or canonical
literals (live :108-120, performance `at()` :529-531, matrix `iso()`).

### Readers of byScheduledAt / byStatus / _schedPartition

| reader | file:line | index |
|---|---|---|
| listByScheduledRange | toursRepo.ts:399-416 (S1 -> queryAll) | byScheduledAt |
| GET /api/tours?from&to | tours.ts:379-387 | via listByScheduledRange |
| Today tours_today | routes/today.ts:550 | via listByScheduledRange |
| perf seed integration | app/test/performanceSeed.integration.test.ts:301 | via listByScheduledRange |
| listByStatus | toursRepo.ts:418-437 | byStatus |
| GET /api/tours?status= | tours.ts:388-394 | via listByStatus |
| auto-close candidates | jobs/tourAutoClose.ts:77 | via listByStatus (scheduled, toured, no_show) |
| NEW queryListPhase | toursRepo.ts (S5) | D: byScheduledAt, U: byStatus |
| index definitions | lib/tables.ts:536-549 | both |
| harness fakes | twilioWebhookHarness.ts:3507-3513 (scheduledAt only - see G4), :3514-3519 | both |
| dashboard, via the routes | useTours.ts:69-72 (Active: from/to + status=requested); Past, Closed, useToday fallback, usePastTours; e2e/performance/selfQa.ts:176 | via GET /api/tours |

No app/src or script code reads `_schedPartition` besides the repo's key
condition (`toursRepo.ts:405`) and the index definition.

### Spec section 8 - confirmed, with three small corrections

- I1 writers: complete for status and scheduledAt. `rosterProvision.ts:398`
  writes only groupThreadId (harmless inclusion).
- I1 readers: complete for this feature. Unaffected scheduledAt-presence
  readers elsewhere (arming, relay intro, the auto-close clock) need nothing.
- I2: writers complete (create stamps since the first commit 1acb89a4; PATCH
  never stamps; seeds fixed by S2). Readers: add `jobs/tourAutoClose.ts:77`
  and `tours.ts:388-394` only as byStatus readers (not I2-relevant).

---

## Gaps and risks

- G1 [GAP, LOW] The shared fake has no tie guard. House rule
  (`unreadIndexFake.ts:120-170`; plan research summary item 4): a resume key
  inside a range-key tie THROWS unless the caller opts in, because DynamoDB
  orders ties opaquely. tourListIndexFake only documents it. Harness rows made
  without an explicit createdAt take `new Date().toISOString()` (harness
  :3481), so two creates in one millisecond tie on byStatus. Add the guard:
  throw a PLAIN Error (not ValidationException-named, so a route test sees a
  500, not a misleading 400 'invalid cursor') unless `allowTieResume` is set.
- G2 [DECIDE, LOW] The parallel branch's plan (feat/clean-org-names, read
  with `git show`; that worktree untouched) adds `rewriteAcceptedAuthorities`
  at the SAME three points this plan uses: right after `list(...)` at the end
  of the UnitsRepo interface (its anchor :430-433), at the end of the
  implementation (:947-952) and after the harness `list` (:2862-2868). Both
  branches inserting there is a guaranteed conflict whichever merges second.
  Placing `getDisplaysByIds` right after `getById` instead (interface :333,
  impl :561-564, harness :2709-2711) removes the overlap entirely; it departs
  from section 0's "end of the interface" wording. That branch has no code
  commits yet (docs only); its plan also exports `buildLiveStaticItems`
  (live.ts:102), which would let the S2 pure pin cover the live rows later.
- G3 [SEQUENCING] Item 11 - the 5.1/5.2 commit boundary leaves typecheck red.
- G4 [KNOWN DIVERGENCE, out of scope] The harness listByScheduledRange
  (:3507-3513) admits any row with a scheduledAt, ignoring
  `_schedPartition`; DynamoDB needs both. Inert while every writer stamps
  (after S2, all do); the new shared fake already models both.
- G5 [COVERAGE, LOW] Spec 9 lists "an unfiltered page reads at most one row
  past the ones it returns, and an unfiltered final page that ends exactly on
  the last row answers nextCursor: null" under the DynamoDB Local tests. The
  plan proves it on the fake (Task 6.1 cases 1-2, pinned by the mirror); Task
  6.2 could also assert `evaluated <= returned + 1` on its unfiltered-D pages
  for free.
- G6 [INFO] Every stored scheduledAt in every environment is canonical
  (routes canonicalize; seeds use toISOString), which phase D's string range
  conditions and the canonical pinned instant rely on. Item 10 is the one
  place a test could break that.
- G7 [ASCII] Header comment lines that already hold non-ASCII, if a task
  extends a header's coverage list: `toursApi.test.ts:1, 3-7`,
  `todayApi.test.ts:1, 6, 10`, `toursRepo.integration.test.ts:1, 3, 34`,
  `unitsRepo.integration.test.ts:1`, `seedLive.test.ts:1, 7, 9`,
  `seedMatrixCoherence.test.ts:6-7`. Near insertion points, also non-ASCII
  (leave untouched): `today.ts:554`, `cast.ts:547`, `unitsRepo.ts:427, 931-932`,
  `toursRepo.ts:209`, harness :2685, :3458, :3461, :3473. Every line of the
  plan's S1-S7 text is ASCII.
