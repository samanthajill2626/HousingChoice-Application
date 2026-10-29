# E1 findings - whole-app invariant sweep (writers and readers)

- Reader: E1 (read-only, Phase 1 delta reader).
- Scope: the seven whole-app surfaces of the E1 assignment - the `matches`
  table, the AI runs table's new families, a contact's `notes` /
  `staff_notes` / `notes_updated_at`, the event bus, configuration, the
  interfaces the plan widens, and the worker poll and shutdown. The sweep
  grepped the tree (app, dashboard, e2e, scripts, fake-twilio, infra), not
  the plan, then checked which sites the plan names.
- Read: plan lines 1-590 (sections 0-4, WI1-WI22, PR1-PR45) in full; spec
  section 2 (lines 49-133) and section 5 (lines 1152-1201). Plan slices
  opened only where a surface lands: S1 C1-C11 and S1.6-S1.11 (662-822,
  2003-2479, 3519-3656); S2 scope / C1-C12 / cross-slice notes, S2.1 call
  site, S2.2, S2.7 and the S2.9 comment (3697-3996, 4725-5243, 7055-7197,
  9290-9345); S5.1, S5.7 `runDueRankings`, S5.9 (21909-22221, 25850-25935,
  26148-26575); S6.3 router construction (28215-28570); S7.1 endpoints,
  S7.11, S7.13 (30313-30870, 35003-35206, 35376-35456); S8.6 (38492-38842).
- Verdict: the seven named surfaces are covered or safe as the tree stands;
  the sweep found two UNPLANNED test pins in the e2e workspace's unit suite
  (part of `npm test`, gate 2) that S7's dashboard edits will turn red, plus
  three comment-drift and residual notes.

Counts: BLOCKER 0, MAJOR 2, MINOR 3.

## Findings

### E1-1 - MAJOR - S7.1 adds a dashboard mutation the e2e mutation catalog does not list

- Plan: S7.1 Step 3 (b), lines 30775-30787 (`startRanking` in
  `dashboard/src/api/endpoints.ts`); S7.13 Step 3, lines 35398-35407.
- Code fact: `e2e/performance/mutationCatalog.test.ts:310-312, 364-390`
  scans EVERY non-test `.ts/.tsx` under `dashboard/src` for `request(...)`
  calls with a non-GET method and requires the discovered set to equal
  `DASHBOARD_MUTATION_CATALOG` (`e2e/performance/mutationCatalog.ts:38-179`)
  exactly, and pins the count at 122 (`mutationCatalog.test.ts:384`). The
  suite runs under root `npm test` (`package.json` "test" runs every
  workspace; `e2e/package.json` "test": "vitest run";
  `e2e/vitest.config.ts` includes `performance/**/*.test.ts`).
- Problem: `startRanking` is a new `request:POST`; simulated against the
  installed TypeScript AST it is discovered as
  `dashboard/src/api/endpoints.ts :: startRanking :: request:POST ::
  /api/rankings/:kind/:anchorId/rank` (the placeholders are the dashboard's
  variable names). Both the fingerprint equality and the 122 count fail, so
  gate 2 is red from S7.1 on. The plan never names the e2e/performance
  files, and S7.13 Step 3's triage rule ("red with no connection to S7:
  record") invites the builder to record it rather than fix it, which
  leaves S9's gate 2 red.
