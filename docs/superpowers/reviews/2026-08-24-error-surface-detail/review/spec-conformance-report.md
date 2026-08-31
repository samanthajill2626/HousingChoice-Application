# SPEC-CONFORMANCE REVIEW - error-surface-detail

Branch `feat/error-surface-detail` @ `03a3e2ed`, worktree `W:\tmp\error-surface-detail`.
Reviewed READ-ONLY against the CURRENT tree (not the diff package alone).
Date: 2026-08-25.

Authority order applied: worklist `.superpowers/sdd/worklist.md` > plan
`docs/superpowers/plans/2026-08-24-error-surface-detail.md` > spec
`docs/superpowers/specs/2026-08-24-error-surface-detail-design.md`.
Decision record consulted: `docs/superpowers/reviews/2026-08-24-error-surface-detail-design-review.md`.

## Verification actually run

| Check | Result |
|---|---|
| `cd app && npx vitest run test/expressErrorHandler.test.ts test/jobs.test.ts test/cloudwatch.adapter.test.ts test/systemStatus.service.test.ts test/system.routes.test.ts` | 5 files, **123 tests PASSED** |
| `cd dashboard && npx vitest run src/routes/settings/{RecentErrors,ErrorTrace,SystemStatusSection}.test.tsx` | 3 files, **35 tests PASSED** |
| `npm run typecheck` (root, bare) | **GREEN** - all 5 tsc projects |
| Non-ASCII scan of every ADDED line across `app/ dashboard/ e2e/ infra/ docs/issues/ RUNBOOK.md` | **0 non-ASCII added lines** |
| `LC_ALL=C tr -d '\11\12\15\40-\176' < app/src/lib/errors.ts \| wc -c` | **0** (whole file ASCII, worklist A3 satisfied) |
| `git status --porcelain` | **clean** |
| terraform state / plan artifacts (`*.tfstate*`, `*.tfplan`, `tfplan*`) | **none anywhere in the tree** |
| Spec file modified by a FEATURE commit? | **No** - only by `6d517552` (pre-build planning commit, the diff-package base) |

Not run (out of brief): `npm test`, `npm run smoke`, `npm run e2e`, docker, terraform.

---

## Work-map verdicts

### T1 - dispatcher message + test: **CONFORMS**
- `app/src/jobs/jobs.ts:338` - message arg only: `` `job failed: ${envelope.jobName}` ``.
  Structured fields (`err`, `jobName`, `jobId`, `durationMs`) unchanged at `:330-337`.
- `app/src/jobs/jobs.ts:296` (`'dispatchJob: malformed job envelope rejected'`) left as-is per spec S1.
- Test `app/test/jobs.test.ts:357-386`, wrapped in its own describe with
  `beforeEach/afterEach(_resetForTests)` per worklist A1; type imports added per A2
  (`jobs.test.ts:12,14,27`).

### T2 - Express handler: **CONFORMS** (implementation) / **PARTIAL** (one named test missing)
- Three DISTINCT branch messages, all naming method + route template:
  - `app/src/lib/errors.ts:165` `unhandled error after response started: ...`
  - `app/src/lib/errors.ts:177` `malformed URI in request - rejected as 400: ...`
  - `app/src/lib/errors.ts:184` `unhandled error while handling request: ...`
- `routeLabel` INTERNAL (not exported), `app/src/lib/errors.ts:144-148`; uses
  `req.baseUrl + req.route.path`, literal `(unrouted)` at `:146`.
- Structured field set `{ err, method, path }` preserved on all three branches
  (`:164`, `:176`, `:183`) - worklist A4.
- PII refusal test: `app/test/expressErrorHandler.test.ts:46-63` - asserts msg does NOT
  contain `+14045551234`, DOES contain `/api/contacts/:contactId/phones/:phone` and
  `DELETE`, and that `obj['path']` still carries the concrete path.
- ASCII: whole file clean (all five U+2014 em-dashes removed, incl. the
  `uncaughtException - exiting` string at `:116`).
