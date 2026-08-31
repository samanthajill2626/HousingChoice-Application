# SLICE D REPORT - Tasks 8 + 9 (error-surface-detail)

Status: BOTH TASKS DONE AND GREEN. Branch feat/error-surface-detail.
No unexpected importer/contract mismatch. No pre-existing red encountered.
Base was a clean tree at `e6999215`.

## Commits

- `32173e8c` feat(observability): add the two-query correlation trace seam
  (app/src/adapters/cloudwatch.ts, app/test/cloudwatch.adapter.test.ts,
  app/test/systemStatus.service.test.ts) - 3 files, +385 / -41
  (the 41 deletions are ONLY the queryInsights body that moved into runInsights)
- `e005b417` feat(observability): add the correlation trace route
  (app/src/services/systemStatus.ts, app/src/routes/system.ts,
  app/test/systemStatus.service.test.ts, app/test/system.routes.test.ts) -
  4 files, +207 / -0

Both carry `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
Bare `git status` run before each; no MERGE_HEAD; explicit paths only.

## Test runs (strict TDD, failure observed before every implementation)

| # | Command | Result |
|---|---|---|
| 1 | `vitest run test/cloudwatch.adapter.test.ts -t "queryTrace"` (T8 RED) | 8 failed, 29 skipped (37) - every one `TypeError: seam.queryTrace is not a function` |
| 2 | `vitest run` on the three files (T8 GREEN) | 89 passed (adapter 37, service 36, routes 16) |
| 3 | `npm run typecheck` (root, bare) | PASS - all 5 workspaces |
| 4 | `vitest run test/systemStatus.service.test.ts test/system.routes.test.ts -t trace` (T9 RED, routes half) | 4 failed, 1 passed, 57 skipped: 3x `expected 404 to be 400/200` + the un-called service spy. (The `is admin-only` test PASSES pre-implementation - `requireRole('admin')` runs before routing, so a missing route still 403s. Expected, not a false green: the same test's 200/400 siblings were red.) |
| 5 | `vitest run test/systemStatus.service.test.ts -t getTrace` (T9 RED, service half) | 5 failed, 36 skipped (41) - every one `svc.getTrace is not a function`. (`-t trace` is case-sensitive and does NOT match `getTrace`; that is why the RED was taken in two runs.) |
| 6 | `vitest run` on the three files (T9 GREEN) | 99 passed (adapter 37, service 41, routes 21) |
| 7 | `npm run typecheck` (root, bare) | PASS - all 5 workspaces |

**The existing list-path tests passed UNCHANGED.** `git show --stat 32173e8c`
reports `app/test/cloudwatch.adapter.test.ts | 159 ++++` with ZERO deletions -
the file was only appended to. All 13 pre-existing `queryInsights` tests are
byte-identical and green, including `sort @timestamp desc` (:127), `@ptr`/`@log`
in the fields clause (:131-132), `startTime === Math.floor(sinceMs/1000)`
(:125 and :305), the epoch-SECONDS endTime test (:287-306), the StopQuery
budget-exhaustion test with fake timers (:256-285), the no-queryId throw, and
both Failed/Cancelled status throws. That is the proof the runInsights
extraction preserved behavior.

Not run (out of scope per the brief): `npm test`, `npm run smoke`,
`npm run e2e`, `npm run db:start`, docker, terraform.

ASCII: every added line of both commits scanned with
`git diff -U0 | grep '^+' | LC_ALL=C grep '[^ -~]'` - zero matches.

## The two hardest rules - how each was satisfied

**1. TWO QUERIES, OPPOSITE SORTS, IN PARALLEL.** `queryTrace` issues both
`runInsights` calls inside one `Promise.all` (cloudwatch.ts:676-679): BEFORE is
`sort @timestamp desc | limit 25` over `[startSec, anchorSec]` and its projected
lines are `.reverse()`d; AFTER is `sort @timestamp asc | limit 25` over
`[anchorSec + 1, endSec]` and is appended as-is. Merged ascending, at most 25
per side (`runInsights` slices raw rows to `limit`, so 50 is a hard ceiling even
if Insights over-returned). Pinned by `merges ascending across the two sides`
and by an ADDED test that asserts the command issue order is
`[StartQuery, StartQuery, GetQueryResults, GetQueryResults]` - sequential
execution would interleave `Start, Get, Start, Get`, so that test fails if
anyone rewrites the `Promise.all` as two awaits.

**2. THE SECOND BOUNDARY.** `anchorSec = Math.floor(atMs / 1000)`;
BEFORE's `endTime` IS `anchorSec` (inclusive, so the anchor line is guaranteed
present) and AFTER's `startTime` IS `anchorSec + 1`. No `Math.ceil` anywhere on
BEFORE's end. Bracket start `Math.floor((atMs - back) / 1000)` with
`back = BRACKET_TIGHT_MS (5 min)` for `correlationId` and `BRACKET_WIDE_MS
(30 min)` for `requestId`/`pollRunId`; bracket end
`Math.ceil((atMs + BRACKET_AHEAD_MS) / 1000)`. All four values are epoch
SECONDS. Pinned by `splits at second granularity with DISJOINT windows`
(which asserts `after.startTime > before.endTime`), the two-branch bracket test,
and an ADDED assertion that AFTER's `endTime` is the +5min ceil.

Also as specified: the filter is `filter ${kind} = "${id}"` and the id is
validated UUID-shaped at the SERVICE layer (`UUID_PATTERN`,
systemStatus.ts:141) BEFORE it can reach the query string - the seam trusts its
caller and says so in its docblock. `truncatedBefore/truncatedAfter` flag at
`>= TRACE_SIDE_LIMIT` PER SIDE. `traceLine` parses raw `@message` JSON with a
NESTED `err` (like the list path, unlike the detail path), defaults `level` to
30, and reuses `str`, `sourceOf` and `parseInsightsTimestamp` rather than
re-deriving them.

## runInsights extraction - what moved and what did not

`runInsights(logGroupNames, queryString, startTimeSec, endTimeSec, limit)` is a
local function inside `createCloudWatchClient` (it needs the `logs` binding) and
returns RAW rows. It carries, unchanged: the StartQuery send, the `queryId`
guard and its exact message, the `INSIGHTS_MAX_POLLS` x
`INSIGHTS_POLL_INTERVAL_MS` loop with the `poll > 0` delay, the
Complete/Failed/Cancelled/Timeout branches and their exact throw strings, the
best-effort StopQuery in a swallowing try/catch, and the budget-exhausted throw.

`queryInsights` KEEPS its own query-string build, its `Math.floor(sinceMs/1000)`
/ `Math.ceil(Date.now()/1000)` conversion, and its `projectErrorEvent` mapping.

## Divergences from the plan (all minor, none behavioral)

1. **`.slice(0, limit)` moved from `queryInsights` into `runInsights`**, where it
   applies to RAW rows instead of projected ones. `projectErrorEvent` is pure, so
   map-then-slice and slice-then-map are byte-identical outputs; doing it in
   `runInsights` ALSO gives the trace path the 25-per-side ceiling the Global
   Constraints require, without adding a slice the plan's pinned `queryTrace`
   body does not have. Every existing queryInsights test still passes.
2. **`traceSeam` (the pinned test helper) also returns an `order: string[]`** -
   additive, used only by the parallel-execution test above.
3. **`TRACE_SIDE_LIMIT` is NOT imported by the adapter test**; the pinned
   truncation test's literal `25` is kept. Importing a not-yet-existing export
   would have failed the whole FILE at import time and made the RED run
   unreadable instead of "not a function".
4. **D3 applied.** Service tests bind `const DEPLOYED_CONFIG = deployedConfig();`
   inside the new describe (the file has no `CONFIG` const). `fakeSeam` gained
   `queryTrace` in BOTH halves. `fakeService` in system.routes.test.ts gained a
   `getTrace` stub at :148, and so did the self-contained literal now at
   :242-257 (it is annotated `SystemStatusService`, so both were typecheck-hard
   requirements, confirmed by run 7).
5. **C6 respected.** `PATHS` (system.routes.test.ts:16) untouched - a bare
   `GET /trace` is 400 and would break the admin-200 loop.
6. **Tests added beyond the plan's pinned bodies**, each pinning a stated
   requirement the pinned bodies left unasserted:
   - adapter: the `fields @timestamp, @message, @log` clause + `filter
     requestId = "r-1"` + `limit 25` in BOTH query strings + `input.limit` 25 +
     the log-group pass-through + AFTER's `endTime`; the parallel issue order;
     a full `toEqual` on a projected INFO line (method/path/statusCode/
     durationMs/jobName/jobId/hopCount + `source: 'worker'` from `@log`); the
     unparseable line degrading at level 30 with `source: 'system'`.
   - service: kind/id/anchor pass-through + both truncation flags surfaced;
     local-env short-circuit ORDER (proved with a MALFORMED id, so
     `unavailable_local` beating `invalid_id` is a real assertion); a throwing
     seam -> `cloudwatch_error`.
   - route: a MISSING `at` is a 400 (the pinned body only covers `at=nonsense`);
     the well-formed request degrades at `available:false` rather than 500ing;
     the chosen kind, the id and the PARSED epoch-ms anchor reach the service.
7. **One header comment line added** to `app/src/routes/system.ts` (:10, the
   `/trace` route line), using ASCII `->` rather than the file's pre-existing
   U+2192 arrows, per "only added lines must be ASCII".

## Handoff notes for Slice G (T15 truth-up)

- `app/src/services/systemStatus.ts:2` still says **"Three reads"** and its :3-6
  list names only getFlags/getAlarms/getErrors. It is now **FIVE**: add
  `getErrorDetail(ref)` and `getTrace(kind, id, atMs)`. Left alone deliberately
  (Slice C made the same call): line :2 contains a non-ASCII section mark, so
  editing it forces the ASCII rewrite that G4 already owns in the same pass as
  the :15-22 PII tail. **The :15-22 PII docblock is UNSHIFTED** - Slice D added
  its imports below it, at :34-35.
- `app/src/routes/system.ts` PII sites shifted by **+1** (my :10 header line):
  the PII block is now **:16-20** (the retired claim is the last line, :20) and
  the "(PII-safe)" phrase on the `/errors` route comment is now **:65**.
  The trace route's own comment (:104-106) already states the new posture.
- No `.superpowers` edits other than this report. No dashboard, e2e, infra, or
  docs files touched.

## LINE ANCHORS for Slice G (post-e005b417, verified)

### app/src/adapters/cloudwatch.ts - 505 -> **686** lines (+181)

| Anchor | New line |
|---|---|
| file header PII block (Slice G owns, untouched) | 12-14 |
| `export interface ErrorEventView` | 93-127 |
| `export interface LogRecordView` | 191-202 |
| **`export type TraceIdKind`** | **205** |
| **`export interface TraceLineView`** (docblock 207-215) | **216-234** |
| **`export interface TraceResult`** (docblock 236) | **237-244** |
| **`export const TRACE_SIDE_LIMIT = 25`** | **247** |
| **`BRACKET_TIGHT_MS` / `BRACKET_WIDE_MS` / `BRACKET_AHEAD_MS`** | **249 / 251 / 253** |
| `export interface CloudWatchClientSeam` | 256-283 |
| - `queryInsights` member | 266 |
| - `getLogRecord` member | 273 |
| - **`queryTrace` member** (docblock 274-281) | **282** |
| `export function projectErrorEvent` | 331-402 |
| **`function traceLine`** (docblock 404-414) | **415-457** |
| `parseInsightsTimestamp` (private, docblock 459-462) | 463-467 |
| `export function createCloudWatchClient` | 517 |
| - **`async function runInsights`** (docblock 521-531) | **532-580** |
| - `async queryInsights` (now 14 lines) | 594-607 |
| - `async getLogRecord` | 609-644 |
| - **`async queryTrace`** | **646-684** |
| end of returned object / function | 685 / 686 |

### app/src/services/systemStatus.ts - 318 -> **367** lines (+49)

| Anchor | New line |
|---|---|
| header "Three reads" list (Slice G - now FIVE reads) | 1-13 |
| PII docblock tail (Slice G rewrites; UNSHIFTED) | 15-22 |
| adapter import block (gained `TraceIdKind`, `TraceLineView`) | 23-36 |
| `export type DetailResult` | 118-120 |
| **`export type TraceServiceResult`** (docblock 122-126) | **127-129** |
| `const REF_PATTERN` | 132 |
| **`const UUID_PATTERN`** (docblock 134-140) | **141** |
| **`export interface SystemStatusService`** | **143-169** |
| - `getErrors` member | 154 |
| - `getErrorDetail` member | 161 |
| - **`getTrace` member** (docblock 162-167) | **168** |
| `isLocalEnv` (private) | 185-187 |
| `createSystemStatusService` | 200 |
| `async getErrors` | 259-315 |
| `async getErrorDetail` | 317-338 |
| **`async getTrace`** | **340-360** |
| end of returned object / factory | 361 / 362 |
| `isSystemErrorWindow` | 365-367 |

### app/src/routes/system.ts - 102 -> **124** lines (+22)

| Anchor | New line |
|---|---|
| header route list (**new `/trace` line at :10**) | 6-10 |
| **PII claim (Slice G rewrites; SHIFTED +1)** | **16-20** |
| **"(PII-safe)" on the `/errors` comment (SHIFTED +1)** | **65** |
| `export function createSystemRouter` | 38 |
| `router.use(requireRole('admin'))` (covers every route) | 47 |
| `router.get('/flags'` / `/alarms'` / `/errors'` | 50 / 56 / 67 |
| `router.get('/errors/detail'` (comment 90-92) | 93-100 |
| **`const TRACE_ID_KINDS`** | **102** |
| **`router.get('/trace'`** (comment 104-106) | **107-121** |
| `return router;` | 123 |

### app/test/cloudwatch.adapter.test.ts - 504 -> **663** lines (+159, append-only)

- `CONFIG` 34 (LOCAL-env config), `fakeCw` 37-39 - unshifted.
- `describe('cloudwatch adapter - queryInsights')` 95-323 - **byte-unchanged**.
- `describe('projectErrorEvent - widened projection')` 325-376 - unchanged.
- `describe('cloudwatch adapter - getLogRecord')` 378-504 - unchanged.
- **`describe('cloudwatch adapter - queryTrace')` 506-663** (helper `traceSeam`
  507-528, `row` 529-533).
- **END-OF-FILE APPEND POINT: after line 663.**

### app/test/systemStatus.service.test.ts - 550 -> **626** lines (+76)

- `localConfig()` 29-32, `deployedConfig()` 34-38 - unshifted.
- **`fakeSeam` 40-63** (was 40-59): annotation 42-47 (`queryTrace:
  ReturnType<typeof vi.fn>;` at 46), literal 48-62 with the `queryTrace` stub at
  59-61. `makeService` 65-67 (was 61-63).
- Everything below shifted **+4**: `getErrors` describe 232-480,
  `isSystemErrorWindow` 482-489, `getErrorDetail` describe 491-554.
- **`describe('systemStatus.getTrace')` 556-626.**
- **END-OF-FILE APPEND POINT: after line 626.**
- Fixture refs in use: `PTR-1`..`PTR-8`, `PTR-A`/`PTR-B`. Slice D added no new
  `PTR-` fixtures (the trace path has no `ref`).

### app/test/system.routes.test.ts - 265 -> **329** lines (+64)

- `PATHS` closed 3-route list: 16 - untouched (C6).
- **`const fakeService: SystemStatusService` literal 116-149**; `getErrorDetail`
  stub 147, **`getTrace` stub 148**.
- `describe('GET /api/system/errors/detail')` 208-267; its self-contained
  `SystemStatusService` literal (the copy idiom) now **242-258**, with the
  `getTrace` stub at 257.
- **`describe('GET /api/system/trace')` 269-329** - `auth` helper 270,
  `AT` 271, `UUID` 272; its own self-contained service literal 308-324.
- **END-OF-FILE APPEND POINT: after line 329.**
- Shared fixture value for later slices: the trace UUID is
  `11111111-2222-4333-8444-555555555555` (used in both test files).
