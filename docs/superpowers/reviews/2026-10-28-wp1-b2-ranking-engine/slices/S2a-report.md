# S2a slice report - Foundations, tasks S2.1-S2.5 (WP1 B2a)

- Range: plan section 6, the S2 head (Scope, Contradictions C1-C12,
  Cross-slice notes; plan 3697-3995) and tasks S2.1-S2.5 (plan 3996-6272).
  Spec D6 (config parts), D19, spec 5 config; D1 and D2.3 for the two repo
  primitives; D3 for `completeness`. Watch items WI6, WI9. WORKLIST section G
  and WL-S2-1, WL-S2-2, WL-S2-3, WL-S2-11, WL-S2-12.
- Tasks S2.6-S2.11 (matchesRepo, the lean seed row, rankingRunsRepo, the
  tables.ts comment, the extraction-log pins, the S2 close and the S2 slice
  report) are the NEXT child's (S2b); none was started. The plan's S2.11
  slice report links this one.
- Branch `feat/wp1-b2-ranking-engine`, worktree `W:/tmp/wp1-b2-ranking-engine`,
  on top of S1 (a2367d27). Implementer: Claude Opus 5.5, 2026-10-29.
- Verdict: every task built test-first as written plus the WORKLIST; every
  RED was red for the stated reason; no one-value test fix was needed; no
  behavior, ruling or spec change; no QUESTION.

## 1. Tasks and commits

