# E2 findings - cross-slice contract consistency (WP1 B2a plan)

- Reader: E2 (Phase 1 delta reader, read-only), 2026-10-29.
- Scope: every symbol, record field, wire field, event field, config field,
  repo method and test helper one slice publishes and a later slice uses
  (S1 -> S8); PR-ruling drift in slice text; file ownership (PR2 / PR27).
- Read: plan sections 0-4 (lines 1-590) in full; S3 "Published shapes"
  (10012-10267); every slice's Scope, Contradictions and Cross-slice notes;
  the task code of S2.4-S2.10, S3.1-S3.11, S4.1-S4.11, S5.1-S5.9,
  S6.1-S6.5, S7.1-S7.4 and S7.10-S7.12, S8.1-S8.6 and S8.8;
  plan-drafts/interface-reconciliation.md (IR1-IR36).
- Method: grep tables, then the plan's code assembled onto a scratch copy
  of app/src and type-checked and unit-run (outside the worktree; detail and
  the full contract table in .superpowers/sdd/research/E2-reference.md).
- Verdict: the cross-slice contracts are consistent. All 141 cross-slice
  imports resolve to the right module with a compatible shape, the assembled
  S2-S6 + S8 source type-checks with zero errors, and every S2 -> S5 -> S6 ->
  S7 record and wire field lines up. Two slice-internal test defects surfaced
  while running the code (E2-1 blocks S5.6 GREEN; E2-2 fails gate 1 at
  S2.11); the rest is text drift.

Counts: BLOCKER 1, MAJOR 1, MINOR 6.

## Findings

### E2-1 - BLOCKER - S5.6: the rankAnchor harness aliases the job record, so two "superseded" cases can never pass

