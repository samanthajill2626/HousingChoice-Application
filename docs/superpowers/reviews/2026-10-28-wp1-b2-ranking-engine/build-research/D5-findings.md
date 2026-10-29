# D5 findings - S5 "The ranking job" (delta reader, Phase 1)

- Reader: D5 (read-only).
- Scope: plan section 9, S5 (tasks S5.1-S5.10): `ranking.updated` on the
  bus / SSE / bridge, `flags.ts`, `job.ts` (claim, join, 409, job view,
  slots, `rankAnchor`, `runDueRankings`), `runLog.ts`, `runBatch.ts`, the
  DynamoDB Local race tests, `jobWiring.ts`, the worker poll, the dev tick,
  the e2e-session env. Spec D7, D8 writes, D10, D11, D12 event; WI1, WI12-WI16.
- Read: plan lines 1-590 (binding sections 0-4) and 21586-26727 (S5) in
  full; the S2 published shapes and code (3833-3995, 6760-7032, 7740-8220,
  8920-9290, 9586-9695), the S3 published shapes (10010-10266) and their
  implementations (12740-12757, 14540-14580, 15685-15775, 15800-15840), the
  S4 published shapes (16432-16602) and code for cap/cost/prompt
  (16848-16920, 17020-17056, 19815-19880, 20055-20120); spec section 2 and
  D7, D8, D10, D11, D12, sections 5-6; the live tree files named below.
- Method beyond reading: the S5 source files and the six in-memory unit
  test files plus both helpers were extracted VERBATIM from the plan into a
  scratch project outside the worktree
  (`C:/Users/Cameron/AppData/Local/Temp/claude/b2a-research/D5/proj`), with
  the S2/S3/S4 types and the helpers the tests execute (matchesRepo codec,
  `mergeMissing`, `capOf`, `costUsd`, the logger mixin) copied from the
  plan's own code. `tsc` (strict, NodeNext, noUncheckedIndexedAccess) and
  the repo ESLint config are clean on it; vitest ran 92 cases: 90 pass, 2
  fail (D5-1); with the one-line fix in D5-1, 92/92 pass.
- Verdict: S5 is sound and compiles against the published S2/S3/S4 shapes;
  every anchor is byte-exact and unique; one test-harness bug stops S5.6
  going GREEN (one-line fix), plus five precision items.

## Findings

### D5-1 - BLOCKER - S5.6 harness aliases the job record, so the two "superseded" cases cannot go GREEN

