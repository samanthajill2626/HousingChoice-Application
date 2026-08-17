---
id: message-push-payload-built-in-two-layers
title: The message-push payload contract is assembled independently in twilio.ts and inboundEmail.ts, with only one of them holding the choke point
type: debt
severity: low
status: open
area: app/push
created: 2026-08-17
refs: app/src/routes/webhooks/twilio.ts, app/src/services/inboundEmail.ts, app/src/lib/pushText.ts, dashboard/src/sw/display.ts
---

Found by the planner's plan-blind adversarial review of inbound-message-push
(2026-08-17); adjudicated FILE - maintainability, no behavior at stake today.

**What is duplicated.** The flat push payload `{ title, body, kind,
conversationId }` that the service worker reads is built in two places:
`emitMessagePush` in routes/webhooks/twilio.ts (which is a real choke point -
it caps title and body and is the only path for all four SMS sites) and
inline in services/inboundEmail.ts, twice (matched `message` in thread(),
`unmatched_email` in quarantineRow), each capping its own fields. The
service-worker contract (which fields exist, that they are FLAT and never
nested under `data`, the caps) is therefore known to three call sites and
one comment, not to one function.

**Why it matters later.** The next payload change (a new field the SW reads,
a different cap, an `actions` list) has to be made in three places, and the
"never nest under data" trap that already bit `/api/push/test` is only
protected by tests at each site.

**Suggested fix.** One `buildMessagePushPayload({ title, body, kind,
conversationId? })` in app/src/lib (next to pushText.ts) that caps and shapes
the payload, used by twilio.ts and inboundEmail.ts; the SW's PushDisplayData
type documents the same shape. Cheap; do it with the next payload change
rather than as a drive-by.
