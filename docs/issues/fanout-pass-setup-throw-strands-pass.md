---
id: fanout-pass-setup-throw-strands-pass
title: A throw in a fan-out pass's setup, before any recipient is attempted, strands the whole pass under the job marker
type: bug
severity: med
status: open
area: jobs
created: 2026-09-25
refs: app/src/jobs/broadcastFanOut.ts:234, app/src/jobs/broadcastFanOut.ts:246, app/src/jobs/broadcastFanOut.ts:317, app/src/jobs/broadcastFanOut.ts:337, app/src/jobs/relayFanOut.ts:749, app/src/jobs/relayFanOut.ts:761, app/src/jobs/relayFanOut.ts:786, app/src/jobs/relayFanOut.ts:1049, app/src/jobs/relayFanOut.ts:1119, app/src/jobs/relayFanOut.ts:1495, app/src/jobs/relayFanOut.ts:1504, app/src/jobs/relayFanOut.ts:1559, app/src/jobs/relayFanOut.ts:1589
---

**Problem.** Both fan-outs claim the per-job execution marker first
(`app/src/jobs/broadcastFanOut.ts:234`, `app/src/jobs/relayFanOut.ts:749`) and
then do per-PASS setup before the recipient loop:

- **Broadcast:** the broadcast read (`broadcastFanOut.ts:246`), the unit read
  for the merge fields (`:317`), and the durable pass claim
  (`claimFanoutPass`, `:337`).
- **Relay:** the conversation read (`relayFanOut.ts:761`), the source-message
  read (`:786`), the versioned preflight that seeds each member's slot
  (`preflightVersionedRecipients`, `:1049`, which also throws outright on four
  unexpected outcomes at `:1495`, `:1504`, `:1559` and `:1589`), and the pass
  claim (`:1119`).

None of these is guarded. A throw - typically a DynamoDB read or write failure -
fails the job, and the SQS redelivery carries the same `jobId`, is suppressed by
the marker and returns successfully. Every recipient of that pass is left
un-attempted: on a first pass that is the whole audience, with each slot
`queued` and a broadcast row stuck at `sending`; on a continuation it is every
recipient the ladder had deferred. Nothing repairs it and the only trace is one
`job failed` ERROR.

This is the anchor's
([throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md))
shape moved up from the per-recipient send to the pass setup.
`feat/send-outcome-reconcile` fixes the per-recipient case (its D7a phases:
"nothing in any phase throws out of the loop") but records the per-PASS setup
as residue, not closed (design Sec 1, guarantee 2). Its trigger is narrower
than the anchor's - no Twilio error reaches it - which is why it is med rather
than high; its blast radius is the whole pass.

**Suggested fix.** Found along the way (the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9); not a send - local error handling in the pass setup, with the sweeper
as the backstop. Nothing has been sent when the setup fails, so the pass can
safely re-enqueue itself under a FRESH `jobId` (bounded, so a persistent
failure ends in an honest close rather than a loop), or close the pending
recipients with an internal code and finalize - but it must not throw into the
marker. Any close here follows the attempt-record gate (SOR D8) once that
record exists. [send-attempt-sweeper](./send-attempt-sweeper.md) is the
backstop for a crash in the same window.

**Related.**
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md),
[fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md),
[relay-staleness-alarm-assumed-not-built](./relay-staleness-alarm-assumed-not-built.md),
[send-attempt-sweeper](./send-attempt-sweeper.md). Presentation finding 8 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/presentation-findings.md`
names the related per-recipient throws outside the send try, which the
send-outcome design's D7a covers.