| Task | Commit | What landed |
|---|---|---|
| S2.1 | 6338ebe0 | `lib/config.ts`: the 21 D19 variables on `AppConfig` (PR4 names, `AppConfig extends RankingConfig`), one fail-fast parse rule, `RANKING_SUPPORTED_MODELS`, `AI_RANKING_MODEL_DEFAULT`, `DEFAULT_AI_PRICE_TABLE`, `parseAiPriceTable`, `isLocalDynamoTarget` (PR30), `parseRankingConfig` called LAST by `loadConfig`; PR22 (pair TTL below max age refused); the stale worker-poll comments corrected (C2). New `app/test/configRanking.test.ts` |
| S2.2 | 9ce642b5 | Production rules (spec D6, WI6): fake / console refused, `RANKING_WORKER_POLL=off` refused, `ANTHROPIC_API_KEY` required whatever `AI_EXTRACTION_ENABLED` says; PR30 refusal of fake / console on real tables outside production; file header; WL-S2-2 comment rewording; the nine production-boot fixtures carry the key |
| S2.3 | 1a703da6 | `completeness` on `TENANT_MATCHING_INPUTS` (app) and the dashboard mirror; the drift test's `MIRRORED` list compares it (PR6, spec D3) |
| S2.4 | 39e63735 | `unitsRepo.getManyByIds(ids, { requireComplete: true })` + the harness fake; `unitsRepoManyByIds.test.ts` and `.integration.test.ts` (PR5, WI9, spec D2.3) |
| S2.5 | b710a017 | `placementsRepo.hasActivePlacementForOtherTenant(unitId, tenantId)` + the harness fake (harness now imports `TERMINAL_STAGES`); `placementsRepoActiveForOther.test.ts` and `.integration.test.ts` (PR5, spec D1, WI20's repo half) |
| report | (this commit) | this file |

Files written byte-exact from the plan with `sed -n` (WORKLIST G2): the S2.1
test (plan 4008-4322; its one backslash line, the PR22 regex, survived and
was grep-checked), the S2.1 config block (plan 4408-4727, inserted after
config.ts line 545), the S2.2 test append (plan 4812-4922), the S2.4 tests
(5559-5745, 5751-5823), the S2.5 tests (5976-6065, 6071-6149). Every other
change went through the Edit tool against the quoted anchors (each matched
exactly once). Every new file is ASCII (`tr` count 0); every added line in a
touched file is ASCII (`git diff -U0 | grep '^+'` count 0 per file).

## 2. Test commands and counts (every run, in order)

App runs from `W:/tmp/wp1-b2-ranking-engine/app`, dashboard runs from
`W:/tmp/wp1-b2-ranking-engine/dashboard`, all `npx vitest run ...` with a
hard timeout, output captured to a scratch file and the exit code read
directly. DynamoDB Local (:8000) was up; no `AWS_*` and no `RANKING_*` /
`AI_PRICE_TABLE` / `DYNAMODB_ENDPOINT` / `NODE_ENV` variable is exported in
this shell (names counted, no value printed). No integration case skipped.

| Task | Step | Command | Result |
|---|---|---|---|
| S2.1 | RED | `test/configRanking.test.ts` | exit 1: 75 failed / 75. Reasons: `parseRankingConfig` / `parseAiPriceTable` / `isLocalDynamoTarget` "is not a function", the constants `undefined`, `loadConfig` without any `ranking*` field (toMatchObject misses), the refusal cases "expected [Function] to throw" - the stated reason (missing exports and fields) |
| S2.1 | GREEN | `test/configRanking.test.ts test/configAiExtraction.test.ts test/configEmail.test.ts test/app.test.ts` | exit 0: 4 files, 130 passed |
| S2.1 | lint | `npx eslint app/src/lib/config.ts app/test/configRanking.test.ts` (root) | exit 0 |
| S2.2 | RED | `test/configRanking.test.ts` | exit 1: 10 failed / 82 passed (92) - exactly the stated ten: production fake / console / " FAKE " (3), production poll off (1), key unset / empty / blank (3), real-tables fake / console / " Console " (3); every (PIN), the local-tables case and both "boots there" cases pass |
| S2.2 | GREEN | the plan's 18 files (configRanking, configAiExtraction, configEmail, configGroupIdentityExcludedNumbers, configRelayLiveProvisioning, configMediaS3Endpoint, configTwilioApiBaseUrl, configTwilioEventsWebhookSecret, configEventBridge, configLogGroupNames, configRelayAreaCodes, configVoiceIntelligence, app, auth, messaging, twilioSmsWebhook, webPushConfig, devGating) | exit 0: 18 files, 443 passed |
| S2.2 | fixture proof | the nine fixtures' UNPATCHED text (from HEAD 6338ebe0) as temporary copies `test/s2verify-*.test.ts`, run against the S2.2 config, then deleted (never staged) | exit 1: 14 failed / 262 passed (276), every failure "ANTHROPIC_API_KEY is required when NODE_ENV=production - the ranking driver is anthropic ..." and only in the nine files (section 3, WI6) |
| S2.2 | WI6 grep | Grep for `NODE_ENV: 'production'` or `nodeEnv: 'production'` in app/test, files_with_matches | exactly the plan's 17 files |
| S2.2 | lint | `npx eslint` on the 11 S2.2 files | exit 0 |
| S2.2 | typecheck | `npm run typecheck` (root, bare) | exit 0, 0 `error TS` |
| S2.3 | RED app | `test/tenantMatchingInputs.test.ts` | exit 1: 1 failed / 12 passed (13) - the new case; every `completeness` undefined |
| S2.3 | RED dashboard (after 1b) | `src/routes/contact/tenantMatchingInputsMirror.test.ts` | exit 1: 1 failed / 4 passed (5) - "carries nothing else" red, the entries case green, as stated |
| S2.3 | RED dashboard (after 3a) | same | exit 1: 2 failed / 3 passed (5) - the entries case now red too, as stated |
| S2.3 | GREEN app | `test/tenantMatchingInputs.test.ts test/tenantMatchingInputsReaders.test.ts test/seedTenantMatchingInputs.test.ts test/extractionSchema.test.ts` | exit 0: 4 files, 85 passed (extraction prompt fingerprint untouched) |
| S2.3 | GREEN dashboard | `src/routes/contact/tenantMatchingInputsMirror.test.ts src/routes/contact/tenantMatchingInputs.test.ts` | exit 0: 2 files, 15 passed |
| S2.3 | lint + tsc | `npx eslint` on the 4 files; `npx tsc -p tsconfig.json --noEmit` (dashboard) | both exit 0 |
| S2.4 | RED | `test/unitsRepoManyByIds.test.ts test/unitsRepoManyByIds.integration.test.ts` | exit 1: 10 failed / 10 - "units.getManyByIds is not a function" x9, "world.unitsRepo.getManyByIds is not a function" x1, as stated |
| S2.4 | GREEN | `test/unitsRepoManyByIds.test.ts test/unitsRepoManyByIds.integration.test.ts test/unitsRepoDisplays.test.ts test/unitsRepo.integration.test.ts` | exit 0: 4 files, 32 passed (integration ran, not skipped) |
| S2.4 | lint + tsc | `npx eslint` on the 4 files; app `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.test.json` | all exit 0 |
| S2.5 | RED | `test/placementsRepoActiveForOther.test.ts test/placementsRepoActiveForOther.integration.test.ts` | exit 1: 9 failed / 9 - "makeRepo(...).hasActivePlacementForOtherTenant is not a function" x3, "placements.hasActivePlacementForOtherTenant is not a function" x6 (repo and fake), as stated |
| S2.5 | GREEN | `test/placementsRepoActiveForOther.test.ts test/placementsRepoActiveForOther.integration.test.ts test/placementsRepo.integration.test.ts` | exit 0: 3 files, 19 passed |
| S2.5 | lint | `npx eslint` on the 4 files | exit 0 |
| S2.5 | typecheck | `npm run typecheck` (root, bare) | exit 0, 0 `error TS` |
| close | regression | app workspace `npx vitest run` (whole, at b710a017) | exit 0: 553 files passed; 11966 passed, 1 skipped (11967); 125.3 s. The skip is staticSmoke's "built dashboard identity tags" diagnostic (confirmed with `--reporter=verbose`; no dashboard/dist in the worktree), as at S1's close. Zero `[dynamoAdmin]` lines. Delta from S1's close (548 / 11854): +5 files, +112 tests (92 + 9 + 1 + 4 + 5 + 1) |
| close | regression | dashboard workspace `npx vitest run` (whole) | exit 0: 273 files, 5672 passed; 62.4 s (unchanged counts: S2.3 renamed a case and added a field) |

## 3. Watch items

- WI6 - DONE.
  - Fake and console refused under `NODE_ENV=production`: config.ts:854-860
    (message "RANKING_DRIVER=<x> is refused while NODE_ENV=production");
    tests "refuses RANKING_DRIVER=fake|console| FAKE " in
    `ranking config in production (spec D6; WI6)`.
  - `RANKING_WORKER_POLL=off` refused in production: config.ts:870-875; test
    "refuses RANKING_WORKER_POLL=off (a hermetic-lane seam)".
  - Every new variable parses fail-fast: the positive-integer, enum,
    boolean, model-id, TTL (PR22) and price-table refusal cases in
    configRanking.test.ts (92 cases in all).
  - The key is required in production whatever `AI_EXTRACTION_ENABLED`
    says (unset / empty / blank x undefined / false / no): config.ts:876-882.
    With extraction enabled the extraction check still fires first (PIN).
  - `ANTHROPIC_API_BASE_URL` still refused in production (PIN; the existing
    check at config.ts:1268-1274 fires before the ranking rules).
  - Ranking rules run LAST (`const ranking = parseRankingConfig(env, nodeEnv)`
    just before the return, config.ts:1671; `...ranking` config.ts:1750);
    PIN "the earlier production gates still fire first".
  - Fixtures that now need the key - all nine, VERIFIED by running their
    unpatched text against the S2.2 config (14 cases, every one failing on
    the ranking key message):
    - `app/test/configAiExtraction.test.ts` - 2 cases ("applies production
      defaults (disabled, anthropic driver)", "EXTRACTION_FACT_MIN_CONFIDENCE
      > defaults to 0.7 in development and production"); its no-key case
      now passes `ANTHROPIC_API_KEY: undefined` so it still tests the
      extraction gate; its prodBase comment says why the base carries a key.
    - `app/test/configEmail.test.ts` - 4 cases.
    - `app/test/configGroupIdentityExcludedNumbers.test.ts` - 1 case.
    - `app/test/configRelayLiveProvisioning.test.ts` - 1 case.
    - `app/test/app.test.ts` - 1 case (job-delivery wiring boots).
    - `app/test/auth.test.ts` - 1 case (auth wiring boots).
    - `app/test/messaging.test.ts` - 2 cases (driver factory).
    - `app/test/twilioSmsWebhook.test.ts` - 1 case (production harness env).
    - `app/test/webPushConfig.test.ts` - 1 case (VAPID unset boots).
  - The other files of the 17-file grep need nothing: configMediaS3Endpoint,
    configTwilioApiBaseUrl and devGating expect an EARLIER production throw
    (run green in the S2.2 GREEN set); devLogtail, requestLoggerMask,
    sesWebhook and twilioJsonSignature never load a production config (green
    in the whole-workspace run). A broader grep (`production` before `,)}`,
    `stubEnv('NODE_ENV'`, `NODE_ENV = 'production'`) found 12 more files;
    each only mentions the word in a comment or string - none builds a
    production config. No production `loadConfig` in the e2e workspace or
    scripts (`scripts/e2e-session.mjs:510/530` set NODE_ENV=production only
    for the DASHBOARD build).
  - The harness default env stays free of `ANTHROPIC_API_KEY`: the harness
    file mentions no `ANTHROPIC` at all (grep, 0 lines); the key appears only
    in twilioSmsWebhook.test.ts's own production env (C10 guard 3 relies on
    harness configs having no key).
- WI9 - DONE. `getDisplaysByIds` (interface doc, body now at unitsRepo.ts
  1307-1351) and every caller are byte-unchanged: the S2.4 diff of
  unitsRepo.ts and of the harness is additions only (0 removed lines);
  `getManyByIds` is new (interface unitsRepo.ts:700, body :1354, after
  `getDisplaysByIds`). `unitsRepoDisplays.test.ts` unchanged and green (11
  passed) - the behavior pin. The harness fake `getDisplaysByIds` is
  untouched; the new fake is at twilioWebhookHarness.ts:3003.

## 4. WORKLIST items

- G1 - complied: no `npm ci` / `npm install` / `npm run db:start`.
- G2 - complied: every plan block holding a backslash was copied with
  `sed -n` (only the S2.1 test has one: the PR22 regex line, grep count 1
  after the copy); files whose touched regions hold backslash escapes
  (tenantMatchingInputs.test.ts, the dashboard mirror module) were edited
  away from those lines and the escapes grep-checked after the edit.
- G3 - not engaged: S2.1-S2.5 write no comment about `failedBatches`,
  `putMatches`, `promptFingerprint` or `capOf`.
- G4 - every RED message read and its reason confirmed (section 2); vitest
  3.2.6 wording matched the plan's "is not a function" exactly for S2.4 and
  S2.5; S2.1's "whole file fails" showed as 75 runtime failures (no import
  SyntaxError: ESM named imports of missing exports load as undefined).
