# Task 4 fix-wave 1 cold re-review

Reviewed commit: `25171778 fix: source native group transport from adapter`

## Scope swept

- Native group message filing has one reachable append path: the
  `OtherRecipients` handler in `app/src/routes/webhooks/twilio.ts:1733-1746`.
  The three relay/closed-relay inbound append paths and ordinary 1:1 fallback
  continue to consume the ordinary Twilio evidence normalizer; they do not
  claim the native Group MMS rail fact.
- `app/src/routes/webhooks/twilioEvents.ts` is a cross-check/receipt endpoint,
  not a second native-group inbound message filer. `groupReceipts.ts` mutates
  recipient delivery slots only. The native outbound writer remains
  `groupSend.ts`, which already obtains its transport result from the group
  adapter.

## Re-review result

The accepted P1 is fixed. `nativeGroupInboundActualTransport()` resides at the
Twilio Conversations provider boundary in
`app/src/adapters/groupConversations.ts:44-46` and is the sole native-group
inbound rail authority. The generic SMS webhook now consumes it at
`app/src/routes/webhooks/twilio.ts:1742`; it no longer contains an MMS literal
or derives actual transport from media, the envelope, the ordinary SMS
normalizer, or a SID.

The new test is meaningful rather than a mirror of the literal. It replaces
that exported authority with `rcs`, posts a signed native-group envelope, and
requires both an invocation and a persisted `actual_transport: 'rcs'`
(`app/test/groupTextWebhook.test.ts:79-94`). Reverting the route to the former
literal makes that persisted assertion fail. `afterEach(vi.restoreAllMocks)`
keeps the seam from leaking into the rest of the file. The `MessageTransport`
return type is the shared closed transport union, so the filer cannot accept an
untyped provider value.

No additional native-group inbound route, generic rail fact, default/failure
behavior, type-boundary, or mock-isolation issue was found. The default remains
the current adapter-owned Group MMS observation; the test-only non-MMS return
demonstrates that the webhook stores only adapter-provided authority.

## Focused verification

Attempted only the permitted focused test:

```text
npm run test -w @housingchoice/app -- test/groupTextWebhook.test.ts
```

It did not start because Vite could not create
`app/node_modules/.vite-temp/vitest.config.ts.timestamp-1788293861904-7374fd2abc5ef8.mjs`
on Windows (`EPERM`, exit 1). This is the same pre-test file-lock condition
recorded by the first Task 4 review, so it supplies no assertion result.

CONFORMS/PASS