- Plan: Task S5.6, `app/test/rankingRankAnchor.test.ts` harness, plan line
  24903 (`runs.jobs.set(job.itemId, job);`); failing cases at plan lines
  25123-25136 ("R2B5: a job superseded after its last batch write is not
  finished") and 25188-25201 ("a superseded job exits quietly").
- Code fact: the fake stores the SAME object the test then passes to
  `rankAnchor(h.job, h.deps)` (`h.record()` = `runs.jobs.get(job.itemId)!`,
  plan 24947). Both cases supersede by writing
  `h.record().generation = 'gen-takeover'`, which also rewrites
  `job.generation` inside `rankAnchor`. The guard
  (`current.generation !== job.generation`, plan 25500) and the fake's
  `live(ref)` (plan 23265-23268) then still match, so the job is not
  superseded.
- Observed (scratch run of the plan's verbatim code): case 1 ends
  `status: 'done'` instead of `'running'` (the generation-conditioned
  finish succeeds); case 2 writes the run (`runs.size` 1, expected 0).
  90/92 pass; the other 22 rankAnchor cases are unaffected.
- Correction: in the S5.6 harness write
  `runs.jobs.set(job.itemId, structuredClone(job));` (verified: 92/92
  pass). Apply the same to the S5.5 harness (plan line 24176) for hygiene:
  it passes today only because its supersession goes through the `guard`
  stub, but `updateJobProgress(ctx.job, ...)` compares a record with
  itself there. Rule for S6 reuse: never seed the fake with the object
  handed to the code under test (S6's read-only seeds at plan 27925/27949
  are safe because the read only sees `getJob` clones).

### D5-2 - MINOR - a `putRun` failure strands the batch's newly raised unlawful flags in the job map

- Plan: Task S5.5, `runBatch.ts` plan lines 24689-24699 (merge into
  `ctx.raised` BEFORE `putRun`) and 24725-24747 (the `putRun` catch returns
  without writing flags).
- Problem: the entries stay in `ctx.raised`, so every later batch of the
  same property and field skips the raise (`raised.has(key)`, plan 22946),
  and no flag record is written by this job although the model raised it;
  later batches' `cappedAtRun` also treat that never-written flag as open.
  Spec D10: "a batch writes a flag record when none is open". Edge case
  (PR36 path), property anchors mainly (all candidates share the unit).
- Correction: in the `putRun` catch, before returning, drop this batch's
  raises: `for (const f of newlyRaised) ctx.raised.delete(`${f.unitId}#${f.field}`);`
  (a later batch can then raise and write it). A thrown
  `putFlagIfAbsentOrClosed` (plan 24801-24805) keeps its entry and is only
  logged - acceptable, but say so in the comment.

### D5-3 - MINOR - the S5 report template has no WI12 line

- Plan: plan lines 167-169 (WI12 names S5: "the job ... call[s] them");
  report template plan lines 26634-26651 lists WI1, WI13-WI16 only.
- Correction: add to Task S5.10 a WI12 check and report line, e.g.
  `git -C W:/tmp/wp1-b2-ranking-engine grep -n -e "tenantCard(" -e "propertyCard(" -- app/src/services/ranking/job.ts app/src/services/ranking/runBatch.ts app/src/services/ranking/runLog.ts app/src/services/ranking/flags.ts app/src/services/ranking/jobWiring.ts`
  -> no output (the job builds no card; every card comes from
  `assembleRanking`).

### D5-4 - MINOR - stale text that contradicts PR37 / PR42 (a builder would copy it into source)

- Plan: `runBatch.ts` header comment, plan lines 24498-24507: "a write
  still unprocessed after the repo's retries throws, which is this batch's
  failure: its candidates get no new match" and "failedBatches for a
  failed call". Since PR37 `putMatches` never throws on a DynamoDB
  failure, landed rows stay and only the not-confirmed candidates fail
  `'repo'`; since PR42 `failedBatches` also holds run-write and
  match-write failures. Section 9.1 item 6 (plan 21690-21693, "failedBatches
  holds failed CALLS only") says the same superseded thing (item 22 has the
  ruling). Items 20, 22, 23, 21 are also out of order (plan 21763-21800).
- Correction: reword the header to "the batch's matches (one BatchWrite;
  rows that land stay, PR37; candidates whose rows are not confirmed
  written fail as 'repo')" and "failedBatches for a batch that left
  candidates unmatched through a failure (call, run write or match write,
  PR42)"; mark 9.1 item 6 superseded by item 22.

### D5-5 - MINOR - poll-count comments go stale when S5.9 adds the ranking poll

- Code fact: `app/src/worker.ts:290` "the six shared-cadence call sites"
  (tour reminder, placement nudge, roster action, extraction, group
  guardrail, journal sweep); `app/src/jobs/pollLoop.ts:15` "seven loops
  today". S5.9 adds a seventh shared-cadence `startPoll` (eighth loop).
- Correction: in S5.9's worker.ts edit change "six" to "seven" (worker.ts
  is S5's file). pollLoop.ts is outside PR2's S5 list: either note it in
  the S5 report or have the planner allow the one-word edit. (S2 C2 fixes
  only the config.ts comments.)

### D5-6 - MINOR - S5.9 Step 2 RED text: the PR30 switch cases do not "already pass" at RED

- Plan: plan lines 26345-26352 ("The PR30 switch tests already pass (S2
  built the config)").
- Code fact: `rankingWiring.test.ts` imports
  `../src/services/ranking/jobWiring.js` at module top (plan 26273), so
  until S5.9 Step 3 the whole file fails to load and every case, the two
  switch cases included, is red (vitest: module not found).
- Correction: "the whole file is red until jobWiring.ts exists; the switch
  cases are pins once it does."

## Checked and fine

- Anchors, byte-exact and unique on the live tree: `events.ts` x3
  (343-344, 352-354, 374-376); `routes/api.ts` x4 (61-62, 2790-2792, 2802,
  2836); `test/sse.test.ts` x4 (173-177, 221, 232, 248-249);
  `test/eventBridge.test.ts` (42-45); `worker.ts` (508-509); `routes/dev.ts`
  x4 (9, 88, 141-143, 785-791); `scripts/e2e-session.mjs` (258). No S1-S4
  task edits these files first. The S5.6/S5.7 import anchors match S5.3's
  job.ts text exactly (assembled programmatically).
- Event spine: bridge iterates `APP_EVENT_NAMES` (eventBridge.ts:45),
  internal route validates against it (internal.ts:34); only
  `eventBridge.test.ts` counts events; no other `Record<AppEventName,...>`,
  switch or dashboard/e2e drift test; the harness recorder does not record
  `ranking.updated` (baseline 0 is right).
- `startPoll` wrapper (worker.ts:292-298) and pollLoop.ts (fresh
  `pollRunId`, unref'd, no await); `runWithContext` replaces the store
  (context.ts:56-58); logger mixin `jobRunId ?? pollRunId ?? requestId ??
  bootId` (logger.ts:244-250); `createLogCapture` is synchronous, so the
  WI14 assertions hold (ran green).
- Dev router: mounted before the origin-secret validator (app.ts), and
  `originSecret.ts` exempts `/__dev/`, so the header-less 404 cases are
  404; Express 5.2.1 forwards async errors; `config.dynamodbEndpoint` is
  the raw env (config.ts:1316); `devRoutes.ts:19` gate as described; no
  dev test asserts an empty log, so the "not mounted" info line is safe.
- e2e lane: `childEnv` (e2e-session.mjs:140-339) reaches app and worker
  (spawnNode 387, app 461, worker 464); `LOCAL_ENDPOINT` is localhost
  (db.mjs:42); the scan's `'\n};'` finds line 339; Playwright runs
  `workers: 1`, so a tick cannot run another spec's job early.
- Cross-slice names and shapes, all present with the signatures S5 uses:
  S2 job/run/flag families (`getJob(kind,id,{consistent})`, `putJobClaim`
  -> `{ok,job}|{ok:false}`, `claimQueued`, `takeOver`, `markLeaseFailed`,
  `renewLease`, `markExpiredQueued`, `updateJobProgress`, `finishJob`,
  `putRun`, `markMatchesWritten`, `getRun`, `getOpenCandidateFlags`,
  `putFlagIfAbsentOrClosed`), `MatchRow`, `putMatches` ->
  `{ written, unwritten }`; S3 `AssembleResult` union,
  `AnchorUnreadable.candidateIds`, `VerifiedCandidate` /
  `UnverifiedCandidate`, `SeenHomeCard`, `PropertyFacts`, `mergeMissing`,
  `mapWithConcurrency`, `createAssembleDeps`; S4 `buildRankingPrompt`
  (with `batchIndex`, `landlordCard`, PR19), `RankingPrompt.snapshotOf`,
  `RankingPromptError`, `RankingCall`, `costUsd` (0 for model `fake`),
  `capOf`, `flagFieldsOfKind`, `createRankingDriver(config, logger)`;
  every `RankingSource` the fixtures use exists.
- The in-memory fake's conditions equal S2's real ConditionExpressions
  (claim, claimQueued, takeOver, markLeaseFailed, renewLease,
  markExpiredQueued, progress, finish, flag put).
- Hand-worked values, recomputed and also run: cost 0.054 / 0.108 / 0;
  `expiresAt` = floor(T0/1000) + 180*86400; queue expiry boundary
  (`<=` expired) consistent across jobView, the claim and claimQueued;
  lease isoAt(150000) and renewal isoAt(91000) at 30000 ms; guard read
  count 6 in the R2B5 case; every job message string and join order;
  `finishedBatchCount` de-dup; the six-key event; event status sequence.
- RED claims: vitest yields `undefined` for a missing named export
  ("is not a function"), as BB7 says (checked in scratch).
- Gates: S5 code is lint-clean under the repo config; log calls put errors
  only under `err` (logCallSiteGuard); no S5 src file spells a
  `TENANT_MATCHING_INPUTS` key (the widened reader scan); the
  jobQueueWiring worker.ts scan is unaffected; the S5 plan text is pure
  ASCII; WI1 (`matches.putMatches(`) and WI13 (`capOf({`) greps will each
  match exactly one line at S5.10.
- S5.8 integration: own `hc-rankjob-` prefix in a per-file DynamoDB Local
  database (no lane marker needed); all four flows traced against S2's
  real conditions; earlier cases' leftover queued records are run by later
  polls but each case asserts only its own anchor.