- **GAP**: spec s7 S1 bullet 4 demands the `(unrouted)` test "including on the
  `URIError` branch". `expressErrorHandler.test.ts:65-71` covers only the normal
  branch; there is no URIError test in the file (grep for `URIError` in `app/test/`
  returns only the unrelated `contactPhones.test.ts:180`). See FINDING 1.

### T3 - pollRunId into the envelope: **CONFORMS**
- `app/src/jobs/jobs.ts:181` - `...(ctx.pollRunId !== undefined && { pollRunId: ctx.pollRunId })`,
  inserted between `requestId` and `conversationId` per worklist A6, with the
  justifying comment at `:176-180`.
- correlationId resolution untouched: no edit to `app/src/lib/logger.ts`; `dispatchJob`
  still mints `jobRunId` (`jobs.ts:303-311`) which wins the ladder.
- Tests: `app/test/jobs.test.ts:389-435` - propagation (`toEqual({ pollRunId: 'poll-abc' })`)
  and the no-invention case (`not.toHaveProperty('pollRunId')`).
- "correlationId resolution unchanged inside a dispatched job" is pinned by
  PRE-EXISTING tests, not a new one: `app/test/logger.test.ts:68-85` and
  `app/test/pollLoop.test.ts:114-132`. Acceptable coverage; see FINDING 7.

### T4 - widened projection: **CONFORMS**
- `ErrorEventView` at `app/src/adapters/cloudwatch.ts:101-135`: all eight new fields
  (`jobName`, `event`, `errType`, `errMessage`, `source`, `ref`, `requestId`, `pollRunId`)
  plus per-field flags `messageTruncated:109`, `errMessageTruncated:126`.
- `@ptr` + `@log` in the fields clause: `cloudwatch.ts:604`
  `fields @timestamp, @message, @ptr, @log | filter ... | sort @timestamp desc | limit N`.
- Whole-row pass: `runInsights` returns raw rows (`cloudwatch.ts:571`), mapped at `:614`
  `rows.map((row) => projectErrorEvent(row, config))`; signature changed to
  `(row: {field?,value?}[], config: AppConfig)` at `:339-342`.
- NESTED `err` access: `cloudwatch.ts:380-385` reads `parsed['err']` as an object then
  `err['message']`; asserted by `cloudwatch.adapter.test.ts` "reads a NESTED err object,
  not a dotted key".
- `sourceOf` compares CONFIGURED names, never suffixes: `cloudwatch.ts:306-315`; the
  foreign-env case (`/hc/otherenv/app` -> `unknown`) is asserted in the adapter test.
- Fallback ladder `cloudwatch.ts:387-388`; single-render rule `:392`
  (`errMessageRaw !== null && errMessageRaw !== chosen`), asserted by "does not duplicate
  the text when message came FROM err.message".
- 300 caps with own flags: `FIELD_CAP = 300` at `:91`, `capped()` at `:317-321`.
- `source` and `ref` REQUIRED/non-null (`:132`, `:134`); set unconditionally in `base`
  at `:354-360` including the unparseable branch (`:371-377`).
- OOM relabel preserved verbatim: `app/src/services/systemStatus.ts:297-298`.
- Fixtures fixed: `app/test/systemStatus.service.test.ts` 8 fixtures (:263-264, :333-338,
  :360-366, :411, :425 - each with `source`, a distinct `PTR-n`, both flags);
  `app/test/system.routes.test.ts:134-143` AND the exact-match assertion at `:172-181`
  (worklist B1 - both updated); `dashboard/src/routes/settings/RecentErrors.test.tsx:90-108,
  :127-137`.
- List query epoch conversion left alone (`cloudwatch.ts:610-611` floor/ceil) - worklist B7.

### T5 - dedup key gains `ref` (leading): **CONFORMS**
- `app/src/services/systemStatus.ts:309`:
  `` const key = `${e.ref}|${e.timestamp}|${e.message}|${e.errorCode ?? ''}`; ``
  Old components retained, with the "they never decide" comment at `:305-308`.
