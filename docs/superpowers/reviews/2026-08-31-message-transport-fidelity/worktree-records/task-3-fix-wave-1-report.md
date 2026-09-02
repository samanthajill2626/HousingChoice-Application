# Task 3 fix wave 1 report

## Scope

- `app/src/repos/messagesRepo.ts`
- `app/test/messagesRepo.transport.test.ts`
- `app/test/helpers/twilioWebhookHarness.ts`

## TDD proof

- First focused red attempt: `npm run test -w @housingchoice/app -- test/messagesRepo.transport.test.ts` exited 1 before test execution because the sandbox denied Vite's `.vite-temp` write with `EPERM`.
- Allowed-environment red: the same command exited 1 with 3 failing and 19 passing tests. The new terminal duplicate returned `updated`, the forced fourth conditional race did not reclassify, and stale RCS evidence returned with no info event.
- The deterministic race seam forces four conditional failures and makes the identical winner durable only on the fourth attempted write. It now proves the final consistent read returns `idempotent`.

## Delivered

- A duplicate terminal result without an error code retains its terminal diagnostic; only a same-status successful `sent` result clears stale transient error data.
- `applyRecipientSendResult` consistently re-reads after its final conditional failure and classifies the durable state rather than returning a bare conflict.
- Message and recipient stale RCS-after-SMS/MMS fallback paths emit info events with safe IDs and transport enums; recipient phone map keys remain redacted and genuine conflicts stay warnings.
- The webhook harness mirrors the real send-result error-cleanup state machine.

## Verification

- `npm run test -w @housingchoice/app -- test/messagesRepo.transport.test.ts` - exit 0, 1 file passed, 22/22 tests passed.
- `npm run typecheck -w @housingchoice/app` - exit 0.
- `git diff --check` - exit 0.
- Added-lines ASCII check - pass.

## Commit

- `5296694a` - `fix: preserve concurrent transport evidence`

## Deviation

- No scope or contract deviation. The test seam also exposed an unused DynamoDB expression-name token on no-error send-result writes; the fix now binds `#error` only when the update uses it.
