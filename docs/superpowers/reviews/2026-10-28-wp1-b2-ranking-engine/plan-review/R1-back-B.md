# Plan review R1 - back half B (plan sections 9-13: S5 job, S6 read and API, S7 dashboard and e2e, S8 scripts and docs, S9 gates)

Reviewer: adversarial plan reviewer (read-only). Plan:
`docs/superpowers/plans/2026-10-28-wp1-b2a-ranking-engine.md` (sections 0-4, 9-13
read in full; S2/S3/S4 read where my slices code against them). Spec:
`docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md` (read in
full). Repo: main @404e039d.

Overall: the back half is unusually concrete and mostly sound. Anchors I
checked in the tree match (api.ts SSE block and `/ai-runs` mount, worker.ts
`startPoll('extraction', ...)`, dev.ts tick block and `tourAutoCloseDeps`,
e2e-session.mjs `childEnv`, sse.test.ts / eventBridge.test.ts pins,
settingsTabs.test.ts / SettingsPage.test.tsx arrays, types.ts / endpoints.ts
anchors, EventStreamProvider anchors, RUNBOOK / GLOSSARY / issue-file /
env-example anchors, every CSS token used). Interfaces S5-S8 code against
(S2 job/run/flag families, S3 `AssembleResult`/`VerifiedCandidate`/
`TenantCardCtx`, S4 `buildRankingPrompt`/`buildRankingBatch`/`RankingWire`/
`RankingParseContext`) agree with what those slices publish. The findings
below are what remains.

---

## 1. [MEDIUM] The deploy checklist (S8.8) and the S8.6 note send Cameron into a refused `secrets:push` and a failed deploy gate

What is wrong. S8.6 adds 21 new keys to `.env.dev.example` / `.env.prod.example`
and its note says "`secrets:sync` carries new keys into a real `.env.dev` /
`.env.prod` as `KEY=` (blank), which S2's parser reads as the default." The
RUNBOOK deploy checklist S8.8 writes (plan lines 36063-36067): "(2)
`secrets:sync` carries the new `RANKING_*` / `AI_*` keys into the real files
blank (blank = the default) ... (3) `secrets:push`, then deploy."

Evidence. `scripts/lib/secretsCore.mjs:182-187` - sync emits a new key as
`KEY=` (empty). `scripts/secrets.mjs:160-168` - for every mode except
`prune`, ANY empty value fails: "empty value(s) in .env.<env> ... SSM cannot
store an empty parameter. Fill them in (or delete the lines) and re-run."
That covers `push` AND `check`, and `scripts/deploy.mjs:221-226` gates every
deploy on `secrets.mjs check`. So following the checklist literally: sync
writes 21 blanks, push refuses, the deploy gate refuses.

What it implies. Spec 7 / D19 promise "No new required env var ... None is
required to deploy beyond the existing ANTHROPIC_API_KEY". The parser
tolerates blanks, but the repo's secrets workflow does not; the documented
path is broken on first use, at deploy time, by Cameron.

Fix. In the RUNBOOK checklist and the S8.6 note, say: after `secrets:sync`,
either copy each new key's value from the example (the defaults are spelled
out there) or delete the lines you do not want to set (the parser default
applies to an ABSENT key); never push a blank. Optionally add a test that
the example values themselves are non-empty (they are) and a one-line
`secrets:check` dry step to the checklist.

## 2. [MEDIUM] The cost endpoint reads every FULL ranking run item, all-time, on every Rankings page open, and silently drops runs whose read did not complete

What is wrong. `GET /api/admin/rankings/cost` (S6.4, plan 26967-27015) loops
`runs.listRuns({ entityKey: 'rankings#global', limit: 100, ... })` up to 50
pages. S2's `listRuns` (plan 8488-8540) BatchGets the whole `rrun#` item for
every pointer - no projection - so each run brings its `rawText`,
`inputGzip` (up to the 350 KB guard), `handles` and `results[]`. The page
(S7.9) calls the cost read with no `from`/`to` by default (all 180 days) on
every open and on every Refresh. In addition, a pointer whose BatchGet key is
still unprocessed after the 4 attempts comes back
`{ expired: true, unavailable: true }` (plan 8526-8531) and the cost loop does
`if (entry.expired) continue;` (plan 26987) - so an incomplete read lowers the
totals with no `truncated` and no other signal (the response's `truncated`
only covers the 50-page cap).

