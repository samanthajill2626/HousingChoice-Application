# D2a findings - S2 head and S2.1-S2.5 (config, completeness, units/placements primitives)

- Reader: D2a (read-only delta reader, B2a build Phase 1).
- Scope: plan section 6, the S2 head (scope, contradictions C1-C12, cross-slice
  notes) and tasks S2.1-S2.5: every D19 variable, the parse rule, the model
  set, the price table, the production refusals, PR22 / PR30, the API-key
  requirement, B1's list `completeness` + dashboard mirror + drift test,
  `unitsRepo.getManyByIds`, `placementsRepo.hasActivePlacementForOtherTenant`.
  Watch items WI6, WI9.
- Read: plan lines 1-590 (binding) and 3697-6272; spec section 2, D1, D2.3,
  D3, D6, D19; plan-drafts/S2-findings.md; plan-adjudications (FB2/PR30,
  R2F6, R2F8). Code: app/src/lib/config.ts (whole), app + dashboard
  tenantMatchingInputs and both tests, unitsRepo.ts, placementsRepo.ts,
  contactsRepo.ts (IncompleteBatchReadError, batchGetByIds),
  test/helpers/twilioWebhookHarness.ts (fakes, makeWebhookHarness), the 16
  test files that name a production NODE_ENV, app/vitest.config.ts,
  lib/dynamo.ts, lib/devRoutes.ts, lib/logger.ts, worker.ts polls,
  scripts/dev.mjs, scripts/lib/devMode.mjs, scripts/e2e-session.mjs,
  scripts/db.mjs, the @anthropic-ai/sdk 0.129.0 effort type.
- Method beyond reading: every quoted anchor counted byte-exact against the
  tree by script; the S2.1/S2.2 config code, the S2.3 edits and the S2.4/S2.5
  repo code and tests replayed in scratch copies OUTSIDE the worktree, then
  type-checked with the repo's compiler options (strict,
  noUncheckedIndexedAccess, NodeNext), linted with the repo eslint config,
  and (config + completeness) run with the installed vitest.
- Verdict: build-ready as written - 0 BLOCKER, 0 MAJOR, 5 MINOR. Every
  anchor matches exactly once (S2.2 Step 1b after stripping the list
  indent), the new code compiles and lints clean, and every RED/GREEN claim
  and hand-worked value checked holds.

## Findings

### D2a-1 - MINOR - S2.2 Step 1b anchors carry 2 spaces of list indentation

- Plan: lines 4929-5102 (Task S2.2, Step 1b, all nine files).
- Code fact: the fences sit inside `- ` list items, so every raw line of
  each old/new block is indented 2 spaces more than the file. Plan 4948
  `    OAUTH_ALLOWED_DOMAINS: 'example.org',` / 4949 `  };` versus
  app/test/configEmail.test.ts:20-21 and configAiExtraction.test.ts:22-23
  (`  OAUTH_ALLOWED_DOMAINS: 'example.org',` / `};`).
- Problem: copied raw into an Edit old_string, none of the 11 anchors
  matches; a raw new_string would also land misindented.
- Correction: strip exactly 2 leading spaces from every line of each old and
  new block in Step 1b. After stripping, all 11 anchors occur exactly once
  (scripted count) and the edited config fixtures pass (see Checked).

### D2a-2 - MINOR - "key required only for extraction" comments go stale in S2.2

