# SLICE B REPORT - Tasks 4 + 5 (error-surface-detail)

Status: BOTH TASKS DONE AND GREEN. Branch feat/error-surface-detail.
No unexpected importer/contract mismatch. No pre-existing red encountered.

## Commits

- `cd608a63` feat(observability): widen the error projection past the four-field allowlist
  (app/src/adapters/cloudwatch.ts, app/test/cloudwatch.adapter.test.ts,
  app/test/systemStatus.service.test.ts, app/test/system.routes.test.ts) - 4 files,
  +241 / -56
- `0448676a` feat(observability): dedup error rows on the log-event pointer
  (app/src/services/systemStatus.ts, app/test/systemStatus.service.test.ts) - 2 files,
  +27 / -1

Both carry `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
Bare `git status` run before each; explicit paths only; no MERGE_HEAD.

## Test runs (strict TDD, failure observed before every implementation)

| # | Command | Result |
|---|---|---|
| 1 | `vitest run test/cloudwatch.adapter.test.ts` (T4 RED) | 7 failed, 12 passed (19) - 6 new + the `@ptr`/`@log` queryString assertion; `projectErrorEvent is not a function` |
| 2 | same, after implementing | 19 passed (19) |
| 3 | `vitest run` on the three files (after all 9 fixtures) | 60 passed (adapter 19, service 29, routes 12) |
| 4 | `npm run typecheck` (root, bare) | PASS - all 5 workspaces |
| 5 | `vitest run test/systemStatus.service.test.ts -t "same-instant rows"` (T5 RED) | 1 failed, 29 skipped - `expected [ {...} ] to have a length of 2 but got 1` (collapsed by timestamp\|message\|errorCode), exactly as the plan predicted |
| 6 | `vitest run` on the three files | 61 passed (adapter 19, service 30, routes 12) |
| 7 | `npm run typecheck` (root, bare) | PASS |

Not run (out of scope per the brief): `npm test`, `npm run smoke`, `npm run e2e`,
`npm run db:start`, docker, terraform.

## Divergences from the plan (all worklist-directed, none discretionary)

1. **B1 scope add applied.** `app/test/system.routes.test.ts` carried a 9th
   `ErrorEventView` fixture the plan misses: the literal inside
   `const fakeService: SystemStatusService` and the exact-match
   `expect(res.body).toEqual(...)` in the "?since window" test. Both updated with
   `source: 'app'`, `ref: 'PTR-R1'`, `messageTruncated: false`,
   `errMessageTruncated: false` and committed with T4. Confirmed: without it the
   tree is red (the annotated literal fails typecheck on the new required members,
   and the toEqual is exact).
2. **B3 applied.** T5's pinned test used `CONFIG`, which does not exist in
   `systemStatus.service.test.ts`; used the file's `deployedConfig()` helper.
   Required, not cosmetic - `localConfig()` would short-circuit `getErrors` to
   `unavailable_local` and the test would pass/fail for the wrong reason.
3. **B6 docblock rewrites done** (ASCII, PII posture): the `ErrorEventView`
   docblock + its per-field comments, the `queryInsights` member docblock on
   `CloudWatchClientSeam`, and the `projectErrorEvent` docblock (the plan's pinned
   PII POSTURE text verbatim). The old in-body comment "A provider error code ...
   PII-safe" died with the function rewrite, as B6 predicted. The file header
   (cloudwatch.ts:12-14) was NOT touched - Slice G owns it.
4. Cosmetic only: the routes fixture is formatted multi-line (it exceeded a sane
   single-line width); the 8 service fixtures stayed single-line as they were.

## Correctness rules - how each was satisfied

- NESTED `err`: `parsed['err']` is read as an object and `err['message']` /
  `err['type']` / `err['name']` off it. No dotted key anywhere on this path.
  Pinned by the test "reads a NESTED err object, not a dotted key".
- `sourceOf` compares the normalised `@log` against `config.errorLogGroupName`,
  `workerLogGroupName`, `systemLogGroupName`; `9:/hc/otherenv/app` -> `'unknown'`.
  No suffix matching.
- Ladder `msg -> message -> event -> err.message -> '(unparseable log line)'`
  (the `message` alias rung is carried over from the old code). When `message`
  came FROM `err.message`, `errMessage` is null (single render).
- PRESERVED: `sort @timestamp desc` assertion; `'(unparseable log line)'`
  behavior and the raw-text-never-on-the-list-path comment; the OOM relabeling in
  systemStatus.ts; the LIST query's `Math.floor(sinceMs/1000)` /
  `Math.ceil(Date.now()/1000)` epoch convention.
- ASCII: every added diff line scanned with `LC_ALL=C grep '[^ -~\t]'` - clean on
  both commits.

## LINE SHIFTS for later slices (post-0448676a, verified)

### app/src/adapters/cloudwatch.ts - 284 -> **385** lines (+101)

| Anchor | New line |
|---|---|
| file header PII block (Slice G owns, untouched) | 12-14 |
| `export type ErrorSource` | 79 |
| `export const FIELD_CAP = 300` | 82 |
| `export interface ErrorEventView` (docblock 84-91) | 92-126 |
| `export interface CloudWatchClientSeam` | 129-140 |
| `queryInsights(...)` member (add `getLogRecord` / `queryTrace` after 139, before the `}` at 140) | 139 |
| `export function normalizeLogGroup` | 150-153 |
| `function sourceOf` | 155-164 |
| `function capped` | 166-170 |
| `function str` | 172-174 |
| **`export function projectErrorEvent`** (docblock 176-187) | **188-259** |
| `function parseInsightsTimestamp` | 265-268 |
| `classifyCloudWatchError` | 291 |
| `export function createCloudWatchClient` | 319 |
| `async queryInsights(` (method body 336-383) | 336 |
| `const queryString` (now `@timestamp, @message, @ptr, @log`) | 338 |
| `startTime: Math.floor` / `endTime: Math.ceil` (LIST convention, keep) | 344 / 345 |
| poll loop (Slice D extracts `runInsights` from here) | 354-374 |
| `return rows.map((row) => projectErrorEvent(row, config)).slice(0, limit);` | 366 |
| StopQuery + budget-exhausted throw | 376-382 |

New module-local helpers Slice C/D can reuse: `normalizeLogGroup` (exported -
T6's `getLogRecord` needs it for `logGroup`), `sourceOf`, `capped`, `str`.
T8's `traceLine` should reuse `str` / `sourceOf` rather than re-deriving.

### app/src/services/systemStatus.ts - 270 -> **274** lines (+4)

| Anchor | New line |
|---|---|
| PII docblock tail (Slice G rewrites :21-22) | 15-22 (unchanged) |
| OOM labels (still true, leave) | 51-53 |
| `SystemStatusService` interface (add `getErrorDetail` / `getTrace`) | 109-121 |
| `isLocalEnv` (private) | 137-139 |
| `createSystemStatusService` | 152 |
| `async getErrors` | 211 |
| OOM relabeling (preserved) | 236-240 |
| `const seen = new Set<string>()` | 244 |
| merge chain `const events = [...]` | 245-257 |
| **dedup `.filter((e) => {` block** (new comment 247-250) | **246-255** |
| `const key = \`${e.ref}\|${e.timestamp}\|${e.message}\|${e.errorCode ?? ''}\`` | **251** |

### app/test/systemStatus.service.test.ts - 450 -> **476** lines (+26)

- `localConfig()` 28-31, `deployedConfig()` 33-37 (both UNSHIFTED).
- **`fakeSeam` 39-50 - UNSHIFTED** (return-type annotation 42-45, literal 46-49).
  Slice C adds `getLogRecord` to both halves; Slice D adds `queryTrace`.
  (Worklist C1's ":39-50" is correct; the plan's ":38-50" is off by one.)
- `makeService` 52-54 (UNSHIFTED). Every fixture edit was at line 250 or below.
- Filter-discrimination idiom to copy: 323-326 (the Twilio `fail` test) and
  441-444 (the new T5 test).
- New T5 test `keeps two same-instant rows from different log groups apart`:
  429-449.
- Fixture refs in use: `PTR-1`..`PTR-8` (service) and `PTR-R1` (routes). Slice C/D
  should pick `PTR-9`+ to stay distinct.

### app/test/system.routes.test.ts - 183 -> **204** lines (+21)

- `PATHS` closed 3-route list: **16** (leave alone per C6).
- `const fakeService: SystemStatusService` literal: **116-147** (was 116-136).
  Slice C adds a `getErrorDetail` stub here; Slice D adds `getTrace`.
- `getErrors: vi.fn<...>` starts **132**; its events fixture 134-145.
- The exact-match `expect(res.body).toEqual(...)` mirror: **168-182**.

### app/test/cloudwatch.adapter.test.ts - 317 -> **373** lines (+56)

- File header PII claim (now overstated: says "timestamp, level, message,
  correlationId ONLY"): **7-9**. Slice G4 lists :7 as "extend per spec" - the
  sentence to extend now spans 7-9.
- `'(unparseable log line)'` PII comment + assertion: **133-134** (was 129-130) -
  still true for the LIST path, preserve.
- Imports 21-28 (`projectErrorEvent` added); `CONFIG` 31; `fakeCw` 34-36.
  `StartQueryCommand`/`GetQueryResultsCommand` already imported at 15-19.
- `describe('cloudwatch adapter - queryInsights')` 92-320; the `@ptr`/`@log`
  queryString assertions 127-129 (comment at 127).
- New `describe('projectErrorEvent - widened projection')`: **322-373**.
  Slice C/D append their describes after 373 (end of file).

## Notes for the orchestrator

- `dashboard/src/routes/settings/RecentErrors.test.tsx` fixtures are NOT yet
  updated (Slice E / worklist E1 owns them). The dashboard mirrors the backend
  types by hand, so `npm run typecheck` is currently green anyway - the break
  arrives only when Slice E widens `dashboard/src/api/types.ts`.
- The `queryInsights` seam signature is unchanged, so nothing outside these files
  needed touching.
