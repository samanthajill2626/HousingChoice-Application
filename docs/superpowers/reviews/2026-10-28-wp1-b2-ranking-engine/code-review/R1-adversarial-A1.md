# R1-adversarial-A1 - plan-blind adversarial code review, Area 1 (server)

- Reviewer id: R1-adversarial-A1
- Branch: feat/wp1-b2-ranking-engine, HEAD a1077128, base main @404e039d
- Area: the server-side ranking engine - the model-scored tenant/property
  pairs, the job record and worker poll in DynamoDB (`ai_runs`), the stored
  match rows (`matches`), the ranking read endpoint, the admin run log and
  cost totals, and the counterfactual fair-housing check script.
- Read: `.superpowers/review/pkg-area1-server.diff` (log, stat, diff) and, in
  full at HEAD, `services/ranking/{job,runBatch,runLog,jobWiring,assemble,pool,
  cards,cardFields,prompt,parse,flags,cap,completeness,schema,seenSet,
  seenFeedback,pairHistory,fingerprints,cost,readRanking,rubric}.ts`,
  `adapters/{ranking,rankingFake}.ts`, `repos/{rankingRunsRepo,matchesRepo}.ts`,
  the `aiRunsRepo` / `placementsRepo` / `unitsRepo` deltas,
  `routes/{rankings,adminRankings}.ts`, the `api.ts` / `dev.ts` / `events.ts` /
  `tables.ts` / `config.ts` deltas, `worker.ts`, `jobs/pollLoop.ts`, the
  counterfactual script and its `rankingCounterfactual/` modules, the env
  examples, the RUNBOOK additions, `scripts/e2e-session.mjs`, and the test
  helpers `rankingJobFixtures.ts` / `rankingRunsFake.ts` plus the poll,
  rankAnchor, wiring, dev-tick and extraction-exclusion tests. Whole-app greps
  for every reader/writer of `ai_runs`, `matches`, the new event, the new
  config keys, `ANTHROPIC_*`, `DYNAMODB_ENDPOINT`, IAM (`infra/modules/ec2`),
  the event bridge receiver, the dev-router gate and the reseed path.
- Proof: one throwaway unit file on the in-memory fakes (deleted); every
  CONFIRMED item below reproduced against a1077128 (6/6). Reproduction steps:
  `.superpowers/sdd/research/R1-adversarial-A1-reference.md`.
- Verdict: the design holds up well under overlap - every job write is
  status- and generation-conditioned, overlapping ticks and two pollers cannot
  double-claim, the extraction readers cannot see any ranking family, and the
  deployed-config refusals are sound. ONE real defect in the slot accounting
  (a thrown takeover leaks a slot for the life of the process - MEDIUM) and a
  set of LOW issues where a transient bookkeeping failure is turned into a
  user-visible failure or a re-billed re-run, and where the stop path hides a
  paid call from the cost page despite the RUNBOOK's "spend is never
  invisible". No CRITICAL or HIGH.

Counts: CRITICAL 0, HIGH 0, MEDIUM 1, LOW 7, INFO 8.

## Findings

### R1-adversarial-A1-1 - MEDIUM - CONFIRMED - a takeover that throws leaks its job slot forever

- Where: `app/src/services/ranking/job.ts:617-643` (stale-lease loop); the
  slot is acquired at `job.ts:627` INSIDE the `try`, so the `catch` at
  `job.ts:640-642` cannot reach `release`. Compare the queued loop,
  `job.ts:600-614`, which acquires before the `try` and releases in the catch.
