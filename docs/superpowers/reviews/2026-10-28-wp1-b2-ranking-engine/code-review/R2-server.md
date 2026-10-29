# R2-server - fresh code re-review (round 2), server side

- Reviewer id: R2-server (Claude Opus 5.5), 2026-10-29.
- Branch feat/wp1-b2-ranking-engine @ be595125 (base main @404e039d). The
  fix wave under review is ebc618dd..be595125.
- Area: the server side of the ranking engine - services/ranking/**,
  adapters/ranking*.ts, repos/{matchesRepo,rankingRunsRepo,unitsRepo,
  placementsRepo,aiRunsRepo}.ts, routes/{rankings,adminRankings,api,dev}.ts,
  worker.ts, jobs/pollLoop.ts, lib/{config,events,tables,
  tenantMatchingInputs}.ts, the seed change, the counterfactual script and
  its modules, the compile-check change, scripts/e2e-session.mjs, their
  tests, RUNBOOK.md's ranking sections, the env examples and the new
  docs/issues files. Round 1 for this area: R1-adversarial-A1.md and the
  server rows of R1-conformance.md; fix rows FW1-1, FW1-2, FW1-3, FW1-11
  (apply.ts comment), FW1-12 (RUNBOOK) and the FILE rows.
- Read: the brief; R1-adversarial-A1, R1-conformance, R1-adjudications,
  FW1-report; the fix diff (`git diff ebc618dd..HEAD`) line by line; at HEAD
  in full: job.ts, runBatch.ts, runLog.ts, cost.ts, readRanking.ts,
  assemble.ts, pool.ts, cards.ts, cardFields.ts, flags.ts, cap.ts, parse.ts,
  prompt.ts, schema.ts, rubric.ts, fingerprints.ts, pairHistory.ts,
  seenSet.ts, jobWiring.ts, completeness.ts (the gap rules),
  adapters/ranking.ts, the console/fake driver tail, rankingRunsRepo.ts,
  matchesRepo.ts, routes/rankings.ts, routes/adminRankings.ts, pollLoop.ts,
  the counterfactual CLI and evaluate/cards modules; the branch diffs of
  config.ts, worker.ts, dev.ts, api.ts, events.ts, tables.ts, unitsRepo.ts,
  placementsRepo.ts, aiRunsRepo.ts, tenantMatchingInputs.ts, lean.ts,
  db-seed.ts, the compile check, e2e-session.mjs and the three env examples;
  RUNBOOK.md 1690-1945 and GLOSSARY.md's FW1 hunks; the four new issue
  files. Spec D7 and D10 opened ONLY to check the reasons the adjudications
  and the code cite. Whole-app greps: every reader/writer of `matches`,
  `ai_runs` key families, the event bridge allowlist, the deploy hydration
  of SSM values, secrets push/parse of a JSON value.
- Proof (all throwaways deleted; `git status` shows none of mine - the three
  untracked `dashboard/src/zz-review-*.test.tsx` files are another
  reviewer's and were not touched):
  - `app/test/zz-review-flagreason.test.ts` (2 cases) - R2-server-1.
  - `app/test/zz-review-takeover-ambiguous.test.ts` (2 cases) -
    R2-server-2, R2-server-3.
  - Mutants: the PRE-FIX `job.ts` and `runBatch.ts` (from ebc618dd) copied
    to the scratchpad with absolute imports and aliased in a throwaway
    vitest config (scratchpad) - section 4.
  - HEAD: rankingPoll, rankingRankAnchor, rankingRunBatch 60/60 green.
- Verdict: the fix wave's three code fixes are REAL (each new test fails for
  the finding's reason with only that fix reverted). One new MEDIUM: the
  unlawful flag's stored reason is lifted from the raising PAIR's own text,
  so one tenant's fact (an eviction, a pet, an accessibility need) lands in
  a PROPERTY record with no TTL and is shown on every other tenant's view of
  that property, as the reason for a fair-housing flag it does not describe.
  Two LOWs (an ambiguous takeover loses the press; the FW1-12 RUNBOOK spend
  sentence contradicts the same section), four INFO. No CRITICAL or HIGH.

Counts: CRITICAL 0, HIGH 0, MEDIUM 1, LOW 2, INFO 4.

## 1. NEW findings

### R2-server-1 - MEDIUM - CONFIRMED (mechanism) / PLAUSIBLE (the model's wording) - a pair's own reason text becomes the property's permanent fair-housing flag reason

- Where: `app/src/services/ranking/flags.ts:75-81` (`flagReason`: the first
  `against` text containing the field's words, else the first `unknowns`
  text containing them, else the default), called by `mergeRaisedFlags`
  (`flags.ts:109`); written by `runBatch.ts:329-338` into the record built
  at `rankingRunsRepo.ts:891-901` (no `expires_at` - spec D10 "no TTL");
  read for EVERY property in view by `readRanking.ts:476-482` (the
  property's own ranking and every tenant anchor whose pool lists it) and by
  the run detail (`adminRankings.ts:276-277`); rendered as "Fair-housing
  flag on <place>, <field>: <reason>" (`RankAnchorPanel.tsx:40`) and
  "<field>: <reason>" (`RankingRunDetail.tsx:159`).
- What happens: against-reasons and unknowns describe THE PAIR - this
  tenant against this property. The rubric forbids the unlawful requirement
  as a reason against ("Do NOT apply an unlawful requirement ... add one
  unknowns note that names the field", `rubric.ts:74`), so an against-reason
  that names the field is, by the rubric's own contract, about something
  else: a LAWFUL clause of the same field, or this tenant's facts. Yet
  `flagReason` checks `against` FIRST, and matches on a substring of the
  field key: the rubric's own example reason "no pets, has a cat"
  (`rubric.ts:82`) matches `pets`; "accessibility: needs a wheelchair-ready
  unit" matches `accessibility`; and for the worked example's own text,
  qualifications "No kids under 12. No evictions in the last 3 years."
  (`examples.ts:461`), a tenant with a recent eviction gets that failure as
  the FIRST reason against (`rubric.ts:59`) - any wording that names
  qualifications becomes the PROPERTY's unlawful-flag reason. The first
  raising run keeps the record (D10), so whichever tenant's pair raised it
  first speaks for the property until the text is edited; a closed record is
  never deleted.
- Reproduced (throwaway, on the repo fakes): `flagReason('pets', { against:
  ['no pets, has a cat'], unknowns: ['pets: ... not applied (fair
  housing)'] })` -> "no pets, has a cat"; the accessibility case returns the
  tenant's need. End to end: `runBatch` for tenant A on a property whose
  qualifications is the example text, with against "eviction in 2024 fails
  qualifications" and the rubric-form unknown -> the stored `uflag#` record's
  reason is "eviction in 2024 fails qualifications", with no `expires_at`;
  then `readRanking` of that property with ONLY tenant B in the pool returns
  `flags = [['qualifications', 'eviction in 2024 fails qualifications']]`.
- Why it matters: (a) one person's fact - possibly a disability-related or
  familial one (an accessibility need, an assistance animal, children) or an
  eviction - is copied out of the pair-scoped, 180-day stores into a
  PROPERTY record with no TTL that outlives the tenant's record and the
  retention every other ranking store has (round 1's A1-12 saw "no TTL" but
  not that the row carries a person's data), and is returned by GET
  /api/rankings (admin and va) on every view involving that property - on
  tenant B's page it reads as part of B's ranking. (b) The flag's one line
  of explanation describes the wrong thing (the lawful evictions clause, or
  the tenant), and that line is what B4's admin review and Dismiss will read
  to judge a fair-housing flag; a false positive (A1-16) is then harder to
  spot.
- Smallest fix: never store pair text on a property record - write
  `DEFAULT_FLAG_REASON` (or a code-built "<field label>: flagged as a
  requirement fair housing does not allow") and leave the pair's own text on
  its match and run, where it already lives under the 180-day TTL. Spec D10
  names "the model's against-reason or unknown text naming it", so that is a
  ruling for Cameron; the narrowest change inside D10's words is to drop the
  `against` source and accept only an unknown in the rubric's own form
  ("<field>: ... not applied (fair housing)"), else the default - but a
  tenant-specific unknown such as "pets: whether the dog is an assistance
  animal is unknown" shares the prefix, so the default sentence is the safe
  choice. `test/rankingFlags.test.ts:67-88` pins today's order with fixtures
  in which the model writes the unlawful clause as a reason against - the
  form the rubric forbids - and must change with the fix.
- Test that catches it: the throwaway inverted - after `runBatch` with a
  tenant-specific against-reason (and unknown) naming the flagged field, the
  stored record's reason contains no pair text, and the property's read for
  another tenant shows none.

### R2-server-2 - LOW - CONFIRMED - a takeover that lands but throws loses the press with no model call

- Where: `app/src/services/ranking/job.ts:644-659` (the stale-lease loop:
  `takeOver`, and FW1-1's catch, which now releases the slot);
  `rankingRunsRepo.ts:330-361` (the takeover sets a NEW generation and
  attempts + 1). The queued loop has the same shape (`job.ts:613-627`,
  `claimQueued`).
- What happens: an UpdateItem can commit and still throw at the caller (a
  timeout or socket error after the commit - the ambiguity matchesRepo's
  PR37 already names for BatchWrite). For `takeOver` the record is then
  `running` on generation G' with attempts 1 and a fresh lease that NO
  process runs: the catch logs "stale lease step failed" and releases the
  slot. About 90 s later the next tick lists it, sees attempts >= 1 and
  `markLeaseFailed` fails it "The ranking stopped before it finished. Press
  Rank again." - with zero model calls. An ambiguous `claimQueued` is the
  milder twin: nothing runs the claimed record until its lease lapses (90 s)
  and the takeover runs it, which spends the job's one takeover (a deploy
  during that run then fails it).
- Reproduced (throwaway): one slot, a stale running record (attempts 0); the
  fake's `takeOver` applies, then throws. Pass 1: `slots.inUse() === 0`,
  record running on `gen-new-1` with attempts 1, driver 0 calls. Pass 2 at
  +91 s: record failed with MSG_STOPPED, driver still 0 calls.
- Why it matters: takeovers happen exactly when DynamoDB is unhealthy (a
  dead worker, a failed renewal), which is when ambiguous errors cluster;
  the press is silently converted into a "press again" after two minutes.
  FW1-1's fix is right (the slot must come back) but cannot see the case.
- Smallest fix: in the stale loop's catch, before releasing, read the record
  once (consistent); if it is `running` on the generation this tick
  proposed, start it with the slot already held (`startClaimedJob`) instead
  of releasing. Same for `claimQueued` (running, the listed generation,
  `startedAt === nowIso`).
- Test: the throwaway inverted - after pass 1 the driver was called and the
  record is `done`.

### R2-server-3 - INFO - CONFIRMED - a dead job is never taken over while each tick has queued work

- Where: `job.ts:613-628` runs the queued claims first and takes every free
  slot; the stale loop (`job.ts:630-661`) then `continue`s past every
  attempts-0 record when no slot is free.
- What happens: as long as every tick finds a queued press for the free
  slot, an OLDER press's dead job (attempts 0) is never taken over: its
  anchor reads "running" with frozen progress and new presses on it join a
  job nothing runs, while newer presses complete. It ends when the queue
  drains (queued presses expire after RANKING_QUEUE_EXPIRY_MS).
- Reproduced (throwaway): one slot, a stale attempts-0 job and a new queued
  press each pass; three passes each `claimed: 1, tookOver: 0`; the stale
  record still running on its original generation.
- Fix: run the stale loop's takeovers before the queued claims (the older
  press first). Test: the throwaway inverted (`tookOver: 1` on the first
  pass).

### R2-server-4 - INFO - PLAUSIBLE - every ranking read pulls whole match rows, snapshots included

- Where: `matchesRepo.ts:219-245` (`getPairs`: no ProjectionExpression,
  ConsistentRead), used by `readRanking.ts:410-416` on every page open and
  on every finished batch the page follows, and by the run detail.
- What happens: each read fetches every pool member's full row, including
  `inputSnapshot` (the pair's whole input gzipped and base64-encoded:
  anchor card, tenant card with its Notes, and the cards of up to
  RANKING_SEEN_MAX seen homes) that the read never uses - up to 300
  consistent whole-item reads per read at RANKING_MAX_POOL, repeated per
  batch while a job runs. The WI18 budget was measured with small seeded
  rows.
- Fix: a ProjectionExpression of the fields `deriveMatch` and the run detail
  read.

### R2-server-5 - INFO - CONFIRMED (by reading) - the glossary says only edits move a fingerprint

- Where: `documentation/GLOSSARY.md:913-916` ("A bare new send never
  changes one; a decline, a tour, a Notes edit or an edit to a card field
  does"; FW1-12 extended this entry), against `cards.ts:297` and
  `fingerprints.ts:62-88` (the tenant card carries the `lastHeardFrom`
  BUCKET, computed from `now`) and `cards.ts:157` (a property card carries
  its authorities as mapped against the organization list).
- What happens: every match of a tenant reads out of date ("card") when 7,
  30 or 90 days of silence pass, and every match of a property when an
  organization-list edit changes how one of its authority names maps - no
  card field was edited. `fingerprints.ts`'s header says "Recency enters only
  as its bucket"; the glossary and the RUNBOOK do not, so staff are left to
  wonder why an untouched match went out of date overnight.
- Fix: one sentence in the glossary entry (and the RUNBOOK's out-of-date
  list).

## 2. Defects in the fix diff

### R2-server-6 - LOW - CONFIRMED (the contradiction) / PLAUSIBLE (the timeout part) - the new "spend is never invisible" sentence is false by the same section's own account

- Where: `RUNBOOK.md:1838-1846` (FW1-12: "So every paid call is a run
  record or one of those two log lines - the spend is never invisible")
  against `RUNBOOK.md:1938-1944` ("model calls in flight at the kill are
  billed but never logged (no run record, no usage line)") and the FILE'd
  `docs/issues/ranking-job-lifecycle-robustness.md` item 4 ("paid, and the
  process exits before the stopped-call WARN line can be written").
- What happens: a deploy or crash mid-call leaves neither a run nor either
  log line; the RUNBOOK now says both that this cannot happen and that it
  does. PLAUSIBLE second gap: `adapters/ranking.ts:91` retries a timed-out
  call once (maxRetries 1); an attempt the client timed out can still be
  processed by the API, carries no usage, and a timeout failure's run
  records `costUsd` 0 (`runLog.ts:105-107`), so the weekly cost and the
  lines both miss it.
- Why it matters: an operator reconciling the provider's bill against
  Settings > Rankings plus the two log lines is told any residue cannot be
  ranking - the reconciliation the sentence exists for.
- Smallest fix: "every paid call that returns to a live worker is a run
  record or one of those two lines; calls killed with the worker (see 'A
  deploy ... mid-ranking') and an attempt the SDK retried after a timeout
  leave neither, so the weekly cost reads low by those too."
- Test: none (documentation).

### R2-server-7 - INFO - PLAUSIBLE - the finish retry can swallow the done event and line

- Where: `job.ts:309-331` (FW1-3's retry in the `finishJob` helper).
- What happens: if the FIRST write committed but threw (the ambiguous case
  again), the retry's condition fails (status is already `done`), the
  helper gets `undefined` and returns before `emitRankingEvent` and the
  "ranking job done" line - the job IS done, with only a "finish write
  failed - retrying once" WARN in the log and no done event; the page's 5 s
  job poll recovers. If instead the RETRY commits and throws, `runJob`
  throws, and the catch-all's guard reads `done` and logs "ranking job
  superseded - exiting quietly" for a job that finished. Log and hint noise
  only; the record is right in both cases.
- Fix (optional): after a retry answers `undefined`, read the record once;
  if it is finished on this generation, emit and log as the first write
  would have.

## 3. Adjudication challenges

- A1-12 (NOTE: `uflag#` rows have no TTL, by spec D10) - WORSE THAN NOTED:
  the row is not only TTL-less, it can carry a person's data and is shown
  across tenants (R2-server-1). Recommend it travels to the handback with
  R2-server-1 as one decision.
- FW1-2's prescribed RUNBOOK wording ("a run record, or a WARN line with
  usage and cost") was inexact by construction: the same adjudication
  FILE'd A1-10, the path with neither (a worker killed mid-call). The fix
  child wrote what the row asked for; the result is R2-server-6.
- A1-16 (NOTE: one run's unlawful flag lifts the cap for that field on every
  pair) - agree NOTE, but it is broader than "a false positive": the worked
  example's own qualifications text (`examples.ts:461`) mixes the unlawful
  clause with a LAWFUL evictions clause; once that flag is open,
  `cap.ts:94` lifts the code cap for a failed qualifications on every pair,
  the evictions part included, and only the model's own Weak score
  (`rubric.ts:59`) keeps such a pair low. With R2-server-1 the flag's reason
  may then describe the evictions clause. Carry both to the handback
  together.
- Reasons verified true (agree): A1-3 FILE - spec D7 does say "a renewal
  that fails stops the job" (spec lines 688-690); A1-4 (b) FILE -
  `updateJobProgress` appends with `list_append`
  (`rankingRunsRepo.ts:446`), so a blind retry duplicates; FW1-2 - spec D7
  "before every model call and every write (match, run, flag, record)";
  FW1-3's safety - `finishJob` is conditioned on running AND the generation
  and a lost condition answers `undefined` (`rankingRunsRepo.ts:41-55,
  467-490`). A1-5, A1-6, A1-8, A1-10 FILE and A1-9, A1-11, A1-13, A1-14,
  A1-15 NOTE: no disagreement.

## 4. Fix verification

| Row | Verdict | Evidence |
|---|---|---|
| FW1-1 (slot leak on a thrown takeOver) | REAL | Mutant: pre-fix `job.ts` aliased -> exactly the new poll test fails, "expected 1 to be +0" at `slots.inUse()`; every other poll and rankAnchor test passes. HEAD green. Release is idempotent and nothing after `started.push` can throw. Residual: R2-server-2 (the landed-then-thrown case). |
| FW1-2 (paid call of a stopped job) | REAL (code) | Mutant: pre-fix `runBatch.ts` aliased -> exactly the three new assertions fail ("expected undefined to match object { level: 40, ... }"), 44 others pass. The WARN carries where, runId, model, usage, costUsd, callFailure - no name, card or score. The doc half: R2-server-6. |
| FW1-3 (thrown final finish write) | REAL | Mutant: pre-fix `job.ts` -> the new rankAnchor test fails (`status: "failed"` where "done" expected). The retry reuses one `finishedAt`, cannot touch another generation and cannot double-emit. Residual: R2-server-7 (INFO). |
| FW1-11 (apply.ts comments) | REAL | The contact is read at `jobs/extraction.ts:486`, before the model call at `:673`, and handed to `applyExtraction` at `:703`; `nextNotes` is that snapshot plus the new lines (`apply.ts:986-987`), written at `:995` - exactly what both comments now say. |
| FW1-12 (RUNBOOK) | PARTLY | The extraction owed-ops text is right (`parseRankingConfig` refuses production without the key). "One key, one rate limit" is right; nit: the extraction client sets no `maxRetries`, so the SDK's default two retries apply, not "the SDK's retry". The "could not finish" entry is right. The spend sentence is not exact: R2-server-6. |
| FILE: ranking-job-lifecycle-robustness | REAL | Refs check out (job.ts:511, :333, runBatch.ts:99, rankingRunsRepo.ts:446, lib/dynamo.ts:60 - no request handler options, worker.ts shutdown ~618); interleavings match the code. |
| FILE: ranking-unlawful-flag-stale-overwrite | REAL | Refs check out (rankingRunsRepo.ts:907, runBatch.ts:332, flags.ts:38, cap.ts:94). R2-server-1 is a separate defect of the same record. |
| FILE: ranking-card-custom-fields-unclassified | REAL | `parseCustomFields` (lib/contactProfile.ts) accepts any label; cardFields.ts:131 includes the container whole. |
| FILE: notes-box-line-readers-split-differently | REAL | Refs check out (singleLine.ts:20, apply.ts:342, caseworkers.ts:77, seenFeedback.ts:26). |

## Swept and fine

- Overlapping ticks and two pollers: every job write is conditioned on
  status and generation (claim, takeOver, markLeaseFailed, renewLease,
  markExpiredQueued, updateJobProgress, finishJob); a stale GSI listing can
  only lose a condition; slots are reserved before a claim and returned on
  every exit, the stale loop now included.
- Redeploy: the old worker's poll keeps running in the drain window and its
  jobs die with it (FILE'd item 4); the new worker takes over once after the
  lease; a second interruption fails the job with the RUNBOOK's message.
- The finish write, the guard's double failure and the catch-all cannot
  finish a job twice or touch a newer generation; no path rejects
  `startClaimedJob`'s promise (rankAnchor catches everything).
- Model call to stored row: a row is built only for a handle the parser
  returned exactly once with a finite score, mapped back by the prompt's own
  handle list; a failed call, an omitted or duplicated handle writes no row.
- Cost totals: one `rrun#` per call (`attribute_not_exists` on a fresh
  uuid), pointers in the same transaction, cost from the CONFIGURED model id
  (never a response field, so the price lookup cannot throw), ISO weeks and
  the default range checked at year boundaries.
- Read derivations against the job record: `failedBatch` needs the
  candidate in the last job's lists AND a row computed before that job's
  `startedAt`; takeover resets the lists and the start; a re-press replaces
  the record; the job record expires before any row it lists (TTL from
  requestedAt vs computedAt), and by then `age` covers it.
- Data to the model: the card allowlist (customFields FILE'd); declines
  carry `by` as 'staff' or 'engine' only, never a staff id; tours carry the
  three projected fields only.
- Logs: ids and counts on every job, batch, poll and driver line; the FW1-2
  WARN adds model, usage and cost only; the parse error text is fixed.
- Event stream: `ranking.updated` carries six keys; the worker bridge
  forwards every APP_EVENT_NAMES name (ranking included) and the app's
  receiver allowlists the same set.
- 180-day stores: runs (input, raw output, handles, results), matches
  (snapshot) and job records all carry `expires_at` on the table's TTL
  attribute (`ai_runs` and `matches` both `expires_at`); `uflag#` is the
  one TTL-less record (R2-server-1).
- Configuration reaching a deployed stack: fake/console and poll off refused
  in production, the key required there; non-production real tables default
  to anthropic with the poll off; the dev tick mounts only on a loopback
  endpoint; `AI_PRICE_TABLE`'s JSON survives `secrets:push` (spawnSync
  without a shell, quote-stripping only for a fully quoted value), the
  deploy's `printf` hydration and compose's unquoted env_file value (no `$`,
  no " #").
- `matches`: no reader or writer outside matchesRepo; no seed writes it
  now; legacy rows ignored by every reader.
- Admin routes behind `requireRole('admin')`; the rank POST rate limited per
  user ahead of the handler; Express 5 forwards a rejected async handler to
  the error handler.
- scripts/e2e-session.mjs: fake driver, poll off and the raised press limit
  for both children, all refused or inert under NODE_ENV=production.
- Counterfactual script: a dry run reads no key; the record target is
  checked before any call; `runCapped` feeds capOf the run's own flags.
