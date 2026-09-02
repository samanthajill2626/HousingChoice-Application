# Task 12 fix wave 1 - E2E assertion correction

## Scope and contract

- Owned file: `e2e/tests/dashboard-next/message-transport-fidelity.spec.ts` only.
- The transport helper now requires the exact requested/actual transport segment followed by the rendered metadata delimiter (`^<segment> - `) inside the relevant message bubble. This distinguishes requested-only/agreement/native labels from `<requested> -> <actual>`.
- Requested-only RCS (pending callback and incomplete-recipient), direct SMS agreement, and native MMS each also have an explicit zero-count assertion for their respective transition prefix. The signed callback separately requires `RCS -> SMS - `.
- The excluded-recipient assertion now matches the real accessible row separator (`^<phone> - `), while preserving positive controls for the state-absent and opted-out rows.
- The optimistic no-chip assertion remains exact and unchanged.

## TDD/red evidence

1. The initial standalone-child exact matcher was intentionally run and failed: the live bubble exposes `RCS - to (555) 010-0001 - <time>` as one metadata span, not a standalone `RCS` child. Exit `1`; `1 failed`; test duration `26.9s`. Artifact: `e2e/.artifacts/test-results/dashboard-next-message-tra-14a60-oss-dashboard-message-hosts-chromium/error-context.md`.
2. With the corrected excluded-row selector temporarily pointed at the state-absent control but retaining `toHaveCount(0)`, the targeted run failed exactly at that assertion: expected `0`, received `1`. Exit `1`; `1 failed`; test duration `25.0s`. This proves the corrected separator matcher reaches normal recipient rows rather than encoding the previous backspace/non-match.

## Final verification

- `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/message-transport-fidelity.spec.ts`: exit `0`; `1 passed (26.6s)`.
- `npm run typecheck -w @housingchoice/e2e`: exit `0`.
- `git diff --check -- e2e/tests/dashboard-next/message-transport-fidelity.spec.ts`: exit `0`.

Final E2E stdout artifact: `.superpowers/sdd/task-12-fixwave-1-final.stdout.log`.

## Commit

`6feb30f0 test: tighten transport fidelity browser proof`
