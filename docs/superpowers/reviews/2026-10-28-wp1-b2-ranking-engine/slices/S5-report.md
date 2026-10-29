# S5 report - the ranking job (WP1 B2a)

Branch feat/wp1-b2-ranking-engine, worktree `W:/tmp/wp1-b2-ranking-engine`.
Tasks S5.1-S5.10. Slice range: 67b2b7d9 (the S4 report, the commit before
S5.1) .. a2e73504 (S5.9), plus this report's commit (the slice tip).

- S5.1-S5.5 were built by the S5a child; its report is
  [S5a-report.md](S5a-report.md) (every S5a command, count, deviation and
  watch-item note lives there and is not repeated here).
- S5.6-S5.10 were built by the S5b child (Claude Opus 5.5, 2026-10-29); this
  report covers them in detail and closes the slice (the 9.4 coverage table,
  the slice gates and the watch items over the whole slice).
- Spec: D7 (claim, poll with expiry, lease, renewal, takeover once, slots,
  the fresh context, batches in parallel, never throws, the hermetic lane),
  D8 writes, D10, D11, D12 (the event). Rulings in force: PR13, PR15, PR19,
  PR30 (worker side), PR36, PR37, PR38, PR42, PR43 (and PR7 through `capOf`).
  Watch items: WI1, WI12, WI13, WI14, WI15, WI16. WORKLIST: section G and
  WL-S5-1 .. WL-S5-9.
- Verdict: S5.1-S5.9 one commit each, S5.10 is this report's commit, and
  S5a's report is its own commit. Every task RED for its stated reason and
  then GREEN, except S5.8, a PIN task (all four cases green on first run,
  as the plan allows). No one-value test fix. No
  QUESTION. Slice gates: root `npm run typecheck` exit 0; eslint on the
  slice's 24 files exit 0 (no error in any file, pre-existing ones
  included); ASCII 0 everywhere; the app workspace suite 592 files / 12510
  passed / 1 pre-existing skip, exit 0, no `[dynamoAdmin]` line.

## 1. Tasks and commits

All paths under `app/` unless shown.

| Task | Commit | Files |
|---|---|---|
| S5.1 `ranking.updated` on the bus, SSE, bridge | 6c8d8979 | see S5a-report.md |
| S5.2 `flags.ts` and the job fixtures | 46098e53 | see S5a-report.md |
| S5.3 `job.ts` part 1 (claim, join, 409, view, slots) and the job-store fake | 55aa9ef7 | see S5a-report.md |
| S5.4 `runLog.ts` | 5659612b | see S5a-report.md |
| S5.5 `runBatch.ts` | 679850c9 | see S5a-report.md |
| S5a report | 4ab0c5de | `docs/.../slices/S5a-report.md` |
| S5.6 `job.ts` part 2: `rankAnchor` | 7d1a6fca | `src/services/ranking/job.ts`, `test/rankingRankAnchor.test.ts` (new) |
| S5.7 `job.ts` part 3: `runDueRankings` (the poll pass) | d940180b | `src/services/ranking/job.ts`, `test/rankingPoll.test.ts` (new) |
| S5.8 the claim and poll races against DynamoDB Local (PIN) | ac81de0f | `test/rankingJob.integration.test.ts` (new) |
| S5.9 wiring: shared deps, worker poll, dev tick, lane env | a2e73504 | `src/services/ranking/jobWiring.ts` (new), `src/worker.ts`, `src/routes/dev.ts`, `src/jobs/pollLoop.ts` (comment), `scripts/e2e-session.mjs`, `test/devRankingTick.test.ts` (new), `test/rankingWiring.test.ts` (new) |
| S5.10 slice gates and this report | this commit | `docs/.../slices/S5-report.md` |

File ownership: `job.ts`, `worker.ts`, `routes/dev.ts` tick and
`scripts/e2e-session.mjs` env are PR2's S5 list; `jobWiring.ts` is PR27's S5
allowance; `jobs/pollLoop.ts` (one comment line pair) is WL-S5-5's
comment-only allowance. No other file was touched. S5b diff (4ab0c5de..a2e73504):
11 files, 1483 insertions, 4 deletions. Whole slice (67b2b7d9..a2e73504):
26 files, 4425 insertions, 7 deletions.

## 2. Gates

- `npm run typecheck` (bare, worktree root): exit 0 (app src + scripts +
  test, dashboard, e2e, fake-twilio, fake-twilio-web).
