---
id: relay-staleness-alarm-assumed-not-built
title: The dashboard's relay delivery rules assume a server-side relay staleness alarm that does not exist, so a relay leg whose dispatch never happened never escalates anywhere
type: bug
severity: med
status: open
area: app+dashboard/messaging-relay
created: 2026-09-25
refs: dashboard/src/routes/contact/deliveryStatus.ts:202, dashboard/src/routes/contact/deliveryStatus.ts:217, dashboard/src/routes/contact/deliveryStatus.ts:221, app/src/services/groupSendStaleness.ts:1, app/src/jobs/groupGuardrails.ts:7, app/src/services/groupSend.ts:679
---

**Problem.** The dashboard decides when a relay leg looks overdue ("Queued - not
confirmed"). A `queued` leg with no `sentAt` never ages
(`dashboard/src/routes/contact/deliveryStatus.ts:202`), on purpose: that shape
is byte-identical for a held connect-when-ready message about to send and for a
fan-out that never ran, and a false red on the first would teach staff to
ignore the cue. The comment justifying it (`:217-223`) ends: "The cost is that
the whole 'our dispatch never happened' class can never escalate here; the
server's own staleness alarm covers it."

There is no such alarm for relay. The only delivery-staleness sweep is the
native group-text one (`app/src/services/groupSendStaleness.ts`, run from
`app/src/jobs/groupGuardrails.ts:7`), and it reads due rows that only the native
group send writes (`app/src/services/groupSend.ts:679`). Nothing watches a relay
source whose legs sit `queued` without a `sentAt`.

So the class the comment hands off is not covered anywhere. Several filed loss
modes produce exactly that shape and are therefore invisible on both sides:
[relay-number-ready-post-flip-enqueue-loss](./relay-number-ready-post-flip-enqueue-loss.md)
(a released message whose fan-out was never enqueued),
[fanout-pass-setup-throw-strands-pass](./fanout-pass-setup-throw-strands-pass.md)
(a pass that threw before its first recipient), and
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md)
(every recipient after the one that threw).

`feat/send-outcome-reconcile` narrows it for legs a send site has CLAIMED: its
D20a ages a `queued` leg with no `sentAt` from the attempt record's
`attemptedAt`. A leg that was never claimed - the fan-out never ran - still
never ages.

**Suggested fix.** Found along the way (the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9); the sweeper group - that section places "the relay staleness alarm the
dashboard assumes" in the Stage 2 sweeper's scope
([send-attempt-sweeper](./send-attempt-sweeper.md)). Either build the server-side
alarm the comment promises (a relay source with non-terminal, unclaimed legs
past a bound raises one ERROR), or correct the comment so the next reader does
not rely on a detector that is not there. Correcting the comment alone is the
cheap first step and should not wait for the sweeper.

**Related.** [send-attempt-sweeper](./send-attempt-sweeper.md),
[relay-hub-message-delivery-status-never-terminal](./relay-hub-message-delivery-status-never-terminal.md).
Presentation finding 7 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/presentation-findings.md`.
