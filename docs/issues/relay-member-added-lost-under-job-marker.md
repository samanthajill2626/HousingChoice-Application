---
id: relay-member-added-lost-under-job-marker
title: A new relay member's intro and the group's join notice are silently lost when a read or the append fails after the relay.memberAdded job marker is claimed
type: bug
severity: med
status: open
area: app/messaging-relay
created: 2026-09-25
refs: app/src/jobs/relayFanOut.ts:901, app/src/jobs/relayFanOut.ts:908, app/src/jobs/relayFanOut.ts:931, app/src/services/relayAnnouncements.ts:181, app/src/services/relayAnnouncements.ts:229, app/src/services/relayAnnouncements.ts:360, app/src/services/relayMembers.ts:259
---

**Problem.** When a member is added to a relay group,
`addMemberToRelay` enqueues ONE `relay.memberAdded` job
(`app/src/services/relayMembers.ts:259-271`). The job sends the group a join
notice and sends the new member the naked intro - their only context, since a
relay member sees no history.

The handler claims the per-job execution marker first
(`app/src/jobs/relayFanOut.ts:901`), then reads the conversation (`:908`) and
calls `sendRelayAnnouncement` (`:931`), which reads the conversation again
(`app/src/services/relayAnnouncements.ts:181`) and appends the announcement row
(`:229`). All three awaits are unguarded and all three run before any text is
sent. A throw fails the job; the SQS redelivery carries the same `jobId`, the
marker suppresses it, it returns successfully and the message is deleted
([throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md)
shape). Nothing re-enqueues it: the add already returned success and will not
announce again.

Lost: the new member's intro and the join notice to everyone else, plus the
thread bubble. One `job failed` ERROR line is the only trace, while the member
IS on the roster and will start receiving relayed texts from a number that
never introduced itself.

The per-member catch (`relayAnnouncements.ts:360`) has the same send-shaped
defect described in
[relay-intro-lost-under-job-marker](./relay-intro-lost-under-job-marker.md): an
ambiguous provider error or a post-send write failure marks a delivered leg
`failed`.

**Suggested fix.** Same two parts as the intro, per the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md)
Sec 9:

- Not a send: local error handling for the pre-send reads
  (`relayFanOut.ts:908`, `relayAnnouncements.ts:181`, `:229`) - re-enqueue under
  a fresh `jobId` (bounded) or record a visible failure; never throw into the
  marker.
- Send-shaped: adopt the send-outcome core + the send-attempt record once
  `feat/send-outcome-reconcile` lands (D1-D3 classification, the D7a phase
  split, reconcile for `unknown`), in `sendRelayAnnouncement`, which both jobs
  share.

**Related.**
[relay-intro-lost-under-job-marker](./relay-intro-lost-under-job-marker.md),
[roster-action-lost-on-post-claim-error](./roster-action-lost-on-post-claim-error.md)
(a deferred add can also skip this enqueue entirely). Sweep finding F3 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/marker-sweep-findings.md`.