- eslint on the slice's files (bare `npx eslint <files>` from the worktree
  root): the plan's 23 files plus `app/src/jobs/pollLoop.ts` (touched by
  WL-S5-5) - exit 0, no error and no warning in any file. The pre-existing
  files (`events.ts`, `api.ts`, `dev.ts`, `worker.ts`, `pollLoop.ts`,
  `sse.test.ts`, `eventBridge.test.ts`) report nothing, so no baseline
  comparison was needed. `scripts/e2e-session.mjs` is `.mjs`: the flat
  config lints `.ts` / `.tsx` only, so eslint on it would check NOTHING; it
  was not counted as linted. Its syntax was checked with `node --check`
  (exit 0) and its childEnv block is pinned by `rankingWiring.test.ts`.
- ASCII sweep: every NEW file of the slice prints 0 with
  `tr -d '\11\12\15\40-\176' < FILE | wc -c` (the 17 files: `flags.ts`,
  `job.ts`, `runLog.ts`, `runBatch.ts`, `jobWiring.ts`, the two helpers,
  and the ten new test files); every pre-existing file (`events.ts`,
  `api.ts`, `dev.ts`, `worker.ts`, `pollLoop.ts`, `e2e-session.mjs`,
  `sse.test.ts`, `eventBridge.test.ts`) prints 0 on its ADDED lines over
  67b2b7d9..HEAD (`e2e-session.mjs` carries pre-existing em dashes; none
  added).
- Tests: the app workspace suite (`cd app && npx vitest run`, the app
  workspace's `npm test`): 592 files passed; 12510 passed, 1 skipped (the
  pre-existing diagnostic "built dashboard identity tags", skipped because
  no dashboard build exists); 139.68 s; exit 0; 0 `[dynamoAdmin]` lines
  (fixed-string grep of the captured output; the two `dynamoAdmin` matches
  are the `dynamoAdminRetry.test.ts` file and case names). No re-run was
  needed. The ROOT `npm test` (every workspace) was NOT run: the brief makes
  it the orchestrator's gate (S5.10 Step 1 item 6 names it; the brief wins).
  `env | grep -c '^AWS_'` printed 0, so no `env -u` prefix.

## 3. Test commands and counts (S5b, in order)

Command form: `cd W:/tmp/wp1-b2-ranking-engine/app && npx vitest run test/<file>`,
output captured to a scratch file and read after the command finished.
DynamoDB Local was up (G1); nothing was installed or restarted.

1. S5.6 RED (`rankingRankAnchor`): 1 file failed, 24 failed (24) - every
   case "TypeError: (0 , rankAnchor) is not a function" (the stated reason,
   BB7 / G4 wording).
2. S5.6 on the plan's VERBATIM harness (before WL-S5-1), implementation in
   place: 22 passed, 2 failed - "R2B5: a job superseded after its last batch
   write is not finished" (`toMatchObject({ status: 'running' })` got the
   done record) and "a superseded job exits quietly" ("expected 1 to be +0",
   one run written). Exactly D5-1's prediction: the fake and the job shared
   one object.
3. S5.6 GREEN after WL-S5-1 (`rankingRankAnchor`, `rankingClaim`,
   `rankingRunBatch`): 3 files, 61 passed.
4. `tsc -p tsconfig.json --noEmit` exit 0; `tsc -p tsconfig.test.json` exit
   0; eslint (2 files) exit 0; ASCII 0; `cmp` against the plan: the import
   edit and the appended block identical.
5. S5.7 RED (`rankingPoll`): 1 file failed, 12 failed (12) - every case
   "TypeError: (0 , runDueRankings) is not a function".
6. S5.7 GREEN (`rankingPoll`, `rankingRankAnchor`): 2 files, 36 passed.
7. tsc src / test exit 0; eslint (2 files) exit 0; `cmp`: the test file and
   the appended block identical to the plan.
8. S5.8 (`rankingJob.integration`): 1 file, 4 passed on the first run
   (about 1 s); re-run with `--reporter=verbose`: 4 passed, each case named
   (none skipped). PIN.
