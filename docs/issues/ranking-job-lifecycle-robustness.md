---
id: ranking-job-lifecycle-robustness
title: A ranking job turns transient DynamoDB trouble into a re-billed re-run or a stuck anchor
type: bug
severity: low
status: open
area: app/ranking
created: 2026-10-29
updated: 2026-10-29
refs: app/src/services/ranking/job.ts:511, app/src/services/ranking/job.ts:333, app/src/services/ranking/runBatch.ts:99, app/src/repos/rankingRunsRepo.ts:446, app/src/lib/dynamo.ts:60, app/src/worker.ts:618, app/src/services/ranking/job.ts:613, app/src/services/ranking/job.ts:630, app/src/repos/rankingRunsRepo.ts:330
---

**Problem.** Four lifecycle edges of the WP1 B2a ranking job, found by the
plan-blind code review (round 1, reviewer A1, 2026-10-29). Each costs a
re-billed re-run, a misleading "press again", or a stuck anchor; none loses
a stored score. The fix wave of that review fixed the neighbours (a thrown
takeover now returns its slot; a thrown finish write is retried once; a paid
call whose job stopped is logged with its usage and cost) and left these.

1. **One THROWN lease renewal stops the job** (A1-3, reproduced).
   `rankAnchor`'s `renew` (job.ts:511-523) sets `stopped` on a thrown
   `renewLease` exactly as on a refused one. Renewals run every
   `RANKING_LEASE_MS / 3` (30 s), so when one throws (throttling, a network
   error past the SDK's retries) the lease still has about 60 s left and the
   next renewal is 30 s away. Interleaving: a batch's model call is in
   flight; the renewal throws; the call returns; the guard says stopped, so
   the batch writes no run (now a WARN line with its usage and cost), no
   match and no progress; the record stays `running` until the lease lapses;
   the next tick takes it over (attempts 1) and runs every batch again,
   billed again; a second hiccup in that attempt fails it "The ranking
   stopped before it finished". The guard read, by contrast, retries once
   (job.ts:476-508). Spec D7 says "a renewal that fails stops the job", so
   today's behavior is the rule: changing it is a ruling, not a bug fix.
   Suggested: on a thrown renewal, log and keep going; stop only on a REFUSED
   renewal, or once the last successful renewal is older than the lease (the
   lease really lapsed). Test: `renewLease` throws once then succeeds while a
   gated call is in flight; the batch's run and matches are written and the
   job ends `done`.

2. **An ambiguous progress write lists a scored batch as failed** (A1-4 b,
   reproduced). A batch's run and matches land, then its progress write
   (`progress()`, runBatch.ts:99-105) throws; `runBatchSafely`
   (job.ts:333-358) catches it and records EVERY candidate of the batch in
   `failedBatches` with failure `error`, so the job ends "2 tenants could not
   be scored. Press Rank again." although both rows exist (the read shows
   them; `batchesDone` and `runIds` miss the batch). Staff press again - a
   needless, billed re-run. A blind retry is NOT safe: `updateJobProgress`
   appends with `list_append` (rankingRunsRepo.ts:446), so a write that
   landed but whose answer was lost would append the batch index and run id
   twice. Make progress idempotent first (for example condition the append
   on `NOT contains(batchesDone, :index)`, or keep per-batch entries in a
   map keyed by index), then retry once, and on a second failure leave the
   batch to the lease/takeover path instead of calling it a scoring failure.
   Test: the progress write throws once after the matches landed; the job
   ends `done` with no failedBatches entry and no message.

3. **A hung step keeps its job "running" indefinitely** (A1-6, plausible,
   not reproduced). The renewal timer is independent of progress and is
   cleared only in `rankAnchor`'s finally (job.ts:524-541), and the DynamoDB
   client sets no request timeout (lib/dynamo.ts:60-79;
   `@smithy/node-http-handler` defaults `requestTimeout` to 0). If any awaited
   step never settles (a stalled DynamoDB socket; the model call has its own
   timeout), the timer keeps extending the lease on a live generation, so no
   takeover ever happens: the anchor reads "running" until the worker
   restarts (a press joins it or gets 409) and one of the process's
   `RANKING_MAX_CONCURRENT_JOBS` slots is gone. Suggested: a ceiling on a
   job's life (stop renewing once `startedAt` is older than, say, the batch
   count times twice `RANKING_CALL_TIMEOUT_MS`, and let the takeover run), or
   a `requestTimeout` on the DynamoDB client (a cross-cutting change). Test:
   an assemble that never resolves with a captured interval; past the
   ceiling the renewal stops.

