# Slice B report - S4, S5 (implementer B)

Implementer: Claude Opus 5.5, 2026-10-06. Worktree `W:\tmp\tour-list`, branch
`feat/tour-list`, started at HEAD 413ff66c, ended at 2e6838a0 (plus this
report's commit). Inputs: plan v3 sections 0, 1, S4 and S5;
`build-research/app-worklist.md` (Tasks 4.1-4.3, 5.1 items 9-12, 5.2 items
13-15, G1, G3, G7); `build-research/README.md` rulings A-2, A-3, A-4; spec
5.3, 5.4, 5.5.

Every task ran strict TDD: test written, run RED and read for the stated
reason, implementation, run GREEN, one commit. No `[dynamoAdmin]` line
appeared in any run (every run's output was captured and swept: 0 hits).
DynamoDB Local was up throughout and was never restarted, stopped or removed.

## Commits

| task | commit | message |
|---|---|---|
| 4.1 | 276c29b3 | feat(app): tour list query parsing for the All tab |
| 4.2 | e5825a6d | feat(app): tour list phase plan |
| 4.3 | ca4c50dc | feat(app): tour list cursor and fingerprint |
| 5.1 | 28070f6e | feat(app): toursRepo.queryListPhase - one All-tab phase batch |
| 5.2 | 2e6838a0 | test(app): the All-tab phase fake model, pinned to DynamoDB Local |

## Task 4.1 - parse and normalize the request

- Files: NEW `app/src/lib/tourListQuery.ts`, NEW `app/test/tourListQuery.test.ts`.
- RED: the test file failed to load - `Cannot find module
  '../src/lib/tourListQuery.js'` (no tests ran): the module did not exist.
- GREEN: 8/8 (plan cases 1-8, one `it` each).
- Small additions inside the plan's cases: `to` alone canonicalizes; `to:
  'yesterday'` errors; `from == to` is accepted (spec "from <= to"); an
  explicit `sort: 'latest'` wins over Upcoming's default; `when: 'upcoming'`
  with a `from` errors.

## Task 4.2 - the phase plan

- RED: the 10 new cases failed with `TypeError: (0 , planTourListPhases) is
  not a function`; the 8 parse cases stayed green (10 failed, 8 passed).
- GREEN: 18/18. Phases asserted with `toStrictEqual`, so "NO statusFilter,
  NO type" is checked as key ABSENCE, not as `undefined` values.
- Additions: past/upcoming with a mixed status set (requested dropped,
  dated statuses filtered, still no U); a reduced plan; `isUnfilteredPhase`
  over every typed phase.

## Task 4.3 - fingerprint and cursor

- RED: the 7 new cases failed, each with `TypeError: (0 , <fn>) is not a
  function` for tourListFingerprint (2), encodeTourListCursor (1),
  decodeTourListCursor (1), locateTourListCursor (2), tourListKeyOf (1);
  the 18 earlier cases stayed green (7 failed, 18 passed).
- GREEN: 25/25; app `tsc -p tsconfig.test.json` exit 0; eslint exit 0.
- Additions: every fingerprint variant is distinct from every other (set
  size), not only from the base; decode also refuses a JSON string, an
  uppercase `f`, a non-canonical `n` (`...T16:00:00Z`), a string `i`, an
  array `k`, and a u key on a d cursor; locate checks that in a REDUCED plan
  a U_ORDER index maps to the right phase index (`i: 2` -> phase 2 in
  `[D, toured, no_show]`).

## Task 5.1 - toursRepo.queryListPhase

- Files: `app/src/repos/toursRepo.ts` (type import; interface method at the
  END of ToursRepo, :329; implementation at the END of the returned object,
  :832 - the plan's code verbatim); `app/test/toursRepo.integration.test.ts`
  (line 17's import widened, one new import line, a NEW top-level describe at
  :1115 with its own `hc-test-${randomUUID().slice(0, 8)}-` prefix - only the
  per-describe setup copied, worklist item 9); NEW
  `app/test/helpers/tourListIndexFake.ts`; `app/test/helpers/twilioWebhookHarness.ts`
  (import :221, method :3534 after listByStatus). Per ruling A-2 the fake and
  the harness method are in this commit.
- RED (repo): the 9 new cases failed with `TypeError: tours.queryListPhase is
  not a function`; the 65 existing cases passed (9 failed, 65 passed).
- GREEN (repo): 74/74 on DynamoDB Local.
- RED (harness, A-2): with the interface and implementation in place, app
  `tsc -p tsconfig.test.json` exited 2 with exactly ONE error -
  `twilioWebhookHarness.ts(3483,9): error TS2741: Property 'queryListPhase'
  is missing ... required in type 'ToursRepo'`. After the fake + harness
  method: exit 0; the harness-backed `toursApi.test.ts` 214/214.
- Fixture (A-4): 6 dated rows at `2028-01-0NT10:00:00.000Z` (N = 1..6;
  scheduled, toured, no_show, canceled, closed, scheduled; types mixed), 2
  requested, 1 undated toured. Every instant is a full toISOString() value.
- Cases 1-9 as the plan, each asserting `scannedCount`. Additions: case 1
  compares WHOLE rows (projection ALL); cases 5, 6 and 7 assert the
  `lastEvaluatedKey` VALUE equals `tourListKeyOf(row, phase)` - DynamoDB
  Local's GSI LastEvaluatedKey is exactly the table key plus the index keys,
  tourListKeyOf's shape; case 7 also shows a Limit EQUAL to the row count
  returns a key; case 8 also resumes descending and from a byStatus item
  key; case 9 sweeps 24 shapes x both directions (48 Queries) and collects
  every failure with its shape, so a broken shape names itself.

## Task 5.2 - the mirror (and the fake's out-of-bounds text)

- Files: NEW `app/test/tourListIndexFakeMirror.integration.test.ts`
  (prefix `hc-test-tourlistmirror-${randomUUID().slice(0, 8)}-`, worklist
  item 14; `dynamoAccessKeyGuard.test.ts` 15/15 with the new file present);
  `app/test/helpers/tourListIndexFake.ts` (message + header).
- RED: first run 6 passed, 1 failed - the OUT-OF-BOUNDS case: the real read
  rejected with name `ValidationException` and message "The provided
  starting key does not match the range key predicate"; the fake threw the
  plan's text "...is outside query boundaries based on provided conditions".
- Probe (a temporary case, removed before the commit): 8 out-of-bounds
  shapes x 2 directions = 16 reads. DynamoDB Local rejected ALL 16 with that
  same name and message; the fake rejected exactly the same 16 - only the
  text differed. The probe is kept as a permanent case ("every shape").
- GREEN: the fake now throws DynamoDB Local's text; 8/8.
- The call-list cases were green on their first run because the fake landed
  in 5.1 by ruling A-2. Their teeth, shown with two temporary mutants of the
  fake, each reverted with the Edit tool (`git diff` of the fake afterwards
  showed only the intended header + message change):
  - a key only when rows REMAIN (the old unreadIndexFake bug): 4 of 8 failed
    - all four walk cases, e.g. `D all up limit 1 page 5: lastEvaluatedKey:
    expected undefined to strictly equal { _schedPartition: 'tours', ... }`;
  - `scannedCount` = matched rows (Count, not ScannedCount): 3 of 8 failed -
    the three filtered walks.
- Cases: D all, both directions, limits 1, 2, 3, 100; D status filter at
  limit 2; D gte + type at limit 2; U toured notExists at limit 1; U
  requested at limit 1 - each walked through every returned
  lastEvaluatedKey AND resumed once from the key of every row it returned;
  OUT-OF-BOUNDS (the plan's case); OUT-OF-BOUNDS every shape; TIE GUARD
  (fake only); KEY POSITION (defined last - it moves a row; the moved row
  comes back last and the old 3rd row first on both sides).

## Out-of-bounds verdict (DynamoDB Local)

DynamoDB Local DOES reject. Name: `ValidationException` (as the plan
assumed). Message: "The provided starting key does not match the range key
predicate" - NOT the "The provided starting key is outside query boundaries
based on provided conditions" the plan quoted. Identical for every shape
probed, both directions: gte with the key below; lt with the key above; lt
with the key AT its exclusive bound; lte above; between below; between above;
a d key with `_schedPartition: 'other'`; a toured byStatus key on the
requested phase. The fake rejects exactly that set and now throws DynamoDB
Local's text. Nothing downstream keys on the text: the plan's route matches
`err.name === 'ValidationException'` (plan :1468) and route test 9 uses
`new Error('bad key')`. Route test 3's second-row clock is unaffected.

## Divergences from the plan and the worklist

1. 4.1 does not import `createHash`; it arrives in 4.3, its first use (an
   unused import between commits). The final file matches the plan.
2. The fake's out-of-bounds message (above) - the plan's own remedy for the
   bigger contradiction ("make the fake match DynamoDB Local"), applied to the
   text. The plan document still quotes the old text (:955-956, :987-989,
   :1048); plan docs are not this slice's to edit.
3. Tie guard (A-3): the house guard exactly - it throws when ANY OTHER row of
   the phase holds the start key's range-key value (unreadIndexFake's
   `ordered.some(same range && other id)`), checked over the phase's members
   BEFORE the FilterExpression (a filtered-out row still holds a position).
   That equals A-3's "shared by more than one row" whenever the key's own row
   is still there; it also throws when the key's row has MOVED and another
   row sits at the old value (DynamoDB's position is opaque there too). The
   house `allowTieResume` opt-in is included (G1 names it; A-3 is silent);
   the harness never sets it. The error is a plain `Error` (name `'Error'`).
4. Every 5.1/5.2 fixture row carries an explicit distinct `createdAt`
   (2027-12-01..09T09:00:00.000Z): the two `scheduled` rows share a byStatus
   partition and could otherwise tie on a same-millisecond create. The
   undated toured row is created directly with `status: 'toured'` (worklist
   item 12's option), not create-then-patch.
5. Mirror additions beyond the plan's call list (supersets): the item-key
   resumes, both directions for every call, U requested and D gte + type in
   the list, whole-row equality, the out-of-bounds sweep.
6. 5.1's commit subject is the plan's, with a body naming ruling A-2; 5.2's
   subject is the plan's, with a body recording the out-of-bounds finding.
   The harness method carries a two-line comment pointing at the mirror.

## Surprises

- The out-of-bounds message (above). The plan's other DynamoDB assumptions
  all held on DynamoDB Local: Limit counts evaluated rows before the filter;
  a key comes back when a Query stops AT its Limit even with nothing after
  it; no key when the range runs out first; resume is by key position after
  a row moves; every phase shape is a valid Query.
- The Bash tool rejected a ~9 KB heredoc append (`unexpected EOF`) and
  appended nothing (tail and `git diff --stat` checked before retrying); the
  append went through the Edit tool instead.

## Gates run here

- `npm run typecheck` after the 5.1 commit (28070f6e): exit 0, all five
  workspaces. After the 5.2 commit (2e6838a0): exit 0.
- App-only `tsc -p tsconfig.test.json` along the way: 4.2 exit 0; 4.3 exit 0;
  5.1 mid-task exit 2 (the expected TS2741 RED); 5.1 final exit 0; 5.2 exit 0.
- Gate-5 form from the worktree root on the 7 files S4-S5 touched
  (`git diff --name-only --diff-filter=d 413ff66c..HEAD -- '*.ts' ...`):
  `npx eslint <files>` exit 0, no output.
- ASCII: all four new files print 0; the added lines of the three edited
  files print 0. The non-ASCII neighbours G7 names were not touched.
- Final targeted run: tourListQuery 25, tourListIndexFakeMirror 8,
  toursRepo.integration 74, toursApi 214 - 321/321.
- Not run, per the brief: full `npm test`, `npm run e2e`, `npm run smoke`.

## Left undone and notes for later slices

- Nothing in S4-S5 is left undone.
- S6/S7: a harness tour created without an explicit `createdAt` takes the
  wall clock (`twilioWebhookHarness.ts:3495`), so two creates in one
  millisecond in the SAME status partition now trip the tie guard on a resume
  - a plain Error, so a 500 in a route test. Give route/engine fixtures
  explicit, distinct `createdAt` and `scheduledAt` values (A-4 style).
- The engine may pass the repo's opts straight through; the fake also accepts
  `allowTieResume`, for a cursor-mechanism test only, with a comment.
