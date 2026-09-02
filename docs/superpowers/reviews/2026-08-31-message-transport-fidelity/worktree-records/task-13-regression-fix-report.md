# Task 13 focused regression fix report

## Scope

- Changed only `app/test/relayFanOut.test.ts`.
- Updated the exact persisted `relay.intro` opted-out recipient assertion to retain
  `status: 'failed'` and `errorCode: 'contact_opted_out'`, and to expect
  `requestedTransport: 'sms'` and `transportAggregationState: 'excluded'`.
- No production source behavior changed.

## TDD evidence

- Isolated red: `npm run test -w @housingchoice/app -- test/relayFanOut.test.ts`
  exited 1. Result: 1 failed, 43 passed, 44 total. The exact-object assertion was
  missing `requestedTransport: 'sms'` and `transportAggregationState: 'excluded'`.
  Captured at `.superpowers/sdd/task-13-regression-isolated-red.log`.
- Isolated green: the same command exited 0. Result: 1 passed file, 44 passed tests.
  Captured at `.superpowers/sdd/task-13-regression-isolated-green.log`.
- Planned 12-file app bundle exited 0. Result: 12 passed files, 453 passed tests.
  Captured at `.superpowers/sdd/task-13-regression-focused-bundle.log`.

## Commit

- `650344db test: expect versioned Relay announcement facts`
- Staged explicitly: `app/test/relayFanOut.test.ts`.
- Pre-commit status named only that file; `MERGE_HEAD` was absent; added lines are ASCII.
