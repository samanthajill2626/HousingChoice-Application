# Task 3 fix wave 1 report

## Delivered

- Replaced the fabricated finalization regression with a stateful job-level
  handoff. The test begins a marker, persists the type suggestion, executes the
  classification-equivalent exact delete and `setVerdict` after the put and
  before `putRun`, and merges the marker only over an incoming pending decision.
  It asserts the terminal human-superseded verdict, the absent suggestion, and
  the full invocation order.
- Retained the extraction-owned guarded-delete counterexample, which records a
  dropped `type_already_classified` decision.
- Every extraction reconciliation state test now asserts the consistent owner
  read. Both retry reads and all four bounded conflict retries pin
  `{ consistentRead: true }`.

## TDD evidence

- RED: `npm run test -w @housingchoice/app -- test/extractionJob.test.ts`
  exited 1: 76 passed, 1 failed. Before the stateful fake retained the row, the
  route handoff assertion could not observe the just-persisted suggestion; its
  throw was correctly surfaced as the apply decision's dropped path.
- GREEN: `npm run test -w @housingchoice/app -- test/extractionApply.test.ts
  test/extractionJob.test.ts test/extractionJobDraftGuard.test.ts
  test/extractionDecisions.test.ts test/extractionRunTypes.test.ts
  test/twilioSmsWebhook.test.ts` exited 0: 239 passed across 6 files.
- `npm run typecheck -w @housingchoice/app` exited 0.
- `git diff --check HEAD^ HEAD` exited 0.

## Commit and scope

- `fd65d9ce test: cover AI type reconciliation handoff`
- Touched only `app/test/extractionApply.test.ts` and
  `app/test/extractionJob.test.ts` (69 insertions, 10 deletions).
- Vite-backed tests used the permitted elevated feature-worktree path after the
  known sandbox `.vite-temp` EPERM. No full suite or e2e was run.

## Concerns

- No production state-machine change was required: the faithful regression
  passes the existing implementation. Runtime schema/parser/prompt activation,
  seed/import/backfill/dependency/infra scope, and generic non-type replacement
  remain untouched.