4. **Shutdown neither stops the ranking poll nor releases leases** (A1-10).
   The worker's SIGTERM handler (worker.ts:618-648) drains the jobs and
   inbound-mail consumers only. Every ranking in flight at a deploy is
   abandoned mid-call (paid, and the process exits before the stopped-call
   WARN line can be written), waits out the 90 s lease, and is re-run in full
   by the new worker (attempts 1). Suggested: on SIGTERM stop the ranking poll
   and set each lease this process holds to now (a conditional update on the
   generation), so the new worker takes the job over on its first tick; or
   await in-flight jobs up to the existing 10 s exit bound.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
R1-adversarial-A1.md (A1-3, A1-4, A1-6, A1-10) and R1-adjudications.md.

**Update (2026-10-29, WP1 B2a code review R2, findings R2-server-2 and
R2-server-3).** Two more edges of the ranking poll (`pollRankingJobs`), both
reproduced by the round 2 server reviewer on the repo fakes. Like the four
above, neither loses a stored score.

5. **A takeover or claim whose write lands but whose call throws starts no
   job** (R2-server-2). An UpdateItem can commit and still throw at the
   caller (a timeout or a socket error after the commit - the ambiguity the
   matches store already names for its BatchWrite, plan PR37). For
   `takeOver` (rankingRunsRepo.ts:330-361, which sets a NEW generation and
   attempts + 1) the stale-lease loop's catch (job.ts:630-661) logs `ranking
   poll: stale lease step failed` and returns the slot (the round 1 fix):
   the record is then `running` on the generation this pass proposed, with
   attempts 1 and a fresh lease that no process runs. About 90 s later
   (`RANKING_LEASE_MS`) the next tick lists it, sees attempts >= 1, and
   `markLeaseFailed` fails it "The ranking stopped before it finished. Press
   Rank again." - with no model call made. An ambiguous `claimQueued`
   (job.ts:613-627) is the milder twin: nothing runs the claimed record until
   its lease lapses, and the takeover then runs it, spending the job's one
   takeover (a deploy during that run then fails it). Takeovers happen when
   DynamoDB is unhealthy (a dead worker, a failed renewal), which is when
   ambiguous errors cluster. Suggested: in each loop's catch, before
   returning the slot, read the record once (consistent); if it is `running`
   on the generation this pass proposed (takeOver), or on the listed
   generation with `startedAt` equal to this pass's `nowIso` (claimQueued),
   start it with the slot already held (`startClaimedJob`) instead. Test: the
   fake's `takeOver` applies, then throws; after pass 1 the driver was called
   and the record is `done` (today pass 1 leaves the slot free and the record
   running on the new generation with attempts 1 and no call, and pass 2 at
   +91 s fails it).

6. **A dead job is never taken over while every pass has queued work**
   (R2-server-3). The poll runs the queued claims first, and they take every
   free slot (job.ts:613-628); the stale loop then skips every attempts-0
   record when no slot is free (job.ts:645-646). So while each tick finds a
   queued press for the free slot, an OLDER press's dead job is never taken
   over: its anchor reads "running" with frozen progress, and new presses on
   it join a job nothing runs, while newer presses complete. It ends when
   the queue drains (queued presses expire after `RANKING_QUEUE_EXPIRY_MS`).
   Suggested: run the stale loop's takeovers before the queued claims (the
   older press first). Test: one slot, a stale attempts-0 job and a new
   queued press on every pass; today three passes each report `claimed: 1,
   tookOver: 0` with the stale record still on its original generation;
   after the fix the first pass reports `tookOver: 1`.

Source (items 5 and 6): docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/
code-review/R2-server.md and R2-adjudications.md.
