# SLICE C REPORT - Tasks 6 + 7 (error-surface-detail)

Status: BOTH TASKS DONE AND GREEN. Branch feat/error-surface-detail.
No unexpected importer/contract mismatch. No pre-existing red encountered.

## Commits

- `b7371d89` feat(observability): add GetLogRecord seam with an err allowlist
  (app/src/adapters/cloudwatch.ts, app/test/cloudwatch.adapter.test.ts,
  app/test/systemStatus.service.test.ts) - 3 files, +260 / -0
- `e6999215` feat(observability): add the full-record detail route
  (app/src/services/systemStatus.ts, app/src/routes/system.ts,
  app/test/systemStatus.service.test.ts, app/test/system.routes.test.ts) -
  4 files, +183 / -0

Both carry `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
Bare `git status` run before each; explicit paths only; no MERGE_HEAD.
Base was a clean tree at `0448676a`.

## Test runs (strict TDD, failure observed before every implementation)

| # | Command | Result |
|---|---|---|
| 1 | `vitest run test/cloudwatch.adapter.test.ts -t "getLogRecord"` (T6 RED) | 10 failed, 19 skipped (29) - every one `TypeError: seamFor(...).getLogRecord is not a function` |
| 2 | `vitest run` on the three files (T6 GREEN) | 71 passed (adapter 29, service 30, routes 12) |
| 3 | `npm run typecheck` (root, bare) | PASS - all 5 workspaces |
| 4 | `vitest run test/systemStatus.service.test.ts test/system.routes.test.ts` (T7 RED) | 9 failed, 43 passed (52): 6x `svc.getErrorDetail is not a function`, plus route `expected 404 to be 400`, `expected 404 to be 200`, and the un-called service spy - exactly the plan's predicted "404, not 400" |
| 5 | `vitest run` on the three files (T7 GREEN) | 81 passed (adapter 29, service 37, routes 15) |
| 6 | `npm run typecheck` (root, bare) | PASS - grep for `error TS` empty |

Not run (out of scope per the brief): `npm test`, `npm run smoke`, `npm run e2e`,
`npm run db:start`, docker, terraform.

ASCII: every added line of both commits scanned with
`git diff -U0 | grep '^+' | LC_ALL=C grep '[^ -~]'` - no matches.

## Divergences from the plan (worklist-directed or forced; none discretionary)

1. **C1 / Task 6 Step 4.** The plan's `fakeSeam` stub used `CONFIG.errorLogGroupName`;
   that const does not exist in `systemStatus.service.test.ts` (same defect class
   as B3/C2). Used `deployedConfig().errorLogGroupName`. `queryTrace` deliberately
   NOT added - it is Slice D and would fail this slice's typecheck.
2. **C2 applied.** T7's service tests use `deployedConfig()` throughout (a local
   config short-circuits to `unavailable_local` before `REF_PATTERN` ever runs, so
   the malformed-ref test would pass for the wrong reason). Foreign group
   `'/hc/prod/app'`; in-scope group `deployedConfig().errorLogGroupName`
   (`/hc/dev/app`). The in-scope test binds `const config = deployedConfig()` once
   and shares it between the service and the stub so the two cannot drift.
3. **C3 applied.** `fakeService` in `system.routes.test.ts` gained
   `getErrorDetail: async () => ({ available: false as const, reason: 'unavailable_local' as const })`.
   Confirmed required: the literal is annotated `SystemStatusService`, so the new
   interface member is a typecheck failure without it. `getTrace` NOT stubbed
   (Slice D).
4. **C6 respected.** `PATHS` (:16) untouched.
5. **Tests added beyond the plan's pinned bodies** - each pins a Global-Constraint
   behavior the pinned bodies left unasserted:
   - adapter: `logRecordPointer` pass-through (asserts the command instance +
     input), `@log` normalisation with `@logStream` / `@ingestionTime` surviving,
     longest-field-first byte-bound trimming, `RAW_TEXT_CAP` cap + flag;
   - service: the worker and system groups are in scope too, local-env
     short-circuit ordering (proved with a MALFORMED ref, so `unavailable_local`
     beating `invalid_ref` is a real assertion), seam-throws -> `cloudwatch_error`;
   - route: the DECODED pointer reaches the service unchanged (`+` and `/` survive
     `encodeURIComponent` + Express query parsing) - the S4 transport claim.
6. That last route test needed its own self-contained `SystemStatusService`
   literal: `fakeService` is declared INSIDE the "available:true shape" describe,
   so it is not in scope in the new describe block.
7. **One comment line added** to `app/src/routes/system.ts`'s header route list
   (`GET /api/system/errors/detail?ref=... -> 200 { available, record? | reason? }`).
   It uses ASCII `->` rather than the file's pre-existing U+2192 arrows, per
   "only added lines must be ASCII". The PII claim at :14-18 and :63 was NOT
   touched - Slice G owns it.

## Handoff note for Slice G (T15 truth-up)

`app/src/services/systemStatus.ts:2` still says "Three reads" and its :3-6 list
names only getFlags/getAlarms/getErrors. It is now FOUR (five after Slice D). I
left it alone deliberately: fixing the count means touching a line containing
a non-ASCII section mark, which the ASCII rule would force me to rewrite - that is G4's job, in
the same pass that rewrites the :15-22 PII tail. Add `getErrorDetail` (+ Slice
D's `getTrace`) to that header list there.

## Correctness rules - how each was satisfied

- **DOT-FLATTENED keys on the detail path.** `isAllowedKey` matches literal
  `'err.'`-prefixed keys against `ERR_ALLOWLIST`; nothing on this path parses
  JSON for field access. The LIST path's nested `parsed['err']` reader is
  untouched.
- **rawText gates on PARSEABILITY of `@message`, never on surviving-field count.**
  `JSON.parse(rawMessage)` + `typeof p === 'object' && p !== null` sets `isJson`
  BEFORE and independently of the field loop; `rawText` is set only when
  `!isJson && rawMessage.length > 0`. The control test
  ("does NOT hand back the raw line when a JSON record had all its err nests
  denied") passes for the right reason: the record parses -> `isJson` true ->
  `rawText` undefined, while `err.config.url` is dropped by the allowlist and
  `@message` is never a field key, so `JSON.stringify(out)` contains no 'secret'.
  A field-count gate would have returned the raw line and failed the second
  assertion.
- **Key policy.** `'@log'`, `'@logStream'`, `'@ingestionTime'` fall through to the
  final `return true` and PASS into `fields` (asserted). `'@message'`,
  `'@timestamp'`, `'@logGroupId'`, `'@logStreamId'`, `backwardToken`,
  `forwardToken` are in `DROPPED_KEYS`; `@aws.` / `@entity.` / `@data_` are
  prefix-dropped. A SCALAR top-level `'err'` is KEPT by the first branch, ahead of
  the `err.` test.
- **Scope check.** `getLogRecord` returns `logGroup: normalizeLogGroup(atLog)`
  (the exported helper reused, not re-derived), and the service does
  `[errorLogGroupName, workerLogGroupName, systemLogGroupName].includes(record.logGroup)`
  - exact equality, no suffix matching. `/hc/prod/app` -> `out_of_scope`.
- **HTTP contract.** Missing/empty `ref` -> 400 before the service is touched;
  present-but-malformed -> degraded 200 `{ available: false, reason: 'invalid_ref' }`
  with `REF_PATTERN` tested BEFORE `cloudwatch.getLogRecord` (spy proves no AWS
  call); local env -> `unavailable_local` BEFORE validation; a throwing seam ->
  `cloudwatch_error` via `classifyCloudWatchError` logging. Every path returns a
  value, so the handler can never 500.
- **RESPONSE_BOUND_BYTES.** `enforceBound` is the pinned implementation verbatim:
  `Buffer.byteLength(JSON.stringify(fields), 'utf8')`, longest-field-first sort,
  512-char slices, re-measured each iteration. Asserted with a
  `RESPONSE_BOUND_BYTES + 10` stack: `responseTruncated` true, the short `msg`
  untouched, the stack <= 512, the serialized result within the bound.

## LINE ANCHORS for Slice D (post-e6999215, verified)

### app/src/adapters/cloudwatch.ts - 385 -> **505** lines (+120)

| Anchor | New line |
|---|---|
| file header PII block (Slice G owns, untouched) | 12-14 |
| `GetLogRecordCommand` import | 22 |
| `export interface ErrorEventView` | 93-127 |
| `export const ERR_ALLOWLIST` (docblock 129-143) | 144-146 |
| `RAW_TEXT_CAP` / `RESPONSE_BOUND_BYTES` | 149 / 151 |
| `DROPPED_PREFIXES` / `DROPPED_KEYS` | 154 / 155-157 |
| `isAllowedKey` | 159-165 |
| `enforceBound` | 168-177 |
| `export interface LogRecordView` (docblock 179-190) | 191-202 |
| **`export interface CloudWatchClientSeam`** | **205-223** |
| - `describeAlarms` member | 207 |
| - `queryInsights` member (docblock 208-214) | 215 |
| - **`getLogRecord` member** (docblock 216-221) | **222** |
| - **add `queryTrace` AFTER 222, before the closing `}` at 223** | 223 |
| `export function normalizeLogGroup` | 233-236 |
| `sourceOf` / `capped` / `str` (reuse, do not re-derive) | 238-247 / 249-253 / 255-257 |
| `export function projectErrorEvent` (docblock 259-270) | 271-342 |
| `parseInsightsTimestamp` (private) | 348-352 |
| `delay` | 355-357 |
| `classifyCloudWatchError` | 374 |
| `export function createCloudWatchClient` | 402 |
| - `async describeAlarms(` | 408-417 |
| - `async queryInsights(` | 419-466 |
| - **`async getLogRecord(`** | **468-503** |
| - end of returned object / function | 504 / 505 |

**The poll loop to extract as `runInsights` (D1)** lives inside `queryInsights`:

- 420-421 `queryString` build (STAYS in queryInsights - the caller composes it)
- 423-432 StartQuery send (epoch SECONDS; the LIST `floor/ceil` convention at
  427-428 must NOT move into a shared helper unchanged - D5's trace queries pass
  their own bracket)
- 434-435 `queryId` guard
- 437-457 the 20 x 400ms poll loop; the `Complete` branch at 445-450 is the ONLY
  part that is projection-specific (`projectErrorEvent(row, config)` at 449) -
  extract `runInsights` returning the raw `results` rows and let each caller
  project
- 459-464 best-effort StopQuery, 465 budget-exhausted throw

### app/src/services/systemStatus.ts - 274 -> **318** lines (+44)

| Anchor | New line |
|---|---|
| header "Three reads" list (Slice G, see handoff note) | 1-13 |
| PII docblock tail (Slice G rewrites) | 15-22 |
| `type LogRecordView` import | 33 |
| `export type ErrorsResult` | 105-107 |
| **`export type DetailResult`** (docblock 110-115) | **116-118** |
| **`const REF_PATTERN`** | **121** |
| **`export interface SystemStatusService`** (add `getTrace` before the `}` at 142) | **123-142** |
| - `getErrors` member | 134 |
| - `getErrorDetail` member (docblock 135-140) | 141 |
| `isLocalEnv` (private, reuse) | 158-160 |
| `createSystemStatusService` | 173 |
| `async getErrors` | 232-288 |
| **`async getErrorDetail`** | **290-311** |
| end of returned object / factory | 312 / 313 |
| `isSystemErrorWindow` | 316-318 |

### app/src/routes/system.ts - 89 -> **102** lines (+13)

| Anchor | New line |
|---|---|
| header route list (new detail line at :9) | 6-9 |
| PII claim (Slice G rewrites :18 and :63) | 15-19 / 64 |
| `router.use(requireRole('admin'))` (covers every route) | 46 |
| `router.get('/flags'` / `/alarms'` / `/errors'` | 49 / 55 / 66 |
| **`router.get('/errors/detail'`** (comment 89-91) | **92-99** |
| `return router;` - Slice D adds `/trace` before this | 101 |

### app/test/cloudwatch.adapter.test.ts - 373 -> **504** lines (+131)

- Header PII claim (still overstated) 7-9 - Slice G4 extends it.
- Imports: `GetLogRecordCommand` added at 16 (logs SDK block 15-20);
  `RAW_TEXT_CAP`, `RESPONSE_BOUND_BYTES` added to the adapter import 22-31.
  `StartQueryCommand` / `GetQueryResultsCommand` already imported (D2 unchanged).
- `CONFIG` 34 (LOCAL-env config, groups `/hc/local/*`), `fakeCw` 37-39.
- `describe('cloudwatch adapter - queryInsights')` 95-323.
- `describe('projectErrorEvent - widened projection')` 325-376.
- **`describe('cloudwatch adapter - getLogRecord')` 378-504.**
- **END-OF-FILE APPEND POINT: after line 504.**

### app/test/systemStatus.service.test.ts - 476 -> **550** lines (+74)

- `localConfig()` 28-31, `deployedConfig()` 33-37 (UNSHIFTED).
- **`fakeSeam` 40-59** (was 39-50): return-type annotation **42-46** (the
  `getLogRecord: ReturnType<typeof vi.fn>;` line is 45), literal **47-58** with
  the `getLogRecord` stub at 50-57. Slice D adds `queryTrace` to BOTH halves.
- `makeService` 61-63.
- `describe('systemStatus.getErrors - degradation + window')` 228-476;
  filter-discrimination idiom 323+9 -> **332-335**; the T5 same-instant test
  **438-458**.
- `describe('isSystemErrorWindow')` 478-485.
- **`describe('systemStatus.getErrorDetail')` 487-550.**
- **END-OF-FILE APPEND POINT: after line 550.**
- Fixture refs in use: `PTR-1`..`PTR-8`, `PTR-A`/`PTR-B` (service), `PTR-R1`
  (routes). Slice D should use `PTR-9`+ or a distinct prefix.

### app/test/system.routes.test.ts - 204 -> **265** lines (+61)

- `PATHS` closed 3-route list: **16** (left alone per C6 - a bare
  `GET /errors/detail` is 400 and would break the admin-200 loop).
- **`const fakeService: SystemStatusService` literal: 116-148** (was 116-147);
  `getErrorDetail` stub at **147**. Slice D adds `getTrace` there.
- The exact-match `expect(res.body).toEqual(...)` mirror: 169-183.
- **`describe('GET /api/system/errors/detail')` 207-265**, incl. a self-contained
  `SystemStatusService` literal at 241-256 that Slice D can copy for `/trace`.
- **END-OF-FILE APPEND POINT: after line 265.**
