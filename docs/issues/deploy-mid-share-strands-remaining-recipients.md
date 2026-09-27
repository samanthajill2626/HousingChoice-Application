---
id: deploy-mid-share-strands-remaining-recipients
title: A deploy during a share or relay fan-out kills the pass after 10 s and silently strands every recipient it had not reached - the redelivery is suppressed by the run-once marker and the untried recipients have no attempt record
type: bug
severity: high
status: open
area: app/jobs
created: 2026-09-27
refs: app/src/worker.ts:543, app/src/worker.ts:530, docker-compose.yml:39, app/src/lib/config.ts:302, app/src/jobs/broadcastFanOut.ts:817, app/src/jobs/broadcastFanOut.ts:351, app/src/jobs/broadcastFanOut.ts:869, app/src/jobs/broadcastFanOut.ts:891, app/src/jobs/broadcastFanOut.ts:1146, app/src/jobs/broadcastFanOut.ts:1527, app/src/jobs/relayFanOut.ts:829, infra/modules/jobs/main.tf:36
---

**Found by.** The planner's post-build review of `feat/send-outcome-reconcile`
(2026-09-27), adversarial finding H-1
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/planner-review/adversarial.md`).
Anchors at HEAD `91a66577` (the code is identical to the code-final commit
`52220729`).

**Pre-existing, not introduced by that branch.** The same kill stranded a
share before the branch. It is filed now because it is the commonest way a
send strands (every deploy that lands during a share), because the branch's
own takeover never reaches it, and because the sweeper as filed would miss
most of it (see "Why the planned sweeper misses it" below).

**Problem.** A worker deploy cuts a fan-out pass in the middle of its
recipient loop, and nothing ever resumes it:

1. **The worker drains for at most 10 s.** On SIGTERM the worker stops
   polling and waits for in-flight jobs, but arms a hard `process.exit(0)`
   10 s later (`app/src/worker.ts:530-556`, the timer at `:543`).
   `docker-compose.yml` sets no `stop_grace_period` for the `worker` service
   (`:39-51`), so Docker's own 10 s default SIGKILLs it at the same point
   anyway.
2. **A pass is paced at about 1 text per second.** The shared A2P bucket
   admits `A2P_RATE_LIMIT_PER_SEC`, default 1.0
   (`app/src/lib/config.ts:302`), and the broadcast pass draws one token per
   recorded send (`afterSend`, `app/src/jobs/broadcastFanOut.ts:817-826`);
   relay draws one per leg. So any share or relay roster with more than about
   10 recipients still to go when SIGTERM lands is cut mid-loop.
3. **The redelivery is suppressed.** The killed job's SQS message is never
   deleted, so it redelivers after the 120 s visibility timeout
   (`infra/modules/jobs/main.tf:36`) - with the SAME `jobId`. The pass's
   run-once execution marker then treats it as a duplicate and returns
   (broadcast `broadcastFanOut.ts:351-363`; relay
   `app/src/jobs/relayFanOut.ts:829-841`), and the consumer deletes the
   message as a success. The only trace is one INFO line, "broadcast send
   duplicate delivery suppressed" (relay: "relay fan-out duplicate delivery
   suppressed"). This is the mechanism of
   [throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md),
   reached by a kill instead of a throw.
4. **No continuation follows.** A pass enqueues its continuation only after
   its loop (`broadcastFanOut.ts:1146-1166`), so a pass killed inside the
   loop enqueues nothing.

**What is left behind.**

- The recipient that was mid-send keeps an `attempting` send-attempt record.
  The branch's takeover (D8a: a stale `attempting` record means "a process
  died mid-send", `broadcastFanOut.ts:891-892`) only fires when a later pass
  or continuation meets the record - and none will. Nothing reconciles
  whether that one text went out.
- Every recipient AFTER it stays `queued` with NO attempt record at all:
  records are created only at the claim, immediately before the send
  (`broadcastFanOut.ts:869-879`; relay `relayFanOut.ts:1941-1952`), and the
  loop never reached them.
- The broadcast reads "Sending" forever: `finalize` defers while any slot is
  `queued` (`broadcastFanOut.ts:1527-1531`). A relay source message keeps
  `queued` legs for every member from the killed one on.
- No ERROR, no alarm, no DLQ message: the suppressed redelivery returns
  successfully.

**Why the planned sweeper misses it.**
[send-attempt-sweeper](./send-attempt-sweeper.md)'s suggested fix is "a
periodic job that finds attempt records open past a bound". Keyed on attempt
RECORDS, it would find the one `attempting` recipient and never see the
untried remainder - most of the share. The pass-setup strand in
[fanout-pass-setup-throw-strands-pass](./fanout-pass-setup-throw-strands-pass.md)
covers a THROW in setup, not a kill inside the loop. So, as filed, the most
frequent strand trigger is covered by nothing. The sweeper issue carries a
dated addendum for this.

**User-visible.** A share to (say) 200 tenants that a deploy lands on sends
to the first handful and then stops; the share shows "Sending" indefinitely
and the rest of the tenants never get the property. On relay, a group message
reaches a prefix of the roster and the rest of the members never get it.
Nobody is told.

**Suggested fix.** Not designed here; the reviewer's direction:

- Make the fan-out loops SIGTERM-aware: on shutdown, stop at a recipient
  boundary (never between a claim and its provider call) and re-enqueue the
  untried remainder as a continuation under a FRESH `jobId` before exiting,
  so the marker does not suppress it. The in-flight recipient's record is
  then met by that continuation and taken over into reconcile as D8a
  intends.
- And/or give the sweeper a second input: `sending` broadcasts and relay
  source messages with `queued` slots and no live pass past a bound (see the
  sweeper addendum). A `queued` slot with NO attempt record was never claimed
  and so never sent - on a pass that ran under the send-attempt record, it
  is safe to re-drive.
- A longer `stop_grace_period` (and a matching drain bound in
  `worker.ts:543`) only narrows the window: a large share still outlasts any
  reasonable grace period at 1 text per second.

**What this is NOT.** Not a double text: nothing is sent twice - the failure
is silence. Not introduced by `feat/send-outcome-reconcile` (the kill and the
marker suppression predate it; the branch only adds the one unmet
`attempting` record). Not the pass-setup throw
([fanout-pass-setup-throw-strands-pass](./fanout-pass-setup-throw-strands-pass.md))
and not a crash in the middle of one recipient's send
([send-attempt-sweeper](./send-attempt-sweeper.md) item 6), though a deploy
kill produces that too, for one recipient.

**Related.** [send-attempt-sweeper](./send-attempt-sweeper.md),
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md),
[fanout-pass-setup-throw-strands-pass](./fanout-pass-setup-throw-strands-pass.md),
[relay-staleness-alarm-assumed-not-built](./relay-staleness-alarm-assumed-not-built.md).
