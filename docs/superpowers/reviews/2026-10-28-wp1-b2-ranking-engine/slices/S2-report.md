# S2 slice report - Foundations (WP1 B2a, tasks S2.1-S2.11)

- Range: plan section 6 (lines 3697-10009): the S2 head (Scope,
  Contradictions C1-C12, Cross-slice notes) and tasks S2.1-S2.11, with the S2
  coverage table. Spec D6 (config), D7, D8, D8.1, D10, D11, D19, spec 5.
  Watch items WI1, WI2, WI6, WI9, WI10 (S2 half), WI19 (S2 grep). WORKLIST
  section G and WL-S2-1..WL-S2-12.
- Built in two children on branch `feat/wp1-b2-ranking-engine`
  (worktree `W:/tmp/wp1-b2-ranking-engine`), on top of S1 (a2367d27):
  - S2a (S2.1-S2.5): its own report,
    [S2a-report.md](S2a-report.md) - config, completeness, getManyByIds,
    hasActivePlacementForOtherTenant, WI6, WI9 (repo half), WL-S2-1/2/3/11/12.
    This report does not repeat its run log; it carries its results forward.
  - S2b (S2.6-S2.11, this child; Claude Opus 5.5, 2026-10-29): matchesRepo,
    the lean seed row, rankingRunsRepo (job, run/pointer, flag families),
    the extraction-log exclusion pins, the ai_runs comment, the close.
- Verdict: every task built test-first as written plus the WORKLIST; every
  RED was red for the stated reason; no one-value test fix; no behavior,
  ruling or spec change; no QUESTION. All S2 gates the slice can run are
  green.

## 1. Tasks and commits

| Task | Commit | What landed |
|---|---|---|
| S2.1 | 6338ebe0 | config: the 21 D19 variables, fail-fast parse, PR22, PR30 defaults (S2a) |
| S2.2 | 9ce642b5 | config: production refusals, key required, PR30 refusals, nine fixtures (S2a) |
| S2.3 | 1a703da6 | `completeness` on the B1 list + mirror + drift test (S2a) |
| S2.4 | 39e63735 | `unitsRepo.getManyByIds` + harness fake (S2a) |
| S2.5 | b710a017 | `placementsRepo.hasActivePlacementForOtherTenant` + harness fake (S2a) |
| S2a report | cafbabea | S2a-report.md |
| S2.6 | f7de5d9b | `app/src/repos/matchesRepo.ts` (new); `app/test/matchesRepo.test.ts`, `app/test/matchesRepo.integration.test.ts` |
| S2.7 | cbf1f4ab | `app/src/lib/seed/lean.ts` (row + constant removed), `app/scripts/db-seed.ts` (header comment), `app/test/seedNoLegacyMatch.test.ts` |
| S2.8 | af2fdb81 | `app/src/repos/rankingRunsRepo.ts` (new, job family); `app/test/rankingRunsRepoJobs.integration.test.ts` |
| S2.9 | f269ff80 | run and pointer family; `app/src/lib/tables.ts` ai_runs comment; `app/src/repos/aiRunsRepo.ts` header comment (WL-S2-10); `app/test/rankingRunsRepoRuns.integration.test.ts`, `app/test/rankingRunsRepoListing.test.ts`, `app/test/rankingRunsExtractionLogExclusion.integration.test.ts` |
| S2.10 | 0a456d70 | flag family; `app/test/rankingRunsRepoFlags.integration.test.ts`; the flag row added to the exclusion pins |
| S2.11 | (this commit) | this report |

How the plan text was applied (WORKLIST G2): every new file was copied
byte-exact from the plan with `sed -n` (S2.6 test 6286-6572, integration
6578-6736, implementation 6755-7031; S2.7 test 7068-7087; S2.8 test
7212-7700, implementation 7719-8224; S2.9 tests 8264-8582, 8589-8703,
8709-8860; S2.10 test 9397-9539). Every quoted "Replace X with Y" of S2.9 and
S2.10 was applied by a scratch script (outside the worktree) that takes X and
Y from the plan's line ranges and refuses unless X occurs exactly once (all
nine anchors matched once: rankingRunsRepo.ts x6, tables.ts x2, the
exclusion test x1). The S2.7 anchors went through the Edit tool (each
matched once). The WORKLIST and G3 changes were Edit-tool edits on top. The
one backslash line kept from the plan (`/contact-\d/`,
matchesRepo.test.ts:209) was grep-checked after the edits.

## 2. Test commands and counts (S2b runs, in order)

App runs from `W:/tmp/wp1-b2-ranking-engine/app`, dashboard from
`.../dashboard`, e2e unit from `.../e2e`, all `npx vitest run ...` with a
hard timeout, output to a scratch file, exit code read directly. DynamoDB
Local (:8000) up; `env | grep '^AWS_'` counted 0 (names only). No
integration case skipped in any run below.

