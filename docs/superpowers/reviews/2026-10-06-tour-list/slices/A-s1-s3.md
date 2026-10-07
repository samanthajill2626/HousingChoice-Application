# Slice A report - S1, S2, S3 (implementer A)

Implementer: Claude Opus 5.5, 2026-10-06. Worktree `W:\tmp\tour-list`, branch
`feat/tour-list`, started at HEAD 90b65a23, ended at 37b84a3a (plus this
report's commit). Inputs: plan v3 sections 0-2 and S1-S3,
`build-research/app-worklist.md` (Tasks 1.1, 1.2, 2.1, 3.1, the
still-compiles checklist, G7), `build-research/README.md` rulings A-1 and A-4,
spec 3.2, 3.6, 5.6, 7, 8.

Every task ran strict TDD: test written, run RED and read for the stated
reason, implementation, run GREEN, one commit. No `[dynamoAdmin]` line
appeared in any run. DynamoDB Local was up throughout (not restarted).

## Commits

| task | commit | message |
|---|---|---|
| 1.1 | 17f07803 | fix(app): the tours date-range read walks every page |
| 1.2 | cb0bee40 | fix(app): drop Today's false tours_today cap warning |
| 2.1 | fa24547b | fix(seed): every seeded tour carries the date-index partition |
| 3.1 | 37b84a3a | feat(app): unitsRepo.getDisplaysByIds - property labels in one batch |

## Task 1.1 - listByScheduledRange walks every page

- Files: `app/src/repos/toursRepo.ts` (interface doc + optional third
  parameter; implementation now `queryAll` with `Limit` from
  `opts.pageLimit`), `app/test/toursRepo.integration.test.ts` (QueryCommand
  added to the lib-dynamodb import; a nested describe after the boundary
  case).
- RED: `pageLimit 1 still returns the whole window, one Query per page` failed
  with `expected 1 to be greater than or equal to 7` - the set-equality and
  length assertions passed first, so one Query returned the whole window and
  the page limit was ignored. The (PIN) case was green. Run: 1 failed, 64
  passed (65).
- GREEN: 1 file, 65/65 passed.

## Task 1.2 - Today's stale tours_today cap warning

- Files: `app/src/routes/today.ts` (the `warnIfCapped('tours_today', ...)`
  line replaced by a one-line comment; `warnIfCapped` and
  `GROUP_FETCH_LIMIT` keep their other callers), `app/test/todayApi.test.ts`
  (one case after "tours_today is scheduled-ONLY").
- RED: `expected [ { level: 40, ...(9) } ] to deeply equal []` - the line was
  msg `today: group fetch hit the cap - results truncated`, group
  `tours_today`, count 100. The case's `toHaveLength(100)` on the tours_today
  items passed first. Run: 1 failed, 61 passed (62).
- GREEN: 1 file, 62/62 passed.

## Task 2.1 - _schedPartition on the four unstamped seed rows

- Files: `app/src/lib/seed/cast.ts` (TOUR_SEARCHING after
  `status: 'requested',`; TOUR_TOURED after `status: 'toured',`),
  `app/src/lib/seed/matrix.ts` (the requested-branch literal, :943), new
  `app/test/seedTourPartition.test.ts`, `app/test/seedMatrixCoherence.test.ts`
  (the :415 assertion inverted, message reworded as the plan gives it),
  `app/test/seedLive.test.ts` (the pin beside the :506 pointer assertion).
- RED: the new pin failed with exactly the four rows -
  `cast:tour-cast-searching-tenant`, `cast:tour-cast-toured-yes-tenant`,
  `matrix:tour-mx-requested-01`, `matrix:tour-mx-requested-02`; the inverted
  coherence assertion failed with `requested tour-mx-requested-01 carries the
  partition ...: expected undefined to be 'tours'`. The seedLive (PIN) case
  was green on unchanged code (confirmed with a `-t` run: 1 passed). Run: 2
  failed, 57 passed (59) across the three files.
- GREEN: the three files 59/59; plus every other test file that builds the
  cast or matrix seeds (castMessageTransport, devRelayReplay,
  reseedUnmatchedEmail, seedHistory, seedMatrix, seedPersonaDrift,
  seedProfile.integration, seedRosterShape, seedTourTrails, seedUnreadFlag):
  13 files, 219/219 passed - no other test pins these rows' shape.

## Task 3.1 - unitsRepo.getDisplaysByIds and its fake

- Files: `app/src/repos/unitsRepo.ts` (`BatchGetCommand` import;
  `UnitDisplayItem` exported right after `UnitItem`; the interface method and
  the implementation RIGHT AFTER `getById`, ruling A-1),
  `app/test/helpers/twilioWebhookHarness.ts` (`type UnitDisplayItem` import;
  the fake method right after `getById`), new
  `app/test/unitsRepoDisplays.test.ts` (6 cases, stub client),
  `app/test/unitsRepo.integration.test.ts` (1 case in the DynamoDB Local
  describe).
- RED: all 7 new cases failed with `units.getDisplaysByIds is not a
  function`. Run: 7 failed, 10 passed (17).
- GREEN: 2 files, 17/17 passed (6 unit; 11 in the integration file).
  Harness smoke after the fake landed: toursApi + todayApi, 2 files, 276/276.

## Typecheck

`npm run typecheck` (all five workspaces; the app's `tsconfig.test.json`
covers `app/test`, so the harness literal and the stub cast are checked):
exit 0 after Task 1.1, exit 0 before the Task 2.1 commit, exit 0 before the
Task 3.1 commit, and exit 0 again on the committed tree at 37b84a3a.

## Divergences from the plan / worklist, and why

1. Task 1.1 uses the file's spying-doc idiom (worklist item 1), not
   `vi.spyOn`: the file imports no `vi`. The two cases sit in a NESTED
   describe with its own `beforeAll` that writes the eight rows once - the
   file had no nested describe, but two independent `it`s would each have
   added seven rows to the same window, and one `it` holding both reads would
   hide the PIN behind the RED. A `toHaveLength(7)` sits beside each set
   equality (catches duplicates).
2. Task 1.2 adds `expect(tours).toHaveLength(100)` so the no-WARN assertion
   cannot pass vacuously (e.g. on a window that missed the rows).
3. Task 2.1's pin is one `it` over the three profiles (the seedRosterShape
   shape) reporting failures as `profile:tourId`, with a `seen > 0` guard
   (lean seeds no tours). The seedMatrixCoherence case title is unchanged
   (still accurate); the seedLive case title is unchanged and the new
   assertion carries a three-line comment.
