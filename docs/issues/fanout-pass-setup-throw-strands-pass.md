---
id: fanout-pass-setup-throw-strands-pass
title: A throw in a fan-out pass's setup, before any recipient is attempted, strands the whole pass under the job marker
type: bug
severity: med
status: open
area: jobs
created: 2026-09-25
updated: 2026-09-27
refs: app/src/jobs/broadcastFanOut.ts:383, app/src/jobs/broadcastFanOut.ts:398, app/src/jobs/broadcastFanOut.ts:503, app/src/jobs/broadcastFanOut.ts:528, app/src/jobs/broadcastFanOut.ts:1062, app/src/jobs/relayFanOut.ts:830, app/src/jobs/relayFanOut.ts:842, app/src/jobs/relayFanOut.ts:875, app/src/jobs/relayFanOut.ts:1146, app/src/jobs/relayFanOut.ts:1305, app/src/jobs/relayFanOut.ts:1461, app/src/jobs/relayFanOut.ts:2267, app/src/jobs/relayFanOut.ts:2276, app/src/jobs/relayFanOut.ts:2333, app/src/jobs/relayFanOut.ts:2365, app/src/jobs/relayRetryLeg.ts:361, app/src/jobs/relayRetryLeg.ts:396, app/src/jobs/relayRetryLeg.ts:401, app/src/jobs/relayRetryLeg.ts:496, app/src/jobs/relayRetryLeg.ts:743, app/src/jobs/relayRetryLeg.ts:780, app/src/jobs/relayRetryLeg.ts:967
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

## 2026-09-27 - feat/send-outcome-reconcile (SOR Stage 1)

Still open, and wider than filed. The build made every per-RECIPIENT unit
total - nothing in it throws out of the loop (spec D7a) - so what remains is
every throw a pass makes OUTSIDE its units, after the job marker. Each fails
the job under the marker and strands what the pass carried; on a re-drive pass
or rung, a `redriven` attempt record stays `redriven`. Anchors at the branch's
HEAD (the ones above predate it); the throw points are the build's (S2a, S2b
and S2c residues, build finding T9-7):

- **Broadcast** (`app/src/jobs/broadcastFanOut.ts`): the marker put (`:383`);
  the snapshot read (`:398-401`, now strongly consistent on a continuation or
  re-drive); the unit read (`:503-506`); the up-front pass claim (`:528`); and,
  new on this branch, a RE-DRIVE pass's post-loop pass claim (`:1062`), whose
  throw strands the re-drive's remainder - a record `redriven` or
  `done`/`retryable` beside a `queued` / `send_retryable` slot.
- **Relay fan-out** (`app/src/jobs/relayFanOut.ts`): the marker put (`:830`);
  the conversation read (`:842`); the source read (`:875-877`); the in-memory
  transport classification (`:1091`) and media-only body (`:1117`), listed for
  completeness; the versioned preflight (`:1146`, `preflightVersionedRecipients`
  at `:2241-2311`), which throws on an unexpected initialize outcome
  (`:2266-2267`), a missing slot (`:2276`), a source that is missing or whose
  schema changed (`readVersionedSource`, `:2324-2336`, read at `:2272`,
  `:2289` and `:2310`)
  and an aggregation-state conflict (`setVersionedAggregationState`,
  `:2344-2366`) - any of which can strand a re-drive pass's `redriven` record;
  the up-front pass claim (`:1305`); and the post-loop pass claim (`:1461`).
- **Relay retry rung** (`app/src/jobs/relayRetryLeg.ts`; added at build time,
  spec Sec 9): after the marker (`:482-491`), the consistent retry-row read and
  its not-found throw (`:496-498`); the lineage throw (`:361`, via
  `:503-506`); the conversation read (`:743`); the gate evaluator's suppression
  reads (`:744-752`); the no-pool-number throw (`:780`); the transient arm's
  pass claim (`:967-971`); the gated closes' own writes - `refuseGate`
  (`:586`, `:591`) and `closeTerminally` (`:607`); and, new on this branch,
  the record gate's own read and takeover (`gateFor`, `:396` and `:401`),
  reached from all six gated close sites (`:756`, `:808`, `:975`, `:1000`,
  `:1023`, `:1047`).

The lazy repo and adapter constructors run BEFORE each marker
(`broadcastFanOut.ts:355-375`, `relayFanOut.ts:803-811`,
`relayRetryLeg.ts:447-456`), so a throw there is a genuine SQS retry, not a
strand; so is a marker put that fails before its write lands. A marker put
whose write landed but whose response was lost is suppressed like the rest.

The suggested fix above stands, and the record gate it names now exists
(`gateFor`: `broadcastFanOut.ts:256-265`, `relayFanOut.ts:1663-1672`,
`relayRetryLeg.ts:395-404`). The `finalize` throw at the end of a broadcast
pass is recorded with the close paths
([fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md),
2026-09-27 section); a record any of these leaves open is
[send-attempt-sweeper](./send-attempt-sweeper.md)'s to find.
