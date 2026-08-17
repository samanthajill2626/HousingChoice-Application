---
id: inbound-push-fanout-unthrottled
title: Message pushes share a VAPID identity with the voice alerts, so an unthrottled inbound fan-out can degrade the founder's call notifications
type: security
severity: med
status: open
area: app/push
created: 2026-08-17
refs: app/src/services/pushService.ts, app/src/routes/webhooks/twilio.ts, app/src/services/inboundEmail.ts, app/src/app.ts, docs/superpowers/specs/2026-08-16-inbound-message-push-design.md
---

This issue carries TWO separable concerns. The first is a deliberate product
decision and is tracked only; the second is the reason the issue exists and is
NOT governed by any spec decision. A triage pass that closes the first must not
close the second with it.

**(1) Unthrottled fan-out volume - a deliberate decision, tracked only.**
Since the inbound-message-push feature, anyone on the internet who texts the
business number or emails the inbound address causes a push fan-out to every
subscribed staff device, with a title and body they choose. There is no rate
limit anywhere on that chain: `createRateLimit` is mounted only on `/p` and
`/unit-media` (`app/src/app.ts`), the webhooks router has none, and `sendToAll`
has no per-kind throttle, no coalescing window, and no cap on broadcasts per
minute.

That is not a defect in the build. Spec decision D2
(`docs/superpowers/specs/2026-08-16-inbound-message-push-design.md`) chose
native-messaging semantics deliberately - per-conversation coalescing via the
notification tag, alerting on every message, and explicitly "NO additional
server-side throttle" - and section 5 accepts the resulting volume in writing.
Section 4 lists rate limiting as an explicit non-goal, so building a throttle
would have been a spec violation, not a fix. Recorded here so the accepted
volume is visible to a future reader, not because it needs doing.

Two riders on the same decision: an attacker rotating source numbers or
addresses rotates the notification tag too, so per-conversation coalescing does
not damp the alert rate; and an unmatched-email push renders attacker-authored
text in a first-party-looking notification.

**(2) Shared VAPID identity across push classes - NOT covered by any spec
decision. This is the real problem.** Message and unmatched-email pushes ride
the SAME VAPID identity as the `pre_ring` and `missed_call` voice pushes - the
time-critical alerts the founder's call workflow depends on. If sustained
inbound spam ever got that identity throttled or blocked by FCM/APNs, it would
degrade the voice alerts too, even though nothing on the voice path
misbehaved.

D2 governs VOLUME. It says staff should be alerted on every message; it says
nothing about which key signs which push class, and no spec decision weighed
this collateral. The blast radius therefore lands on a different and
higher-value feature than the one whose volume was accepted, the trigger is
external and unauthenticated, and the failure is silent from the voice side -
hence `type: security` / `severity: med` rather than the volume note's
`improvement` / `low`.

**Suggested fix.** For (2), a separate VAPID identity per push class, so a
throttle earned by the message kinds cannot reach the voice kinds. That means
new secrets and terraform, so it needs an explicit human go (AGENTS.md) and was
correctly out of scope for the build branch. For (1), if real-world volume ever
proves noisy, the lever is a cheap per-process token bucket on `sendToAll` (N
broadcasts per minute, dropping and counting the excess into the existing
aggregate log line) - but that reopens D2 and is an operator decision, not an
engineering one. The two are complementary: the bucket limits the volume, the
split identity contains the fallout if it is ever exceeded.