4. Task 3.1, unit test: the throwing-chunk case uses THREE chunks (250 ids,
   the middle one throws) rather than two, proving results both before and
   after the failed chunk are kept; the two warns are asserted by msg
   (worklist item 7). It also pins that a thrown chunk is not retried (three
   requests for three chunks) - the GREEN code's and contactsRepo's
   behavior. The stub refuses any command that is not a `BatchGetCommand`
   instance and is cast `as unknown as DynamoDBDocumentClient` (item 6).
5. Task 3.1, integration case: placed right after the existing getById
   round-trip case, not at the end of the describe - the same reasoning as
   A-1 (the parallel branch would append at the end). It asserts EXACT
   equality `{ unitId, address }`, so it also proves DynamoDB Local honors the
   projection (landlordId, status, beds, deleted_at absent).
6. `UnitDisplayItem` placement is not given by the plan; it sits directly
   after `UnitItem`, far from the interface end A-1 protects.
7. The harness fake returns the stored `address` value by reference (as the
   fake's `getById` returns the stored item) rather than spreading it: a
   legacy unit may hold a plain-string address (UnitItem doc), which a spread
   would turn into an object of characters.

## What surprised me

- Gate 5 preview (`npx eslint` on the 13 TS files this slice touched): exit 1
  with 5 errors, ALL pre-existing - `cast.ts` 79:7 `CP`, 109:7 `poolNum`,
  110:7 `listingSendId`, 434:7 `UNIT_SEARCHING_A`; `matrix.ts` 134:7
  `DEADLINE_TYPES` (all no-unused-vars). Attributed by baseline: the
  90b65a23 blobs linted through `--stdin --stdin-filename` give the identical
  five. S15's gate 5 will see them and should name them as not this branch's.
- `listByScheduledRange` (like the file's `queryGsi`, and as the plan's GREEN
  code has it) calls `queryAll` without `{ logger: log }`, so queryAll's
  page-cap WARN goes to the default logger rather than the repo's injected
  one. Pre-existing pattern, left as the plan wrote it; noted only.
- The pure pin cannot see the performance seed's tours (a config-driven
  generator outside the plan's three profiles); it stamps unconditionally at
  `performance.ts:655`, so nothing is missing today.

## Left undone

Nothing in S1-S3 scope. Not run here by instruction: the full `npm test`,
`npm run e2e`, `npm run smoke` (later phases).
