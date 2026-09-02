# Task 4 fix wave 1 report

Commit: `25171778 fix: source native group transport from adapter`

## Contract shipped

- Added `nativeGroupInboundActualTransport()` to
  `app/src/adapters/groupConversations.ts`. It is the adapter-owned statement
  that the current Twilio Conversations classic native-group rail is Group MMS.
- Replaced the generic webhook's inline `actualTransport: 'mms'` with that
  adapter authority in `app/src/routes/webhooks/twilio.ts`.
- Added a signed native-group webhook regression that spies on the adapter
  authority with a non-default `rcs` sentinel. The persisted inbound row follows
  the authority, proving the route does not fabricate the rail fact. Existing
  coverage continues to prove the unmocked native-group result is MMS.

## TDD proof

- Initial focused test attempt: pre-execution Vite `.vite-temp` `EPERM`; no
  test ran. Reran in the allowed environment as required by the brief.
- Red: `npm run test -w @housingchoice/app -- test/groupTextWebhook.test.ts`
  exited 1 with 61 passed and 1 failed: the regression reported
  `nativeGroupInboundActualTransport does not exist`.
- Green: the same command exited 0 with 62 passed.
- `npm run typecheck -w @housingchoice/app` exited 0.

## Scope

Only the approved adapter, generic webhook, and signed webhook test changed.
No group outbound, receipt, direct/relay status, seed, or UI behavior changed.