- Plan: Task S2.2 Step 3 (plan 5124-5197) updates only the file header (3a).
- Code fact: app/src/lib/config.ts:382-387 (`anthropicApiKey` doc: "Required
  only when extraction is ENABLED with the anthropic driver in production")
  and config.ts:883-886 (inline: "Required only when extraction is ENABLED
  with the anthropic driver in production ...").
- Problem: after S2.2 the key is required in production whatever extraction
  says (parseRankingConfig), so both comments state a false rule in S2's own
  file.
- Correction: in S2.2 Step 3 also reword both (ASCII), e.g. doc: "Required in
  production: the ranking driver is anthropic there (WP1 B2a,
  parseRankingConfig); the extraction gate below fires first when extraction
  is enabled. Never log." Inline: "The extraction gate (enabled + anthropic
  in production). parseRankingConfig requires the key in production
  regardless, and runs last." Same staleness sits in .env.dev.example:209-212
  and .env.prod.example:234-237 ("Required only when AI_EXTRACTION_ENABLED=true
  ..."); those are S8's files - tell S8 so its new "REQUIRED" wording does
  not sit under a contradicting comment.

### D2a-3 - MINOR - two definitions of "local DynamoDB" after PR30

- Plan: S2.1 isLocalDynamoTarget (plan 4526-4535) and the head's C10 guard 1
  (plan 3812-3813, "mounts only when a DYNAMODB_ENDPOINT is set").
- Code fact: PR30 treats only a loopback host (localhost / 127.0.0.1 /
  [::1]) as local. The existing predicates treat ANY set endpoint as DynamoDB
  Local: lib/devRoutes.ts:18 (`!config.dynamodbEndpoint`), lib/logger.ts:85
  (devLogTailEnabled), scripts/dev.mjs:113-116 (liveMode),
  scripts/lib/devMode.mjs:43.
- Problem: an endpoint that names DynamoDB Local by a non-loopback host (a
  docker service name, a LAN IP, 0.0.0.0) boots with the anthropic driver and
  poll off and REFUSES RANKING_DRIVER=fake/console, while the dev router still
  mounts. No lane does this today (e2e-session.mjs:144 with db.mjs:42 =
  http://localhost:8000; e2e-stop.mjs:117 = 127.0.0.1), and the divergence
  fails safe.
- Correction: none in code. Record in the S2 report (and S8's RUNBOOK dev
  modes caveat) that the hermetic lanes must use a loopback endpoint. Do not
  "align" devRoutes or the logger gate in S2.

### D2a-4 - MINOR - head cross-slice note contradicts PR39

- Plan: line 3922-3923 ("S8 owns the env example files and RUNBOOK lines for
  the 21 variables (uncommented with defaults ...)").
- Code fact / ruling: PR39 (plan 525-536) writes RANKING_DRIVER and
  RANKING_WORKER_POLL as COMMENTS in .env.example and RANKING_WORKER_POLL as a
  comment in .env.dev.example (PR30's real-tables safety).
- Problem: ruling drift in a note; S2 builds nothing from it.
- Correction: read the note as "per PR39".

### D2a-5 - MINOR - getManyByIds error counts are imprecise on a multi-chunk read

- Plan: Task S2.4 Step 3b (plan 5882-5898).
- Code fact: the plan throws after the FIRST incomplete chunk with
  `IncompleteBatchReadError(keys.length, uniqueIds.length, 'units')`. B1's
  getDisplaysByIds (unitsRepo.ts:1300-1335) and contactsRepo batchGetByIds
  (contactsRepo.ts:1075-1112) walk every chunk and report the summed count.
- Problem: with 250 ids and an incomplete first chunk the message reads "1 of
  250 keys unread" while 150 keys were never attempted. Behavior
  (complete-or-nothing, throw) is right; only the count misleads a reader of
  the log.
- Correction (optional): keep walking and throw after the loop with the
  summed count (the B1 shape; a thrown chunk still rethrows at once), or pass
  the chunk size as `requested`. The plan's tests (3 ids, one chunk) pass
  either way.

## Checked and fine

- Anchors (scripted, LF files): S2.1 3a/3b/3c/3d-insertion-line/3e (x2),
  S2.2 3a/3b and the 11 Step 1b anchors, S2.3 1a/1b (x2)/3a (x5)/3b, S2.4
  3a/3b/3c, S2.5 3a/3b/3c (x2) - each occurs exactly once.
- S2.1+S2.2 replay: the plan's configRanking.test.ts (92 cases) passes
  against the plan's config.ts; against the S2.1-only implementation exactly
  the 10 cases Step 2 names fail (the PINs, local-tables and both "boots"
  cases pass). tsc (repo options) and eslint clean for config.ts and the test.
- Hand-worked values: all 21 D19 defaults and names = PR4 / spec D19; price
  table {sonnet 2/10, opus 4/20} = spec D6 and the claude-api model table;
  isLocalDynamoTarget cases (new URL('http://[::1]:8000').hostname is
  '[::1]'); JSON.parse keeps "__proto__" as an own key, refused by the model-id
  regex; positive-integer, enum, boolean, TTL (6 < 7 refused, 7 accepted)
  and price-table refusal messages all match their regexes.
- C6: @anthropic-ai/sdk 0.129.0 messages.d.ts:2115 effort union is exactly
  low|medium|high|xhigh|max; both supported models take all five with
  adaptive thinking.
- WI6: production refuses fake/console and poll off, requires the key
  whatever AI_EXTRACTION_ENABLED says, ANTHROPIC_API_BASE_URL still refused
  (config.ts:900-907, fires earlier), extraction key check fires first when
  enabled (config.ts:887-894); ranking rules run last (after CF, job
  delivery, auth, messaging, VAPID).
- Production fixtures: exactly 16 test files name a production NODE_ENV
  (the Step 4 list is right). The NINE that must boot are correct:
  configAiExtraction, configEmail, configGroupIdentityExcludedNumbers,
  configRelayLiveProvisioning, app, auth, messaging, twilioSmsWebhook,
  webPushConfig. Scratch replay of the 11 config*.test.ts files against the
  S2.2 config: 8 cases fail unpatched (all in the 4 config fixtures), 0 after
  the plan's edits; configMediaS3Endpoint, configTwilioApiBaseUrl and the
  rest pass unpatched (earlier throws). devGating, devLogtail,
  requestLoggerMask, sesWebhook, twilioJsonSignature need nothing.
- AppConfig breakage at a distance: tsc over app src+test+scripts with the
  21 fields added as required -> the ONLY error is loadConfig's return
  (config.ts:1303), fixed by `...ranking`. No AppConfig literal elsewhere;
  the `as AppConfig` partial casts (poolNumbers, relayWarm, groupSend,
  contactTimeline, ...) are unaffected.
- Repo breakage at a distance: tsc with the two methods added -> the only
  implementers that stop compiling are unitsRepo.ts:1253, placementsRepo.ts:284
  and the harness fakes twilioWebhookHarness.ts:2969, :3484 - all four
  touched by S2.4/S2.5. placementNudges.test.ts fakes are `as unknown as`.
- S2.4/S2.5 replay: the plan's getManyByIds and
  hasActivePlacementForOtherTenant compile clean in copies of the real repos;
  the four new test files compile clean against the extended interfaces and
  lint clean. Names verified: IncompleteBatchReadError(unprocessed,
  requested, table) and its message format (contactsRepo.ts:686-700);
  BatchGetCommand and IncompleteBatchReadError already imported in unitsRepo
  (:20-29, :50); createLogCapture().atLevel; createLogger({ destination });
  createFakeWorld with world.units / unitsRepo / placementsRepo;
  TERMINAL_STAGES re-exported by placementsRepo (:54, ReadonlySet<PlacementStage>)
  and not already imported by the harness; queryIndex sends ':v' and passes
  ExclusiveStartKey through (placementsRepo.ts:260-282); all stage literals
  valid; units.create / softDelete(unitId, at) / getById(id, { consistentRead });
  the integration idiom matches unitsRepo.integration.test.ts.
- WI9: getDisplaysByIds and its fake are untouched; the new method is
  inserted after them; its TODO slug's issue exists.
- S2.3 replay: Step 1 -> the app case and "carries nothing else" red (first
  mirror case green); after 3a -> both mirror cases red; after 3b -> 18/18
  green; tsc clean. No consumer compares or spreads whole entries
  (EligibilityIntakeCard, ContactEditForm, suggestionTargets, AiRunDetail,
  extraction prompt/schema/apply/runTypes, adapters/extraction, the probe,
  suggestionResolution), so the extraction prompt fingerprint is unchanged.
- PR30 per lane: e2e lane (e2e-session.mjs:144, db.mjs:42 localhost) ->
  console/on; npm test (vitest.config.ts env and harness defaults carry no
  endpoint) -> anthropic/off; live dev (dev.mjs:113-116) -> anthropic/off;
  local dev (devMode.mjs:46 localhost) -> console/on. Note: createDynamoClient
  calls loadConfig(process.env) (lib/dynamo.ts:62), so every integration
  suite, the two new ones included, parses the ranking variables from the
  shell; a clean shell gets the real-tables defaults and nothing throws.
- Keep the harness default env (twilioWebhookHarness.ts:5686-5702) free of
  ANTHROPIC_API_KEY: C10 guard 3 relies on harness configs having no key.
  The plan's choice (key only in twilioSmsWebhook's production harness env)
  is right; the harness comment at :5693-5694 can stay.
- Head facts: C1 (lean.ts:36-38, :445-457, :454), C2 (config.ts:403-410,
  630-632, 641; worker.ts startPoll at 352/388/436/508/526/534), C3
  (tables.ts:625-644; aiRunsRepo inflight#), C4 (aiRuns.ts:228-233), C5
  (config.ts:887-894), C10 (dev.mjs:113-116, devRoutes.ts:18) all accurate.
- Gate traps: eslint is clean today on every pre-existing file S2.1-S2.5
  touches (so any gate-5 error is new); no non-ASCII byte in plan lines
  3697-6272; the worktree git dir for the MERGE_HEAD check exists.
