# Task 3 fix round 2 report

## Delivered

- `beginFinalization` now creates an empty/pending marker in the stateful job fake.
- The route-equivalent post-put handoff asserts that marker is empty, then
  `setVerdict` is the only mutation that makes it terminal.
- `putRun` merges only a defined terminal marker verdict over the incoming
  pending type decision. The existing persisted-suggestion delete, ordering,
  terminal-result, and extraction-owned delete counterexample remain asserted.

## TDD evidence

- RED: with the pending marker model and the `setVerdict` marker mutation
  deliberately omitted, `npm run test -w @housingchoice/app --
  test/extractionJob.test.ts` exited 1: 76 passed, 1 failed. The handoff test
  received `verdict: pending` where it requires `superseded_by_human_edit`.
  This proves the terminal assertion is causal on the post-put marker write.
- GREEN: `npm run test -w @housingchoice/app -- test/extractionJob.test.ts`
  exited 0: 77 passed.
- Focused S3 suite: `npm run test -w @housingchoice/app --
  test/extractionApply.test.ts test/extractionJob.test.ts
  test/extractionJobDraftGuard.test.ts test/extractionDecisions.test.ts
  test/extractionRunTypes.test.ts test/twilioSmsWebhook.test.ts` exited 0:
  239 passed across 6 files.
- `git diff --check` exited 0. Added lines are ASCII-only.

## Scope and concern

- Commit: `faa995f0 test: make AI finalization handoff causal`.
- No production code changed.
- `npm run typecheck -w @housingchoice/app` exited 1 on pre-existing literal
  widening errors in `app/test/extractionApply.test.ts:65-66` and
  `app/test/extractionJob.test.ts:180-181`; the Job source at 173-181 is
  byte-identical to `fd65d9ce`. Targeted ESLint similarly reports the
  pre-existing unused `WINDOW_CHAR_BUDGET` import at
  `app/test/extractionJob.test.ts:23`, outside this diff.
