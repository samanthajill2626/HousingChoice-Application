---
id: refusal-stamp-announce-extra-round-trips
title: The gate-refusal announce re-reads a row updateCallStatus already held - 5 DynamoDB round trips before the hangup TwiML
type: debt
severity: low
status: open
area: app/voice-webhooks
created: 2026-08-19
refs: app/src/routes/webhooks/voice.ts:1038, app/src/routes/webhooks/voice.ts:1107, app/src/routes/webhooks/voice.ts:1258, app/src/routes/webhooks/voice.ts:1304, app/src/repos/messagesRepo.ts:1082, app/src/repos/messagesRepo.ts:2172, app/src/repos/messagesRepo.ts:1650
---

**Problem.** Each of the three voice gate-refusal branches now stamps the call
terminal and then announces the stamp to any open contact timeline, and the
announce pays for a lookup the stamp already did.

`announceRefusalStamp` (`app/src/routes/webhooks/voice.ts:1038`) needs the row's
`conversationId`, `tsMsgId`, `direction`, and `delivery_status` to build the
`message.persisted` payload, and recovers them with
`messages.getByProviderSid(parentCallSid)`. That helper
(`app/src/repos/messagesRepo.ts:1650`) is TWO sequential round trips: a sid-pointer
get, then an item get on the resolved key.

`messages.updateCallStatus` has already performed the identical lookup
internally - `app/src/repos/messagesRepo.ts:2172` calls the same
`getByProviderSid` before its conditional write - and then DISCARDS the row it
resolved, returning only a boolean.

So a refusal that transitions the row costs:

1. sid-pointer get (inside `updateCallStatus`)
2. item get (inside `updateCallStatus`)
3. the conditional `UpdateCommand`
4. sid-pointer get (inside `announceRefusalStamp`)
5. item get (inside `announceRefusalStamp`)

Five sequential DynamoDB round trips, up from three, and they run on the one path
in this feature where a human is holding a silent line waiting for the hangup
TwiML. Twilio's TwiML fetch ceiling is 15 seconds. The swallowing try/catch around
each call bounds ERRORS, not LATENCY: a slow-but-succeeding read still delays the
response. The three call sites are
`app/src/routes/webhooks/voice.ts:1107` (the `/outbound-bridge` unresolved-target
branch), `:1258` (the whisper gate's unresolved target/business branch), and
`:1304` (the DNC re-check branch).

This is latency debt, not a correctness bug: the added reads are two point gets on
a hot key, and the whole announce is best-effort.

**Suggested fix.** Have `updateCallStatus` return the resolved row alongside its
boolean (for example `{ updated: boolean; item?: MessageItem }`, or the updated
item's `ReturnValues`) so `announceRefusalStamp` can build its payload from what
the caller already has and cost zero extra reads.

Deliberately NOT done in the originating change (`feat/comms-panel-call-direction`
fix wave): it is a repository signature change on
`app/src/repos/messagesRepo.ts:1082`, a method with many existing callers across
the voice and messaging routes, in a file that change did not otherwise touch, and
it would have landed after the branch's review pass. The saving is roughly a
hundred milliseconds on a bounded, best-effort path - not proportionate to that
blast radius under a calls-scoped mission.
