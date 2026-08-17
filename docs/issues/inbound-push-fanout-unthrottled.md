---
id: inbound-push-fanout-unthrottled
title: An unauthenticated inbound texter or emailer can trigger an unthrottled push fan-out that shares a VAPID identity with the voice alerts
type: improvement
severity: low
status: open
area: app/push
created: 2026-08-17
refs: app/src/services/pushService.ts, app/src/routes/webhooks/twilio.ts, app/src/services/inboundEmail.ts, app/src/app.ts, docs/superpowers/specs/2026-08-16-inbound-message-push-design.md
---

**Problem.** Since the inbound-message-push feature, anyone on the internet who
texts the business number or emails the inbound address causes a push fan-out
to every subscribed staff device, with a title and body they choose. There is
no rate limit anywhere on that chain: `createRateLimit` is mounted only on `/p`
and `/unit-media` (`app/src/app.ts`), the webhooks router has none, and
`sendToAll` has no per-kind throttle, no coalescing window, and no cap on
broadcasts per minute.

This is NOT a defect in the build. Spec decision D2
(`docs/superpowers/specs/2026-08-16-inbound-message-push-design.md`) chose
native-messaging semantics deliberately - per-conversation coalescing via the
notification tag, alerting on every message, and explicitly "NO additional
server-side throttle" - and section 5 accepts the resulting volume in writing.
Filed as a consequence worth tracking, not as a bug to fix silently.

The NEW information, which the spec did not weigh, is the COLLATERAL risk to a
different and higher-value feature. Message and unmatched-email pushes ride the
SAME VAPID identity as the `pre_ring` and `missed_call` voice pushes - the
time-critical alerts the founder's call workflow depends on. If sustained
inbound spam ever got that identity throttled or blocked by FCM/APNs, it would
degrade the voice alerts too, even though nothing on the voice path misbehaved.
The blast radius of the accepted volume decision is therefore wider than
"noisy notifications".

Secondary, already implied by D2: an attacker rotating source numbers or
addresses rotates the notification tag too, so per-conversation coalescing does
not damp the alert rate; and an unmatched-email push renders attacker-authored
text in a first-party-looking notification.

**Suggested fix.** Either a cheap per-process token bucket on `sendToAll` (N
broadcasts per minute, dropping and counting the excess into the existing
aggregate log line), which bounds every consequence without touching the happy
path; or a separate VAPID identity per push class, so a throttle earned by the
message kinds cannot reach the voice kinds. The two are complementary - the
token bucket limits the volume, the split identity contains the fallout if it
is ever exceeded.
