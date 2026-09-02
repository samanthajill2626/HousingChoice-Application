# Task 7 adversarial review: native Group MMS transport

Reviewed commit `d5a4657d` against the live group adapter, receipt repository
writers, signed Conversations webhook, native inbound filing, and the dashboard
group-thread projection. This was an adversarial review; no feature files were
edited.

## Verdict

CONFORMS / PASS. No must-fix finding found.

## Evidence reviewed

- `app/src/services/groupSend.ts:395-408` gets the intent and prepared post from
  the group adapter. `app/src/services/groupSend.ts:624-637` records that
  returned intent/result on the parent and every non-suppressed slot without
  inspecting content, `type`, media, or the roster to infer a rail.
- `app/src/services/groupSend.ts:651-678` retains legacy `type: 'sms'` while
  persisting schema version 1, requested/actual transport, attempted slots, and
  requested-only excluded suppression slots.
- `app/src/adapters/groupConversations.ts:710-718,806-838` is the boundary that
  declares and observes the Group MMS rail. The post result returns authoritative
  MMS regardless of the legacy message type; optional channel-SID evidence can
  only warn on conflict.
- `app/src/routes/webhooks/twilio.ts:1733-1745` files native inbound actual MMS
  through `nativeGroupInboundActualTransport()`, not body/media or `SM`/`MM`
  inference.
- `app/src/services/groupReceipts.ts:394-443,475-535` treats a channel SID as
  corroboration only, copies only an already-authoritative parent fact to a
  recipient slot, keeps SID/status/actual writes independent, and emits SSE only
  for a real status or transport change. `app/src/repos/messagesRepo.ts:3139-3206`
  supplies conditional child-field writes, so that update cannot replace the
  entire delivery slot or overwrite an established non-RCS actual rail.
- `app/src/routes/webhooks/twilioConversations.ts` remains signature-gated and
  forwards the live `ChannelMessageSid` / `ParticipantSid` payload shape to the
  receipt service; `app/test/groupConversationsWebhook.test.ts:24-38,85-100`
  pins that bridge.
- No generic native-group transport inference, receipt-SID overwrite, actual/status
  coupling, legacy type drift, or dashboard projection bypass was found in the
  consumer/mutator sweep.

## Focused verification

`npm run test -w @housingchoice/app -- test/groupSend.test.ts test/groupReceipts.test.ts test/groupConversationsWebhook.test.ts test/groupSendRepo.integration.test.ts`

Exit 0: 4 files passed, 122 tests passed, duration 7.56s. The initial sandboxed
attempt could not create Vite's temporary config bundle (`EPERM`); the approved
worktree run above completed cleanly.
