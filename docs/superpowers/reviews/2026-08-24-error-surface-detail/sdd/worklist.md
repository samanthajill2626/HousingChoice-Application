# WORKLIST - error-surface-detail (research-merged, 2026-08-24)

Authority order for implementers: (1) this worklist where it corrects the plan,
(2) the plan docs/superpowers/plans/2026-08-24-error-surface-detail.md,
(3) the spec docs/superpowers/specs/2026-08-24-error-surface-detail-design.md.
Research verified every plan anchor against the live tree; the plan is accurate
EXCEPT the corrections below. Do not re-verify what this file states.

## GLOBAL FACTS (verified)

- Worktree W:\tmp\error-surface-detail, branch feat/error-surface-detail. Tree code == plan baseline.
- tsconfig: strict, noUncheckedIndexedAccess TRUE (the plan's `!` index assertions are REQUIRED),
  exactOptionalPropertyTypes OFF, app+e2e are NodeNext (.js suffix on relative imports MANDATORY),
  dashboard is bundler but the .js-suffix convention is universal - follow it.
- Lint is NOT a gate. no-floating-promises and consistent-type-imports are OFF. Do not add lint churn.
- app typecheck = 3 tsc projects incl. test/. dashboard tests: jsdom, globals:true, clock pinned
  to 2026-07-01T12:00:00Z in src/test/setup.ts, css:false (CSS-module class names are NOT real in
  tests - assert on text/roles, never styles.*).
- Installed @aws-sdk/client-cloudwatch-logs@3.1073.0 (root node_modules, hoisted) EXPORTS
  GetLogRecordCommand. Input { logRecordPointer }, output { logRecord?: Record<string,string> }.
- DynamoDB Local container hc-dynamodb-local is UP. NEVER run npm run db:start, db:stop, or any
  docker command - sibling worktrees share the container.
- Config file is app/src/lib/config.ts (NOT app/src/config.ts). Keys errorLogGroupName /
  workerLogGroupName / systemLogGroupName at :526-528. AppConfig imported in cloudwatch.ts:27
  already. loadConfig(env?: NodeJS.ProcessEnv).
- isLocalEnv is PRIVATE in systemStatus.ts:137-139: appEnv==='local' || messagingDriver==='console'.
- projectErrorEvent is currently NOT exported (plain function, cloudwatch.ts:123). Plan exports it - additive, fine.
- classifyCloudWatchError EXPORTED from cloudwatch.ts:180, already imported by systemStatus.ts:24.
- parseInsightsTimestamp exists, PRIVATE, cloudwatch.ts:154-158, (value: string | undefined) => number.
- PINO_ERROR_INSIGHTS_FILTER exported at cloudwatch.ts:59; already imported by systemStatus.service.test.ts:23.
- createCloudWatchClient deps { config, cloudwatch?, logs? }; local bindings `cw` and `logs` (:208-211).
- Service factory is createSystemStatusService (systemStatus.ts:152) with deps { config, logger?, cloudwatch? }.
  Test file defines makeService at systemStatus.service.test.ts:52-54.
- system.routes.test.ts imports: `import request from 'supertest'`; TEST_ADMIN_COOKIE /
  TEST_SESSION_COOKIE from './helpers/authSession.js'; makeWebhookHarness + ORIGIN_SECRET from
  './helpers/twilioWebhookHarness.js'; `const SECRET = ORIGIN_SECRET;` at :15. Harness accepts
  systemStatusService?: SystemStatusService injection. Its env pins MESSAGING_DRIVER 'console' (= local env).
- COMMIT DISCIPLINE: bare `git status` before every commit; stage EXPLICIT paths only (never -A);
  trailer `Co-Authored-By: <your model name per your own system prompt> <noreply@anthropic.com>`.
- ASCII ONLY in every new/touched line.

## SLICE A (T1 jobs message, T2 express handler, T3 pollRunId) - corrections

- A1. jobs.test.ts has NO file-level afterEach(_resetForTests) - the two existing resets are inside
  describe blocks (:49-51, :215-217). WRAP the new tests in a NEW describe with
  `beforeEach(() => { _resetForTests(); });` and `afterEach(() => { _resetForTests(); });`
  or handler re-registration throws and the logger/queue swaps leak.
- A2. jobs.test.ts must ADD type imports: `import { type Logger } from '../src/lib/logger.js';`
  `import { type JobEnvelope } from '../src/jobs/types.js';`
  `import { type OutboundQueueAdapter } from '../src/adapters/scheduler.js';`
  (OutboundQueueAdapter and JobEnvelope are NOT exported from jobs.ts.)
- A3. errors.ts holds FIVE U+2014 em-dashes: :116 ('uncaughtException - exiting' message string),
  :133 x2 (docblock), :149 (comment), :154 (the URIError message). The plan's Task 2 Step 4 ASCII
  check `LC_ALL=C tr -d '\11\12\15\40-\176' < src/lib/errors.ts | wc -c` expects 0 for the WHOLE
  file. ASCII-ise ALL FIVE (em-dash -> ' - ' or '-' as reads naturally). Nothing asserts any of
  these literals (verified: zero test hits for the handler messages; grep 'uncaughtException' in
  app/test to confirm before changing :116 - if any test asserts it, STOP and report).
- A4. The three branches currently share the field set { err: toError(err), method: req.method,
  path: req.path } - KEEP those structured fields unchanged in all three.
- A5. dispatchJob envelope in T1's test: shape verified OK against JobEnvelope (v: 1 literal).
  The catch to modify is jobs.ts:324-335; ONLY the message arg (:332) changes.
- A6. T3: CorrelationContext already declares pollRunId (context.ts:33). Insert the pollRunId
  spread + comment between requestId and conversationId in the builder at jobs.ts:174-179.
  runWithContext already imported in jobs.test.ts.
- Task verify commands are as the plan states; also run `npm run typecheck` (root) before each commit.

## SLICE B (T4 projection widen, T5 dedup) - corrections

- B1. CRITICAL SCOPE ADD: app/test/system.routes.test.ts holds a 9TH ErrorEventView fixture the
  plan misses: the 4-key event literal at :134 inside `const fakeService: SystemStatusService`
  (:116-136) AND an exact-match `expect(res.body).toEqual(...)` at :159. T4 must update BOTH
  (add source: 'app', ref: 'PTR-R1', messageTruncated: false, errMessageTruncated: false and
  mirror them in the :159 assertion) or the tree stays red. Commit that file with T4.
- B2. The 8 fixtures in systemStatus.service.test.ts are at :250, :251, :316-322, :343, :346,
  :349, :394, :408. Give each source: 'app', a DISTINCT ref ('PTR-1'...'PTR-8'), plus
  messageTruncated: false, errMessageTruncated: false.
- B3. T5's pinned test uses `CONFIG` - that const does NOT exist in systemStatus.service.test.ts.
  Use the file's existing `deployedConfig()` helper (:34-37) - REQUIRED anyway, because a local
  config short-circuits getErrors to unavailable_local and the test would fail for the wrong
  reason. makeService exists (:52-54). The fake's filter-discrimination idiom to copy is :323-326.
- B4. The result-row loop to replace spans cloudwatch.ts:253-264 (map opens :254). The current
  row cell type in queryInsights results: rows are { field?: string; value?: string }[][].
- B5. Existing assertions that MUST keep passing: 'sort @timestamp desc' (adapter test :123),
  '(unparseable log line)' (:129-130 and service tests), epoch-seconds :121 and :280-299.
- B6. ErrorEventView/seam docblocks being rewritten (PII posture): cloudwatch.ts:12-14, :78, :84,
  :88-92, :96-107 (seam), :116-122 (projection docblock) - T4 rewrites the ones its edits touch
  (per plan Task 15 note "Tasks 4 and 6 already rewrote the cloudwatch.ts docblocks they
  replaced"), including the comment INSIDE projectErrorEvent at :139 (spec's list misses it;
  it dies with the rewrite).
- B7. queryInsights gains @ptr, @log in `fields` and passes whole rows + config to
  projectErrorEvent. Do NOT touch the :233-234 floor/ceil epoch conversion for the LIST query.

## SLICE C (T6 GetLogRecord seam, T7 detail route) - corrections

- C1. fakeSeam is at systemStatus.service.test.ts:39-50 (not :38). Its return-type annotation
  (:42-45) AND literal (:46-49) both need the new getLogRecord member (Task 6) - and queryTrace
  only later in Slice D (do NOT add queryTrace in this slice; it fails typecheck until T8).
- C2. T7 service tests: use deployedConfig() (see B3) for the in-scope/out-of-scope tests; the
  malformed-ref test also needs deployedConfig() (a local config would return unavailable_local
  before REF_PATTERN runs). CONFIG.errorLogGroupName in the plan's pinned tests -> use
  deployedConfig() log groups: /hc/dev/app etc. A foreign group for the out-of-scope test:
  '/hc/prod/app'.
- C3. T7 ALSO must extend `const fakeService: SystemStatusService` in system.routes.test.ts
  (:116-136) with a getErrorDetail stub (e.g. async () => ({ available: false as const,
  reason: 'unavailable_local' as const })) - the literal is annotated as the full interface and
  fails typecheck when the interface gains a member. (getTrace comes in Slice D - do not stub it yet.)
- C4. Route registration: createSystemRouter (system.ts:36) - add the route AFTER the existing
  /errors route; requireRole('admin') at :45 already covers it via router.use. The 400 precedent
  to match is :68-72.
- C5. In getLogRecord, '@log', '@logStream', '@ingestionTime' pass the allowlist into fields
  (by design - the spec names them as response keys); '@message', '@timestamp', '@logGroupId',
  '@logStreamId', backwardToken, forwardToken, @aws./@entity./@data_ prefixes are dropped.
- C6. app/test/system.routes.test.ts PATHS (:16) is a closed 3-route list driving the
  admin-200/va-403 loops - LEAVE IT ALONE (a bare GET on /errors/detail is 400, which would
  break the 200 loop). The plan's own per-route tests cover the admin gate.

## SLICE D (T8 trace seam, T9 trace route) - corrections

- D1. Extract runInsights from queryInsights PRESERVING the existing behavior byte-for-byte:
  the poll loop (20 x 400ms), the timeout StopQuery best-effort call, and error classification.
  The existing queryInsights tests (incl. :96-108 mockResolvedValueOnce chains) must keep passing.
- D2. traceSeam test helper: StartQueryCommand and GetQueryResultsCommand are ALREADY imported
  in cloudwatch.adapter.test.ts (:15-19; GetQueryResultsCommand is currently unused - it becomes
  used). CONFIG in that file is the LOCAL-env config (groups /hc/local/*) - fine for seam tests
  (the seam has no env gate; the SERVICE does).
- D3. T9 service tests: deployedConfig() as DEPLOYED_CONFIG (see B3). fakeSeam gains queryTrace
  in THIS slice (annotation + literal). fakeService in system.routes.test.ts gains a getTrace stub
  in THIS slice (e.g. async () => ({ available: false as const, reason: 'unavailable_local' as const })).
- D4. The trace route's 400 for bad `at`: Date.parse('nonsense') is NaN -> 400. Note
  Date.parse accepts some non-ISO strings; that laxity is acceptable (validated ids are the
  injection surface, `at` is a number after parse).
- D5. Insights `limit` is also passed as StartQuery input limit by the existing code (:236);
  keep passing TRACE_SIDE_LIMIT there for both queries.

## SLICE E (T10 wire layer, T11 hooks) - corrections

- E1. RecentErrors.test.tsx fixture fix (plan T10 Step 3): the fixtures at :67-68 and :88-92 gain
  source: 'app' (or per-test values), distinct ref, messageTruncated: false,
  errMessageTruncated: false. The file currently mocks the BARREL '../../api/index.js' via
  importActual spread (:12-19) - leave that mechanism intact.
- E2. Types go in dashboard/src/api/types.ts near :334-346; functions in endpoints.ts near
  :2088-2108; both re-export automatically via the barrel (index.ts `export *`). Components must
  import ONLY from '../../api/index.js'.
- E3. request() already supports query + signal (client.ts:35-42); non-2xx THROWS ApiError;
  AbortError is re-thrown as DOMException - the plan's hook catch guards are correct as written.
- E4. T11 hooks: FetchStatus is 'loading' | 'ready' | 'error' (no 'idle') - plan initialises
  'ready', distinguishing never-loaded via result === null. Fine; components must handle
  status==='ready' && result===null.
- E5. T11 adds imports to the useSystemStatus.ts import block (:13-20) - NOTE the resulting net
  line shift for Slice G's perf-ledger update; report the file's new total line count and the
  new line numbers of useSystemAlarms and its effects in your final report.
- E6. useCallback deps: the load functions take all args per call - keep deps [] as pinned.
  react-hooks compiler lint rules apply to dashboard non-test files; if eslint would flag a
  setState-in-effect pattern you did not add, leave existing disables alone. Lint is not a gate.

## SLICE F (T13 ErrorTrace FIRST, then T12 row/expander) - corrections

- F1. DO T13 BEFORE T12 (T12 imports ErrorTrace). Separate commits are fine in that order
  (T13's component compiles standalone).
- F2. THERE IS NO RecentErrorsHarness. RecentErrors takes NO props and self-fetches via
  useSystemErrors. DO NOT invent an events prop. Test mechanism (the repo's proven idiom,
  RecentErrors.test.tsx:12-19 + SystemStatusSection.test.tsx:9-20): mock the BARREL
  '../../api/index.js' with importActual spread; add getSystemErrorDetail and getSystemTrace to
  the SAME factory (never bare vi.fn() - mockResolvedValue a degraded result by default, e.g.
  { available: false, reason: 'unavailable_local' }); drive rows by
  getSystemErrors.mockResolvedValue({ available: true, events: [...] }); render <RecentErrors />
  and `await screen.findBy...` the first row (fetch is async). Write a tiny local helper
  `renderRows(events)` in the test file for this; adapt the plan's pinned test bodies to it.
- F3. The plan's trace-link test asserts getByTestId('trace-kind') - there is no such testid and
  the repo forbids new testids without a note. INSTEAD assert the mocked barrel getSystemTrace
  was called with kind 'requestId' after clicking the trace control (waitFor the call), e.g.
  expect(getSystemTrace).toHaveBeenCalledWith('requestId', 'r-1', base.timestamp, expect.anything()).
  (The signal arg may be undefined - match loosely.)
- F4. RecentErrors.tsx imports NOTHING from react today - ADD `import { useState } from 'react';`.
  Keep existing imports (:11-14) and the existing errorCode chip, correlationId line, warn styling
  (asserted at test :79, :81, :99, :100).
- F5. CSS: SystemStatusSection.module.css needs .errorChip, .truncated, .errorDetail (the plan's
  JSX uses styles.errorDetail but its Step 4 forgets it), .traceList, .traceLine, .traceAnchor -
  follow the file's token conventions (var(--sp-N), var(--c-*), var(--fs-*)); status conveyed by
  TEXT as well as colour (file header rule). css:false in tests, so classes are proof-read only.
- F6. Degraded-string count hazard: 'Available in deployed environments.' is pinned to EXACTLY 2
  page-wide occurrences by SystemStatusSection.test.tsx:67 and e2e settings.spec.ts:156. ErrorTrace's
  degraded state renders it only after a click - fine. For ErrorDetail's degraded state use
  'Available in deployed environments.' ONLY for reason unavailable_local and a DIFFERENT string
  (e.g. 'Could not load the full record.') for other reasons; never render either on initial page load.
- F7. ErrorDetail (unspecified in the plan): render on available:true - the fields map as a
  key/value list (sorted keys for determinism), err.stack in its own scroll container (a
  max-height + overflow auto class), rawText in a <pre> when present, and text markers for
  rawTextTruncated and responseTruncated. Handle result===null (transient) with the spinner or
  nothing. Component test coverage: at least degraded, fields render, stack container, rawText
  + truncation markers.
- F8. levelLabel/formatWhen are module-local in RecentErrors.tsx (:22-35) - reuse, do not
  duplicate. SOURCE_LABEL maps system->'host' per plan; the four-value chip test asserts labels
  app/worker/host/unknown.
- F9. The expander button name: plan uses 'Show all'/'Hide details' with aria-expanded - keep;
  the e2e degraded state renders no rows, so no e2e collision.

## SLICE G (T14 terraform, T15 truth-up + perf ledger + issue, T16 e2e spec) - corrections

- G1. T14 - IAM QUESTION ANSWERED (orchestrator verification, 2026-08-24, primary source):
  AWS's machine-readable service reference (https://servicereference.us-east-1.amazonaws.com/v1/logs/logs.json)
  lists GetLogRecord with "Resources": [{ "Name": "log-group" }] - it DOES support
  resource-level permissions (StopQuery lists none; StartQuery lists log-group). Per the spec's
  S7 default-to-scoped rule AND the plan's own conditional branch ("If the AWS Service
  Authorization Reference shows GetLogRecord DOES support a log-group resource type, prefer a
  scoped statement instead and cite the reference inline"), write a NEW SCOPED statement - do
  NOT add the action to SystemStatusInsightsResults and do NOT use the plan's pinned "*" block:
    statement {
      sid     = "SystemStatusGetLogRecord"
      actions = ["logs:GetLogRecord"]
      resources = [ <the SAME two ARN forms as SystemStatusInsightsStart at :291-293> ]
    }
  with an ASCII comment above it citing: AWS service reference logs.json (retrieved
  2026-08-24): GetLogRecord supports the log-group resource type, so this is scoped to this
  env's groups like StartQuery; the pointer resolves server-side to its log group for IAM to
  match. Place it right after SystemStatusInsightsResults (:296-300), which stays UNCHANGED
  (GetQueryResults + StopQuery remain "*" - StopQuery genuinely supports no resource).
  Then `cd infra && terraform fmt -check` and `terraform validate` ONLY. NEVER plan/apply.
  (terraform 1.15.6 is on PATH.) HANDBACK NOTE: after the human applies, they should verify the
  expander against real data; if enforcement unexpectedly rejects the scoped form, the fallback
  is moving GetLogRecord to the "*" statement - the app-level env scope check (S4) is the real
  boundary either way.
- G2. T15 perf ledger: DEFERRED TO POST-SYNC (planner directive 2026-08-24 late): main has
  REWRITTEN e2e/performance/* (routes.ts, routes.test.ts, templates.ts, cli.ts, selfQa.ts,
  config.ts + tests; commits incl. 6e707348 and 4cb1cfe4), so the :680/:762/:353 anchors are
  stale against the merged tree. Slice G does NOT touch the perf citation ledger. After the ONE
  main sync, the orchestrator re-derives the citations from the MERGED routes.ts +
  collect.test.ts + useSystemStatus.ts (slice-E-report's 86-141 / 133-141 recompute is a
  cross-check only - re-verify against the merged dashboard file too). The RULE is unchanged:
  the routes.ts citations and the collect.test.ts pinned literal update TOGETHER; keep
  systemAlarms first if the order-sensitive toEqual survives on main; re-check the '140-155'
  negative pin and the cited() shape in the MERGED tests.
- G3. T15 endpoint registry: the profiler NEVER reaches the detail/trace endpoints (verified:
  the walk clicks only the System status TAB and observes; the only click probes are inbox +
  email). So LEAVE templates.ts, SYSTEM_GETS, and routes.test.ts:106-109 COMPLETELY ALONE.
- G4. T15 PII rewrite list, corrected/completed (rewrite to the new posture - admin-only, may
  contain PII, credentials handled by the detail-path allowlist; do NOT delete):
  app/src/adapters/cloudwatch.ts:12-14 (header; if Slice B already rewrote it, verify wording);
  app/src/services/systemStatus.ts:15-22 (the :21-22 tail is the retired claim);
  app/src/routes/system.ts:14-18 (:18 is the claim) and :63;
  dashboard/src/api/endpoints.ts:2095; dashboard/src/api/types.ts:334 (docblock - fields came in T10);
  dashboard/src/routes/settings/RecentErrors.tsx:1-10 (the header block runs to :10, NOT :7 -
  rewrite the whole block coherently; if Slice F already touched it, verify);
  RecentErrors.test.tsx:2 (header comment) and :63 (describe name);
  app/src/adapters/messaging.ts:700 (comment names the old literal - now 'job failed: <jobName>');
  docs/issues/fake-twilio-messaging-attach-404.md:45 (the Insights signature - update to the new
  message format);
  docs/issues/system-status-errors-oldest-first-scan.md:35 (says the query path is 'PII-safe' -
  spec's list misses it; touch that phrase to the new posture).
  LEAVE AS-IS (still true): app/test/cloudwatch.adapter.test.ts:7 and :129-130 - EXTEND per spec
  (note the detail path surfaces raw text; the list path still never does);
  app/src/services/systemStatus.ts:51 and :236 (OOM labels ARE still synthesized/PII-safe);
  out-of-surface PII-safe sites (broadcastFanOut, contactTimeline, tours, voice, extraction,
  statusTransition, messaging.test) - NOT this mission's surface.
- G5. T15 RUNBOOK: the DLQ row is RUNBOOK.md:2169 (one table row). ADD the panel's new detail
  expander + trace pivot affordances to its remediation text; PRESERVE the Insights-query
  technique. :2167 (error-logs row) stays as-is. ASCII on touched lines.
- G6. T15 issue file: docs/issues/cloudwatch-log-cp1252-mojibake.md from _TEMPLATE.md - but the
  template contains em-dashes; the NEW file must be pure ASCII (every line is new). Frontmatter:
  id matches filename, type: bug, severity: low, status: open, area: app, created: 2026-08-24,
  refs: app/src/index.ts:162, app/src/worker.ts:530. Body: UTF-8 em-dash (E2 80 94) in source
  arrives in CloudWatch as lone 0x97 (CP1252), invalid UTF-8, replacement char in every UTF-8
  consumer incl. the panel; isolated past PowerShell console encoding AND the AWS CLI stdout
  encoding (PYTHONIOENCODING=utf-8 reproduced it); genuine at-rest defect in build/runtime/ingest.
  NOTE the spec section 9 as origin. Then run `npm run issues` (INDEX.md is gitignored - do not
  commit it).
- G7. T16: the System status assertions live at settings.spec.ts:153-159 (NOT :131-137 - that is
  the tab click). ADD below the existing block (do not restructure :114-152; main has pending
  comment edits at :114-120 and :158-162 that the final sync must merge cleanly): keep
  toHaveCount(2) INTACT; add e.g. a scoped check that the Recent errors heading's block shows the
  degraded notice and offers NO 'Show all' / 'Trace' buttons in the degraded state
  (page.getByRole('button', { name: 'Show all' }) toHaveCount(0), same for Trace). Accessibility
  selectors; ASCII source (build any needed em-dash via String.fromCharCode - not needed here).
  Do NOT run npm run e2e in this slice; the orchestrator runs it in the gates phase.
- G8. T15/T16 e2e-workspace files are typechecked by `npm run typecheck` (e2e tsc covers
  performance/ and tests/). Run root typecheck before each commit as usual, plus
  `cd e2e && npx vitest run performance/collect.test.ts performance/routes.test.ts` after G2.

## POST-SYNC WATCHOUTS (orchestrator-owned, recorded for the final phase)

- main is 35 commits ahead (not 7): per-recipient-delivery + remove-dev-outbox + dynamo tmpfs.
  Overlapping files: messaging.ts (comment region - no conflict), RUNBOOK.md:852 (other section),
  templates.ts:26 (deletion; we do not touch the file), settings.spec.ts:114-120/:158-162
  (comments around our T16 block).
- AppConfig.recordOutbox is DELETED on main - post-sync grep touched files for recordOutbox.
- Post-sync `npm run db:start` would FORCE-RECREATE the shared dynamo container (main's db.mjs
  rejects -inMemory args) - machine-wide; avoid running it; the container is already up.
- e2e/performance selfQa.ts + cli.ts gained required params on main - post-sync typecheck re-run
  is mandatory (it is anyway, as a gate).