- Plan: S5.6 Step 1 harness, line 24903 (`runs.jobs.set(job.itemId, job);`);
  the cases at 25123 ("R2B5: a job superseded after its last batch write is
  not finished") and 25188 ("a superseded job exits quietly").
- Fact: `runningJob()` returns one object; the harness stores that SAME
  object in the fake's map and passes it to `rankAnchor(h.job, ...)`. Both
  cases supersede by `h.record().generation = 'gen-takeover'`, which also
  rewrites `h.job.generation`, the generation `rankAnchor`'s guard and every
  generation-conditioned write use (job.ts, plan 25500 and 25317). The guard
  then never sees a newer generation and `finishJob` succeeds.
- Evidence: the plan's own S5.6 test file run against the plan's job.ts
  (scratch, vitest 3.2.6): 22 pass, these 2 fail ("expected status 'running',
  received 'done'"; "expected runs.size 0, received 1"). With the one-line
  fix below all 24 pass. The plan's job.ts is correct; the test is not.
- Correction: at line 24903 write
  `runs.jobs.set(job.itemId, structuredClone(job));`. The same aliasing
  pattern sits at 24176 (S5.5), 25635 (S5.7 seed), 26200 (S5.9), 27925 and
  27949 (S6.2); those cases pass today (they supersede through a guard flag
  or a listed clone), so cloning there is optional hardening.
- Scope note: S5-internal (outside E2's cross-slice brief), reported because
  it stops the S5 builder at S5.6 Step 4 with a correct implementation.

### E2-2 - MAJOR - S2.6: matchesRepo.test.ts fails `npm run typecheck` (stub parameter type)

- Plan: S2.6 Step 1, `stubGetDoc(stored: Array<Record<string, unknown>>, ...)`
  at 6369-6371, called with `MatchRow[]` at 6512, 6548, 6552 and with
  `[legacy, row(...)]` at 6529.
- Fact: `MatchRow` is an interface (plan 6800) with no index signature, so it
  is not assignable to `Record<string, unknown>`: tsc reports TS2345 at the
  three `stored` calls and TS2322 at the array literal (4 errors in the
  assembled build, the only errors in all of S2-S6 + S8). vitest strips
  types, so S2.6 goes green and the failure first appears at S2.11's
  `npm run typecheck` (gate 1; tsconfig.test.json includes `test`).
- Correction: line 6370 ->
  `  stored: ReadonlyArray<{ readonly tenantId?: unknown; readonly unitId?: unknown }>,`
  (checked in scratch: tsc clean, the 14 cases still pass). Scope note:
  S2-internal, reported because tsc is the only thing that sees it.

### E2-3 - MINOR - S5 9.1 item 6 still says `failedBatches` holds failed CALLS only (PR42)

- Plan: 21690-21693 ("`failedBatches` holds failed CALLS only").
- Ruling: PR42 (plan 556-562): `failedBatches` holds every batch that left
  candidates without a match through a failure - the call, the run write or
  the match write. S5's own item 22 (21771-21785) and its code (runBatch,
  plan 24743-24746 and 24818) follow PR42.
- Correction: strike or rewrite item 6's last sentence to point at item 22.
  No code change.

### E2-4 - MINOR - S7 N1 and the S7.1 type comments still describe `failedBatches` as failed calls only (PR42)

- Plan: N1 at 30173-30174 ("`failedBatches: ... (failed CALLS only)`") and
  the comments S7.1 writes INTO dashboard/src/api/types.ts at 30500
  ("Indexes of the batches that SCORED; a failed call is in failedBatches")
  and 30502 ("Failed CALLS only (plan PR13)").
- Ruling: PR42; N1's own round-2 paragraph (30221-30233) and S7.3's code
  (`failedBatchIndexes`, 31370-31377) already follow it (a partial match
  write is in both lists; run-write and match-write failures are entries).
- Correction: replace the 30502 comment with "Every batch that left
  candidates without a match through a failure (call, run write or match
  write), each listing exactly those candidates (plan PR42); a partly
  written batch is also in batchesDone." and drop "(failed CALLS only)" from
  N1. Comment-only.

### E2-5 - MINOR - S2's MatchRow comment defines promptFingerprint as the system text only (PR18)

- Plan: 6814 `/** sha256 of the call's system text (spec D4, D8.1). */`
  (written into app/src/repos/matchesRepo.ts).
- Ruling: PR18 (404-408): sha256 over the system text, a newline and the
  stable JSON of the schema sent; S4's prompt.ts implements that (19932).
- Correction: "sha256 over the call's system text, a newline and the stable
  JSON of its schema (plan PR18; prompt.ts rankingPromptFingerprint)".

### E2-6 - MINOR - Stale cross-slice notes that contradict the code the later slice builds

Notes only; every consumer's TASK CODE is right (it compiles and runs):
- S4 note "For S5", 16590: "each match's `inputSnapshot.data` is
  `encodeSnapshot(...)`" - IR5 made it the top-level string
  `inputSnapshot` (S2 6825; S5 24639). Drop `.data`.
- S3 cross-slice notes 10484-10486 (and the assemble.ts header 15065-15066):
  "S8's counterfactual check calls `buildTenantSide` / `buildPropertySide`";
  S8 C1 (35550-35558) and its cards.ts (36884-36961) call `tenantCard`,
  `propertyCard`, `propertyFacts`, `tenantMissing`, `propertyMissing`
  directly (S3's own note 10534-10536 says so too). Align the first note.
- S6 10.1 item 6, 26821-26827: the org-list / matches / job 503s are "for
  the planner to confirm" - PR17 (398-403) already rules them.
- PR3 (290) sketches `runDueRankings(...): Promise<void>`; S5 returns
  `RankingPollSummary` (S5 9.1 item 9, 25871) and the dev tick needs it.
  Compatible, but section 4 "wins over slice text": add "(S5 returns a
  summary)" to PR3 so a strict builder does not drop it.

### E2-7 - MINOR - Contract constants defined twice instead of imported (PR7 / PR33 / IR29 spirit)

- `PROPERTIES_SEEN_KEY = 'propertiesSeen'` is exported by S3 cards.ts
  (14164) AND re-defined by S4 prompt.ts (19794). prompt.ts already depends
  on S3's types; import S3's constant (S4's `SEEN_HOME_KEY = 'home'` has no
  S3 twin - fine).
- S5's helpers spell the S2 index partitions as literals instead of
  importing `RANKING_JOBS_QUEUED_ENTITY` / `RANKING_JOBS_RUNNING_ENTITY`
  (S2 7777-7778): rankingJobFixtures.ts 22738, 22750; rankingRunsFake.ts
  23306, 23315, 23322, 23340. A later rename in S2 would leave the fake
  listing nothing, silently.

### E2-8 - MINOR - Two files edited outside PR2 / PR27 without a planner line

- `app/test/sse.test.ts` - S5.1 edits it (plan 21973-22054); S5's notes name
  it (21896) but PR27's S5 allowance (446-449) does not.
- `e2e/support/selectors.md` - S7.10 edits it (34675-34688, BA7); PR2 gives
  S7 "every new e2e spec and helper", not this doc.
- No other slice touches either file, so nothing collides; add both to PR27
  for the record.

## Checked and fine

- All 141 symbols a later slice imports from an earlier one (S2 config,
  matchesRepo, rankingRunsRepo; S3 types, cardFields, cards, completeness,
  pool, assemble; S4 bands, cap, cost, parse, prompt, driverTypes, rubric,
  examples, adapters; S5 job, flags, test helpers) exist in the named module
  with a compatible shape: the assembled build type-checks with 0 errors in
  src (strict + noUncheckedIndexedAccess).
- S3's "Published shapes" equal S3's code exports (code adds only
  TenantCardKey, PropertyCardKey, SeenSetInput); the S4, S5 and S6 export
  lists in their cross-slice notes equal their code.
- PR3 names and signatures (computePool, tenantCard, propertyCard,
  propertyFacts, assembleRanking, bandOf, capOf, RankingDriver,
  claimRanking, rankAnchor, readRanking) and PR5's repo API (job, run,
  pointer, flag families; getPairs; putMatches returning
  { written, unwritten }; getManyByIds; hasActivePlacementForOtherTenant)
  match the code and every call site.
- Job record S2 -> S5 writes -> S6 reads -> S7 RankingJobView: same fields;
  every S5 `updateJobProgress` patch is non-empty (S2 throws on an empty one,
  plan 8171).
- Run `results[]` S2 -> S5 runLog -> S6 run-detail pairs -> S7
  RankingRunPair; runs list and cost rows S6 -> S7; read response, row,
  match, anchor and flag S6 -> S7; error bodies 404 / 409 / 503 -> S7's
  error text; `matchesWritten { count, at }` S2 -> S5 -> S7; `usage` guarded.
- MatchRow: S5 writes all 21 fields (top-level promptFingerprint, string
  inputSnapshot); S6 reads fingerprints, versions, model, computedAt, cap
  inputs.
- AssembleResult union (IR6), PoolFailure extras (FB4), AnchorUnreadable
  candidateIds (PR38 / PR43), display strings (IR7), sortRecencyAt (FB19),
  createAssembleDeps / loadPropertyFacts (IR9) - consumed as published.
- RankingBatchInput / RankingCall / RankingPrompt (S4) vs S5's runBatch,
  stub prompt and stub driver (IR13, IR14) - compile and run.
- capOf input (S4) vs S5 cappedAtRun, S6 deriveMatch, S8 runCapped - same
  four fields; PR29/40/44/45 cases pass in S4's own suite.
- Event payload S5 -> S7 (six keys, batchesDone a count) and the dev tick
  S5 -> S7 fixture; dashboard enum mirrors equal their server unions.
- Test helpers: rankingFixtures (S3 only), rankingBatchFixture (S4 only),
  rankingJobFixtures and rankingRunsFake (S5, imported by S6 with names S5
  exports); no path is created by two slices (IR1 holds).
- Every quoted anchor of S1's ContactItem edit, S2-S6 and S8 (scripts and
  env examples) was found exactly once when applied in build order; S5 and
  S6 edit disjoint regions of routes/api.ts; S1 and S7 edit disjoint regions
  of dashboard/src/api/types.ts.
- No breakage at a distance: all existing app tests and scripts type-check
  against the S2-S6 changes (only paths outside the scratch copy failed).
- Runtime: every pure new test file of S2-S8 passes against the assembled
  code (800 tests; only the 5 deliberate S4.11 PIN-ME pins and E2-1's 2
  cases fail); S4.6's examples match S3's completeness output; S8's
  counterfactual tests pass on S3's cards and S4's prompt and cap; S8.6's env
  defaults parse to S2's defaults.
- The S7.10 e2e expectations (Strong 80 / Good 70 / capped Weak last;
  "Done: 1 batch; 2 candidates not scored"; card edit -> "a card changed";
  tenant anchor order) and the S6.5 WI11 / WI18 expectations hold when
  replayed through the real S3 -> S4 -> S5 -> S6 (-> S7 jobStatusText) code
  in memory.
- adapters/ranking.ts (thinking 'adaptive', output_config.effort,
  APIConnectionTimeoutError) type-checks against the installed SDK 0.129
  types (bundler resolution), so S4 C7's STOP condition should not fire.
