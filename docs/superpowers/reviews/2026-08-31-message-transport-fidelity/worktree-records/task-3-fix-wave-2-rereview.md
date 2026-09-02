# Task 3 fix wave 2 cold re-review

Reviewed pressured correction commit `8bbb0f8f` against the live repository,
the accepted first re-review finding/adjudication, the source and test fake, and
the narrow diff package.

## Required finding

### P1 - Successful `delivered` duplicates can still erase a retained terminal diagnostic

`isSuccessfulDeliveryStatus()` classifies `delivered` as successful at
`app/src/repos/messagesRepo.ts:143-145`. Both real persistence
(`app/src/repos/messagesRepo.ts:3274-3285`) and the shared fake
(`app/test/helpers/twilioWebhookHarness.ts:1464-1473`) therefore remove an
existing `errorCode` for a same-status `{ status: 'delivered' }` patch. A
terminal current slot is only excluded when the patch is *stale*, not when it is
the same terminal status.

Reproduction with the real repository contract:

1. Append a v1 recipient slot
   `{ status: 'delivered', errorCode: 'terminal-provider-error', requestedTransport: 'sms' }`.
2. Call `applyRecipientSendResult(..., { status: 'delivered' })`.
3. The condition is eligible (`statusSame`), the new helper returns true, and
   the update emits `REMOVE #dr.#mk.#error`; the terminal diagnostic disappears.

This violates the accepted persistence-review constraint that a duplicate
terminal callback without an error must retain terminal delivery diagnostics
(`docs/superpowers/reviews/2026-08-31-message-transport-fidelity/task-3-persistence-review-adjudications.md:7`), and the direct brief requirement that the new classification never clear them. The current test covers only duplicate `failed`
(`app/test/messagesRepo.transport.test.ts:461-476`), so it cannot catch this
second terminal status.

Keep the queued `accepted` correction, but restrict cleanup to a non-terminal
successful result (at minimum `queued` and `sent`), or independently prohibit
cleanup when the stored slot is terminal. Add real DynamoDB Local coverage for
the duplicate delivered slot above; update/retain fake parity with the same case.

## Cold checks

- The new `queued` classification correctly covers Twilio `accepted`,
  `scheduled`, `queued`, and `sending`: the adapter maps those states to queued
  (`app/src/adapters/messaging.ts:557-573`), and the added real-repository test
  proves same-status queued success clears the old transient error while retaining
  first SID/time (`app/test/messagesRepo.transport.test.ts:345-384`).
- Existing error, SID/time, actual-transport, and final conditional-race logic is
  otherwise unchanged by this three-file correction. The fake imports and uses the
  same classifier as production (`app/test/helpers/twilioWebhookHarness.ts:88-99,
  :1464-1473`), so the identified terminal-delivered loss has fake parity rather
  than being a production-only discrepancy.
- I did not run the focused repository test: the required defect is deterministically
  visible in the emitted branch logic, and the preceding focused attempt was unable
  to load Vitest because this sandbox returned EPERM before test discovery (recorded
  in `.superpowers/sdd/task-3-fix-wave-1-rereview.md:69-72`). No working-tree files
  were changed by this review apart from this report.

PARTIAL/NEEDS_FIX