9. eslint exit 0; test tsc exit 0; ASCII 0.
10. S5.9 RED, vitest (`devRankingTick`, `rankingWiring`, verbose): 2 files
    failed; `devRankingTick` 2 failed ("expected 404 to be 200"; "expected {}
    to deeply equal { ok: true, ... }") and 2 passed (the two 404 cases -
    pins of absence, already true with no route); `rankingWiring` failed to
    load: "Cannot find module '../src/services/ranking/jobWiring.js'" (so
    its two PR30 switch cases were red too - D5-6, G4).
11. S5.9 RED, types (`npx tsc -p tsconfig.test.json`): exit 2 - TS2353
    "'rankingTickDeps' does not exist in type 'DevRouterDeps'" at
    `devRankingTick.test.ts:69, 77, 89`, and TS2307 "Cannot find module
    '../src/services/ranking/jobWiring.js'" at `rankingWiring.test.ts:9` (the
    plan's two stated type errors).
12. S5.9 GREEN (verbose): 2 files, 10 passed.
13. The whole S5 set (plan S5.9 Step 4: `rankingUpdatedEvent`, `sse`,
    `eventBridge`, `rankingFlags`, `rankingClaim`, `rankingRunLog`,
    `rankingRunBatch`, `rankingRankAnchor`, `rankingPoll`,
    `rankingJob.integration`, `devRankingTick`, `rankingWiring`): 12 files,
    127 passed.
14. The neighbors of the S5.9 edits (every test that reads `worker.ts`,
    `routes/dev.ts` or `pollLoop.ts`, plus the source-scanning guards):
    `devGating`, `devGroupGuardrailTicks`, `devJournalSweepTick`,
    `devListingSendFixture`, `devMessageTransportFixture`, `devOrgFixture`,
    `devRelayReplay`, `devTourAutoCloseTick`, `devTranscriptFixture`,
    `devZeroPrimaryFixture`, `jobQueueWiring`, `placementConvert`,
    `pollLoop`, `registerHandlers`, `logCallSiteGuard`,
    `tenantMatchingInputsReaders`, `messageCatalogAscii`: 17 files, 222
    passed.
15. tsc src / scripts / test exit 0; eslint (the six S5.9 `.ts` files) exit 0;
    ASCII 0 on the new files and on every added line; `cmp`: `jobWiring.ts`,
    the worker block, the four `dev.ts` edits and the session's ranking lines
    identical to the plan.
16. S5.10: root `npm run typecheck` exit 0; eslint (24 files) exit 0; ASCII
    sweep 0; the watch-item greps (section 4); the app workspace suite
    (section 2).

New cases in S5b: 50 (rankAnchor 24, poll 12, integration 4, dev tick 4,
wiring 6). Slice total with S5a's 60: 110 new cases.

## 4. Watch items

- WI1 (writers: only the ranking job writes `matches`). BA8 call-site greps:
  `git grep -n "matches.putMatches(" -- app/src` ->
  `app/src/services/ranking/runBatch.ts:285:      const result = await deps.matches.putMatches(rows);`
  (exactly one line); `git grep -n "tableName('matches'" -- app/src` ->
  `app/src/repos/matchesRepo.ts:176:  const table = tableName('matches', deps.env);`
  (only the repo). Also `git grep -n -e "TABLES.matches" -- app/src`: no
  output; `git grep -n "putMatches(" -- app/src`: the interface
  (`matchesRepo.ts:111`), the implementation (`:180`) and the one call
  (`runBatch.ts:285`). Holds.
- WI12 (one card definition; WL-S5-3). `git grep -n -e "tenantCard(" -e
  "propertyCard(" -- app/src/services/ranking/job.ts
  app/src/services/ranking/runBatch.ts app/src/services/ranking/runLog.ts
  app/src/services/ranking/flags.ts app/src/services/ranking/jobWiring.ts`:
  no output (exit 1). The job builds no card: every card reaches it through
  `assembleRanking`'s result, which `jobWiring.ts` binds
  (`assemble: (anchor, o) => assembleRanking(anchor, o, assembleDeps)`).
  Holds.
- WI13 (one cap function). `git grep -n "capOf({" -- app/src/services/ranking`
  -> `app/src/services/ranking/runLog.ts:74:      cappedAtRun: capOf({`
  (exactly one line). Holds.
