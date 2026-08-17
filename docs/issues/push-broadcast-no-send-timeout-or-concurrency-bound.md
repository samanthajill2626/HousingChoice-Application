---
id: push-broadcast-no-send-timeout-or-concurrency-bound
title: The fire-and-forget push broadcast has no per-send timeout and no in-flight bound, so a hung push vendor accumulates invisible pending broadcasts
type: improvement
severity: low
status: open
area: app/push
created: 2026-08-17
refs: app/src/adapters/webPush.ts, app/src/services/pushService.ts, app/src/routes/webhooks/twilio.ts, app/src/services/inboundEmail.ts
---

Found by the planner's plan-blind adversarial review of inbound-message-push
(2026-08-17); adjudicated FILE, not fix - correct observation, team-scale
consequence, no decision changed.

**What is missing.** The web-push adapter passes only VAPID + urgency + an
optional TTL to `webpush.sendNotification`; no `timeout`. A hung FCM/APNs
socket therefore leaves a send pending with no deadline. One broadcast is
fully serial (devices, then users), and the emit sites are `void
pushService.sendToAll(...)` with no in-flight counter, queue, or cap. So if
the push vendor degrades and holds connections while inbound messages keep
arriving, each message starts a broadcast that never finishes; the webhook
acks fine the whole time (that is the point of fire-and-forget), and the
growing set of pending sends - each holding a serialized payload and a live
socket - is invisible until the process degrades on sockets/heap.

The serial-devices comment in pushService.ts ("a founder has at most a few
devices, cap 10") was written for sendToUser; sendToAll multiplies it by the
user count and the inbound rate.

**Also missing.** No test pins the fire-and-forget contract itself: the
harness fake resolves immediately, so an accidental `await` on the emit
would not turn anything red.

**Suggested fix.** (a) Pass `timeout` (the web-push option, milliseconds) in
the adapter - a one-line change shared with the voice sends, pick something
like 10s. (b) A tiny in-flight gauge on the broadcast (count + a WARN when it
exceeds N) so a vendor stall is visible in logs. (c) A test that resolves the
fake sendToAll only after the webhook has already acked (or checks the
returned promise is not awaited), pinning fire-and-forget. None of this
changes behavior at team scale today.