| Task | Step | Command | Result |
|---|---|---|---|
| S2.6 | RED | `test/matchesRepo.test.ts test/matchesRepo.integration.test.ts` | exit 1: both files fail at import - "Cannot find module '../src/repos/matchesRepo.js'" / "Failed to load url ... Does the file exist?" (G4 wording of "does not exist"); no tests |
| S2.6 | GREEN | same | exit 0: 2 files, 18 passed (14 + 4) |
| S2.6 | tsc | app `npx tsc -p tsconfig.json --noEmit`, `npx tsc -p tsconfig.test.json` | both exit 0 (WL-S2-4 applied first) |
| S2.6 | lint | `npx eslint` on the 3 files (root) | exit 0 |
| S2.7 | RED | `test/seedNoLegacyMatch.test.ts` | exit 1: 1 failed / 1 passed - "expected [ 'contacts', 'units', ...(8) ] to not include 'matches'"; case 2 (cast and matrix) green as the PIN |
| S2.7 | GREEN | the plan's 10 files (seedNoLegacyMatch, seedData, seedProfile.integration, seedHistory, seedMatrix, seedHeardFrom, seedTourTrails, seedContactTypeInvariants, performanceSeed, performanceSeed.integration) | exit 0: 10 files, 314 passed; no seed test edited |
| S2.7 | extra | the other 14 seed suites (seedNotesStamp, seedLive, seedMatrixCoherence, seedMedia, seedMessageTransport, seedOrgNames, seedPersonaDrift, seedPriority, seedRequirements, seedRosterShape, seedTenantMatchingInputs, seedTourPartition, seedUnreadFlag, reseedUnmatchedEmail) | exit 0: 14 files, 125 passed (S1's seedNotesStamp pins 2/2) |
| S2.7 | lint | 3 files | exit 0 |
| S2.8 | RED | `test/rankingRunsRepoJobs.integration.test.ts` | exit 1: fails at import (Cannot find module '../src/repos/rankingRunsRepo.js'); no tests |
| S2.8 | GREEN | same | exit 0: 22 passed |
| S2.8 | lint + tsc | 2 files; app tsc src + test | all exit 0 |
| S2.9 | RED | `test/rankingRunsRepoRuns.integration.test.ts test/rankingRunsRepoListing.test.ts test/rankingRunsExtractionLogExclusion.integration.test.ts` | exit 1: 12 failed / 5 skipped (17). Runs file: 12 failed ("repo.putRun is not a function" x9, "rankingRunItemId is not a function", "rankingRunEntityKey is not a function", "expected undefined to be 358400"). Listing file: fails at collect (top-level `rankingRunEntityKey()` is not a function). Exclusion file: its beforeAll throws "rankings.putRun is not a function", the suite FAILs and vitest 3.2.6 reports its 5 cases as SKIPPED (the plan says "its cases fail" - G4: same reason, different wording) |
| S2.9 | GREEN | the plan's 8 files (the three + rankingRunsRepoJobs.integration, aiRunsRepo.integration, aiRunsApi, tables, genTables) | exit 0: 8 files, 136 passed; `npm run gen:tables` not needed (comment only) |
| S2.9 | lint + tsc | 6 files (incl. tables.ts, aiRunsRepo.ts); app tsc src + test | all exit 0 |
| S2.10 | RED | `test/rankingRunsRepoFlags.integration.test.ts test/rankingRunsExtractionLogExclusion.integration.test.ts` | exit 1: 5 failed / 5 skipped (10): "unlawfulFlagItemId is not a function" (keys case), "repo.putFlagIfAbsentOrClosed is not a function" x4; exclusion beforeAll throws "rankings.putFlagIfAbsentOrClosed is not a function" (its 5 cases skipped, as in S2.9) |
| S2.10 | GREEN | the plan's 4 files (Flags, Exclusion, Runs, Jobs) | exit 0: 4 files, 44 passed |
| S2.10 | lint + tsc | 3 files; app tsc src + test | all exit 0 |
| S2.10 | WI2 proof | 5 single mutations of rankingRunsRepo.ts, the exclusion file run after each (section 4, WI2) | every mutation exit 1 (RED); file restored byte-exact each time; `git status` clean after |
| S2.11 | typecheck | `npm run typecheck` (root, bare) | exit 0, 0 `error TS` |
| S2.11 | lint | `npx eslint` on the plan's 35 files + `app/src/repos/aiRunsRepo.ts` (root) | exit 0, no output |
| S2.11 | app workspace | `npx vitest run` (whole, at 0a456d70) | exit 0: 561 files passed; 12033 passed, 1 skipped (12034); 134.5 s. The skip is staticSmoke's "built dashboard identity tags" diagnostic (`test/staticSmoke.test.ts (12 tests / 1 skipped)`), as at S1's and S2a's close. Zero `[dynamoAdmin]` lines. Delta from S2a's close (553 / 11966): +8 files, +67 tests (14 + 4 + 2 + 22 + 12 + 3 + 5 + 5) - exactly the eight new files |
| S2.11 | dashboard workspace | `npx vitest run` (whole) | exit 0: 273 files, 5672 passed; 62.2 s (unchanged; S2b touched no dashboard file) |
| S2.11 | e2e workspace (unit, no browser) | `npx vitest run` | exit 0: 22 files, 509 passed; 5.5 s (extra; the seed changed) |

No red file in any run, so no re-run comparison was needed.

## 3. Head contradictions (C1-C12) - resolved

- C1 (seed path) - done in S2.7: the row was `app/src/lib/seed/lean.ts:445-457`
  and the constant + comment `:36-38` at 404e039d; both removed (17 lines,
  0 added). Nothing else in `app/src/lib/seed/` names `matches`.
- C2 (stale poll comment) - done in S2.1 (S2a section 5): config.ts's
  `workerPollIntervalMs` doc and implementation comment name the ranking poll.
- C3 (ai_runs comment) - done in S2.9: `app/src/lib/tables.ts:625-661` lists
  all seven families (run#, inflight#, extraction ptr#, rjob#, rrun#,
  ranking ptr#, uflag#), which rows carry the byEntity keys, and the TTL per
  family (none on uflag#). WL-S2-9 wording applied (section 5).
- C4 (detail route kind check) - no route change: `app/src/routes/aiRuns.ts:228-233`
  reads `getRun` = `run#<id>` (`aiRunsRepo.ts:307-312`); a ranking run is
  `rrun#` so the detail answers 404 `run_not_found`. Pinned by
  `rankingRunsExtractionLogExclusion.integration.test.ts` (case 4, green).
- C5 (two key checks) - S2.2 (S2a): the extraction check is unchanged and
  fires first; the ranking key check runs last in `parseRankingConfig`.
- C6 (effort values) - S2.1 (S2a): low, medium, high, xhigh, max.
- C7 (promptFingerprint on the row) - `MatchRow` carries `rubricVersion`,
  `examplesVersion` and `promptFingerprint` top level
  (`app/src/repos/matchesRepo.ts:59-66`); the field comment states PR18's
  meaning (G3).
- C8 (open shapes) - `matchesWritten` is `{ count, at }`
  (rankingRunsRepo.ts:596, set by `markMatchesWritten` :767-776, condition
  `attribute_exists`); the 350 KB guard lives in `putRun` (:733 through
  `withRankingRunSizeGuard` :675-679); `takeOver` resets poolSize,
  batchCount, batchesDone, failedBatches, notScored, message and KEEPS
  runIds (:330-361, UpdateExpression :335); `markLeaseFailed` is its own
  primitive (:363-388, attempts >= 1).
- C8a (notScored, PR13) - `RankingJobRecord.notScored` (:114) starts `[]` on
  every claim, appended by `updateJobProgress` (:454), reset by `takeOver`.
  `failedBatches` per PR42 (`RankingFailedBatch` and its doc :67-81 name
  every failure kind including `error`).
- C8b (results[]) - `RankingRunResult` (:548-564): `returned: false` with no
  scored field; a returned pair carries merged `missing` beside `unknowns`
  and `cappedAtRun: { capped, capReason }`. Case "results[] keep a returned
  pair ... and a not-returned one with no score" green.
- C9 (pair TTL vs max age, PR22) - S2.1 (S2a): config.ts:821-826 refuses a
  pair TTL below the max age.
- C10 (real tables outside production, PR30) - S2.1/S2.2 (S2a). The three
  guards stay LOAD-BEARING for WI7 (no test reaches the network); no later
  slice may remove one without replacing it:
  1. the dev router mounts only with a `DYNAMODB_ENDPOINT`
     (`app/src/lib/devRoutes.ts:19`, the condition line today);
  2. the worker builds a ranking driver only when `rankingWorkerPoll` is on
     (S5, worker.ts), and the poll defaults off on real tables / in npm test;
  3. `createRankingDriver` throws for the anthropic driver when
     `config.anthropicApiKey` is unset (S4, adapters/ranking.ts).
- C11 (partial match write, PR37) - `putMatches` reports pairs not
  confirmed written (matchesRepo.ts:180-217): unprocessed after 5 attempts,
  or every not-yet-confirmed row of a chunk whose request threw (WARN
  "matches: BatchWrite chunk failed" :204); the other chunks still land; it
  throws only on a non-schema-2 row (:181-185). Both PR37 cases green.
- C12 (run listing reads summaries, PR34) - `listRuns` (:783-845) BatchGets
  `rrun#` items PROJECTED to `RANKING_RUN_SUMMARY_FIELDS` (19 fields,
  `SUMMARY_PROJECTION` :701, every name aliased `#f0..#f18`); an unread run
  is `{ expired: true, unavailable: true }` and the page says
  `incomplete: true` (:843). Green: the three stub cases in
  `rankingRunsRepoListing.test.ts` and the summary integration case.

Rulings: PR5 (section 7 lists the exact APIs), PR13, PR14 / IR3 / IR19,
PR15, PR22, PR30 (the real-tables cases of `configRanking.test.ts`, 92/92
green in the workspace run), PR34, PR37, PR42, IR23 - all applied; their
cases green in the S2.11 workspace run.

Every new DynamoDB Local integration suite mints `hc-test-<uuid8>-`
(its `testEnv` is `TABLE_PREFIX` = `hc-test-` + `randomUUID().slice(0, 8)` + `-`):
matchesRepo.integration:67, rankingRunsRepoJobs.integration:55,
rankingRunsRepoRuns.integration:127, rankingRunsRepoFlags.integration:48,
rankingRunsExtractionLogExclusion.integration:39 (and S2a's
unitsRepoManyByIds.integration:31, placementsRepoActiveForOther.integration:32),
so the residue sweep's `RESIDUE_PREFIXES` (`/^hc-test-/`,
app/test/globalTeardown.ts:80-84) covers an interrupted run, and
`setup/dynamoAccessKeyGuard.test.ts` (16/16 green) accepts them. The two stub
suites (matchesRepo.test.ts, rankingRunsRepoListing.test.ts) create no table
(`hc-test-x-` names only a stub's RequestItems key).

## 4. Watch items

- WI1 - DONE (S2 half; S5 adds the one writer, S6 the readers).
  - Grep (pattern `tableName\('matches'|TABLES\.matches|'matches'|"matches"`):
    `app/src` - exactly three hits: `app/src/lib/tables.ts:240`
    (`baseName: 'matches'`), `app/src/repos/matchesRepo.ts:176`
    (`tableName('matches', deps.env)`), `app/src/repos/matchesRepo.ts:241`
    (the `IncompleteBatchReadError` label, a message string). `app/scripts`:
    none. `scripts`: only `scripts/secrets.mjs:301` (`status = 'matches'`, a
    status word). `e2e`: none. `createMatchesRepo` over `app/src`: only the
    definition (matchesRepo.ts:174).
  - No other by-name writer. Manifest-wide (a table-name grep cannot see
    them, WL-S2-8): `app/src/lib/devReset.ts` clears EVERY `TABLES` base on a
    hermetic reseed (`clearTable` Scan + BatchWrite deletes :35-64, called for
    each `TABLES` base :94 and :102-104, refused unless the prefix is
    hermetic :86-91) -
    `matches` included, the intended clean slate; and `seedAll` writes every
    key `SEED` holds (`app/src/lib/seed/index.ts:118`), which no longer
    includes `matches` (seedNoLegacyMatch.test.ts, case 1).
  - Legacy rows ignored by every reader: `isCurrentMatchRow`
    (matchesRepo.ts:139) gates `getPairs` (:236) and both lists (:261,
    :276). Green: the "a row is current only with schema 2" and "a legacy
    row ... both absent" cases (matchesRepo.test.ts) and "listByUnit and
    listByTenant return only schema 2 rows; a legacy row is ignored by every
    reader" (integration, the removed seed row's exact shape).
- WI2 - DONE.
  - Step 1 diff: `git diff --stat 404e039d -- app/src/routes/aiRuns.ts
    app/src/jobs/journalSweep.ts app/src/routes/dev.ts
    app/src/lib/performanceSeed.ts app/src/lib/devReset.ts app/src/worker.ts`
    printed NOTHING.
  - `aiRunsRepo.ts` on the branch: `git log 404e039d..HEAD` shows S1.4's
    2895ed6a (notesDuplicate) and S2.9's f269ff80 - the latter is the
    WL-S2-10 header comment ONLY (7 comment lines replace 2; zero
    non-comment lines changed, checked on `git show -U0`). The plan expected
    only S1.4's commit; WL-S2-10 sanctions the second.
  - Readers, from the built tree:
    - `app/src/routes/aiRuns.ts`: the list validates `scope` against
      `SCOPE_PATTERN` (:30-31; admits only global, outcome#<4 outcomes>,
      conversations#<id>, contacts#<id> - no rankings#, rankjobs#, uflags#)
      and answers 400 `invalid_scope` (:141-142), then `listByEntity(scope)`
      (:174); the detail (:228) reads `getRun` (:230) = `run#<id>`, 404
      `run_not_found` (:232). Safe; pinned.
    - `app/src/repos/aiRunsRepo.ts`: `getRun` :307-312 (GetItem `run#`);
      `listByEntity` :314 on reads ONE byEntity partition (the caller's
      extraction scope) then `batchGetRuns` of `run#` ids (:202-233). Safe;
      pinned. Its header (now :1-7) says the ranking families share the
      table under their own partitions.
    - `app/src/jobs/journalSweep.ts`: builds an `aiRunsRepo` only for the
      suggestion-resolution service (:118); the service touches ai_runs only
      through `setVerdict` on a known run id
      (`services/suggestionResolution.ts:474`). Its Scan enumerates resolve#
      journal rows (header :12-15), not ai_runs. No prefix read: safe.
    - `app/src/routes/dev.ts`: builds an `aiRunsRepo` for the extraction tick
      (:752), which calls `beginFinalization` / `putRun` / `setVerdict` by key
      (`jobs/extraction.ts:698, 779, 802`). No Scan in dev.ts. The reseed
      (:357) is `resetLocalData` (`lib/devReset.ts`), which Scans and deletes
      EVERY item of every table - the ranking families included, the
      intended clean slate on a hermetic lane. Safe.
    - `app/src/lib/performanceSeed.ts`: writes only its eight `TABLE_BASES`
      tables (:47-56, no ai_runs); its reader bundle
      `createPerformanceSeedReaders` builds an `aiRuns` repo (:163) that no
      src module calls (only `performanceSeed.integration.test.ts:318` asks
      `listByEntity('global')`, the extraction global scope no ranking family
      writes); it resets through `resetLocalData` (:250). No prefix read: safe.
    - Also read: `scripts/wipe-dev-data.mjs` Scans and deletes every item
      (no prefix logic); nothing in `app/scripts` or `scripts` reads ai_runs.
  - Pins: all five cases of
    `app/test/rankingRunsExtractionLogExclusion.integration.test.ts` green,
    with every ranking family in the table (a run + its 2 pointers, a queued
    job, a flag row). LOAD-BEARING, proven: each mutation below, applied
    alone to rankingRunsRepo.ts, turned the pins RED (exit 1), then the file
    was restored byte-exact:
    - M1 the ranking run stored as `run#<id>`: 2 failed ("aiRunsRepo.getRun
      does not find the ranking run", the detail 404 case).
    - M2 the global pointer partition = `global`: 2 failed (listByEntity in
      every scope, GET /api/ai-runs).
    - M3 the per-anchor pointer partition = `contacts#<id>`: 1 failed
      (listByEntity, the contacts# scope).
    - M4 the queued job partition = `global`: 2 failed (listByEntity,
      GET /api/ai-runs).
    - M5 the flag partition = `global`: 2 failed (listByEntity,
      GET /api/ai-runs).
- WI6 - DONE in S2.1/S2.2 (S2a section 3): fake / console refused and
  `RANKING_WORKER_POLL=off` refused under NODE_ENV=production; the key
  required in production whatever `AI_EXTRACTION_ENABLED` says;
  `ANTHROPIC_API_BASE_URL` still refused (PIN). The NINE fixtures that
  gained the key, by file and object: `configAiExtraction.test.ts` prodBase
  plus its no-key case's explicit `ANTHROPIC_API_KEY: undefined`;
  `configEmail.test.ts` prodBase; `configGroupIdentityExcludedNumbers.test.ts`
  prodBase; `configRelayLiveProvisioning.test.ts` prodBase; `app.test.ts`
  the job-delivery prodBase; `auth.test.ts` prodBase; `messaging.test.ts`
  JOB_DELIVERY_ENV; `twilioSmsWebhook.test.ts` the fail-closed case's env;
  `webPushConfig.test.ts` the unset-VAPID case's env. Verified by running
  the nine files' unpatched text against the S2.2 config (14 failures, all
  on the ranking key message). The S2.2 grep found exactly the plan's 17
  files; the other 8 need nothing (S2a section 3). All green again in the
  S2.11 workspace run.
- WI9 - DONE. `git diff -U0 404e039d -- app/src/repos/unitsRepo.ts`: two
  hunks, both pure additions (`@@ -688,0 +689,12 @@` the interface method
  and its doc; `@@ -1340,0 +1353,28 @@` the `TODO(...)` line and
  `getManyByIds`); 39 added lines, NO removed line besides the `---` header.
  `unitsRepoDisplays.test.ts` unchanged since 404e039d and green (11/11).
- WI10 (S2 half) - DONE. Removed at 404e039d `app/src/lib/seed/lean.ts:36-38`
  (`// matches TTL: epoch seconds for 2026-09-01T00:00:00Z ...` and
  `const MATCH_EXPIRES_AT = 1_787_270_400;`) and `:445-457` (the
  `matches: [ { tenantId: IDS.tenant, unitId: IDS.unitA, fit_score: 0.91,
  approval_likelihood: 0.84, rank: 1, status: 'shared',
  portability_required: false, expires_at: MATCH_EXPIRES_AT, generated_at:
  T0 } ]` block). `git diff --stat 404e039d -- app/src/lib/seed/` = lean.ts
  17 deletions, 0 additions; no other seed module changed; `T0` and
  `IDS.unitA` stay used; `MATCH_EXPIRES_AT` has no other user (Grep: none).
  NO seed stability test changed (`git diff --stat 404e039d` empty for the
  ten S2.7 suites; `seedProfile.integration.test.ts` derives its count and
  ids from `SEED`). Every seed suite green (24 files: 10 + 14 in section 2),
  `seedNoLegacyMatch.test.ts` 2/2, S1's `seedNotesStamp.test.ts` 2/2.
  `app/scripts/db-seed.ts` header now says it writes no `matches` row (Grep
  `matches` in that file: only the new sentence, :7).
- WI19 (S2 grep) - DONE. Grep over `e2e/` for
  `fit_score|approval_likelihood|portability_required|matchesRepo|contact-tenant-0001.*unit-0001`:
  no hit. The "matches property" text is voucher-chip copy, not the match
  row: `e2e/tests/dashboard-next/broadcasts.spec.ts:173` (comment), `:176`,
  `:326`; `e2e/tests/dashboard-next/property-requirements.spec.ts:535-536`;
  `e2e/support/selectors.md:163` (a selectors-table row). The e2e workspace
  imports only `app/src/lib/seed/performance.js` from the seed.

## 5. WORKLIST items

- G1 - complied: no `npm ci` / `npm install` / `npm run db:start`.
- G2 - complied (section 1). The only plan backslash in S2b's files is in
  matchesRepo.test.ts (`/c-\d/`, replaced by WL-S2-6; `/contact-\d/` kept,
  :209, grep-checked).
- G3 - applied twice: `MatchRow.promptFingerprint`'s comment now reads
  "sha256 over the call's system text, a newline and the stable JSON of the
  schema sent on that call (spec D4, D8.1; plan PR18 - prompt.ts
  rankingPromptFingerprint)" (matchesRepo.ts:61-65; plan text said "system
  text" only); `RankingFailedBatch`'s comment names the `error` kind (an
  unexpected exception in the batch; S5 writes it) beside the call kinds
  and `repo` (rankingRunsRepo.ts:67-76). No S2 comment says an unwritten
  match throws or groups unlawful flags by item.
- G4 - every RED read and its reason confirmed (section 2). Wording
  differences recorded: "Cannot find module / Failed to load url" for a
  missing module; a suite whose beforeAll throws reports its cases SKIPPED,
  not failed (S2.9 and S2.10 exclusion file).
- G5 - the job partitions are exported constants
  (`RANKING_JOBS_QUEUED_ENTITY`, `RANKING_JOBS_RUNNING_ENTITY`,
  rankingRunsRepo.ts:62-63); the repo itself never re-spells them.
- G6 - complied: no `ANTHROPIC_*` value printed or read; no client built.
- G7 - complied: every command foreground with a hard timeout (the WI2
  mutation script ran its five vitest runs synchronously); nothing left
  running.
- WL-S2-1, WL-S2-2, WL-S2-3, WL-S2-11, WL-S2-12 - S2a (S2a section 4).
  WL-S2-3's note stands: PR30's `isLocalDynamoTarget` counts only loopback
  hosts as local (fails safe; RUNBOOK caveat is WL-S8-16). WL-S2-11:
  `getManyByIds` throws on the first incomplete chunk; its count can
  understate on a multi-chunk read (no change).
- WL-S2-4 - applied: `stubGetDoc(stored: ReadonlyArray<PairKey>, ...)` and
  the matcher `k.tenantId === item.tenantId && k.unitId === item.unitId`
  (matchesRepo.test.ts:84-101). tsc (src + test) exit 0 at S2.6 and the
  root typecheck exit 0 at S2.11.
- WL-S2-5 - applied: the case is named "updateJobProgress with only an
  empty notScored list is an empty patch: it throws and writes nothing"
  (rankingRunsRepoJobs.integration.test.ts:449); body unchanged.
- WL-S2-6 - applied: `for (const id of ['c-1', 'c-2', 'c-3'])
  expect(JSON.stringify(warns[0])).not.toContain(id);` replaces the
  host-dependent `/c-\d/` (matchesRepo.test.ts:192).
- WL-S2-7 - applied, unchanged tests: `matchesRepo.listByUnit` /
  `listByTenant` call the house `queryAll` (`lib/dynamoPaging.ts`, page cap
  100 + WARN) with the repo's logger and filter `isCurrentMatchRow`
  (matchesRepo.ts:247-277); the private helper of the same name and the
  now-unused `QueryCommand` / `QueryCommandInput` imports are gone.
  `rankingRunsRepo.getOpenCandidateFlags` calls `queryAll<UnlawfulFlagRecord>`
  (rankingRunsRepo.ts:919-933; the flag family now destructures `log`).
  No plan test needed a stub change, so no `walkQuery` rename.
- WL-S2-8 - applied (WI1 above: devReset and seedAll).
- WL-S2-9 - applied: the tables.ts comment carries no "(WI2)"; its reads
  sentence now says the two run listings (extraction and ranking) are
  Query(byEntity) then ONE BatchGetItem of the run rows, the job poll and
  the flag read a plain Query(byEntity), a job or run read a GetItem -
  never a Scan (tables.ts:646-649).
- WL-S2-10 - applied, comment only (WI2 above). aiRunsRepo.ts:1-7 now says
  its extraction rows are run rows, pointers and the inflight# marker, only
  the pointers indexed, and that the ranking families' queued / running job
  rows, run pointers and flag rows are byEntity rows under their own
  partitions, which no extraction scope names.

## 6. Gates the slice can run

- Typecheck: `npm run typecheck` (root, bare) exit 0, 0 `error TS`.
- Lint (gate 5 style, the slice's own files): the plan's 35 files plus
  `app/src/repos/aiRunsRepo.ts`, which WL-S2-10 touched - exit 0, no
  output. These 36 are every code file the slice changed
  (`git diff --name-only a2367d27..HEAD`). No pre-existing error in any of
  them, so no baseline comparison was needed.
- ASCII: every new file prints 0 (`tr` sweep: matchesRepo.ts,
  rankingRunsRepo.ts and the 13 new test files of S2); every edited
  pre-existing file's ADDED lines since 404e039d print 0 (config.ts,
  tenantMatchingInputs.ts, unitsRepo.ts, placementsRepo.ts, lean.ts,
  db-seed.ts, tables.ts, aiRunsRepo.ts, the harness, the dashboard mirror
  and its test, the nine fixture files, tenantMatchingInputs.test.ts). The
  sort-key ceiling is `String.fromCharCode(0xffff)`; no `\u` escape anywhere.
- Workspaces: app 561 files / 12033 passed / 1 skipped (staticSmoke
  diagnostic); dashboard 273 / 5672; e2e unit 22 / 509. All exit 0.
- Not run (the orchestrator's): root `npm test`, `npm run smoke`,
  `npm run e2e`.

## 7. Deviations from the plan text

- WL-S2-4..WL-S2-10 and G3 as in section 5 (all sanctioned by the
  WORKLIST). The tables.ts comment also reflows the plan's one 92-column
  TTL line and says "a pointer can outlive its run row (run# or rrun#) -
  both listings render that entry as expired" (the plan kept the old
  "its run# row - readers"), since the paragraph now covers both kinds.
- Commit bodies add one "WORKLIST: ..." line each; every subject is the
  plan's.
- The MERGE_HEAD check used the brief's `test -e "$(git rev-parse
  --git-path MERGE_HEAD)"` form (printed ok before every commit).
- S2.11 Step 1's `aiRunsRepo.ts` log shows two commits, not one (WL-S2-10;
  section 4 WI2).
- Extra verification beyond the plan: the WI2 mutation proof, the other 14
  seed suites, the e2e workspace unit run, and `aiRunsRepo.ts` in the lint
  list.
- No one-value test fix; every expected value matched the plan.

## 8. QUESTIONS

None.

## 9. Deploy note for the handback

From S2.2 on, a deployed stack refuses to start without
`ANTHROPIC_API_KEY`, whatever `AI_EXTRACTION_ENABLED` says (the ranking
driver is anthropic there). Spec 7 states production and hosted dev hold the
key today and the deploy checklist confirms it before deploy; this slice did
not (and may not) read either environment. Untrimmed input paths: none new -
every ranking variable is trimmed by `rankingEnvValue`
(config.ts:684-689) through its parse helpers; model ids are trimmed and
compared exactly; S2b's repositories take no typed input.

## 10. For S3 and later slices - what S2 shipped

- `app/src/repos/matchesRepo.ts`:
  - `RankingAnchorKind = 'unit' | 'tenant'` (structurally S3's `AnchorKind`),
    `MATCH_SCHEMA = 2`, `MatchReason { text; source }`,
    `MatchMissing { key?; text }`, `MatchFairHousingFlag { kind: 'unlawful' |
    'accommodation'; field }`, `MatchFingerprints { tenantCard; unitCard;
    pairHistory }`, `MatchRow` (tenantId, unitId, schema: 2, score, for,
    against, missing, failedRequirements, fairHousingFlags, stage: 1,
    rubricVersion, examplesVersion, promptFingerprint, model, runId,
    jobGeneration, computedAt, anchorSide, fingerprints, inputSnapshot,
    expires_at), `MatchPairKey { tenantId; unitId }`,
    `MatchWriteResult { written; unwritten: MatchPairKey[] }`.
  - `matchPairKey(t, u)` = `${t}#${u}`; `isCurrentMatchRow(item)`;
    `rankingExpiresAt(fromIso, ttlDays)` (epoch seconds; throws "not an ISO
    time"); `gzipBase64` / `gunzipBase64`; `encodeSnapshot(value)` (throws
    on a non-JSON value) / `decodeSnapshot(b64)`.
  - `createMatchesRepo(deps?)`: `putMatches(rows)` (dedupes a pair, last copy
    wins; 25 per BatchWrite; 5 attempts, 25 ms doubling; never throws on a
    DynamoDB failure; throws only on a non-schema-2 row; WARN lines carry
    counts only); `getPairs(keys, { requireComplete: true })` (the option is
    checked - anything else throws before any call; 100 keys per consistent
    BatchGet, 4 attempts; `IncompleteBatchReadError` from contactsRepo with
    table `matches`; a chunk whose request throws rethrows; legacy rows
    absent); `listByUnit(unitId)` (byUnit, eventually consistent) and
    `listByTenant(tenantId)` (base table, consistent) - Rankings page only.
- `app/src/repos/rankingRunsRepo.ts`, `createRankingRunsRepo(deps?)` =
  job & run & flag families:
  - Job: `getJob(kind, id, { consistent })`; `putJobClaim(claim)` ->
    `{ ok: true; job }` (the record as written) | `{ ok: false }`;
    `listQueued(limit)` / `listExpiredLeases(nowIso, limit)` (ONE byEntity
    Query page each, `Limit` = limit, oldest first, eventually consistent -
    no page walk); `claimQueued`, `takeOver`, `renewLease`,
    `markExpiredQueued`, `markLeaseFailed`, `updateJobProgress`,
    `finishJob` - each conditional on the generation; a lost condition
    answers `undefined` / `false`, never throws.
    `RankingJobProgress` = `{ poolSize?, batchCount?, batchDone? (one index),
    failedBatch? (one entry), notScored?: RankingNotScored[], runIds? }`;
    the list fields APPEND (parallel-safe); an empty patch - including
    `{ notScored: [] }` alone - THROWS "empty progress", so guard with
    `length > 0`. `RankingFailedBatch.failure` is a string: refusal | parse |
    truncated | timeout | driver | repo | error. Key builder
    `rankingJobItemId`; constants `RANKING_JOBS_QUEUED_ENTITY`,
    `RANKING_JOBS_RUNNING_ENTITY` (import them, G5).
  - Run: `putRun(input: RankingRunRecordInput)` (one TransactWrite: the run
    conditioned on a new id + the global and per-anchor pointers; a repeated
    run id throws; the 350 KB guard applied; returns the stored record);
    `markMatchesWritten(runId, { count, at })` -> boolean; `getRun(runId)`
    (plain GetItem, not a consistent read); `listRuns({ entityKey, from?,
    to?, cursor?, limit? })` (default 25, newest first, summaries only,
    `nextCursor`, `incomplete`). Types `RankingDirection`,
    `RankingRunFailure`, `RankingRunUsage`, `RankingRunHandle`,
    `RankingRunResult`, `RankingRunRecord`, `RankingRunSummary`,
    `RankingRunListEntry`, `RankingRunListPage`, `ListRankingRunsOptions`;
    builders `rankingRunItemId`, `rankingRunEntityKey(anchor?)`,
    `rankingRunSortKey`, `rankingPointerItemId`; `RANKING_RUNS_GLOBAL_ENTITY`,
    `RANKING_RUN_ITEM_MAX_BYTES`, `RANKING_RUN_DEFAULT_PAGE_SIZE`,
    `RANKING_RUN_SUMMARY_FIELDS`, `withRankingRunSizeGuard`,
    `rankingRunItemBytes`.
  - Flag: `putFlagIfAbsentOrClosed(UnlawfulFlagInput)` -> true (written:
    absent, or stored textHash differs) / false (open: same hash, first run
    kept); `getOpenCandidateFlags(unitId)` returns EVERY record of the unit
    (open or closed) sorted by field - the reader decides "open" (field on
    the current card, trimmed text hashing to `textHash`). Builders
    `unlawfulFlagItemId`, `unlawfulFlagEntityKey`; types
    `UnlawfulFlagRecord`, `UnlawfulFlagInput`. No TTL.
  - Callers compute every TTL with `rankingExpiresAt(from,
    config.rankingPairTtlDays)`; the repositories read no configuration.
- No harness fake exists yet for either repo (`twilioWebhookHarness.ts` has
  none; S5's PR27 helpers add `test/helpers/rankingRunsFake.ts`).
- The lean world has NO matches row now; every ranking fixture comes
  through the API (S7) or a test's own table.
- For S8: WL-S8-13's issue update should name `matchesRepo.getPairs`
  (matchesRepo.ts:219-245) and the run-listing walk `batchGetRuns` in
  rankingRunsRepo.ts (a copy of aiRunsRepo.ts:202-233); neither carries the
  `TODO(units-contacts-batchget-walk-duplicated)` marker (only S2.4's
  `getManyByIds` does). The `matches` table spec comment in tables.ts:239
  ("Volatile engine output; bulk-regenerated; stale rows TTL away.") is
  untouched and reads loosely for per-press rewrites - wording only.
- Baselines at 0a456d70: app 561 files / 12033 passed / 1 skipped; dashboard
  273 / 5672; e2e unit 22 / 509; root typecheck exit 0; eslint clean on all
  36 S2 code files.
