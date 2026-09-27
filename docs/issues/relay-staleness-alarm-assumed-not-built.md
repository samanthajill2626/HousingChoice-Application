---
id: relay-staleness-alarm-assumed-not-built
title: The dashboard's relay delivery rules assume a server-side relay staleness alarm that does not exist, so a relay leg whose dispatch never happened never escalates anywhere
type: bug
severity: med
status: open
area: app+dashboard/messaging-relay
created: 2026-09-25
updated: 2026-09-27
refs: dashboard/src/routes/contact/deliveryStatus.ts:251, dashboard/src/routes/contact/deliveryStatus.ts:274, dashboard/src/routes/contact/deliveryStatus.ts:298, app/src/jobs/relayFanOut.ts:1982, app/src/services/groupSendStaleness.ts:1, app/src/jobs/groupGuardrails.ts:7, app/src/services/groupSend.ts:679
---

**Problem.** The dashboard decides when a relay leg looks overdue ("Queued - not
confirmed"). A `queued` leg with no `sentAt` never ages
(`dashboard/src/routes/contact/deliveryStatus.ts:202`), on purpose: that shape
is byte-identical for a held connect-when-ready message about to send and for a
fan-out that never ran, and a false red on the first would teach staff to
ignore the cue. The comment justifying it (`:217-223`) ends: "The cost is that
the whole 'our dispatch never happened' class can never escalate here; the
server's own staleness alarm covers it." (That sentence is gone as of the
2026-09-27 section below.)

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

## 2026-09-27 - feat/send-outcome-reconcile (SOR Stage 1)

**The comment is corrected - the cheap first step is done.** The false
sentence is gone (plan Task 13, build finding T13-3 and ruling A6). The S3
staleness table (`dashboard/src/routes/contact/deliveryStatus.ts:245-255`,
the `queued` rows at `:251-252`) and its reasoning (`:263-282`) now say that
the class which stays silent - dispatch never happened, or its clock was
erased - has no alarm anywhere else either, and name this issue (`:280-282`).

**D20a is built: a CLAIMED relay leg now ages.** The claim stamps OUR attempt
clock `attemptedAt` on the leg's slot before the provider call
(`app/src/jobs/relayFanOut.ts:1979-1991`, best-effort), and a `queued` leg with
no `sentAt` ages from it (`deliveryStatus.ts:298-301`) into "Queued - not
confirmed" after the same 15-minute budget. A leg nothing has claimed - its
fan-out never ran (a released message whose fan-out was never enqueued, or a
first pass that threw before its first recipient), or a hold - still carries
no clock and still never ages, and so does a legacy leg whose clock a
whole-slot write erased. For that class the server-side alarm is still owed,
and it stays with the sweeper
([send-attempt-sweeper](./send-attempt-sweeper.md)). Status stays open; the
refs above are re-anchored at HEAD.
