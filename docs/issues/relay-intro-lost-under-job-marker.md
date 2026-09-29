---
id: relay-intro-lost-under-job-marker
title: A relay group intro is silently lost when a read or the announcement append fails after the relay.intro job marker is claimed
type: bug
severity: med
status: open
area: app/messaging-relay
created: 2026-09-25
refs: app/src/jobs/relayFanOut.ts:830, app/src/jobs/relayFanOut.ts:839, app/src/jobs/relayFanOut.ts:867, app/src/services/relayAnnouncements.ts:168, app/src/services/relayAnnouncements.ts:181, app/src/services/relayAnnouncements.ts:229, app/src/services/relayAnnouncements.ts:266, app/src/services/relayAnnouncements.ts:344, app/src/services/relayAnnouncements.ts:354, app/src/services/relayAnnouncements.ts:360, app/src/services/relayProvisioning.ts:199, app/src/jobs/relayNumberReady.ts:176
---

**Problem.** The `relay.intro` job announces a new relay group to every member
from the group's pool number and persists that announcement in the thread. It
is enqueued once, by provisioning (`app/src/services/relayProvisioning.ts:199`)
or by `relay.numberReady` for a connect-when-ready group
(`app/src/jobs/relayNumberReady.ts:176`). Nothing ever enqueues it again.

The handler claims the per-job execution marker first
(`app/src/jobs/relayFanOut.ts:830`), then reads the conversation (`:839`) and
calls `sendRelayAnnouncement` (`:867`), which reads the conversation again
(`app/src/services/relayAnnouncements.ts:181`) and appends the announcement row
(`:229`) before its per-member loop. None of those three awaits is guarded. A
throw from any of them fails the job; the SQS redelivery carries the same
`jobId`, finds the marker taken and returns successfully, so the message is
deleted. The same defeated-redelivery shape as
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md).

`sendRelayAnnouncement`'s docblock says such a failure "propagates (nothing was
sent, the caller may retry)" (`relayAnnouncements.ts:168-170`). True that
nothing was sent - but no caller that holds a run-once marker can retry.

Lost: the intro to every member (the text that tells them who is in the group
and that it is Sam) and its thread bubble. The only trace is one `job failed`
ERROR line.

A second, send-shaped defect sits inside the per-member loop
(`relayAnnouncements.ts:266-381`). Its catch (`:360`) marks the member's slot
`failed` for ANY error - including an ambiguous provider error (a timeout after
Twilio may have accepted) and a failure of the writes AFTER a successful send:
the slot result (`:344`) and the `relaysid#` pointer (`:354`). In those cases
the member got the text and the slot says it failed, permanently (relay slots
are forward-only).

**Suggested fix.** Two parts, per the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md)
Sec 9:

- Not a send: local error handling for the pre-send database reads
  (`relayFanOut.ts:839`, `relayAnnouncements.ts:181`, `:229`). Nothing was sent
  when they fail, so the job can safely re-enqueue itself under a fresh `jobId`
  (bounded), or record a visible failure - but it must not throw into the
  marker.
- Send-shaped: adopt the send-outcome core + the send-attempt record from
  `feat/send-outcome-reconcile` (merged at `79b9479e`) - classify the per-member provider error
  (D1-D3), split the member unit into prepare / send / record phases (D7a) so a
  post-send write failure is `sent_unrecorded` rather than `failed`, and hand
  an `unknown` outcome to the reconcile job.

**Related.**
[relay-member-added-lost-under-job-marker](./relay-member-added-lost-under-job-marker.md)
(same announcement path, same fix),
[tour-reminder-lost-on-post-claim-send-error](./tour-reminder-lost-on-post-claim-send-error.md)
(group reminders use the same `sendRelayAnnouncement`),
[relay-number-ready-post-flip-enqueue-loss](./relay-number-ready-post-flip-enqueue-loss.md)
(the other way the intro is lost). Sweep finding F2 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/marker-sweep-findings.md`.
