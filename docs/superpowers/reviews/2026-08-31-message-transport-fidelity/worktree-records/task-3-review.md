# Task 3 independent persistence review

Reviewed `52a924d7` against the approved transport design and Task 3 contract.

## Required findings

### P1 - A duplicate terminal result without an error code deletes retained terminal diagnostics

`app/src/repos/messagesRepo.ts:3215-3225` removes `errorCode` whenever the incoming patch omits it and the stored status equals the patch status. For an existing `{ status: 'failed', errorCode: 'provider-terminal' }`, calling `applyRecipientSendResult(..., { status: 'failed' })` meets `statusSame` and `errorEligible`, then emits `REMOVE #dr.#mk.#error`. The equivalent test-harness implementation does the same at `app/test/helpers/twilioWebhookHarness.ts:1463-1474`.

This conflicts with the intended cleanup rule: success clears an old transient error, while terminal delivery error data must remain protected. `errorCode` is optional on `RecipientSendResultPatch`, so a duplicate/retried failure result with no provider code is a valid call shape and loses the original provider diagnostic.

Reproduction/proof: add a repository contract test that appends a v1 slot `{ status: 'failed', errorCode: 'terminal-provider-error' }`, invokes `applyRecipientSendResult` with `{ status: 'failed' }`, and expects the slot unchanged plus `idempotent`. It fails on this commit because the field is removed; guarding error cleanup to a non-terminal successful result (and mirroring the harness) makes it pass.

### P2 - The fourth conditional failure is returned as `conflict` without the required re-read classification

`app/src/repos/messagesRepo.ts:3155-3281` reads before each of four attempts, but if the fourth `UpdateCommand` is conditionally refused, the loop exits directly at `:3281` with `conflict`. There is no final consistent read to distinguish an idempotent concurrent winner, allowed RCS fallback, stale observation, or a genuine conflict.

The approved contract requires a conditional race to be re-read and classified, and Task 3 explicitly requires this outcome rather than an unexamined DynamoDB error. A concurrent identical producer result that wins after this invocation's fourth read is reported as `conflict` even though all requested facts are already persisted; a caller can unnecessarily treat a successful retry as failed.

Reproduction/proof: use a document-client seam that rejects the fourth update after installing the same requested status/SID/time/actual values, then assert `idempotent` after a final consistent read. Current code returns `conflict`. Re-read/classify after the final conditional failure (or make the retry loop include its final classification pass) before returning.

### P2 - Expected stale RCS callback ordering is silent instead of being debug/info observable

`app/src/repos/messagesRepo.ts:2956-2975` and `:3125-3147` classify an RCS observation after a stored SMS/MMS fallback as `stale`, but make no info/debug log. The design requires that expected stale ordering be an idempotent no-op logged at info/debug, while conflicts alone warn. The shared webhook fake similarly returns `stale` silently at `app/test/helpers/twilioWebhookHarness.ts:1351-1368` and `:1400-1419`.

Reproduction/proof: append/request RCS, persist actual SMS, then submit actual RCS and capture the repository logger. The outcome is `stale`, but no debug/info record identifies the superseded observation. Add a non-warning structured stale log with only safe IDs/enum values and an assertion in the repository contract test.

## Confirmed points

- `append` maps the versioned message fields and preserves legacy `type`/delivery data; its validation rejects carrier facts on call/email, inbound message-level requested transport, and invalid transport unions (`app/src/repos/messagesRepo.ts:882-933`, `:2049-2088`).
- The four dedicated transport writes use aliased child paths, schema-version conditions, and consistent reads after ordinary conditional failures (`:2925-3147`). The aggregation transition conditions match the approved pure state machine.
- `applyRecipientSendResult` uses child fields, preserves requested transport, uses absent-only `if_not_exists` for SID/timestamp, and permits status/actual evidence to progress independently (`:3150-3276`).
- Existing whole-slot callers are limited to pre-Task-5 relay fan-out and announcement paths (`app/src/jobs/relayFanOut.ts:708`, `app/src/services/relayAnnouncements.ts:333`); replacing them is explicitly owned by later slices, not silently missed here.
- The two direct full-interface test fakes only add required methods with inert `missing` outcomes, while the webhook harness mirrors the new methods; the edit scope is minimal for Task 3.

## Focused proof

Attempted `npm run test -w @housingchoice/app -- test/messagesRepo.transport.test.ts`. It could not start in this sandbox: Vite failed opening `app/node_modules/.vite-temp/vitest.config.ts.timestamp-...mjs` with `EPERM` (exit 1). No product files were changed.

PARTIAL/NEEDS_FIX