- WI14 (the job's log lines carry the press's requestId).
  `rankingPoll.test.ts` "WI14: every job line carries the press's requestId
  as its correlationId - no pollRunId, no jobRunId" runs a poll pass inside
  `runWithContext({ bootId, pollRunId })` and READS THE LOGGER OUTPUT
  (`createLogCapture`): every line whose msg starts "ranking job" (at least
  three) has `correlationId` = `requestId` = the press's
  (`PRESS_REQUEST_ID`), `traceparent` = the stored one, and no `pollRunId`,
  `jobRunId` or `bootId` key; the poll's own "ranking poll pass" line keeps
  the tick's `pollRunId` as its correlationId. "a record with no traceparent
  runs with the requestId alone" pins the absent-traceparent shape.
  Mechanism: `startClaimedJob` runs `rankAnchor` in a FRESH
  `runWithContext({ requestId, traceparent? })`, which REPLACES the store
  (`lib/context.ts` `runWithContext` copies the given context). Result: pass.
- WI15 (overlapping ticks and two pollers). `rankingPoll.test.ts`: "WI15:
  overlapping ticks never run more than RANKING_MAX_CONCURRENT_JOBS jobs in
  one process" (2 slots, 3 queued, two ticks started without awaiting: 2
  run, 1 stays queued, `slots.inUse()` 2 then 0, the third runs on the next
  pass), "WI15: two pollers (two processes) racing one queued record - one
  claim, one run", "a tick with no free slot claims nothing", "a claim lost
  between the listing and the write runs nothing and frees its slot";
  `rankingJob.integration.test.ts` repeats the races on DynamoDB Local
  through S2's real conditions ("two concurrent presses", "two pollers
  racing one queued record"). Result: pass.
- WI16 (the event's exact key set). `rankingRankAnchor.test.ts` "every
  ranking.updated payload is exactly the six keys (WI16), running then done"
  asserts `Object.keys(payload).sort()` on EVERY emitted payload of a whole
  job (and the status sequence running x4, done); `rankingRunBatch.test.ts`
  (S5a) pins `toRankingEvent`; the payload TYPE is held by
  `npm run typecheck` (the `AppEventMap` entry in `events.ts`), not by a
  vitest case. Result: pass.

## 5. WORKLIST items

- G1: nothing installed or restarted; DynamoDB Local used as found.
- G2: every plan block was copied with `sed -n` (byte-exact) and checked with
  `cmp`. The one block with a backslash escape, `rankingWiring.test.ts`'s
  childEnv scan, kept it (one line, grep-confirmed). The WORKLIST edits were
  made with the Edit tool and contain no backslash.
- G3: no S5b comment restates a superseded ruling (the appended job.ts text
  already says PR42's "candidates" count and R2B5's no-guard-before-finish).
- G4: every RED was vitest 3.2.6's wording for the stated reason (section
  3). Two G4 notes: S5.9 Step 2's "the PR30 switch tests already pass" is not
  true at RED - the whole `rankingWiring` file fails to load until
  `jobWiring.ts` exists (D5-6); and the two 404 cases of `devRankingTick`
  pass at RED (absence is already true), which is consistent with the
  plan's "the tick answers 404 (no route)".
- G5: no S5 file spells `rankjobs#`; `git grep "rankjobs#" -- app/src
  app/test` lists only S2's definitions (`rankingRunsRepo.ts:62-63`), the
  `tables.ts` comment and S2's own tests.
- G6: no `ANTHROPIC_*` value read or printed; every S5 test uses the stub
  driver or the config's `console` / `fake` driver on a local endpoint (no
  client, no network).
- G7: no command left running; the longest was the app suite (139.68 s,
  foreground, hard timeout).
- WL-S5-1 (BLOCKER, S5.6 half): `rankingRankAnchor.test.ts`'s harness seeds
  `runs.jobs.set(job.itemId, structuredClone(job));` with a comment. Without
  it the two superseded cases fail (section 3 item 2); with it 24/24.