- Test: `systemStatus.service.test.ts` "keeps two same-instant rows from different log
  groups apart" (same timestamp/message/errorCode, distinct refs -> 2 rows survive).
  The pre-existing "deduplicates OOM events that have the same timestamp+label" test
  still passes (shared `PTR-8`).

### T6 - GetLogRecord seam: **CONFORMS**
- `ERR_ALLOWLIST` exactly the seven paths: `cloudwatch.ts:152-154`
  (`err.message, err.stack, err.type, err.name, err.code, err.status, err.response.status`).
- Drops at ANY depth: `isAllowedKey` at `:167-173` - any `err.`-prefixed key not in the
  literal list is dropped, so `err.cause.config.headers.Authorization` and
  `err.config.params` die by construction. Asserted in the adapter test
  ("drops every other err nest AT ANY DEPTH, including err.cause").
- Scalar `err` kept: `:168` `if (key === 'err') return true;` - asserted.
- Non-`err` fields pass through: `:172`.
- `@message` never a response key: `DROPPED_KEYS` at `:163-165`; asserted
  ("never returns @message or AWS transport metadata for a PARSED record").
- No AWS transport metadata: `DROPPED_PREFIXES` `@aws.`/`@entity.`/`@data_` at `:162`,
  plus `@logGroupId`, `@logStreamId`, `backwardToken`, `forwardToken`, `@timestamp`.
  `@log`/`@logStream`/`@ingestionTime` deliberately pass (worklist C5) and are asserted.
- rawText ONLY for non-JSON: gated on PARSEABILITY (`:624-644`), not field count -
  and the adapter test "does NOT hand back the raw line when a JSON record had all its
  err nests denied" pins exactly that, asserting `JSON.stringify(out)` contains no
  `secret`. 4000 cap + flag: `RAW_TEXT_CAP = 4000` at `:157`, applied `:641-644`.
- 64 KB byte bound + flag: `RESPONSE_BOUND_BYTES = 65536` at `:159`, `enforceBound`
  at `:176-185` using `Buffer.byteLength(..., 'utf8')`; asserted incl. the
  longest-field-first behaviour and a post-condition byte-length check.
- Dot-FLATTENED access documented and used (`LogRecordView` docblock `:187-198`,
  `record['@log']` `:620`).
- `fakeSeam` gained BOTH methods: `systemStatus.service.test.ts:42-62`.

### T7 - detail route: **CONFORMS**
- Admin-gated by the router-level `requireRole('admin')` (`app/src/routes/system.ts:53`);
  route registered AFTER `/errors` at `:100`. Asserted: `system.routes.test.ts`
  "is admin-only" -> 403 for a VA session.
- Missing `ref` -> 400: `system.ts:102-105`; asserted "400s when ref is missing".
- Malformed `ref` -> degraded 200 `invalid_ref` with NO AWS call:
  `systemStatus.ts:329` (`REF_PATTERN` at `:142`, tested BEFORE the seam call);
  asserted "degrades a malformed ref without calling AWS" (`getLogRecord` not called).
- Env scope check on the normalised `@log`: `systemStatus.ts:335-339`; asserted for a
  foreign group (`/hc/prod/app` -> `out_of_scope`) and for all three in-scope groups.
- `unavailable_local` on hermetic, BEFORE ref validation: `systemStatus.ts:328`; asserted.
- Never 500: throw -> `cloudwatch_error` at `:341-347`; asserted.
- Pointer transport round-trip asserted at the route:
  `system.routes.test.ts` "hands the DECODED pointer to the service (+ and / survive)".

### T8 - trace seam: **CONFORMS**
- Two queries, OPPOSITE sorts, in `Promise.all`: `cloudwatch.ts:680-683`
  (`sort @timestamp desc` / `sort @timestamp asc`). Parallelism asserted by command
  ISSUE ORDER: `['StartQuery','StartQuery','GetQueryResults','GetQueryResults']`.
- BEFORE `endTime = Math.floor(atMs/1000)` (`:669` `anchorSec`, passed at `:681`);
  AFTER `startTime = anchorSec + 1` (`:682`). DISJOINT; asserted with a `.500` ms anchor
  plus `after.startTime > before.endTime`.
