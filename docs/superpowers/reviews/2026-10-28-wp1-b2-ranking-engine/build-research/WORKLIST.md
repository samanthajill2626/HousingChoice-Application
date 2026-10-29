# B2a build - Phase 1 WORKLIST (adjudicated; binds every builder)

Orchestrator: abt:build-orchestrator, 2026-10-29. Branch
feat/wp1-b2-ranking-engine @2308ff43 (main @404e039d + docs only).

Source: eleven parallel read-only delta readers (2026-10-29, ~30-38 min
each), findings in this directory: D1 (S1), D2a (S2.1-S2.5), D2b
(S2.6-S2.11), D3 (S3), D4 (S4), D5 (S5), D6 (S6), D7 (S7), D8 (S8), E1
(whole-app writer/reader sweep), E2 (cross-slice contracts). Most readers
extracted the plan's code into scratch projects outside the worktree and
compiled, linted and ran it against the installed types (tsc 5.9.3,
vitest 3.2.6, @anthropic-ai/sdk 0.129.0), so the "checked and fine" lists
in each file are executed, not read.

Totals: 1 BLOCKER (D5-1 = E2-1), 5 MAJOR (D1-1; D2b-1 = E2-2; D7-1 = E1-1;
D7-2 = E1-2; D8-1), 59 MINOR. No finding re-opens a spec decision or a PR
ruling. Byte-exact replacement text lives in the scratch reference files
`.superpowers/sdd/research/<id>-reference.md` (in the worktree, not
committed).

PRECEDENCE: where this worklist and the plan's slice text disagree, the
worklist wins. Plan section 4 rulings still win over both unless an item
below says otherwise (none does).

## G - every builder

- G1 (D1-5, D4-4) `node_modules` IS installed (npm ci EXIT=0 at
  2026-10-29 14:00Z). NEVER run `npm ci` / `npm install` (plan line 625 and
  section 0's "run npm ci once" are done). DynamoDB Local
  (`hc-dynamodb-local`, :8000) and MinIO are running: never run
  `npm run db:start` (it prunes and may recreate the container). No `AWS_*`
  variable is exported in this environment.
- G2 (D1-1, D1-2, D1-3) Escape-safe file writing. Measured in this
  harness: the Bash tool turns `\\` into `\` even inside a quoted heredoc;
  the Write/Edit tools keep `\\` but DECODE a single-backslash `\uXXXX`
  into the raw character. Any plan code block that contains a backslash
  escape (`U+2028 as a six-character escape`, `\\`, regex escapes) is copied BYTE-EXACT from the plan
  file with `sed -n '<first>,<last>p' <plan> > <target>` (the block's lines
  between its fences; D1 reference R3), then checked (`grep -c`, line
  count, and `tr -d '\11\12\15\40-\176' < FILE | wc -c` = 0). The Bash tool
  also caps one command near 10 KB, so a long heredoc is never typed.
  Files without escapes: Write/Edit are fine.
- G3 (D2b-2, D2b-3, D3-1, D5-4, D7-5, E2-3, E2-4, E2-5) Comments and docs
  that contradict a ruling: where slice text writes a comment or doc
  saying `failedBatches` holds failed CALLS only (PR42: every batch that
  left candidates without a new match - call, run write or match write -
  listing exactly those candidates, failure kinds including `error`), that
  an unwritten match throws (PR37: `putMatches` reports unwritten keys),
  that `promptFingerprint` is the system text only (PR18: system text, a
  newline, the stable JSON of the schema), or that `capOf` groups UNLAWFUL
  flags by item (PR40: item grouping is for accommodation flags only;
  PR45 joins `qualifications`), write the ruling's meaning instead.
- G4 (D1-4, D5-6, D6-1, D6-2, D7-6, D8-3) A RED message quoted by the plan
  may not match vitest 3.2.6's wording (e.g. "Cannot find module ... /
  Failed to load url ..."). Confirm the RED is for the stated REASON
  (missing module, missing export, missing behavior). Where the plan says
  a case already passes or fails at RED and it does not, record it in the
  slice report; never alter a test just to manufacture a RED.
- G5 (D4-1, E2-7) Shared constants are imported, never re-spelled:
  `PROPERTIES_SEEN_KEY` from S3's `cards.js` (prompt.ts must not define its
  own); the job index partitions `rankjobs#queued` / `rankjobs#running`
  from S2's `rankingRunsRepo` constants (S5's test helpers too).