What it implies. Today's volume is small (only Rankings-page presses), but
B3 makes every composer press a ranking: at a few thousand runs of tens of KB
each the cost tab reads tens to hundreds of MB per view (100 items of up to
350 KB exceed BatchGet's 16 MB response, so unprocessed keys are the normal
case at that size), and the totals it shows can be quietly short. The spec
(D11/D12) makes cost a first-class audit number ("every run records its
cost").

Fix. Keep the cost read off the full items: either a projected listing
(`ProjectionExpression` of runId, startedAt, environment, usage, costUsd) in
a dedicated `rankingRunsRepo.listRunCosts`, or carry `costUsd`/token counts on
the pointer rows S2 already writes (`putRun` builds both pointers) and sum
the pointers. Treat an `unavailable` entry as a reason to set an explicit
`incomplete: true` (and show it), never as zero. Default the page's cost read
to a bounded range (for example the last 8 ISO weeks) unless the URL names
one. The runs list should likewise render `unavailable` as "could not be
read", not "Expired run" (RankingRunList renders every `expired` row as
expired; S6 drops the `unavailable` bit when it maps entries, plan 26855).

## 3. [LOW] A `putRun` failure after a paid model call loses the run record, its cost and the batch's matches

What is wrong. In `runBatch` (S5.5, plan 22888-22889) `await deps.jobs.putRun(run)`
has no try/catch, and it runs BEFORE the match write. A thrown TransactWrite
(throttling, a transaction conflict) propagates to `runBatchSafely`, which
records `failedBatch { failure: 'error' }` (plan 23307-23309). The model call
already happened and was billed, but no run exists (no cost, no raw output),
and the scored candidates get no match although nothing about the matches
failed. Spec D11: "Every model call (one per batch) is a ranking run";
spec D7 orders run, matches, flags but does not require the matches to wait
on the run write.

Fix. Wrap `putRun` like the match write: on failure log it, still write the
matches (they carry `runId`; the run detail already tolerates a missing run
with `run_not_found`), and record the batch outcome; or retry `putRun` once
with backoff. Either way add a runBatch case for a throwing `putRun`.

## 4. [LOW] S7's wire type promises `poolTooLarge.message`, which S6 never sends, and S7.13 tells the builder to "confirm" it

What is wrong. S7.1 types `poolTooLarge?: { size: number; message: string }`
(plan 28053) and its coverage row says `poolTooLarge { size, message }`
(plan 32688). S6 returns `poolTooLarge: { size }` only (plan 25745, and the
S6.3 test body at 26075). S7.13's report step asks the builder to confirm
"`poolTooLarge.message` on the read" against the committed server code
(plan 32629-32631) - it will not be there. The panel happens to render its
own text from `size` (plan 30180), so nothing breaks today, but the type lies
and the builder is sent to resolve a drift the plan created. PR16's "the
read answers 200 with the anchor block present (display, `anchorNotes`,
missing)" is also not met: S6 sends `missing: []` for the ceiling case
(contradiction 5, plan 24610-24614) because `PoolFailure` carries no card.

Fix. Drop `message` from the S7 type and the S7.13 checklist (the page
already composes the copy). For `missing`, either state in S6 that the
ceiling read carries no missing flags (a ruling against PR16's text) or have
S3's `PoolFailure` carry the anchor's missing flags (cheap: `propertyMissing`
/ `tenantMissing` need no extra read).

## 5. [LOW] The page re-reads the ranking only when SCORED batches grow; a failed batch mid-job is not shown until the job ends

What is wrong. `useAnchorRanking.refreshJob` (S7.4, plan 29346-29352) computes
`grew` from `next.batchesDone.length`, which holds scored batches only
(RankingJobView, plan 27974-27976). A batch that fails adds to
`failedBatches`, not `batchesDone`, so its candidates keep reading as before
(an old match without `failedBatch`, or "not ranked yet") until the job ends.
Spec D12: "it re-reads the full ranking when `batchesDone` grows (by event or
by poll)", and the event's `batchesDone` is defined as finished batches,
scored or failed (S5 contradiction 5; IR27).

Fix. Track finished batches as distinct indexes over `batchesDone` and
`failedBatches` (the same count S5's `finishedBatchCount` emits) and re-read
when that grows. Add a hook case: running, `failedBatches` grows, the
ranking is read again.

## 6. [LOW] A tenant anchor whose own card cannot be read fails the job instead of reading "not scored - retry"

What is wrong. Spec D2.3: "In the job, that candidate (or, for a tenant
anchor, the anchor and so the whole job) is left out of the call and reads
'not scored - retry'". S5's `runJob` turns S3's `anchor_unreadable` into
`finishJob(failed, 'This record could not be read in full. Try again.')`
(plan 23332-23339; test 23122-23127). No candidate is listed in `notScored`,
so once the read recovers every row reads "not ranked yet", not "not scored -
retry". The job message carries the intent, the rows do not.