- What happens: a running record past its lease (attempts 0) is listed;
  `tryAcquire()` takes a slot; `takeOver` throws any non-conditional error
  (throttling or a network error that survived the SDK's own retries); the
  catch logs "ranking poll: stale lease step failed" and the slot is never
  returned. `RankingSlots` is per process and lives as long as the worker.
  With the default RANKING_MAX_CONCURRENT_JOBS=2, two such throws (the same
  stale record is retried every 30 s tick, so a short DynamoDB episode is
  enough) leave the worker with zero slots: the queued loop breaks at once
  (`job.ts:602`), every new press sits queued and fails "The ranking was not
  picked up" after 10 minutes, until the worker restarts; and the stale
  anchor itself stays `running` (attempts 0, so never marked failed) and
  every press on it joins a job nothing will run. Reproduced: after
  one thrown takeOver with 1 slot, `slots.inUse()` stays 1, and a later pass
  claims nothing (`claimed: 0`, record stays `queued`, driver never called).
- Why it matters: production runs ONE worker container
  (`docker-compose.yml`), so this silently disables ranking for the whole
  stack; the only symptom is a single ERROR line per throw. Takeovers happen
  exactly when things are already unhealthy (a dead worker, a deploy, a
  failed renewal), which is when DynamoDB errors cluster.
- Smallest fix: declare `let release: (() => void) | undefined` before the
  `try` in the stale loop and call `release?.()` in its `catch` (the queued
  loop's shape).
- Test that catches it: in `rankingPoll.test.ts`, seed
  `runningJob({ leaseExpiresAt: isoAt(-1) })`, make `runs.repo.takeOver`
  throw, run one pass with `createRankingSlots(1)`, assert
  `slots.inUse() === 0` (fails today), and that a following pass claims a
  newly queued record.

### R1-adversarial-A1-2 - LOW - CONFIRMED - a stopped or superseded generation drops a PAID call with no run record

- Where: `app/src/services/ranking/runBatch.ts:230` (the generation check
  sits BEFORE `putRun`), against the stated rule at `runBatch.ts:234` ("the
  call is paid for; a lost run must never hide the spend") and RUNBOOK.md:1828
  ("the spend is never invisible"). The cost totals read run records only
  (`app/src/routes/adminRankings.ts:332-386`).
- What happens: the model call returns (usage billed), then `ctx.guard()`
  returns false because the job was stopped or superseded, and the batch
  returns STOPPED without writing the run. Triggers: a lease renewal that
  throws or is refused (`job.ts:498-510`), a takeover by another process
  while this one is alive, or the guard's double read failure
  (`job.ts:468-487`). Up to RANKING_BATCH_CONCURRENCY calls per incident are
  lost to the run log; the only trace is the adapter's info line
  "anthropic ranking usage" (`app/src/adapters/ranking.ts:116-124`: tokens,
  no runId, no cost) - not the error line the RUNBOOK tells operators to look
  for. Reproduced for both a thrown renewal and a takeover: one call made,
  zero runs written.
- Note: `app/test/rankingRankAnchor.test.ts:343-357` and `:373-385` pin the
  current behavior ("no run" when superseded or when a renewal fails), so the
  "exit quietly" rule and the "never hide the spend" rule are in conflict in
  the design itself; the tests chose the one that hides spend.
- Why it matters: the Settings > Rankings weekly cost is the operator's spend
  view and under-reports by exactly the calls of failed/overlapped attempts;
  the RUNBOOK sentence is false.
- Smallest fix: write the run (it already carries `jobGeneration`) whatever
  the guard says, i.e. move the `putRun` above the `runBatch.ts:230` check
  (keep the check for the matches, flags and progress writes); or, minimally,
  log the run's usage and computed cost at WARN on the stopped path and
  correct the RUNBOOK.
- Test: the two pinned tests above, inverted - after a supersession during the
  call, `runs.runs.size === 1` with `jobGeneration: 'gen-1'` and
  `h.matches.puts` still empty.

### R1-adversarial-A1-3 - LOW - CONFIRMED - one transient renewal failure stops the job and forces a full re-billed re-run

- Where: `app/src/services/ranking/job.ts:506-509` (a THROWN `renewLease`
  sets `stopped` exactly like a refused one).
- What happens: renewals run every RANKING_LEASE_MS / 3 (30 s), so when one
  throws the lease still has ~60 s left and the next renewal is 30 s away.
  Instead the job stops: in-flight results are discarded (A1-2), the record
  stays `running` until the lease lapses, the next tick takes it over
  (attempts 1) and the job runs again from batch 0 - every batch billed again
  - and a second hiccup in that attempt fails it "stopped before it
  finished". The guard read, by contrast, retries once (`job.ts:468-473`).
  Reproduced: after a thrown renewal mid-call the record is still `running`,
  nothing written.
- Smallest fix: on a thrown renewal, log and keep going; stop only on a
  REFUSED renewal, or when the last successful renewal is older than the
  lease (the lease really lapsed).
- Test: rankAnchor with `renewLease` throwing once then succeeding, a gated
  call in flight; assert the batch's run and matches are written and the job
  ends `done`.

### R1-adversarial-A1-4 - LOW - CONFIRMED - bookkeeping-write failures after real work are reported as scoring failures

- Where: `app/src/services/ranking/job.ts:443` (the final `finishJob` is not
  caught inside `runJob`) with the catch-all at `job.ts:519-525`; and
  `app/src/services/ranking/runBatch.ts:99-105` (`progress()` lets
  `updateJobProgress` throw) with `runBatchSafely` at `job.ts:326-344`.
- What happens: (a) every batch scored and saved, then the `done` write
  throws once -> the catch re-guards and finishes the job `failed` with "The
  ranking could not finish. Press Rank again." (b) a batch's run and matches
  land, then its progress write throws -> `runBatchSafely` lists EVERY
  candidate of the batch in `failedBatches` with failure 'error', and the job
  message says "2 tenants could not be scored. Press Rank again." Both
  reproduced. The read itself stays right (rows exist, computed after the job
  start), but the page tells staff to press again - a needless re-run that
  is billed again - and `batchesDone` / `runIds` miss the batch.
- Smallest fix: wrap the progress and finish writes in their own
  try-with-one-retry; on a second failure log it and record the batch as done
  (or leave the job to the lease/takeover path), never as a scoring failure.
- Tests: the two reproductions in the reference file (assert `done`, no
  failedBatches, no message).

### R1-adversarial-A1-5 - LOW - CONFIRMED (the condition) / PLAUSIBLE (the interleaving) - a stale job replaces an OPEN unlawful flag

- Where: `app/src/repos/rankingRunsRepo.ts:907`
  (`attribute_not_exists(#itemId) OR #textHash <> :textHash`), written from
  `runBatch.ts:311-320` with the hash of the text the job read at assemble
  time; "open" is `flags.ts:38-44`; the exemption it buys is `cap.ts:94`.
- Interleaving: job J1 (anchor A) assembles and reads property P's
  `qualifications` = T1; staff edit it to T2 (the unlawful clause kept); job
  J2 (another anchor) assembles, scores and writes the flag with hash(T2) -
  open; J1's slower batch then writes hash(T1): the condition passes because
  the hashes differ, the record is replaced, and it now reads CLOSED against
  the current T2. Until some later press re-raises it, the flag vanishes from
  the read and the run detail, and a failed `qualifications` caps every
  tenant of P again - an unlawful clause back in effect. The repository's own
  doc ("write unless one is OPEN", `rankingRunsRepo.ts:876-881`) is not what
  the condition can check. Reproduced on the fake, which mirrors the
  condition.
- Smallest fix: key the record by the hash too (`uflag#<unit>#<field>#<hash>`,
  same partition) so writers never overwrite each other and "open" is "a
  record whose hash equals the current text's hash"; or keep one record and
  add the hash to the item key's sort side in the uflags partition.
- Test: write hash(T2), then hash(T1); `openFlagFields(records, { field: T2 })`
  must still return the field.

### R1-adversarial-A1-6 - LOW - PLAUSIBLE - a hung step keeps its job "running" indefinitely

- Where: `app/src/services/ranking/job.ts:511-514` (the renewal interval is
  independent of progress and is cleared only in the `finally`,
  `job.ts:526-528`); `app/src/lib/dynamo.ts:59-79` sets no request timeout and
  `@smithy/node-http-handler` (4.9.13) defaults `requestTimeout` to 0.
- What happens: if any awaited step never settles (a stalled DynamoDB
  socket; the Anthropic call is bounded by its own timeout), the renewal
  timer keeps extending the lease on a live generation, so no takeover ever
  happens: the anchor reads "running" forever (presses join it or get 409)
  and one of the process's slots is gone until restart.
- Smallest fix: a ceiling on a job's life - stop renewing (and let the
  takeover path run) once `startedAt` is older than, say, the batch count
  times twice the call timeout; or give the DynamoDB client a
  requestTimeout.
- Test: rankAnchor with an assemble that never resolves, a captured interval;
  after N intervals past the ceiling the renewal must stop.

### R1-adversarial-A1-7 - LOW - PLAUSIBLE - ranking bursts share the extraction key's rate limit

- Where: `app/src/services/ranking/jobWiring.ts:31` / `adapters/ranking.ts:79-92`
  (2 jobs x 4 batches = up to 8 concurrent calls per worker, each a
  ~7k-token system prompt plus up to 40 full tenant cards); extraction runs on
  the same ANTHROPIC_API_KEY and burns an attempt per failed call, parking a
  row after 5 (`app/src/jobs/extraction.ts:860-867`).
- What happens: one press of a large pool can push the organization's
  per-minute token limit; concurrent extraction calls then fail (429 after
  the SDK retry), back off, and can park - an inbox feature degraded by a
  Settings button. Ranking itself just fails the batch.
- Smallest fix: document the coupling and size RANKING_BATCH_CONCURRENCY /
  RANKING_MAX_CONCURRENT_JOBS against the key's tier; better, treat a 429 as
  a non-attempt-burning failure in extraction, or share one in-process AI
  call limiter.
- Test: none offline beyond a unit test that a driver 429 does not burn an
  extraction attempt (if that route is taken).

### R1-adversarial-A1-8 - LOW - PLAUSIBLE - `customFields` reach the model wholesale, outside the per-attribute allowlist

- Where: `app/src/services/ranking/cardFields.ts:131` (`customFields:
  include(...)`), copied as is by `cards.ts:293-296`; stored for
  RANKING_PAIR_TTL_DAYS in each run's `inputGzip` (`runLog.ts:114`) and each
  match's `inputSnapshot` (`runBatch.ts:145`).
- What happens: the card is a runtime allowlist per attribute (charter 6.1,
  `cardFields.ts:1-7`), but `customFields` is a container of staff-defined
  label/value pairs (`lib/contactProfile.ts:26-37`), so any field staff add -
  a birth date, an income, a case number, a diagnosis - goes to the model and
  into two 180-day stores without anyone classifying it. The counterfactual
  check never swaps a custom field (`app/scripts/rankingCounterfactual/swaps.ts:24-70`),
  so the gate does not cover this path either.
- Smallest fix: exclude `customFields` (or allowlist custom labels), or add a
  custom-field swap to the counterfactual suite and say in the RUNBOOK that
  custom fields are model input.

## INFO

- R1-adversarial-A1-9 (INFO): there is no production-legal way to pause
  ranking spend: console/fake drivers and RANKING_WORKER_POLL=off are refused
  under NODE_ENV=production (`config.ts:854-875`), the rank API accepts any
  VA (`routes/rankings.ts:1-3`), the limiter is per user per process
  (6/min), and removing ANTHROPIC_API_KEY now refuses BOTH the app and the
  worker at boot (`config.ts:876-882`) - taking down sends and the inbox
  where extraction is off - though only the worker's poll ever calls the
  model (the app never builds the ranking driver outside the local dev
  tick). Stated as a design decision (charter item 12); flagging the blast
  radius. Requiring the key only in the worker would narrow it.
- R1-adversarial-A1-10 (INFO): worker shutdown (`worker.ts:620-646`) does not
  stop the ranking poll or release running leases; every ranking in flight
  at a deploy is abandoned mid-call (paid, unrecorded), waits out the 90 s
  lease, and is re-run in full by the new worker. Setting the lease to now on
  SIGTERM would let the new worker take over at once.
- R1-adversarial-A1-11 (INFO): no cross-check that RANKING_QUEUE_EXPIRY_MS
  exceeds WORKER_POLL_INTERVAL_MS (`config.ts:789-845`); an expiry below the
  interval makes every press fail "not picked up".
- R1-adversarial-A1-12 (INFO): `uflag#` rows carry no TTL and nothing deletes
  them (`rankingRunsRepo.ts:887-917`); bounded per unit and field, they
  outlive a deleted unit. Matches and runs of a HARD-deleted contact (import
  retract, `lib/import/apply.ts:826-833`) keep its name and card
  (`handles.display`, `inputGzip`, `inputSnapshot`) for up to 180 days.
- R1-adversarial-A1-13 (INFO): `matchesRepo.listByUnit` / `listByTenant`
  (`matchesRepo.ts:249-277`) have no caller in `app/src`; the "Rankings page
  only" comment is stale.
- R1-adversarial-A1-14 (INFO): `new Anthropic({ apiKey })`
  (`adapters/ranking.ts:64`) silently honors the SDK's own
  `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` environment variables;
  config refuses only the app's `ANTHROPIC_API_BASE_URL` in production
  (`config.ts:1267-1272`). Pre-existing for extraction; ranking now always
  builds the client in a deployed worker.
- R1-adversarial-A1-15 (INFO): a renewal already in flight when the job
  finishes logs "ranking job lease renewal refused - stopping" at WARN after
  "ranking job done" (`job.ts:502-504` vs the clear at `job.ts:527`) -
  misleading log noise.
- R1-adversarial-A1-16 (INFO): one run's unlawful flag - including a false
  positive on lawful text - becomes a property record that lifts the cap for
  that field on EVERY pair of the property until the text is edited; the
  planned dismissal is display-only by design (`flags.ts:12-14`). Worth a
  conscious check that a single model mistake should have property-wide,
  indefinite effect.

## Swept and fine

- Claim/join/409 (`job.ts:211-223`): one conditional put; a lost race reads
  consistently and joins only the same window; retried once when the record
  finished in between.
- Every job write is conditioned on status and generation
  (`rankingRunsRepo.ts:305-495`); a superseded finish, progress or renewal is
  refused; takeover is once (`attempts < 1`), its listing staleness is
  harmless because the conditions are re-checked on the base table.
- Overlapping ticks and two pollers: the queued loop reserves the slot
  before the claim and releases on a lost or thrown claim; the existing
  WI15 tests cover both, and I re-walked the stale-GSI cases (claimed record
  still listed as queued, re-pressed generation, expired-and-reclaimed).
- Queue expiry vs a fresh press: `markExpiredQueued` is generation-conditioned
  and cannot fail a re-press.
- `ai_runs` readers: extraction scopes are a closed regex
  (`routes/aiRuns.ts:30-31`), `getRun` reads `run#`, no Scan touches the
  table; ranking partitions (`rankjobs#`, `rankings#`, `uflags#`) and keys
  (`rjob#`, `rrun#`, `uflag#`) never collide; the exclusion integration test
  is real. The GSI projects ALL (`infra/modules/dynamodb/main.tf:57`), so the
  job listings return whole records.
- `matches` table: no prior reader or writer; legacy rows ignored by schema.
- IAM: the instance policy's per-table actions cover BatchWrite, BatchGet and
  the transactions (`infra/modules/ec2/main.tf:44-61`).
- Reseed wipes every table in `TABLES`, `matches` and `ai_runs` included.
- Event: `ranking.updated` carries ids, status and two counts only
  (`runBatch.ts:76-85`); the SSE route is behind requireAuth; the bridge
  receiver allowlists event names (`routes/internal.ts:69-80`).
- Auth: `/api/rankings` behind the /api requireAuth (admin and va only
  roles exist); `/api/admin/rankings` behind `requireRole('admin')` on the
  router; CSRF origin middleware and SameSite=lax apply app-wide.
- Spend bounds per press: RANKING_MAX_POOL before any call, ceil(pool/40)
  calls, SDK maxRetries 1 with a 120 s timeout, one takeover; joins spend
  nothing; reads call no model.
- Dev tick: mounted only behind the dev-router triple gate AND a loopback
  endpoint (`routes/dev.ts:813-827`); never in a deployed stack.
- Config: every ranking key parses fail-fast; fake/console refused in
  production and on real tables; the e2e lane forces fake + poll off on a
  loopback endpoint; `.env.example` sets neither driver nor poll.
- Logs: ids and counts only on every ranking path I traced; the parse error
  message is fixed text; the console driver logs sizes only.
- Run listing and cost read the summary projection only (no rawText,
  inputGzip, handles or results); BatchGet leftovers surface as
  `incomplete`, never a silent drop; the cursor/`from`/`to` bound logic
  handles BETWEEN's inclusive top.
- `putMatches` never throws on a DynamoDB failure and reports unwritten
  pairs; `getPairs` is complete-or-nothing; the 350 KB run guard drops only
  `inputGzip` (adequate at the default output cap).
- Counterfactual script: synthetic records only, no DB or AWS, the key shown
  as its last four characters, the endpoint printed before the first call,
  the output file checked before spending, any ungraded run fails the gate.