- G5 - not engaged in this range (the harness imports `TERMINAL_STAGES`
  from placementsRepo rather than re-spelling the stages).
- G6 - complied: no `ANTHROPIC_*` value printed, echoed or logged; no
  sending client constructed; the shell checks counted variable NAMES only.
- G7 - complied: every command ran in the foreground with a hard timeout;
  nothing left running.
- WL-S2-1 - applied: the S2.2 Step 1b anchors were matched with the 2 list
  spaces stripped; each of the 11 old blocks matched exactly once (the Edit
  tool refuses a non-unique match) and the new lines carry the file's own
  indentation.
- WL-S2-2 - applied in S2.2 (config.ts). The `anthropicApiKey` doc
  (config.ts:384-391) now reads: the key the extraction and ranking drivers
  authenticate with, "Required in production whatever AI_EXTRACTION_ENABLED
  says: the ranking driver is anthropic on every deployed stack (WP1 B2a
  spec D6; parseRankingConfig checks it last). When extraction is ENABLED
  with the anthropic driver in production, the extraction gate fails fast on
  a missing key first. Never log." The inline comment (config.ts:1247-1253)
  now calls the block "The extraction gate" and adds that parseRankingConfig
  requires the key in production regardless of AI_EXTRACTION_ENABLED and
  runs last, so with extraction enabled the extraction message is the one a
  missing key shows. The env examples' twin text (.env.dev.example ~209-212,
  .env.prod.example ~234-237, "Required only when AI_EXTRACTION_ENABLED=true")
  is S8's (WL-S8-5) and is untouched.