Fix. Either accept the deviation explicitly (a one-line ruling: the job
message is the signal; rows read "not ranked yet") or have the read treat a
`failed` last job whose message is the anchor-unreadable one as listing every
pool member (no stored per-candidate list is needed for that).

## 7. [LOW] Some RED predictions and pins assert things vitest cannot observe

- S5.1 Step 2 says the new file "fails to compile (`RankingUpdatedEvent` is
  not exported)"; S5.9 says `createDevRouter` "rejects the unknown
  `rankingTickDeps` key (typecheck)"; S6.3 says "TypeScript rejects
  `api.rankings`". Vitest strips types (AGENTS.md "Vitest and Playwright run
  through esbuild/tsx, which strip types without checking them"), so none of
  those is the observed RED; the real RED in each is a runtime miss (a
  missing list entry, a 404). Harmless, but a builder told to "confirm it is
  red for the stated reason" (plan section 0) will not see the stated reason.
- S5.1's "the payload type is exactly the six spec keys" test checks the keys
  of a hand-written constant (plan 20220-20224); a seventh OPTIONAL field
  added to `RankingUpdatedEvent` passes it. WI16 is really proven by S5.5's
  `toRankingEvent` key-set case and S5.6's every-payload case - the S5.10
  report text crediting rankingUpdatedEvent.test.ts with "pins the type"
  overstates it.
- S5.10 step 4 expects "the only `putMatches(` caller is runBatch.ts" from
  `git grep -n "putMatches(" -- app/src`, which also lists matchesRepo.ts's
  interface and method; S6.6 step 5 likewise lists cap.ts's definition. Say
  "callers other than the definition".

Fix. Restate the three REDs as their runtime symptom; drop or relabel the
constant-keys case; reword the two grep expectations.

## 8. [LOW] S9 has no independent code review or fix wave

What is wrong. Plan section 13 (binding) goes sync -> gates -> self-QA ->
handback. AGENTS.md "Request lanes and feature workflow" requires the
"isolated build, independent review, and human-merge pipeline", and
mission records (review rounds, adjudications, fix-wave reports) are to be
committed under the records directory. Nothing in S9 says when the
independent review runs, where its findings go, or that the gates are re-run
after a fix wave.

Fix. Add S9.x: an independent plan-blind code review of `main...HEAD`
(findings to `<records>/code-review/`), the adjudication, a fix wave, then
the five gates again on the final tip before the handback; the handback
links them.

---

## Checked and found sound (no finding)

- Claim / join / 409 / retry-once, queue expiry, lease renewal, takeover once
  then `markLeaseFailed`, slots reserved before the conditional claim, the
  fresh `runWithContext` (verified `runWithContext` replaces the store,
  `app/src/lib/context.ts:56-58`; the logger mixin spreads the context,
  `app/src/lib/logger.ts:248-252`), and every fake condition matches S2's
  real condition expressions (plan 7493-7690).
- `updateJobProgress` never receives an empty patch from S5 (S2 throws on
  one, plan 7646): the start write always has `poolSize`, every batch write
  has `batchDone` or `failedBatch`.
- Ticks overlap as the plan assumes: `app/src/jobs/pollLoop.ts:63-76` has no
  in-flight guard. GSI `byEntity` projects ALL (`app/src/lib/dynamoAdmin.ts:57`),
  so listed job records carry `generation` / `queuedExpiresAt`.
- The e2e lane: `workers: 1`, `fullyParallel: false`, expect timeout 15 s
  (`e2e/playwright.config.ts:135-141`), so one dev tick per spec cannot race
  another spec's job and the 5 s job poll fits inside an assertion.
  `childEnv` is spread into both children; `NODE_ENV` is `development`
  there (`scripts/e2e-session.mjs:140-142`), so `RANKING_WORKER_POLL=off`
  and the fake driver are accepted.
- e2e fixtures: `POST /api/units` accepts `accepted_authorities` (checked
  against the org list, `app/src/routes/units.ts:949-961`) and
  `voucher_size_accepted`; units start in setup and publish through
  `PATCH /api/units/:id/listing-status` `{ toStatus, source }`
  (`app/src/routes/statusTransition.ts:342-366`); contact create accepts
  `notes`, `status`, `pets`, `voucherSize` and the B1 inputs
  (`app/src/routes/contacts.ts:921-1000`). The fake rules give Strong 80 /
  Good 70 / capped Weak as the spec asserts.
- Counterfactual data: every authority name is on the starting org list
  (`app/src/lib/orgStartingList.ts:17-60`), so no swap flips a property's
  mapped/unmapped split; `buildStartingEntries(now, newId)` exists (:85).
- S8's `--dry-run` path never reads the key and never builds a driver; the
  module's `invokedDirectly` guard keeps the test import from running `main`.