- G6 (D8-1) `ANTHROPIC_BASE_URL` is exported in this shell (the harness's
  proxy); `ANTHROPIC_API_KEY` is not. Never print, echo, `printenv` or log
  any `ANTHROPIC_*` value. No test or script run by a builder constructs a
  sending Anthropic client (PR1, WI7).
- G7 Long commands (any e2e run, the full app suite): run them bare with a
  hard timeout and WAIT for them in your own turn; never end your turn
  with a command still running in the background. Never edit dashboard or
  app source while this worktree's e2e runs.

## S1 - The Notes box (plan 591-3696)

- WL-S1-1 (D1-1 MAJOR, D1-2, D1-3) S1.1's test (the two
  `toContain('\\u2028')` / U+2029 assertions, plan ~878-879) and the
  S1.3(a) heredoc (17.8 KB; 338 lines) are written per G2 (copy from the
  plan by line range). If a raw separator ever needs restoring, use the
  `\x5c` form (D1 reference R2), never the plan line 644 one-liner.
  Expected S1.1 GREEN: 5 passed.
- WL-S1-2 (D1-6) The WI3 table cites `routes/webhooks/twilio.ts` and
  `routes/webhooks/voice.ts` (the plan's `webhooks/...` paths do not
  exist).
- WL-S1-3 (D1-7) GLOSSARY's staff_notes entry is S8.9's (see WL-S8-9);
  S1 does not touch GLOSSARY.

## S2 - Foundations (plan 3697-10009)

- WL-S2-1 (D2a-1) S2.2 Step 1b's anchors are fenced inside list items:
  strip the 2 leading spaces of list indentation from every old and new
  line before matching (each then matches exactly once).