- Brackets: `BRACKET_TIGHT_MS = 5min` `:257`, `BRACKET_WIDE_MS = 30min` `:259`,
  `BRACKET_AHEAD_MS = 5min` `:261`; selection at `:659`. Asserted for correlationId
  (-5min) and pollRunId (-30min), and the +5min look-ahead.
- 25/side: `TRACE_SIDE_LIMIT = 25` `:255`, in the query string AND as StartQuery `limit`
  (worklist D5) - asserted `limit 25` and `input.limit === 25`.
- Merged ascending: `:685-688` (BEFORE reversed, then AFTER); asserted.
- Per-side flags: `:689-690` `length >= TRACE_SIDE_LIMIT`; asserted.
- Epoch SECONDS on both bounds (`:660-661`, `:669`); asserted numerically.
- `TraceLineView` shape at `:224-242` with all seven diagnostic fields; asserted by an
  exact `toEqual` on a full INFO context line, and the level-30 unparseable default.
- `fields @timestamp, @message, @log` (`:670`) and nested-`err` access (`:442-454`).
- System group EXCLUDED at the SERVICE (`systemStatus.ts:356-361` passes app+worker only);
  asserted "queries app and worker but NOT the system group".
- `runInsights` extracted preserving behaviour byte-for-byte (`:540-588`): 20x400ms poll,
  best-effort StopQuery, same throws. All pre-existing queryInsights tests still pass.

### T9 - trace route: **CONFORMS**
- Exactly-one-of the three ids -> 400: `system.ts:115-119`; `at` required and parseable
  -> 400: `:120-125`. Asserted: no id, several ids, bad `at`, and missing `at`.
- UUID validation BEFORE AWS -> degraded `invalid_id`: `systemStatus.ts:352`
  (`UUID_PATTERN` `:151`); asserted with `queryTrace` not called.
- app+worker groups only: `systemStatus.ts:357`.
- Kind/id/parsed-anchor pass-through asserted at both route and service level.

### T10 - dashboard mirror: **CONFORMS**
- `SystemErrorEvent` widened with all eight fields + both flags:
  `dashboard/src/api/types.ts:341-357`; `SystemErrorSource` union at `:335`.
- `SystemLogRecord` `:378-384`, `SystemTraceLine` `:387-399`.
- Discriminated unions on `available`: `SystemErrorDetailResult` `:402-404`,
  `SystemTraceResult` `:406-408`.
- Client fns via `request()` with `query` + `signal`:
  `dashboard/src/api/endpoints.ts:2116-2145`. `getSystemErrorDetail` passes
  `query: { ref }` (URLSearchParams -> `+`/`/`/`=` percent-encoded), with the
  do-not-hand-roll comment at `:2116-2122`. `getSystemTrace` uses `query: { [kind]: id, at }`.

### T11 - hooks with abort handling: **CONFORMS**
- `useErrorDetail` `dashboard/src/routes/settings/useSystemStatus.ts:253-283`,
  `useErrorTrace` `:285-320`. Both: `abortRef` supersede-on-new-load, `signal.aborted`
  guard in `.then`, and a `.catch` that swallows `DOMException`/`AbortError`
  (worklist E3). `useCallback` deps `[]` (E6). `status` starts `'ready'` with
  `result === null` (E4), documented at `:245-250`.

### T12 - the widened row: **CONFORMS**
- Source chip, four values, `system -> 'host'`: `SOURCE_LABEL`
  `dashboard/src/routes/settings/RecentErrors.tsx:74-79`, rendered `:160`.
- `jobName` else `event` chip: `:152`, rendered `:161`. `errType` chip `:162`.
- `errMessage` on its OWN line under `message`, with its OWN flag, rendered only when
  non-null (the single-render rule): `:178-183`.
- `ref` row key: `:286` `<ErrorRow key={ev.ref} ...>`.
- Trace link precedence requestId > pollRunId > correlationId: `tracePivot` `:62-71`;
  absent when all three are null `:202`; sends the row's timestamp as the anchor
  `:210` (`at={event.timestamp}`).
