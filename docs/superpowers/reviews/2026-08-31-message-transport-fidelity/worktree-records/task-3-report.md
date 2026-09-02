# Task 3 report: versioned transport persistence

## Commit

- `52a924d717a804e4d21153f522d3d699bd609439` - `feat: persist versioned message transport facts`

## TDD proof

- DynamoDB Local reachability: `http://127.0.0.1:8000` answered HTTP 400, which is the expected unsigned DynamoDB response.
- First focused RED attempt: `npm run test -w @housingchoice/app -- test/messagesRepo.transport.test.ts` exited 1 before test execution with the known Vite `.vite-temp` EPERM. This was environmental, not a product result.
- Allowed-environment RED after correcting one test-helper assertion: the same command exited 1 with 19/19 tests failing for the missing mapping, validation, and repository methods.
- Final focused GREEN: the same command exited 0 with 1 file passed and 19/19 tests passed.
- App typecheck: `npm run typecheck -w @housingchoice/app` exited 0 after all three TypeScript projects completed.
- Hygiene: `git diff --check` exited 0, added lines were ASCII-only, and `MERGE_HEAD` was absent before commit.

## Files

- `app/src/repos/messagesRepo.ts`
- `app/test/messagesRepo.transport.test.ts`
- `app/test/helpers/twilioWebhookHarness.ts`
- `app/test/scheduledSendSuppression.test.ts`
- `app/test/sendMessage.test.ts`

The last two files contain only five additive `MessagesRepo` method stubs each. App typecheck identified them as exhaustive repository fakes that had to match the exported interface; no behavior in those suites changed.

## Exported contract

- `NewMessage` maps optional camel-case `transportSchemaVersion`, `requestedTransport`, and `actualTransport` into versioned snake-case `MessageItem` fields.
- `RelayRecipientDelivery` carries optional requested/actual transport and aggregation state.
- `TransportMutationOutcome` exports `updated | idempotent | stale | conflict | legacy_noop | missing`.
- `RecipientSendResultPatch` narrowly carries status, SID, sent time, error code, and actual transport.
- Added `setMessageActualTransport`, `initializeRecipientDelivery`, `setRecipientTransportAggregationState`, `setRecipientActualTransport`, and `applyRecipientSendResult`.
- Real repository writes are conditional child-field updates. Legacy rows are quiet no-ops, missing rows/slots are distinct, requested intent is never replaced, first SID/time are preserved, success clears transient errors, terminal errors are protected, and actual/aggregation transitions reuse Task 1 decisions.
- The webhook harness fake mirrors append mapping and the new state-machine outcomes so later callback/service tests cannot collapse transport evidence into delivery status.

## Drift and mismatches

- No unexpected importer, conditional semantic ambiguity, or approved-plan mismatch was found.
- The only scope expansion was the two typecheck-required exhaustive test fakes named above; both were minimal additive compatibility updates authorized by the brief.
