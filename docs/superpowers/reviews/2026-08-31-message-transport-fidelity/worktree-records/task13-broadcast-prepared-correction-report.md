# Task 13 broadcast prepared-send correction

## Scope and contract

Only `app/test/broadcastFanOut.test.ts` changed. The real send wrapper in
`app/src/services/sendMessage.ts` classifies the transport, prepares the send,
and calls `adapter.sendPreparedMessage(prepared)`. The fake adapter retains that
prepared-send boundary, so the test's provider-error injection now replaces
`sendPreparedMessage` and inspects `prepared.params.to`.

No production code, fake harness, Group MMS rule, or provider metadata changed.

## Red proof

`npm run test -w @housingchoice/app -- test/broadcastFanOut.test.ts` first hit
the known sandbox Vite temporary-file EPERM. The permitted normal-workspace rerun
exited 1: 6 failed and 19 passed. The failures were the 429 continuation/cap,
30007, 30005, continuation-backoff, and transient-event assertions; each injected
only legacy `adapter.sendMessage`, which the current service bypasses.

## Green proof

After retargeting the six existing test doubles, the same isolated command exited
0 with `Test Files 1 passed (1)` and `Tests 25 passed (25)`.

## Commit

`f1325049 test: preserve broadcast error injection`

## Remaining concern

The orchestrator owns all final gates. This narrow correction proves the test
seam follows the current prepared-send adapter contract only; it does not replace
the feature mission's broader verification.