- WL-S2-2 (D2a-2) S2.2 also rewords the two comments that go stale when
  the key becomes required in production: the `anthropicApiKey` doc
  (config.ts ~382-387) and the inline comment (~883-886) - the key is
  required on every production stack (the ranking driver is `anthropic`
  there) whatever `AI_EXTRACTION_ENABLED` says. (The env examples' twin
  text is S8's, WL-S8-5.)
- WL-S2-3 (D2a-3) The S2 report notes that PR30's `isLocalDynamoTarget`
  counts only loopback hosts as local while devRoutes.ts:18, logger.ts:85,
  dev.mjs:113-116 and devMode.mjs:43 count any set endpoint as local; it
  fails safe (fake/console refused) and no lane uses a non-loopback local
  host. RUNBOOK caveat: WL-S8-16.
- WL-S2-4 (D2b-1 MAJOR = E2-2) `app/test/matchesRepo.test.ts`
  `stubGetDoc`'s `stored` parameter is `ReadonlyArray<PairKey>` and its
  matcher compares `k.tenantId === item.tenantId && k.unitId ===
  item.unitId` (D2b reference "D2b-1 exact replacement"). Otherwise tsc
  fails with 4 TS2345/TS2322 errors at S2.11 although vitest is green.
- WL-S2-5 (D2b-4) The test named "ignores an empty notScored list" is
  renamed to say what it asserts (a throw).
- WL-S2-6 (D2b-5) The log assertion `/c-\d/` (plan ~6477) is
  host-dependent: assert the actual candidate ids instead.
- WL-S2-7 (D2b-6) Use the house `queryAll` from
  `app/src/lib/dynamoPaging.ts` (page cap + WARN) for
  `matchesRepo.listByUnit` / `listByTenant` and
  `rankingRunsRepo.getOpenCandidateFlags`, and drop matchesRepo's private
  helper of the same name. If a plan test's stub doc cannot serve
  `queryAll` unchanged, keep the plan's walk but rename the private helper
  (e.g. `walkQuery`) and say so in the report.
- WL-S2-8 (D2b-8) The S2 report's WI1 record adds: `devReset` clears every
  table on reseed, `matches` included (a manifest-wide iterator a
  table-name grep cannot see; safe).
- WL-S2-9 (D2b-10) The new `ai_runs` table comment says "Query then ONE
  BatchGetItem" only for the listings, and carries no plan-internal tag
  such as "(WI2)".
- WL-S2-10 (E1-4) Comment-only allowance: S2 also corrects the header
  comment at `app/src/repos/aiRunsRepo.ts:1-2` (pointer rows are no longer
  the only `byEntity` rows: ranking job and flag rows carry its keys too).
- WL-S2-11 (D2a-5) `getManyByIds` stays as written (throws on the first
  incomplete chunk; its count can understate on a multi-chunk read). Note
  it in the report; no change.
- WL-S2-12 (D2a-4, D8-11) The S2 head note "S8 writes all variables
  uncommented" is superseded by PR39; S2 builds nothing from it.

## S3 - Pool and cards (plan 10010-16251)

- WL-S3-1 (D3-1) `requirementItemOfField`'s doc comment in cardFields.ts
  (plan ~11439-11441) follows PR40 (item grouping applies to
  accommodation flags only) - comment only.
- WL-S3-2 (D3-3) `notes_updated_at` is dropped from `UntypedTenantKey`
  (S1 declares it on `ContactItem`); it stays classified EXCLUDE (WI4).
- WL-S3-3 (D3-4) ORCHESTRATOR RULING (display only): `propertyDisplay`
  (the Rankings page's name for a property, plan ~15805-15807) returns the
  trimmed stored address string when `propertyLabel` gives nothing and the
  stored `address` is a non-empty string, before falling back to the
  placeholder. Add a test case. `SeenHome.label` (what the model sees) and
  the attach step (`attachLabel`) are UNCHANGED (PR23). Rationale: every
  other staff surface shows such an address as stored
  (dashboard/src/routes/contact/format.ts:97-99); 57 of 60 full-world seed
  units store a plain string. If `propertyDisplay` turns out to feed any
  model-facing text, do NOT apply this item; STOP and report.
- WL-S3-4 (D3-2) S3.4's commit carries an import S3.5 first uses; no
  action (S3.12's lint must be clean).

## S4 - The model call (plan 16252-21585)

- WL-S4-1 (D4-1, G5) prompt.ts imports `PROPERTIES_SEEN_KEY` from
  `./cards.js` (D4 reference section 3).
- WL-S4-2 (D4-2) The rubric's tenant-card line (plan ~18147) names
  `created_at (when the record was made)` after `status` (D4 reference
  section 4) - BEFORE S4.11 computes the pins.
- WL-S4-3 (D4-3) ORCHESTRATOR RULING: every example card in examples.ts
  is written in the production builders' key order (registry order, then
  the derived keys), per D4 reference section 5 - BEFORE S4.11 pins e1.
  Key membership and every value stay as the plan writes them; the R2F13
  membership test is unchanged. Rationale: spec D2.2 (a card has a fixed
  key order) and PR31 (the examples show the wire shape of a real call);
  doing it now avoids a post-deploy examples-version bump.
- WL-S4-4 Because of WL-S4-2 and WL-S4-3 the six PR32 pins will NOT equal
  the D4 reference section 2 values (those assume the verbatim plan text):
  compute them with S4.11's print command after both changes and record
  all six in the S4 report.
- WL-S4-5 SDK typing (mission trap, S4 C7): D4 and E2 compiled the exact
  S4.9 request (`thinking: { type: 'adaptive' }`, `output_config: {
  effort, format }`, options `{ timeout, maxRetries: 1 }`) against
  @anthropic-ai/sdk 0.129.0 with zero errors. If `npm run typecheck`
  rejects it anyway, STOP and report the exact tsc error; never cast
  through `unknown`.

## S5 - The ranking job (plan 21586-26727)

- WL-S5-1 (D5-1 BLOCKER = E2-1) The S5.6 `rankAnchor` harness (plan
  ~24903) seeds the fake with a CLONE: `runs.jobs.set(job.itemId,
  structuredClone(job));` - the same line in the S5.5 harness (plan
  ~24176). Without it the two "superseded" cases cannot go GREEN (the
  fake and the job under test share one object).
- WL-S5-2 (D5-2) runBatch.ts: in the `putRun` catch, before returning,
  remove this batch's newly raised flags from `ctx.raised` (delete each
  one's `<unitId>#<field>` key, the same key the raise check uses; D5
  findings D5-2), so a later batch can raise and write them; comment that
  a thrown
  `putFlagIfAbsentOrClosed` keeps its entry and is only logged. Add a test
  (a putRun failure followed by a later batch raising the same flag writes
  the flag record).
- WL-S5-3 (D5-3) The S5 report gets a WI12 line: a grep showing no
  `tenantCard(` / `propertyCard(` call in the job files (cards come only
  through `assembleRanking`).
- WL-S5-4 (D5-4, G3) runBatch.ts's header comment follows PR37 / PR42.
- WL-S5-5 (D5-5, E1-3) Comment-only allowance: update `worker.ts:290`
  ("six shared-cadence call sites" -> seven) and
  `app/src/jobs/pollLoop.ts:15` ("seven loops today" -> eight).
- WL-S5-6 (D6-4) `scripts/e2e-session.mjs` also sets
  `RATE_LIMIT_RANK_PER_MIN=100000` beside the other per-user limits it
  raises (the precedent at ~182-193), so self-QA never trips a 429. The
  route-level 429 test (S6) still proves the limiter.
- WL-S5-7 (D6-3) S5.8's DynamoDB Local table prefix is `hc-test-rankjob-`
  (not `hc-rankjob-`), so `test/globalTeardown.ts`'s residue sweep
  (~80-84) covers an interrupted run.
- WL-S5-8 (E1-5) The S5 report records the shutdown residual: worker
  shutdown (worker.ts ~590-616) stops only the SQS consumers, so a deploy
  mid-ranking kills that job (its lease expiry and one takeover recover
  it, as designed) and up to RANKING_MAX_CONCURRENT_JOBS x
  RANKING_BATCH_CONCURRENCY (8) in-flight calls are billed but never
  logged; the extraction poll has the same shape. No code change.
- WL-S5-9 (E2-8) `app/test/sse.test.ts` is an allowed S5 file.

## S6 - The read and the API (plan 26728-30044)

- WL-S6-1 (D6-3) S6.5's DynamoDB Local table prefix is `hc-test-rkread-`.
- WL-S6-2 (D6-5) S6.5's seeding `batchPut` throws when anything stays
  unprocessed, and the test asserts `putMatches(...).unwritten` is empty,
  so a seeding shortfall cannot read as a fingerprint defect.
- WL-S6-3 (D6-6) The WI11 "tour roster change" case changes the roster
  fields (`roster` / `rosterVersion`, toursRepo.ts ~95-97), not only
  `groupThreadId`.
- WL-S6-4 (D6-7) The run detail reads candidate properties' flags with
  `mapWithConcurrency` bounded by `rankingReadConcurrency` (as the read
  does), not one sequential query per property.

## S7 - Dashboard and e2e (plan 30045-35513)

- WL-S7-1 (D7-1 MAJOR = E1-1) S7.1 catalogs the new POST: add
  `entry(ENDPOINTS, 'startRanking', 'request:POST',
  '/api/rankings/:kind/:anchorId/rank')` to
  `e2e/performance/mutationCatalog.ts` and bump the pinned count 122 ->
  123 in `e2e/performance/mutationCatalog.test.ts` (D7 reference R1 / E1
  reference R1). Allowed S7 files.
- WL-S7-2 (D7-2 MAJOR = E1-2) S7.11 updates the perf route pin per the
  `/settings/organizations` precedent: `'/rankings'` into the
  settings-children list and `'/settings/rankings'` into `excluded` in
  `e2e/performance/routes.test.ts`, plus a
  `TODO(perf-pages-settings-rankings-surface)` beside the organizations
  one in `e2e/performance/routes.ts` (D7 reference R2 / E1 reference R2).
  Allowed S7 files. The issue file is S8's (WL-S8-14).
- WL-S7-3 (D7-3) e2e test 1 uses band-free tenant names, asserts the
  "not ranked yet" rows BEFORE the tick, and asserts band / capped per
  CELL, so no assertion can pass on a name alone (D7 reference R3).
- WL-S7-4 (D7-7) `RankAnchorPanel`'s kind state is seeded from the anchor
  (a reloaded tenant anchor stays Tenant when cleared) - D7 reference R4,
  with a test.
- WL-S7-5 (D7-4) The WI19 grep record lists every hit (fixture,
  `rankings.spec.ts` comment, `selectors.md` row); fine.
- WL-S7-6 (E2-8) `e2e/support/selectors.md` is an allowed S7 file.
- WL-S7-7 S7.13 Step 3's triage rule is narrowed: a red test in ANY
  workspace caused by S7's additions (catalogs, route pins, selectors) is
  S7's to fix, never "record it".

## S8 - Merge-gate scripts and docs (plan 35514-39630)

- WL-S8-1 (D8-1 MAJOR) S8.11 step 3 has NO `printenv`: run
  `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL npx tsx app/scripts/ranking-counterfactual-check.ts --model claude-sonnet-5-5 --dry-run`
  from the worktree root (D8 reference "D8-1 replacement"); the same
  `env -u` prefix for any `--timing --dry-run`.
- WL-S8-2 (D8-2) The WI7 / WI12 / WI13 greps search for calls
  (`tenantCard(`, `propertyCard(`, `capOf(`), not bare names (D8
  reference "D8-2").
- WL-S8-3 (D8-4) S8.10's citation greps use `-w` and the phrase "since
  you opened this form" (D8 reference "D8-4").
- WL-S8-4 (D8-5) The closed issue quotes S1's conflict copy exactly as
  built (read it from the built ContactEditForm, not from the plan).
- WL-S8-5 (D8-6, D2a-2) Reword the stale "key required only when
  AI_EXTRACTION_ENABLED" text in `.env.dev.example` (~209-212),
  `.env.prod.example` (~234-237) and `RUNBOOK.md` (~1470) (D8 reference
  "D8-6" suggested text).
- WL-S8-6 (D8-7) RUNBOOK (~1334, "five" polls) and the env examples'
  `WORKER_POLL_INTERVAL_MS` comments name the ranking poll.
- WL-S8-7 (D8-8) The deploy checklist's key pattern also covers
  `RATE_LIMIT_RANK_PER_MIN`.
- WL-S8-8 (D8-9) The gate sheet does not claim the compile check prints
  an endpoint line.
- WL-S8-9 (D8-10, D1-7) GLOSSARY: correct ~281-282 ("nothing ranks on the
  requirements yet"); make the new Pool / Match entries say how they
  differ from "pool number" / "Matching"; correct the staff_notes entry
  (~165-173: nothing machine-WRITES it, the ranking card machine-READS it,
  D15) and mention `notes_updated_at` (the Notes box's stamp, D14.3).
- WL-S8-10 (D8-11) The CLI header says three controls (PR41); the S8 scope
  text follows PR39.
- WL-S8-11 (D8-12) C12's wording says exactly what the record holds (swap
  rows carry no per-run cap and no flags).
- WL-S8-12 (D8-13) The CLI checks the `--out` directory exists and is
  writable BEFORE the first call (exit non-zero, no call made), and if the
  record append still fails after the calls, prints the verdict and the
  table to stdout before exiting non-zero. A test for each.
- WL-S8-13 (D2b-7) The `units-contacts-batchget-walk-duplicated` update
  also names `matchesRepo.getPairs` and the run-listing BatchGet walk.
- WL-S8-14 (D7-2, E1-2) File
  `docs/issues/perf-pages-settings-rankings-surface.md` from the
  organizations precedent (E1 reference R2d).
- WL-S8-15 (E1-5) RUNBOOK's ranking section states the deploy residual
  (WL-S5-8).
- WL-S8-16 (D2a-3) RUNBOOK's PR30 caveat says "local" means a loopback
  `DYNAMODB_ENDPOINT` for the ranking defaults.

## Not adopted / no action

- D2a-5 (WL-S2-11), D3-2 (WL-S3-4), D3-5, D4-5, D2b-9, D2b-11, D7-4,
  E2-6: precision or wording in plan-internal notes; the code is right.
  Builders are not asked to act; nothing in source depends on them.
