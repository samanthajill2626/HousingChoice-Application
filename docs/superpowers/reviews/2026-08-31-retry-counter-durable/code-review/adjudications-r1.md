# Code review round 1 - adjudications

Two parallel reviewers on the feature diff (merge-base 1af02926..d2d15b4e):
conformance (spec + plan + work map) and adversarial (plan-blind by standing
mandate - diff, repo, charter only). Reports committed beside this file as
r1-conformance.md and r1-adversarial.md. Adjudicated by the orchestrator; the
two sharpest claims re-verified directly against the tree before ruling.

Counts: conformance - all work-map items CONFORMS, one recorded deviation
(S6 in-region fix-or-file), 0 must-fix, 6 notes. Adversarial - 0 must-fix,
3 should-fix, 6 notes.

## Should-fix adjudications

### SF1 - "D20's exemption rationale is false: a native group-text 30003 leg
### still prints 'will retry' and no leg retry exists." ACCEPT the evidence,
### REJECT the remedy on this branch. FILED.

Re-verified: BOTH halves are true, at different levels.

- The spec's R4-6 fact holds at the MESSAGE level: the 30003 arm of the
  status webhook resolves `messages.getByProviderSid(MessageSid)` and enqueues
  `retrySend` (twilio.ts:2567) with no `group_text` guard, so a message-level
  group-text 30003 DOES reach the retry enqueue.
- The reviewer's fact holds at the LEG level: per-recipient group-text codes
  are written by the Conversations receipts side (groupReceipts.ts:422), which
  enqueues no retry - and `rollUpAggregate` copies the worst leg's code onto
  the message row, so the per-recipient row's "will retry" describes a retry
  that path never schedules.

Changing group-text copy is out of this branch's scope TWICE over: spec Sec 2
fences "native group-text receipt behavior", and relay-30003-retry-lineage's
own scope guard says any extension to those paths "requires separate evidence
and explicit scope". This finding IS the separate evidence - filed as
`group-text-30003-leg-retry-promise-unverified` so the next mission starts
from the trace instead of from D20's one-level rationale. Behavior unchanged
here; the D20 pin test (Timeline.delivery.test.tsx:517) stays as the record
of today's deliberate behavior.

This is instance five of the mission's named failure pattern - a mechanism
credited by name without tracing whether it is on the path in question - and
this time it survived nine spec rounds because both reviewers checked
REACHABILITY of the enqueue, not WHICH ROW's failure reaches it.

### SF2 - the close log line reports the advisory envelope attempt, not the
### durable counter. ACCEPT - FIXED in the wave.

Both closeBroadcast and closeRelay log `attempt: payload.attempt`. On close B
that prints `attempt: 1` beside `closeCode: transient_cap` while the durable
counter that forced the close reads 3 - an operator reading the one ERROR
line this branch promises would see a contradiction. Fix: log the claimed/
stored `fanout_attempt` (fanoutAttempt field), keep the envelope value as
`envelopeAttempt` for correlation.

### SF3 - "close C converts a transient enqueue fault into permanent recipient
### failures." REJECT - this re-litigates a settled spec decision.

The design considered exactly this trade twice. Round 1 (B5) ADOPTED the
reviewer's preferred shape - throw and let redelivery walk the durable
counter to the cap - and the scalar-check pass then PROVED that shape dead:
a post-throw redelivery carries the same jobId and is suppressed by the
execution marker, so nothing comes back (spec-r5, adjudications "the linchpin
failed"). With redelivery suppressed, an immediate close is the only path to
a terminal state; the alternative is the anchor bug (a broadcast stuck on
"Sending" forever). D9/D10 stand. The real residue the reviewer surfaced -
there is no re-drive tool for a closed broadcast (markSending is draft-only) -
is the same operational gap main's cap-close already has, and goes in the
handback as a note, not a change.

## Notes, all recorded with no change

- N1 (adversarial) non-atomic close loop / a crash mid-close leaves later
  slots queued under the suppressed redelivery: SAME-AS-MAIN - the old cap
  branch had the identical per-key loop under the identical marker.
- N2 double-finalize on a stale continuation: verified against finalize() -
  status is RE-DERIVED deterministically (allFailed ? markFailed : markSent),
  so no failed->sent flip is reachable; the duplicate best-effort
  `broadcast_sent` audit row on a stale all-terminal continuation is
  pre-existing (main's trailing finalize has the same shape).
- N3 close-B copy on an INBOUND relay source writes slots the UI never
  renders (delivery rows render on outbound bubbles only): true; the operator
  surface for that close is the ERROR log line; rendering inbound delivery
  is new UI scope nobody asked for.
- N4 the ladder lengthens the rail_creating hold by up to ~2s against the
  inline caller: true and bounded; the claim already spans multi-second
  Twilio calls.
- N5 reReadUntilBound returns the LAST read, not the best: that is D15 -
  the latest read is authoritative by decision.
- N6 test observations + conformance's stale broadcastFanOut.ts:563 comment
  (a slice-2-to-slice-6 handoff lapse): the comment is corrected in the fix
  wave; the test observations stand as notes.
- Conformance: the operator log message rename (both fan-outs now share
  'fan-out closed - remaining recipients marked failed' + closeCode field)
  is named in the handback for anything keying on the old cap string.

## Fix wave scope (one wave)

1. SF2: log the durable attempt in both closes (+ assert the field in the
   close tests).
2. The stale broadcastFanOut.ts:563 comment.
3. File `group-text-30003-leg-retry-promise-unverified` (SF1 evidence).
4. Commit the two review reports + this adjudication.
