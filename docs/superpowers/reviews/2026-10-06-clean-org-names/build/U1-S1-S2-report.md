# U1 report - S1 (Tasks 1.1-1.5) + S2 (Tasks 2.1-2.3)

- Implementer: U1 (Claude Opus 5.5), 2026-10-06.
- Worktree `W:/tmp/clean-org-names`, branch `feat/clean-org-names`.
- Range: HEAD before 18af2f97, after 2ec24791 (8 commits, one per task).
- Worktree clean after the last commit. Nothing left running.

## Per task

| task | commit | RED (one line) | GREEN | fast gates |
|---|---|---|---|---|
| 1.1 | 4cb1b6ab feat(org-names): matching rules - types, normalization, on-list check | Cannot find module '../src/lib/orgNames.js' | orgNames 4/4 | typecheck exit 0 |
| 1.2 | a42077d4 feat(org-names): D4 resolution, compound test, close names | 16 new cases: resolveOrgText / compoundSpans / closeNames is not a function | orgNames 20/20 | typecheck exit 0 |
| 1.3 | 397b4e17 feat(org-names): D5 write checks for scalar and list fields | 8 new cases: checkScalarWrite / checkListWrite is not a function (20 earlier stay green) | orgNames 28/28 | typecheck exit 0 |
| 1.4 | 8e382fca feat(org-names): name and spelling rules (D12, D13) | 6 new cases: checkNewName / checkSpelling is not a function (28 stay green) | orgNames 34/34 | typecheck exit 0 |
| 1.5 | df0aecb0 feat(org-names): the starting list and its conformance tests | Cannot find module '../src/lib/orgStartingList.js' | orgStartingList 32/32 (+ orgNames 34/34) | typecheck exit 0; S10-guard regex scan of the 4 S1 files: no hit |
| 2.1 | 49788e54 feat(org-names): org-list store - consistent read, create-only first write, peek, seed put | Cannot find module '../src/repos/orgListRepo.js' | orgListRepo.integration 4/4 RAN against DynamoDB Local (none skipped) | typecheck exit 0 |
| 2.2 | cb7b5342 feat(org-names): org-list read-and-bump mutate with busy and size guards | 8 new cases: repo.mutate is not a function (4 Task 2.1 cases stay green) | orgListRepo.integration 12/12 RAN | typecheck exit 0 |
| 2.3 | 2ec24791 test(org-names): in-memory org-list fake and world.orgListRepo | Cannot find module './helpers/orgListFake.js'; then, fake in place and harness not yet edited: harness case TypeError: Cannot read properties of undefined (reading 'peek') (5/6 green) | orgListFake 6/6 | typecheck exit 0 (harness via tsconfig.test.json); smoke: 3 harness-backed suites 17/17 |

Final combined run (all four U1 suites): 4 files, 84/84 passed, exit 0.
Lint preview (not a required gate here): `npx eslint` on all 10 touched
files, exit 0, no findings.

Checks on every commit: bare `git status` read first, no MERGE_HEAD, explicit
paths only, ASCII subject + `Co-Authored-By: Claude Opus 5.5
<noreply@anthropic.com>` trailer (verified with git log). New files: `tr -d`
count 0 each; edited files: added `git diff` lines 0 non-ASCII bytes.

## Worklist items applied

- RD-1 (Task 1.5): the `samMappings` comment in
  `app/test/orgStartingList.test.ts` no longer names the retired module path:
  "The retired alias map read a bare `clayton` as Clayton County; Cameron's
  launch-gate ruling (2026-10-06): a bare "Clayton" is the city in Rabun
  County, which DCA serves." Grepped all S1 files for the S10 guard's six
  regexes: no hit.
- RA-2 (Task 2.2): the import replacement in
  `app/test/orgListRepo.integration.test.ts` was done as TWO separate Edit
  calls (the one-line `@aws-sdk/lib-dynamodb` import; then the two-line
  orgListRepo + orgFixtures imports).

## Divergences from the plan

None in code: every file is the plan's text (plus RD-1's comment wording).
Process only: in Task 2.3 I created `helpers/orgListFake.ts` and re-ran the
suite BEFORE the harness edit, to get runtime RED evidence for the
`world.orgListRepo` case (the plan states that half of the RED as a type
error); then applied the four harness edits exactly as written. All five
harness anchors matched at the plan's lines (141-144, 219, 411-412, 2667,
4888-4890) and were unique.

## Exports later slices rely on (as the plan writes them)

- `app/test/helpers/orgFixtures.ts`: ORG_T0, orgEntry, ATLANTA, AUGUSTA, DCA,
  VASH, STEP_UP, ORG_FIXTURE, orgRef, orgListItem, runningRewrite,
  quietLogger.
- `app/test/helpers/orgListFake.ts`: createOrgListFake, ORG_LIST_FAKE_NOW.
- `FakeWorld.orgListRepo` (twilioWebhookHarness.ts), created by
  `createFakeWorld()`; empty until the first read.
- `app/src/repos/orgListRepo.ts` also exports ORG_LIST_MAX_ATTEMPTS and
  orgListItemBytes (Task 2.2) beside the plan 3.2/3.3 names.

## Out of scope, noticed (no change made)

- `app/src/lib/orgNames.ts:266` (checkScalarWrite, plan text): the
  "unchanged" test compares the TRIMMED next value with the UNTRIMMED stored
  value (`trimmed === current`), while checkListWrite (`:292`) trims both
  sides. Today contacts PATCH stores the string as sent, untrimmed
  (`app/src/routes/contacts.ts:634`), so a stored off-list value with
  surrounding spaces that a caller re-sends unchanged would be judged a
  change and checked against the list (refused if off-list). Low impact:
  the tenant form never re-sends an unchanged housingAuthority (plan
  section 12), and the S6 callers may pass `current` trimmed. Flagging for
  the S3/S6 implementers or reviewers; not a plan deviation.