- Expander `aria-expanded`: `:192`; fetch on OPEN only `:196`.
- Every truncation indicator rendered: `messageTruncated:169`, `errMessageTruncated:181`,
  `rawTextTruncated:134`, `responseTruncated:137`.
- Existing affordances preserved: warn styling `:157`, errorCode chip `:163-165`,
  correlationId line `:184-186`, window selector, warnings toggle, refresh, `role="alert"`
  only on a true load error `:271`.
- CSS added and token-conformant (`SystemStatusSection.module.css`): `.errorChip:323`,
  `.truncated:338`, `.errorActions:346`, `.errorDetail:356`, `.detailBlock:364`,
  `.detailFields:374`, `.detailStack/.detailRaw:405-406` (`max-height:240px; overflow:auto`
  - the spec's "own scroll container"), `.traceList:437`, `.traceLine/.traceAnchor:446-447`.
- Degraded copy split per worklist F6: `unavailable_local` -> "Available in deployed
  environments."; any other reason -> "Could not load the full record." (`:108-110`).
  Neither renders on initial page load.
- Tests: `RecentErrors.test.tsx` 24 tests, all passing, covering each bullet above
  (four-value chip :194, precedence :280, absent-id :299, expander/aria :261,
  per-row state isolation :246, all four truncation markers :221/:226/:336).

### T13 - trace view: **CONFORMS**
- `dashboard/src/routes/settings/ErrorTrace.tsx` - merged ascending `<ol>` `:50-62`,
  source chip `:57`, anchor marked by TEXT "this failure" `:59`, per-side truncation
  `:47-49` and `:63-65`, degraded `:42` vs empty `:43` DISTINCT.
- The component is a byte-for-byte match with the plan's pinned implementation
  (plan Task 13 Step 3) plus a file header - which is why it renders
  timestamp+source+message and not `level`/diagnostics (declared deliberate deviation).
- Component test `ErrorTrace.test.tsx` - 7 tests, all passing, incl. the explicit
  empty-vs-degraded test `:106-117` and both truncation sides `:82`/`:94`.
- Built BEFORE T12 in commit order (`8b4cac96` precedes `17928dcd`) - worklist F1.

### T14 - terraform: **CONFORMS**
- `infra/modules/ec2/main.tf:311-318` - new `SystemStatusGetLogRecord` statement,
  `actions = ["logs:GetLogRecord"]`, resources IDENTICAL to `SystemStatusInsightsStart`
  (`:292-293` vs `:315-316`), placed immediately after `SystemStatusInsightsResults`.
- `SystemStatusInsightsResults` (`:296-300`) UNCHANGED - still `["*"]`.
- Inline ASCII citation of the AWS service reference with retrieval date at `:301-310`,
  and it names the app-level env scope check as the independent second boundary.
- WRITTEN ONLY: `git status` clean; no `*.tfstate*`, `*.tfplan`, or `tfplan*` anywhere
  in the tree.

### T15 - comment and doc truth-up: **CONFORMS**
Every spec section-8 site verified against its CURRENT text:

| Site | Current state |
|---|---|
| `app/src/adapters/cloudwatch.ts` header | rewritten `:14-22` (admin-only, may carry PII, credentials excluded by ERR_ALLOWLIST) |
| `cloudwatch.ts` `ErrorEventView` docblock | rewritten `:93-100` ("DISPLAY control, not a storage control") |
| `cloudwatch.ts` message/errorCode field notes | rewritten `:107-116`, no PII claim |
| `cloudwatch.ts` seam doc | rewritten `:267-273` ("an admin-only display projection, not a redaction boundary") |
| `cloudwatch.ts` `projectErrorEvent` docblock | rewritten `:327-338`; the in-body comment (spec's list missed it, worklist B6) rewritten `:368-370` |
| `app/src/services/systemStatus.ts:15-22` | rewritten `:25-32` |
| `app/src/routes/system.ts:14-18` and `:63` | rewritten `:20-26` and `:71-72` |
| `dashboard/src/api/endpoints.ts:2095` | rewritten `:2097-2103` |
| `dashboard/src/api/types.ts:334-346` | rewritten `:337-342` (+ real fields) |
| `dashboard/.../RecentErrors.tsx:1-10` | whole header rewritten `:1-24` |
| `RecentErrors.test.tsx:2`, `:63` | header `:1-8`; describe now `RecentErrors - available:true rendering` `:85` |
| `app/src/adapters/messaging.ts:700` | updated to `'job failed: <jobName>'` `:700` |
| `docs/issues/fake-twilio-messaging-attach-404.md:45` | updated to the new signature, with the pre-2026-08-24 form preserved `:45-47` |
| `docs/issues/system-status-errors-oldest-first-scan.md:35` (worklist G4 addition) | updated `:35-40` |
| `RUNBOOK.md` DLQ row `:2169` | new message format + the panel's Show all / Trace affordances ADDED, and the Insights-query technique with "the originating request's correlation IDs" PRESERVED verbatim |
| NOT-a-correction: `app/test/cloudwatch.adapter.test.ts:7`, `:129` | EXTENDED at the file header `:1-24` (list path still never surfaces raw text; detail path DOES). The inline `:148` marker left true-as-written, not "fixed" |
| LEAVE-AS-IS: `systemStatus.ts:64`, `:294` (OOM labels) | untouched, still PII-safe by construction |

CP1252 issue filed: `docs/issues/cloudwatch-log-cp1252-mojibake.md` - frontmatter matches
`_TEMPLATE.md` (id == filename, `type: bug`, `severity: low` [valid per README:48],
`status: open`, `area: app`, `created: 2026-08-24`), refs `app/src/index.ts:162` and
`app/src/worker.ts:530` - both VERIFIED to still hold a real U+2014 em-dash. Whole file
is pure ASCII (it describes the character rather than quoting it). `npm run issues` was
run: the entry is present at `docs/issues/INDEX.md:114`, and INDEX.md is gitignored
(`.gitignore:62`) and NOT committed.

### T16 - e2e: **CONFORMS**
- `e2e/tests/dashboard-next/settings.spec.ts:160-167` - added BELOW the existing block,
  `toHaveCount(2)` pin at `:156` INTACT and untouched.
- Accessibility-first selectors; `exact: true` on 'Trace' to avoid substring collisions.
- Collision check performed: 'Show all' and 'Trace' appear in exactly ONE dashboard
  component (`RecentErrors.tsx:200`, `:204`), so both `toHaveCount(0)` assertions are
  structurally safe in the degraded lane.
- Restructuring of `:114-152` avoided per worklist G7.

### Spec section 7 test obligations: **PARTIAL**
All obligations spot-checked and confirmed EXISTING and ASSERTING what the spec demands,
with two exceptions:
- **MISSING**: the `(unrouted)` token on the `URIError` branch (see FINDING 1).
- **THIN**: S4's "stringified coercion" (see FINDING 2).
Everything else - the PII refusal, the allowlist drops (incl. `err.cause.*` and
`err.config.params`) with `err.response.status` surviving and a scalar `err` surviving,
the disjoint-window assertions, the parallel-execution assertion, the empty-vs-degraded
distinction, and every truncation indicator - is present and passing.

Deliberate deviations confirmed as declared, NOT reported as findings: the perf
source-citation ledger deferred to post-sync (worklist G2); the endpoint registry left
untouched because the profiler never reaches the templates (G3) - verified
`e2e/performance/templates.ts` and `routes.ts` carry no diff; Task 14 on the scoped IAM
branch (G1); ErrorTrace's field set matching the plan's pinned component; tests mocking
the api barrel rather than a nonexistent `RecentErrorsHarness` (F2).

### Global constraints table (plan lines 19-32): **CONFORMS**

| Constraint | Shipped | Evidence |
|---|---|---|
| `message`/`errMessage` cap 300, own flags | yes | `cloudwatch.ts:91`, `:317-321`, `:389-392` |
| `rawText` cap 4000 + flag | yes | `cloudwatch.ts:157`, `:641-644` |
| Detail bound 65536 BYTES via `Buffer.byteLength` | yes | `cloudwatch.ts:159`, `:177`, `:181` |
| 25 rows/side, 50 merged | yes | `cloudwatch.ts:255`, `:681-688` |
| Bracket -5min correlationId / -30min cross-hop / +5min ahead | yes | `cloudwatch.ts:257-261`, `:659-661` |
| BEFORE `endTime=floor(at/1000)`, AFTER `startTime=floor+1`, disjoint, never `ceil` for BEFORE | yes | `cloudwatch.ts:669`, `:681-682` |
| `source` union derived from CONFIGURED names | yes | `cloudwatch.ts:88`, `:306-315` |
| `err` allowlist = exactly 7 paths, any-depth drop, scalar kept | yes | `cloudwatch.ts:152-154`, `:167-173` |
| `source`/`ref` REQUIRED non-null; rest `?: T \| null` | yes | `cloudwatch.ts:131-134` |
| LIST/TRACE nested `err`; DETAIL dot-flattened | yes | `:380-385`, `:442-445` vs `:620-637` |
| HTTP: missing param 400, malformed degraded 200, never 500 | yes | `system.ts:102-105`, `:116-125`; `systemStatus.ts:329`, `:352`, `:341-347`, `:363-369` |
| ASCII only on new/touched lines | yes | 0 non-ASCII added lines, measured |
| Green between tasks | yes | typecheck GREEN, 158 targeted tests pass |

---

## FINDINGS

### FINDING 1 - SHOULD-FIX: the spec's named `(unrouted)`-on-URIError test does not exist
`app/test/expressErrorHandler.test.ts:65-71` covers `(unrouted)` only on the normal
error branch. Spec section 7, S1 bullet 4 says: "the `(unrouted)` token appears when
`req.route` is unset, **including on the `URIError` branch**", and decision record AJ36
(review doc `:476-481`) states the WARN branch was pulled into scope precisely because
its rule "yields `method + (unrouted)` identically every time" and a builder should not
have to guess. Grep confirms no test in `app/test/` exercises `createExpressErrorHandler`
with a `URIError`. The behaviour itself is correct (`errors.ts:174-181` calls the same
`routeLabel`), so this is a missing guard rather than a defect - but it is the only
untested branch of the one slice the spec singles out as having "the highest-consequence
rule and no test until now". A three-line test
(`handler(new URIError('bad'), req, fakeRes(false), noop)` asserting `lines[0].msg`
contains `(unrouted)` and starts with the malformed-URI string) closes it.

### FINDING 2 - CONSIDER: S4's "stringified coercion" obligation is only structurally met
Spec section 7 S4 lists "stringified coercion" as a test obligation (fact 5: a real
record returned `level` as the string `"30"`). `cloudwatch.ts:636` does
`fields[key] = String(value)` unconditionally and the seam types the record as
`Record<string, string>`, so the requirement holds by construction - but no test feeds a
non-string value and asserts the coerced output. Every `getLogRecord` test fixture in
`cloudwatch.adapter.test.ts` already passes strings. Low value to add, recorded for
completeness.

### FINDING 3 - CONSIDER: `enforceBound` sets its flag without guaranteeing the bound
`app/src/adapters/cloudwatch.ts:176-185`. The function returns `true` as soon as the
initial serialization exceeds 65536 bytes, then trims each field to 512 chars
longest-first, breaking as soon as it fits. With more than roughly 128 surviving keys the
post-trim payload could still exceed the bound while the flag says "truncated". Not
reachable with any realistic `GetLogRecord` record (the allowlist plus the three `@`
metadata keys bound the key count to tens), and the client is told the response was
trimmed either way, so this is a robustness nit rather than a contract break.

### FINDING 4 - CONSIDER: `@`-metadata exclusion is a denylist, not the spec's "stated key set"
Spec S4 frames the response as "A STATED KEY SET, not 'everything the record has'".
`isAllowedKey` (`cloudwatch.ts:167-173`) implements a true allowlist under `err` but a
DENYLIST for `@`-prefixed metadata (`DROPPED_KEYS:163-165` + `DROPPED_PREFIXES:162`), so a
future AWS-added `@`-key outside `@aws.`/`@entity.`/`@data_` would pass through into
`fields`. This matches the spec's own enumeration verbatim ("`backwardToken`,
`forwardToken`, `@logGroupId`, `@logStreamId`, `@aws.*`, `@entity.*`, `@data_*` ... is NOT
returned"), so the build followed instructions - noting only that the structural
guarantee the spec claims for the `err` subtree does not extend to the metadata tier.
No credential exposure: credentials live under `err`, which is allowlisted.

### FINDING 5 - CONSIDER: a stale test title in `RecentErrors.test.tsx`
`dashboard/src/routes/settings/RecentErrors.test.tsx:86` still reads
`'renders timestamp + level + message + correlationId ONLY'`. The row now also renders a
source chip, and the fixtures at `:90-108` carry `source: 'app'` - so the "ONLY" in the
name is no longer true of what the component renders (the assertions themselves are
correct and pass). Cosmetic.

### FINDING 6 - CONSIDER: ErrorTrace renders the raw `source` value, not the `host` label
`ErrorTrace.tsx:57` renders `{l.source}` directly, while `RecentErrors.tsx:74-79` maps
`system -> 'host'`. Unreachable in practice: the trace service queries app+worker only
(`systemStatus.ts:357`), so a trace line can only be `app`, `worker` or `unknown`. It
matches the plan's pinned component exactly. Worth knowing only if the trace is ever
widened to the system group.

### FINDING 7 - CONSIDER: S2's second test obligation rests on pre-existing coverage
Spec section 7 S2 asks for "`correlationId` resolution is unchanged inside a dispatched
job". No new test asserts it; the property is pinned by PRE-EXISTING
`app/test/logger.test.ts:68-85` ("pollRunId outranks bootId, and jobRunId outranks
pollRunId") and `app/test/pollLoop.test.ts:114-132` ("a job dispatched inside a tick
reports its OWN jobRunId, not the tick id"). Both still pass and both would go red if the
resolution changed, so the obligation is genuinely covered - just not by anything this
branch added. No action needed unless the reviewer wants the pin co-located.

---

## Spec-vs-shipped discrepancies I could not adjudicate

### D1 - the decision record contradicts the current spec on `errMessage` rendering
`docs/superpowers/reviews/2026-08-24-error-surface-detail-design-review.md:906-915`
(AJ71) resolves: "the collapsed row renders `message` plus `errType`; `errMessage` is
NOT rendered separately there, so the duplicate case cannot arise."
The SPEC was subsequently amended in commit `6d517552` (the diff-package base, a
pre-build planning commit) to the opposite: spec `:518-528` now says "`errMessage` IS
rendered, on its own line under `message`", with the S3 single-render rule as the
reason the duplicate case cannot arise. The shipped row follows the CURRENT spec
(`RecentErrors.tsx:178-183`).
I read this as the spec superseding a stale decision-record entry (spec is the contract,
and the amendment is explicit and reasoned), so I did NOT score it as a defect. Flagging
it because a reader consulting the decision record alone would reach the opposite verdict,
and because the decision record was not updated alongside the spec.

### D2 - the fallback ladder carries one more rung than the spec's prose
Spec S3 states the ladder as `msg -> event -> err.message -> (unparseable log line)`.
Shipped (`cloudwatch.ts:387-388`) is
`msg -> message -> event -> err.message -> (unparseable log line)`.
The extra `message` rung is pinned verbatim by the plan (`plan:563`, and again for the
trace path at `plan:1216-1219`), and it preserves the PRE-EXISTING behaviour the spec
itself describes two paragraphs earlier ("replaces it only when `msg`/`message` is a
non-empty string (`:127`, `:135-136`)"). Per the stated authority order the plan wins, and
dropping the rung would be a silent regression for any line using `message` instead of
`msg`. Scored as CONFORMS; recorded here only because the spec's one-line summary of the
ladder omits it.