- Correction (S7.1 owns it; add both files to PR27's S7 allowances): add
  `  entry(ENDPOINTS, 'startRanking', 'request:POST', '/api/rankings/:kind/:anchorId/rank'),`
  to `DASHBOARD_MUTATION_CATALOG` (for example after the `createRelayGroup`
  line, `mutationCatalog.ts:177`); in `mutationCatalog.test.ts:384` change
  `toHaveLength(122)` to `toHaveLength(123)` and extend the count comment
  above it with `+ startRanking (WP1 B2a: POST
  /api/rankings/:anchorKind/:anchorId/rank)`. Defaults (`workflow_only`,
  `first_party_api`) are right: the firewall derives its paths from the
  catalog (`e2e/performance/firewall.ts:188-207`). Verify with
  `cd W:/tmp/wp1-b2-ranking-engine/e2e; npx vitest run performance/mutationCatalog.test.ts performance/firewall.test.ts`.
  Exact text: `.superpowers/sdd/research/E1-reference.md` R1.

### E1-2 - MAJOR - S7.11's new `rankings` route breaks the perf profiler's App-route pin

- Plan: S7.11 Step 3 (b), lines 35139-35173 (`<Route path="rankings">` in
  `dashboard/src/App.tsx`); S7.13 Step 3 (35398-35407).
- Code fact: `e2e/performance/routes.test.ts:353-421` ("mechanically matches
  App route elements") regex-reads every `<Route ... path="...">` in
  `App.tsx`, maps only a FIXED list of settings children
  (`routes.test.ts:378-388`: team ... ai-runs, numbers, organizations) to
  `/settings/...`, and requires every remaining path to be a registered
  profiler surface or in its `excluded` set (`routes.test.ts:396-417`).
  Same `npm test` workspace as E1-1.
- Problem: simulated on the real `App.tsx` with S7.11's insertion (anchor
  found exactly once), the only new relative path is `/rankings`; it is not
  in the settings-children list and not excluded, so the `toEqual` at
  `routes.test.ts:416-417` fails. The precedent for a new settings tab
  (`/settings/organizations`) is an exclusion plus an issue
  (`routes.test.ts:403-407`, the `TODO(perf-pages-settings-organizations-surface)`
  block at `e2e/performance/routes.ts:679-692`,
  `docs/issues/perf-pages-settings-organizations-surface.md`).
- Correction (S7.11 owns the two e2e/performance edits - add them to PR27's
  S7 allowances; S8.10 owns the issue file): add `'/rankings',` after
  `'/ai-runs',` in the settings-children list; add `'/settings/rankings',`
  to `excluded` with a two-line comment naming
  `perf-pages-settings-rankings-surface`; add the matching `TODO(...)`
  block to `e2e/performance/routes.ts` beside the organizations one; S8.10
  files `docs/issues/perf-pages-settings-rankings-surface.md` from
  `_TEMPLATE.md`. Verify with
  `cd W:/tmp/wp1-b2-ranking-engine/e2e; npx vitest run performance/routes.test.ts`.
  Exact text: `E1-reference.md` R2.

### E1-3 - MINOR - poll-count comments in worker.ts and pollLoop.ts go stale

- Plan: S5.9 Step 3 (worker block, lines 26400-26442); S2 C2 (3742-3748)
  rewrites only the config.ts comments.
- Code fact: `app/src/worker.ts:286-291` ("so the six shared-cadence call
  sites stay one line each"); `app/src/jobs/pollLoop.ts:4-15` ("the
  worker's five poll loops ... seven loops today").
- Problem: S5.9 adds a seventh shared-cadence `startPoll` and an eighth
  loop; neither comment is touched. No test reads them.
- Correction: in S5.9, "six" -> "seven" at worker.ts:290 and "seven loops
  today" -> "eight loops today" (naming the ranking poll) at pollLoop.ts:15.
  Comment-only; ASCII.

### E1-4 - MINOR - aiRunsRepo.ts header comment contradicts the new byEntity rows

- Plan: S2.9 Step 3c (9290-9345) rewrites the `ai_runs` comment in
  `lib/tables.ts` only.
- Code fact: `app/src/repos/aiRunsRepo.ts:1-2` - "pointer rows are the only
  rows indexed by byEntity".
- Problem: after S2.8 / S2.10, queued and running `rjob#` rows and `uflag#`
  rows carry `entityKey` / `sortKey` in the same table, so the header is
  false (the tables.ts rewrite says so correctly).
- Correction: in S2.9 (or S1.4, which already edits this file), make the
  header say the extraction rows here are run records and pointers, and
  that the table also holds ranking job and flag rows indexed by byEntity
  under their own partitions (rankingRunsRepo.ts; see lib/tables.ts).

### E1-5 - MINOR - worker shutdown never stops the ranking poll; in-flight calls die unlogged

- Plan: S5.9 worker block (26413-26442); PR36 ("never loses a paid call")
  and spec D7's takeover-once "enough to cover a redeploy" (spec 683-687).
- Code fact: `app/src/worker.ts:590-616` stops only the SQS consumers and
  then `process.exit(0)` (10 s cap); `app/src/jobs/pollLoop.ts:64-68`
  intervals are unref'd and never cleared.
- Problem: on every deploy (`docker compose up -d`, `scripts/deploy.mjs`)
  each running ranking job is killed mid-batch; its lease expiry and the
  single takeover recover it (as designed), but up to
  `RANKING_MAX_CONCURRENT_JOBS x RANKING_BATCH_CONCURRENCY` (8) in-flight
  model calls are billed and never logged, and a tick inside the drain
  window can still claim a queued job. The extraction poll has the same
  shape (precedent), so no code change is owed.
- Correction: no code; the S5 report and S8's RUNBOOK ranking section state
  the residual ("a deploy during a ranking spends that job's one takeover
  and may leave up to 8 in-flight calls unlogged").

## Surface inventory (file:line, plan coverage, verdict for anything uncovered)

Legend: W writer, R reader, D deleter. "Plan" = the plan names the file or
the site; (a) safe as is, (b) needs a plan addition, (c) invariant break.

### 1. `matches` table

| Site | Kind | Plan | Verdict |
|---|---|---|---|
| `app/src/lib/tables.ts:238-252` (table spec, byUnit, TTL) | def | S2.9 note | unchanged |
| `app/src/lib/seed/lean.ts:36-38, 445-457` (legacy row + constant) | W | S2.7 | covered |
| `app/src/lib/seed/index.ts:117-121, 160-167` (seedAll Put loop over SEED keys) | W | no | (a) generic: after S2.7 no `matches` key exists |
| `app/scripts/db-seed.ts:7` (header) | doc | S2.7 | covered |
| `app/src/lib/devReset.ts:94-104` (clears every TABLES base) | D | S2.11 diff | (a) hermetic-only guard `:86-91` |
| `app/src/lib/performanceSeed.ts` resetPerformanceData -> resetLocalData | D | WI2 | (a) |
| `scripts/wipe-dev-data.mjs:116-119, 504-510` (hosted-dev wipe of every tfvars table) | D | no | (a) human-run; closing restart; a live job's generation read finds no record and exits |
| `app/scripts/db-create.ts:35-62`, `db-update-gsis.ts:168`, `gen-tables.ts:59` | def | no | (a) no table change |
| `infra/envs/{dev,prod}/tables.auto.tfvars.json:300` | def | spec 7 | (a) unchanged |
| `infra/modules/ec2/main.tf:42-61` (IAM: every table ARN + `/index/*`, BatchWriteItem, ConditionCheckItem) | perm | no | (a) the new writes are already permitted; spec 7 "no infra" holds |
| `app/test/tables.test.ts:26, 221, 324`; `app/test/genTables.test.ts:24, 192, 208, 243, 247` | R (pins) | no | (a) schema unchanged |
| `app/test/seedProfile.integration.test.ts:43-50` | R | S2.7 | (a) derives from SEED |
| any other reader (`fit_score`, `approval_likelihood`, `tableName('matches')`) | R | - | none in app, dashboard, e2e, scripts, fake-twilio |

### 2. AI runs table (`rjob#`, `rrun#`, `ptr#rankings#...`, `uflag#`)

| Site | Kind | Plan | Verdict |
|---|---|---|---|
| `aiRunsRepo.ts:160-165` key builders; `:297-302` getRun (`run#`); `:304-381` listByEntity (one `entityKey` partition + BatchGet `run#`); `:392-501` setVerdict (`run#` / `inflight#`) | R/W | WI2, S2.9 | covered; no partition shared with `rankings#*`, `rankjobs#*`, `uflags#*` |
| `routes/aiRuns.ts:30-31` SCOPE_PATTERN, `:139-226` list, `:228-273` detail | R | WI2, S2.9 | covered (the pattern refuses every ranking entityKey) |
| other AiRunsRepo users: `jobs/extraction.ts:139`, `routes/contacts.ts:1092`, `routes/suggestions.ts:97`, `services/caseworkerConversion.ts:185`, `services/contactClassification.ts:84, 175`, `services/suggestionResolution.ts:474`, `routes/api.ts:667`, `routes/dev.ts:752`, `worker.ts:476` | R/W | no | (a) extraction keys only |
| `jobs/journalSweep.ts:12-15` (Scan) | R | WI2 | (a) scans `ai_extraction` resolve# rows, not `ai_runs` |
| `routes/dev.ts:355, 365` reseeds | D | WI2 | (a) clear-all, no prefix sweep |
| `lib/performanceSeed.ts:163` readers; `performanceSeed.integration.test.ts:315` (`listByEntity('global')`) | R | WI2 | (a) |
| every other Scan in app/src, app/scripts, scripts | R | no | (a) all target other tables (devReset and wipe-dev-data delete by key schema) |
| byEntity consumers: `aiRunsRepo.ts:344`, `aiRunsRepo.integration.test.ts:309-377` | R | no | (a) own random-prefix table per file |
| dashboard AI run log, `e2e/performance/routes.ts:327` | R | no | (a) through the scoped API only |
| TTL sweeps in app code | - | - | none exist (DynamoDB TTL only) |
| `aiRunsRepo.ts:1-2` header | doc | no | E1-4 |

### 3. Contact `notes`, `staff_notes`, `notes_updated_at`

| Site | Kind | Plan | Verdict |
|---|---|---|---|
| `routes/contacts.ts:645-649` (PATCH parse), `:1950-1952` stamp neighbour | W | S1.6, S1.8 | covered |
| `routes/contacts.ts:921-923, 1242` (manual create) | W | S1.6 | covered |
| `services/extraction/apply.ts:958` (append) | W | S1.7 | covered |
| `lib/import/apply.ts:1196-1198` (contact upsert, new and re-import) | W | S1.7 | covered |
| `lib/import/apply.ts:1558-1560` | W | S1.11 table | a UNIT's notes, not a contact |
| `routes/public.ts:617-647, 684`; `routes/unmatchedEmail.ts:465-471`; `services/contactCapture.ts:111`; `services/groupConvert.ts:337-347`; `services/groupMembers.ts:155`; `services/caseworkerConversion.ts:533-552, 592`; `services/statusTransition.ts:371, 650`; `webhooks/twilio.ts:1210, 1251`; `webhooks/voice.ts:748`; `routes/dev.ts:1342` | W (other fields) | S1.11 table | (a) none writes `notes` |
| seeds (lean, cast, matrix, live, performance), app/scripts, fake-twilio | W | S1.7 pin, S1.11 | (a) none writes a contact's `notes` |
| `routes/contacts.ts:655-659, 2007-2010, 2036-2045` (staff_notes + guard) | W/R | S1.8 | covered |
| GET `routes/contacts.ts:1319-1321` (raw item spread) | R | no | (a) the stamp reaches the form with no serializer change |
| `jobs/extraction.ts:163-205` toProfile (explicit picks) | R | no | (a) the stamp never reaches the extraction prompt |
| `services/possibleCaseworkers.ts:82`, `lib/caseworkers.ts:75-77` | R | S1.9 | (a) text only |
| audit `contact_updated` fields = `parsed.changedFields` | R | S1.6 test | (a) stamp not listed |
| exports / CSV of contacts; code iterating all contact keys | R | - | none exist |
| client round-trip: `ContactEditForm.tsx:368-518, 608` (diff-built patch), `ContactDetail.tsx:755, 899`, `StaffNotesCard.tsx:124`, `ConsentCaptureModal.tsx:52`, every e2e PATCH/POST body | W (client) | S1.10 | (a) explicit keys only, so no client ever echoes `notes_updated_at` into the new 400 |

### 4. Event bus

| Site | Kind | Plan | Verdict |
|---|---|---|---|
| `lib/events.ts:343-379` (map, exhaustive `Record<AppEventName, true>`, names) | def | S5.1 | covered |
| `lib/eventBridge.ts:45`, `routes/internal.ts:34` | R | no | (a) iterate APP_EVENT_NAMES |
| `routes/api.ts:2760-2836` SSE (hand-registered, no role filter) | R | S5.1 | covered |
| `eventBridge.test.ts:42-46` (count 10), `sse.test.ts:221-249` | pin | S5.1 | covered |
| `twilioWebhookHarness.ts:632-644` recorder; `internalRoute.test.ts:64`; e2e `event-bridge.spec.ts:157` | R | no | (a) named events / bogus names only |
| `dashboard/src/api/EventStreamProvider.tsx:180-239`; `useEventStream.test.tsx` | R | S7.2 | covered (tests count instances, not events) |

### 5. Configuration

| Site | Kind | Plan | Verdict |
|---|---|---|---|
| production-boot fixtures: the 16 files the S2.2 grep lists (re-run: same 16 at HEAD; no test sets NODE_ENV through a variable) | R | S2.2 | covered; all eleven S2.2 anchors occur exactly once (after removing the 2-space list-fence indent) |
| hand-built configs: `jobQueueWiring.test.ts:22`, `poolNumbers.test.ts:304-318`, `relayWarm.test.ts:42-52`, `systemStatus.service.test.ts:29-37`, `twilioEventsWebhook.test.ts:180-188`, `voiceTranscriptJobs.test.ts:49-55`, `sesWebhook.test.ts:93`, `groupSend.test.ts:237`, `groupConversationsAdapter.test.ts:725-990`, `backfillMediaContentTypes.test.ts:433-467`, `contactTimeline.test.ts:1654` | R | no | (a) `as AppConfig` casts or loadConfig spreads; new required fields break none |
| `index.ts` / `worker.ts` loadConfig; `docker-compose.yml:25-28, 49-52` (both NODE_ENV production, one `.env`) | boot | spec 7, S8 | (a) both processes need the key; both stacks hold it |
| operator scripts on real tables: `import-apply.ts:126-135, 334, 510`; `backfill-media-content-types.ts:758` | boot | S8 RUNBOOK line 39205 | (a) PR30 defaults (anthropic, poll off, no key outside production) |
| `scripts/secrets.mjs:139-168` (drift warning, empty values refused); `secretsSync.mjs`; `scripts/lib/secretsCore.mjs:11-29` denylist | R | PR35, PR39 | (a) no new key is denylisted |
| `scripts/deploy.mjs:527-541` (hydrates the whole SSM path) | R | S8 | (a) no key allowlist; health gate catches a boot failure |
| `scripts/smoke-dist.mjs` | - | no | (a) resolution only, literal dynamic imports included; boots nothing |
| `app/vitest.config.ts` env, `makeWebhookHarness` env | R | S2 C10 | (a) no DYNAMODB_ENDPOINT, so PR30's test-time defaults hold as C10 says |

### 6. Widened interfaces

| Interface | Implementers / literals | Plan | Verdict |
|---|---|---|---|
| `UnitsRepo` (`unitsRepo.ts:666`) | real repo; `twilioWebhookHarness.ts:2969`; `placementNudges.test.ts:176-182` (cast) | S2.4 | covered / (a) |
| `PlacementsRepo` | real repo; `twilioWebhookHarness.ts:3484`; `placementNudges.test.ts:164` (cast) | S2.5 | covered / (a) |
| `TenantMatchingInput` (+`completeness`) | `lib/tenantMatchingInputs.ts:78` and dashboard mirror `:44` (`satisfies`); drift test MIRRORED list | S2.3 | covered; every consumer reads named fields (prompt.ts:14-20, 95; schema.ts:39; runTypes.ts:16, 40; apply.ts:124; jobs/extraction.ts:188; suggestionResolution.ts:166; adapters/extraction.ts:123) |
| `AiRunRecord` (+`notesDuplicate?`) | optional field; no `keyof` maps | S1.4 | (a) |
| `ApplyOutcome` (+`notesDuplicate`) | only `apply.ts:973-977` builds it; `extractionApply.test.ts:217, 278-285` toEqual | S1.4 | covered |
| `ApiRouterDeps`, `DevRouterDeps` | optional seams; default rankings router builds no driver (plan 28526-28553) | S5.9, S6 | (a) |
| `AppEventMap` | one exhaustive Record (`events.ts:365`); no `never`-default switch | S5.1 | covered |

### 7. Worker poll and shutdown

| Site | Plan | Verdict |
|---|---|---|
| `worker.ts:292-298` startPoll wrapper; block after `:508-509` | S5.9 | covered |
| `jobQueueWiring.test.ts:133-148` (auto-close block cut by `\n{\n` ... `\n}\n` around its own call) | no | (a) the new `if (...) {` block sits earlier and is not a bare `{` line |
| tests counting polls | - | none (pollLoop.test.ts tests the function) |
| `worker.ts:590-616` shutdown | no | E1-5 (record only) |
| smoke gate | - | (a) |
| comments `worker.ts:286-291`, `pollLoop.ts:4-15` | no | E1-3 |

## Checked and fine

- `infra/modules/cloudfront` guard (`app/test/cloudfrontBehaviors.test.ts:131-143`) reads only `app.use('/...')` in app.ts; the rankings routers mount inside `/api` (all-methods behavior) and the tick under `/__dev` (exempt).
- `app/test/setup/dynamoAccessKeyGuard.test.ts:365-415`: every plan test file that calls `ensureTable` (S2.4-S2.10, S5.8, S6 read budget) mints a `randomUUID` prefix; the S3.11 `hc-test-assemble-` prefix is on a stub doc with no `ensureTable`.
- ESLint `readFileSync` ban for `app/src` (`eslint.config.mjs`): no plan `app/src` file uses it (only tests do).
- `e2e/support/viewport.guard.test.ts` and the other e2e support guards: no plan e2e file uses the banned idiom.
- `e2e/tests/dashboard-next/settings.spec.ts:38, 219-221` name tabs explicitly; no tab counts; `settingsTabs.ts` ids are `string` (no exhaustive map).
- `e2e/performance/firewall.test.ts:115` and `collect.test.ts:365-382` are derived or static ledgers; no count changes from S7 beyond E1-1 / E1-2.
- `dashboard/src/api/types.ts` is also compiled by the APP test tsconfig (`app/test/contactTimeline.test.ts:43`) and the e2e tsconfig (`e2e/tests/tour-roster.spec.ts:65`); S7.1's added types import nothing and use no DOM-only type.
- `ContactEditForm.tsx:188` captures `base` at open, so an SSE re-read of the contact cannot silently re-base the Notes stamp the form sends.
- No route-inventory test, middleware-order test, or `RateLimit` routeKey union exists (`middleware/rateLimit.ts:243` is `string`).
- Playwright runs `workers: 1`, `fullyParallel: false` (`e2e/playwright.config.ts:140-141`): a reseed cannot race another spec's ranking tick.
- `scripts/e2e-session.mjs:140-144` gives both children `localhost:8000` unless overridden; every DynamoDB endpoint in the repo is localhost / 127.0.0.1, so PR30's local-target rule keeps `RANKING_DRIVER=fake` legal on the lane.