- WL-S5-2: S5a's (see S5a-report.md); `rankAnchor` builds ONE `raised` map
  and ONE `storedFlags` map per job attempt (`runJob`'s `BatchContext`),
  which the batches share, as WL-S5-2 relies on.
- WL-S5-3: the WI12 line above, with `jobWiring.ts` in the grep.
- WL-S5-4: S5a's (`runBatch.ts` header).
- WL-S5-5 (comment only): `worker.ts` "the six shared-cadence call sites"
  -> "the seven shared-cadence call sites" (now `worker.ts:290`);
  `jobs/pollLoop.ts:14-15` "and the tour auto-close poll on its own
  15-minute interval: seven loops today" -> "the tour auto-close poll on its
  own 15-minute interval, and the ranking poll: eight loops today". No test
  reads either comment.
- WL-S5-6: `scripts/e2e-session.mjs` sets
  `RATE_LIMIT_RANK_PER_MIN: process.env.RATE_LIMIT_RANK_PER_MIN ?? '100000',`
  (line 198) BESIDE the other per-user limits it raises (after
  `RATE_LIMIT_VERIFY_START_MAX`), with a four-line comment: an externally
  set value still wins, and the route-level 429 test (S6, app workspace) is
  what proves the limiter. Placed by WL-S5-6's text ("beside the other
  per-user limits"), not D6-4's "beside the S5.9 lines".
- WL-S5-7: S5.8's prefix is `hc-test-rankjob-<uuid8>-`, so
  `test/globalTeardown.ts`'s residue sweep (`/^hc-test-/`) covers an
  interrupted run.
- WL-S5-8 (the shutdown residual; no code change). Worker shutdown
  (`worker.ts:620-649` after S5.9: `shutdown()` stops only the SQS consumers,
  `consumer?.stop()` and `inboundMailConsumer?.stop()` at `:638`, then
  `process.exit(0)`, with a 10 s cap at `:633`) never stops the poll loops
  (`jobs/pollLoop.ts` intervals are unref'd and never cleared) or a running
  job (its lease-renewal timer and guard-retry sleep are unref'd too). So a
  deploy mid-ranking kills that job: its lease expires and the ONE takeover
  re-runs it from the start (as designed, spec D7 "enough to cover a
  redeploy"), which spends that job's takeover; up to
  RANKING_MAX_CONCURRENT_JOBS x RANKING_BATCH_CONCURRENCY (2 x 4 = 8 by
  default) in-flight model calls are billed and never logged (no run record,
  no usage line); and a tick inside the drain window can still claim a
  queued job. The extraction poll has the same shape (precedent). S8's
  RUNBOOK ranking section should state it (E1-5).
- WL-S5-9: S5a's (`test/sse.test.ts`).

## 6. Integration (S5.8)

PIN: all four cases green on the first run against DynamoDB Local through
S2's real repositories ("two concurrent presses: exactly one claims, the
other joins the same generation"; "two pollers racing one queued record:
one run, matches readable by key; a later press claims afresh"; "a queued
record past its expiry is failed by the poll with the not-picked-up
message"; "an expired lease is taken over once, then a second expiry fails
the job"). Re-run: 4/4. No condition of S2's repo disagreed with what the
job relies on; nothing was sent to the planner.

## 7. Decisions taken under the plan

- Slot reserved before the claim (contradiction 2): `runDueRankings` calls
  `slots.tryAcquire()` before `claimQueued` / `takeOver` and releases on a
  lost claim or a throw; `startClaimedJob`'s `finally` releases when the job
  ends. Settled, the counter equals the jobs this process runs.
- Omitted and unreadable candidates in notScored (PR13).
- matchesWritten is { count, at } (PR15).
- runDueRankings returns a summary `{ expired, claimed, tookOver,
  failedStale }` (contradiction 9); the dev tick answers it.
- A RankingPromptError fails the batch as 'driver' with no run (IR34).
- PR36: a failed generation check is retried once after GUARD_RETRY_MS
  (500 ms, `deps.sleep`), then the job is finished failed (MSG_ERROR) by the
  generation-conditioned `finishJob`, and the slot is released; a putRun
  throw fails the batch 'repo' (the call's own kind after a failed call,
  R2B7) with usage and cost on the error line.
- PR37: a partial match write keeps the rows that landed; failedBatches
  lists only the not-confirmed candidates ('repo'); matchesWritten counts
  the rows written.
- PR38 / PR43: an anchor of either kind unreadable after its pool is done
  with every candidate not scored ('unreadable') and MSG_TENANT_UNREADABLE /
  MSG_PROPERTY_UNREADABLE; with no `candidateIds` (no pool yet) the job fails
  with the gatherer's message.
- PR42: failedBatches lists exactly the candidates left without a match
  through a failure; the job message counts candidates ("N tenants could not
  be scored.", "N scores could not be saved.", beside the unreadable and
  omitted sentences), never batches.
- R2B5: the guard retries after 500 ms; no guard read before the finish (a
  failed guard read after every batch wrote cannot turn the job failed).
- R2B7: a putRun failure after a failed call keeps the call's kind.
- R2F6: the dev tick mounts only on a local DynamoDB target
  (`isLocalDynamoTarget(config.dynamodbEndpoint)`); elsewhere one info line
  "dev ranking tick not mounted - ..." and a 404.
- BA6: markMatchesWritten has its own generation check.
- PR30 (worker side): worker.ts reads only `config.rankingWorkerPoll`; off
  -> one boot-context info line "ranking poll not started - ..." and no
  poll. The lane sets RANKING_WORKER_POLL=off and RANKING_DRIVER=fake in the
  childEnv both children inherit (its local DYNAMODB_ENDPOINT keeps PR30's
  fake-driver refusal away).
- Lease renewal every `max(1, floor(RANKING_LEASE_MS / 3))` ms on the job's
  generation (S2 `renewLease`); a refused or throwing renewal stops the job
  before its next write.

## 8. Deviations from the plan text

All sanctioned by the WORKLIST; no behavior change.

- `test/rankingRankAnchor.test.ts`: the harness seed cloned plus a
  three-line comment (WL-S5-1). Otherwise identical to the plan.
- `test/rankingJob.integration.test.ts`: the prefix `hc-test-rankjob-` plus
  a one-line comment (WL-S5-7). Otherwise identical.
- `src/worker.ts`: "six" -> "seven" in the startPoll comment (WL-S5-5);
  the ranking block identical to the plan.
- `src/jobs/pollLoop.ts`: the loop-count comment (WL-S5-5), outside PR2's
  S5 list by the WORKLIST's comment-only allowance.
- `scripts/e2e-session.mjs`: `RATE_LIMIT_RANK_PER_MIN` and its comment
  (WL-S5-6); the ranking lines identical to the plan.
- Byte-identical to the plan (`cmp`): both job.ts import edits and both
  appended blocks, `rankingPoll.test.ts`, `devRankingTick.test.ts`,
  `rankingWiring.test.ts`, `jobWiring.ts`, the four `dev.ts` edits.
- S5.10: the app workspace suite instead of the root `npm test` (the
  brief); `pollLoop.ts` added to the eslint list (touched); the report adds
  the WI12 line (WL-S5-3), the shutdown residual (WL-S5-8) and the S5b
  detail the brief asks for.
- No one-value test fix: every hand-worked value held (lease isoAt(91000) at
  30000 ms, claim lease isoAt(150000), guard read count 6, every message
  string, the event status sequence, the summary counts).

## 9. QUESTIONS

None.

## 10. Coverage (plan 9.4)

Every row's named test exists in the files below (fixed-string grep of each
quoted name) and is green in the S5 set run (section 3 item 13):

- S5.3 claim / join / 409 rows: `rankingClaim.test.ts`.
- Poll claim race, in-process limit, takeover once then failed, the press's
  request id: `rankingPoll.test.ts`; DynamoDB Local repeats in
  `rankingJob.integration.test.ts`.
- Lease renewal, superseded exit, parallel batches with one failing, a pool
  of zero, never throws, an unreadable candidate, PR36, PR38, PR43, PR42 /
  R2B4, R2B5, WI16 on every payload: `rankingRankAnchor.test.ts`.
- Matches put, snapshot, failure kinds, flags across batches, a CLOSED flag
  overwritten, PR36 putRun, PR37, R2B7, BA6: `rankingRunBatch.test.ts`;
  flags closed on a text edit: `rankingFlags.test.ts`; run log cost,
  results[], cappedAtRun: `rankingRunLog.test.ts`; the event:
  `rankingUpdatedEvent.test.ts`, `sse.test.ts`, `eventBridge.test.ts`.
- The lane env, the worker poll and PR30 (worker side): `rankingWiring.test.ts`;
  the dev tick and R2F6: `devRankingTick.test.ts`.

## 11. For S6 (and S7) - what S5 shipped

- `services/ranking/job.ts` exports (exact names): `MSG_RUNNING`,
  `MSG_NOT_PICKED_UP`, `MSG_STOPPED`, `MSG_ERROR`, `MSG_TENANT_UNREADABLE`,
  `MSG_PROPERTY_UNREADABLE`, `GUARD_RETRY_MS` (500),
  `RANKING_POLL_LIST_LIMIT` (25), `unreadableMessage`, `omittedMessage`,
  `unscoredMessage`, `unsavedMessage`, `isVerified`, `RankingSlots`,
  `createRankingSlots`, `LeaseTimers`, `RankingJobDeps`, `RankingPress`,
  `ClaimResult`, `ClaimDeps`, `claimRanking`, `RankingJobViewStatus`,
  `RankingJobView`, `jobView(record, nowIso)` (derives `expired` with
  MSG_NOT_PICKED_UP), `rankAnchor(job, deps): Promise<void>`,
  `RankingPollSummary`, `runDueRankings(nowIso, deps): Promise<RankingPollSummary>`.
- S6's rank route builds `ClaimDeps` itself: `jobs` (`getJob`,
  `putJobClaim` from `createRankingRunsRepo`), `anchorExists` bound to S3's
  `rankingAnchorExists` (PR21; S5 keeps no copy), `config`
  (`rankingQueueExpiryMs`, `rankingPairTtlDays`), `now`. `claimRanking`
  returns `{ status: 202, job, joined } | { status: 409, error:
  'ranking_running' } | { status: 404 }`; a tenant anchor's `includeOlder`
  is forced false (always joins).
- `services/ranking/jobWiring.ts`: `createRankingJobDeps({ config, logger,
  events }): RankingJobDeps` - the ONE job deps builder (worker and dev
  tick); each call builds its own slots (RANKING_MAX_CONCURRENT_JOBS per
  process). It builds the driver from config at construction
  (`createRankingDriver(config, logger)`), so an anthropic driver without
  `ANTHROPIC_API_KEY` throws there (production config already requires the
  key; the worker builds it only when the poll is on; the dev tick builds it
  lazily on its first POST, local tables only, where the default driver is
  `console`). S6 should not need it (the routes do not run jobs).
- `POST /__dev/ranking/tick` (no body): runs ONE `runDueRankings` pass on
  the wall clock and answers `200 { ok: true, expired, claimed, tookOver,
  failedStale }` only after every job it claimed has finished; mounted only
  when the dev router is mounted AND `isLocalDynamoTarget(config.dynamodbEndpoint)`;
  test seam `DevRouterDeps.rankingTickDeps`. Its `events` is the app's own
  bus (`appEvents`), so `ranking.updated` reaches SSE clients with no bridge
  hop. S7's specs run jobs only through it (WI19).
- The hermetic lane (`scripts/e2e-session.mjs` childEnv, both children):
  `RANKING_DRIVER: 'fake'`, `RANKING_WORKER_POLL: 'off'`,
  `RATE_LIMIT_RANK_PER_MIN` = env ?? `'100000'`. So no lane spec can see the
  default 6-per-minute limit; S6's 429 proof must be a route-level app test
  with its own small ceiling (or a spec that sets the env var).
- `worker.ts` starts `startPoll('ranking', ...)` only under
  `config.rankingWorkerPoll`; the worker's `appEvents` reaches the app's SSE
  through the event bridge (best effort, spec D12 - the page also polls the
  job read).
- The job record S6 reads: `failedBatches` (PR42: exactly the candidates
  with no match through a failure, kinds `refusal|parse|truncated|timeout|driver|repo|error`;
  a partially written batch's index is in `batchesDone` too) and `notScored`
  (`omitted` | `unreadable`), both APPENDED by progress writes and reset by a
  takeover (which keeps `runIds`). The record's `message` is set only by
  the finishing writes (`finishJob`, `markExpiredQueued`,
  `markLeaseFailed`); a progress write carries none. `startedAt` is set when
  the POLL claims the record (`claimQueued`, not the press's `putJobClaim`)
  and reset by a takeover - PR13's out-of-date rule compares a match's
  `computedAt` with it.
- Test helpers (`test/helpers/rankingJobFixtures.ts`,
  `test/helpers/rankingRunsFake.ts`): as S5a-report.md section 8 lists. The
  rule from WL-S5-1: never seed the fake with the object handed to the code
  under test (`structuredClone` it); read-only seeds are safe because reads
  see `getJob` / `list*` clones.
- S6's DynamoDB Local prefix is `hc-test-rkread-` (WL-S6-1), the same
  residue-sweep reason as WL-S5-7.

## 12. Untrimmed input

None new. S5b adds no path that takes typed user input: the poll and the
tick take no body, and the job reads ids and records written by S2 / S6.