- WL-S2-3 - recorded (no code change): PR30's `isLocalDynamoTarget`
  (config.ts:672) counts ONLY a loopback host (localhost, 127.0.0.1, [::1])
  as local, while the existing predicates count ANY set endpoint as DynamoDB
  Local: `lib/devRoutes.ts:18` (`!config.dynamodbEndpoint`), `lib/logger.ts:85`
  (devLogTailEnabled: endpoint non-empty), `scripts/dev.mjs:113-116`
  (liveMode = no endpoint), `scripts/lib/devMode.mjs:43` (mode local when an
  endpoint is set). An endpoint naming DynamoDB Local by a non-loopback host
  (a docker service name, a LAN IP, 0.0.0.0) would boot with the anthropic
  driver and poll off and REFUSE `RANKING_DRIVER=fake|console` while the dev
  router still mounts - it fails SAFE. No lane does this today: the e2e lane
  defaults to `LOCAL_ENDPOINT` = `http://localhost:8000`
  (`scripts/e2e-session.mjs:144`, `scripts/db.mjs:42`), the dev loop's local
  mode uses the same constant (`scripts/dev.mjs:146` into devMode.mjs:46),
  `scripts/e2e-stop.mjs:117` uses `http://127.0.0.1:8000`, and
  `app/vitest.config.ts` sets no endpoint (npm test defaults to anthropic /
  poll off). The hermetic lanes must keep a loopback endpoint. The RUNBOOK
  caveat is S8's (WL-S8-16).
