# Task 5 relay fan-out report

## Outcome

Committed `dc6f1410 feat: track transport across relay fanout`.

Source creation now persists schema version 1 and adapter-owned requested
transport on open and connecting relay sources plus every source-time recipient
slot. Classification uses durable attachments and stable media-store availability;
the enqueue payload and existing queued/queued_pending behavior are unchanged.

The worker branches immediately after the source read. Schema-absent jobs call the
legacy execution wrapper, which uses `adapter.sendMessage` and
`setRecipientDelivery` without classification, preparation, initialization,
aggregation, or transport-result calls. Tests prove this for an ordinary in-flight
job, a continuation, and an actual `flushQueuedMessages` release of a
`queued_pending` source.

Version 1 preflight computes the eligible roster from the existing sender exclusion
followed by the existing continuation-key filter. It initializes missing eligible
slots, plans eligible never-attempted slots, excludes stale never-attempted slots,
and leaves attempted slots intact before provider call zero. A real preflight
failure produces zero provider calls. Suppression is excluded before any send;
nonsuppressed legs become attempted immediately before the prepared provider call.
Results use `applyRecipientSendResult`, preserve first SID/time and requested intent,
record normalized actual evidence, and clear a transient error on accepted queued
success.

## TDD proof

- Initial sandbox run: exit 1 before test execution due the documented Vite
  `.vite-temp` EPERM.
- Allowed-environment red run: exit 1, 7 failed and 83 passed across 90 tests. The
  failures were the missing source transport fields, missing worker preflight, and
  missing versioned aggregation/result behavior. Two initial fixture-shape errors
  were corrected before green proof.
- Final focused command:
  `npm run test -w @housingchoice/app -- test/relayApi.test.ts test/relayFanOut.test.ts`
  exited 0 with 2 files and 94 tests passed.
- `npm run typecheck -w @housingchoice/app` exited 0.
- `npx eslint app/src/routes/api.ts app/src/jobs/relayFanOut.ts app/test/relayApi.test.ts app/test/relayFanOut.test.ts`
  exited 0.
- `git diff --check` exited 0 and added-lines ASCII check passed.

## Files

- `app/src/routes/api.ts`
- `app/src/jobs/relayFanOut.ts`
- `app/test/relayApi.test.ts`
- `app/test/relayFanOut.test.ts`

`app/src/services/relayQueuedMessages.ts` and its tests required no signature or
behavior change. No announcement, native Group MMS, non-live, projection, or
presentation files were changed.

## Contract issues

No unexpected importer, cycle, or contract mismatch was found. The only environment
issue was the documented Vite temp-file EPERM; the allowed-environment reruns supplied
the required red and green evidence.
