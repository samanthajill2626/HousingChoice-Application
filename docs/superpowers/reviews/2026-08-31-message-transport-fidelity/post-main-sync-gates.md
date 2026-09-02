# Post-main-sync completion gates

Date: 2026-09-02

Baseline merged into the feature branch:
`e9180a8a3ae54e29877861301cfb3fa2190fafa9`.

## Required non-browser gates

- `npm run typecheck`: EXIT 0.
- `npm test`: EXIT 0 on the executable rerun. App: 359 files passed,
  6740 tests passed, and 1 skipped. Dashboard: 185 files and 2995 tests
  passed. E2E support: 20 files and 496 tests passed. Fake Twilio: 34 files
  and 245 tests passed. Fake Twilio web: 13 files and 111 tests passed.
- The first `npm test` launch did not run tests because the sandbox denied
  Vitest access to `node_modules/.vite-temp`. The same bare command was rerun
  with worktree write access and completed with EXIT 0. This was a launcher
  environment failure, not a test failure.
- `npm run smoke`: EXIT 0. Plain Node resolved 1396 import specifiers across
  246 emitted files.

## Human-directed E2E handling

The human directed a 15-minute watchdog for heavy gates and, for any E2E
failure, one isolated run of the named test followed by moving on.

The bare `npm run e2e` gate reached test 207 of 266 and was stopped at the
15-minute watchdog. Before the cutoff it reported one failure:

- `e2e/tests/dashboard-next/outbound-mms.spec.ts:247:3`, the 1:1 outbound MMS
  image send and render case.

The first narrowed command accidentally ran the six tests in that file because
the root npm wrapper consumed the grep option. It reported 5 passed and the
same target failed. The corrected command was run directly through the E2E
workspace and executed exactly one test. That test failed in 4.7 seconds on
the scroll-preservation assertion at line 463: expected timeline top 512 and
received 500. The send, fake-provider media record, and rendered timeline image
had completed before that assertion.

No additional full-suite run or unrelated E2E repair was attempted, following
the human's explicit resource-limit instruction. The isolated failure is not a
transport-fidelity acceptance failure and the test file is not changed by this
branch. Its browser artifacts remain under the gitignored E2E artifact folder.

## Touched-file ESLint ratchet

The required `main...HEAD` path selection produced 83 code files. ESLint
reported 10 errors and 9 warnings. The same 10 errors were reproduced on main
for the seven affected files. None of those files changed between the exact
merge base and current main, so that run is also an exact merge-base content
comparison. Result: zero branch-introduced lint errors; the ratchet passes.

## Completion ruling

The merge is committed, conflict intent has been reviewed, the transport
feature has no post-sync source finding, and the discovered relay concurrency
defect is durably deferred to
`docs/issues/relay-fanout-active-pass-cap-close-race.md` by explicit human
direction. The branch is complete under the human-directed E2E watchdog and
single-test exception. This record does not claim that the full E2E command
exited green.