- WL-S2-11 - recorded (no change): `getManyByIds` throws on the FIRST
  incomplete chunk with `IncompleteBatchReadError(keys.length,
  uniqueIds.length, 'units')`; on a multi-chunk read the "N of M keys
  unread" count can understate (keys of later chunks were never attempted).
  The behavior (complete or nothing, throw) is right; only the logged count
  is imprecise. Unlike `getDisplaysByIds` and contactsRepo's
  `batchGetByIds`, which walk every chunk and report the summed count.
- WL-S2-12 - noted: the S2 head's cross-slice line "S8 owns the env example
  files ... (uncommented with defaults ...)" is superseded by PR39
  (`RANKING_DRIVER` and `RANKING_WORKER_POLL` as comments in .env.example,
  `RANKING_WORKER_POLL` as a comment in .env.dev.example); S2a built nothing
  from it.

## 5. Head contradictions and rulings covered by this range

- C2 - done in S2.1: the `workerPollIntervalMs` interface doc (config.ts
  408-418) and the implementation comment (:993-996) name the ranking poll
  among the startPoll-wrapper polls, default 30000 (spec 5's stale "three
  polls, default 60000" is gone).
- C5 - the extraction key check is unchanged; the ranking check runs last;
  (PIN) "with extraction enabled, the extraction check still names the key
  first" green.
- C6 - `RANKING_EFFORT` accepts exactly low, medium, high, xhigh, max
  (test "accepts every driver and every effort level the API takes"; none
  and minimal refused).
- C9 / PR22 - `RANKING_PAIR_TTL_DAYS` below `RANKING_MAX_AGE_DAYS` refused
  (6 < 7 refused, 7 accepted; config.ts:821-826).
- C10 / PR30 - built as written: `onRealTablesOutsideProduction` =
  NODE_ENV not production AND `!isLocalDynamoTarget(DYNAMODB_ENDPOINT)`;
  there the driver defaults to anthropic, the poll to off (an explicit `on`
  honored), fake / console refused at startup (config.ts:863-869). Guard 1
  (dev router mounts only with an endpoint) exists at devRoutes.ts:18;
  guards 2 and 3 are S5's and S4's.
- PR4 - the 21 fields are exactly the PR4 names (test "the fields are
  exactly the PR4 names ..."); env names are spec D19's.
- PR5 / PR6 - the two repo methods and `completeness` as specified.

## 6. Deviations from the plan text

- WL-S2-2's comment rewording (sanctioned by the WORKLIST; wording in
  section 4 - D2a's text was an "e.g.", so the exact sentences are mine).
- The S2.2 commit body adds "PR30" and one sentence naming the WL-S2-2
  comment change; the subject line is the plan's.
- The MERGE_HEAD check used the brief's `test -e "$(git rev-parse
  --git-path MERGE_HEAD)"` form (printed ok before every commit) instead of
  the plan's `ls` of the worktree git dir; equivalent.
- Extra verification beyond the plan: the nine-fixture proof run (temporary
  copies, deleted) and the whole app and dashboard workspace runs.
- No one-value test fix; no expected value differed from the plan.
- Process note: the first S2.1 Edit batch was refused ("file modified since
  read") because the ranking block had just been inserted with `sed`; the
  file was re-read and the same edits applied. No content effect.

## 7. QUESTIONS

None.

## 8. For S2b (S2.6-S2.11) - what S2a shipped

- `app/src/lib/config.ts` exports: `RankingDriverName`, `RankingEffort`,
  `RankingPriorityStrength`, `AiPrice`, `AiPriceTable`,
  `RANKING_SUPPORTED_MODELS` (`['claude-sonnet-5-5', 'claude-opus-5-5']`),
  `AI_RANKING_MODEL_DEFAULT`, `DEFAULT_AI_PRICE_TABLE` (frozen),
  `RankingConfig`, `parseRankingConfig(env, nodeEnv)`,
  `parseAiPriceTable(raw)`, `isLocalDynamoTarget(endpoint)`.
  `AppConfig extends RankingConfig`; the TTL field is
  `config.rankingPairTtlDays` (default 180) for S2.6's
  `rankingExpiresAt(fromIso, ttlDays)` callers.
- PR30 in tests: a config from `loadConfig` (directly, via
  `makeWebhookHarness`, or via `createDynamoClient`, which calls
  `loadConfig(process.env)` at lib/dynamo.ts:62) with no loopback
  `DYNAMODB_ENDPOINT` gets `rankingDriver: 'anthropic'`,
  `rankingWorkerPoll: false`, and THROWS on `RANKING_DRIVER=fake|console`.
  An integration test must never export `RANKING_DRIVER=fake` without a
  loopback endpoint; inject a driver as a dependency instead.
- Harness (`app/test/helpers/twilioWebhookHarness.ts`, `createFakeWorld()`):
  `world.unitsRepo.getManyByIds(ids, { requireComplete: true })` (full
  COPIES; unknown id absent; soft-deleted unit answers; never throws) at
  :3003; `world.placementsRepo.hasActivePlacementForOtherTenant(unitId,
  tenantId)` at :3531; the harness imports `TERMINAL_STAGES` from
  placementsRepo (:146). (The contacts fake's own `getManyByIds` at :2340 is
  a different, pre-existing method.)
- `unitsRepo.getManyByIds` throws `IncompleteBatchReadError` (from
  contactsRepo) with table `units`; the option must be exactly
  `{ requireComplete: true }` or it throws "complete read only" before any
  call. Marked `TODO(units-contacts-batchget-walk-duplicated)` (the issue
  exists; its update is S8's).
- `placementsRepo.hasActivePlacementForOtherTenant` pages `byUnit` through
  the private `queryIndex` (sends `':v'`), stops at the first hit.
- `TENANT_MATCHING_INPUTS[i].completeness: boolean` (app and dashboard
  mirror): area_preference and max_tenant_portion true, the other two false.
- Baselines at b710a017: app workspace 553 files / 11966 passed / 1 skipped
  (the staticSmoke diagnostic); dashboard 273 files / 5672 passed; root
  `npm run typecheck` exit 0; eslint clean on every file S2a touched (no
  pre-existing error in them, so gate 5 needs no baseline for these files).
- Untouched and S2b's: `repos/matchesRepo.ts`, `repos/rankingRunsRepo.ts`,
  `lib/tables.ts` comment, `lib/seed/lean.ts` (+ `scripts/db-seed.ts`
  header), `repos/aiRunsRepo.ts` header (WL-S2-10), the WI1 / WI2 / WI10 /
  WI19 records, and WL-S2-4..WL-S2-10.
