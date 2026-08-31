# SLICE E report - T10 wire layer, T11 hooks (2026-08-24)

Branch feat/error-surface-detail. Started at e005b417, ends at f5922e2e. Tree clean.

## Commits

- `e35b0cdf` feat(observability): mirror the widened error contracts in the dashboard
  (T10) - dashboard/src/api/types.ts, dashboard/src/api/endpoints.ts,
  dashboard/src/routes/settings/RecentErrors.test.tsx. 3 files, +104/-7.
- `f5922e2e` feat(observability): add detail and trace fetch hooks
  (T11) - dashboard/src/routes/settings/useSystemStatus.ts. 1 file, +86/-0.

Both carry `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
(The T10 commit was amended once, immediately after creation, to strip a shell
quoting artifact from the subject line. No other history rewriting.)

## Verification (per run)

| Run | Command | Result |
|---|---|---|
| T10 tests | `dashboard> npx vitest run src/routes/settings/RecentErrors.test.tsx src/routes/settings/SystemStatusSection.test.tsx` | 2 files / 13 tests PASS (RecentErrors 9, SystemStatusSection 4) |
| T10 gate | `npm run typecheck` (root, bare) | PASS - all 5 workspaces |
| T11 tests | same two files | 2 files / 13 tests PASS (9 + 4) |
| T11 gate | `npm run typecheck` (root, bare) | PASS - all 5 workspaces |

ASCII check on added diff lines both times:
`git diff -U0 <files> | grep '^+' | LC_ALL=C tr -d '\11\12\15\40-\176' | wc -c` = 0.

No pre-existing red encountered. No importer/contract mismatch: the mirrored
types were diffed against the live backend declarations (cloudwatch.ts:80,
:93-125, :191-244; systemStatus.ts:118-129) and the two routes (system.ts:93-121)
before writing.

## What landed

### T10 - dashboard/src/api/types.ts

- `SystemErrorSource` added directly after the `SystemAlarm` interface (so the
  existing `SystemErrorEvent` docblock stays attached to its interface - that
  docblock is Task 15/G4's to rewrite, and it was NOT touched here).
- `SystemErrorEvent` widened to the pinned 15-field shape. `source` and `ref`
  REQUIRED and non-null; `messageTruncated` / `errMessageTruncated` REQUIRED
  booleans; the eight new optionals follow the `?: string | null` convention.
- `SystemLogRecord`, `SystemTraceLine`, `SystemErrorDetailResult`,
  `SystemTraceResult` added after `SystemErrorsResult`. Both result types are
  DISCRIMINATED unions on `available` (Task 13's narrowing depends on it);
  `reason` is `string` on both, as pinned - deliberately wider than the backend's
  literal unions.

### T10 - dashboard/src/api/endpoints.ts

- `SystemErrorDetailResult` and `SystemTraceResult` added to the existing
  `import type` block (alphabetical, alongside `SystemAlarmsResult` etc.).
- `getSystemErrorDetail(ref, signal?)` and
  `getSystemTrace(kind, id, at, signal?)` added directly after `getSystemErrors`,
  both using the shared `request()` helper with the `query` option and the
  conditional `...(signal !== undefined && { signal })` spread, exactly like
  `getSystemErrors`. The pointer-encoding docblock is carried verbatim from the
  plan.
- No barrel edit: `dashboard/src/api/index.ts` re-exports both modules with
  `export *`.

### T10 - RecentErrors.test.tsx fixtures

Fixtures only; the barrel-mock mechanism (`vi.mock('../../api/index.js')` with
`importActual` spread) and every existing assertion are untouched. Slice F owns
new tests in this file.

- The two-event fixture (was :67-68) gained `messageTruncated: false`,
  `errMessageTruncated: false`, `source: 'app'`, `ref: 'PTR-A'` / `'PTR-B'`;
  expanded from one-liners to multi-line literals.
- The Twilio 30034 fixture (was :88-92) gained the same four with `ref: 'PTR-C'`.
- Types were NOT weakened anywhere.

### T11 - useSystemStatus.ts

- Import block gained `getSystemErrorDetail`, `getSystemTrace`,
  `type SystemErrorDetailResult`, `type SystemTraceResult` (+4 lines).
- `useErrorDetail()` and `useErrorTrace()` appended verbatim from the pin -
  `abortRef` supersede pattern, `setStatus('loading')` on load, aborted-guard
  before every setState, `DOMException`/`AbortError` guard in `catch`,
  `useCallback` deps `[]`, `reset()` that aborts and clears.
- `FetchStatus` is unchanged (`'loading' | 'ready' | 'error'`); both hooks
  initialise `'ready'` with `result === null`, so a never-loaded hook is
  `ready` + `null`. **Slice F must handle that pair** - it is NOT an error state.

## Divergences from the pin (2, both deliberate)

1. **T10, types.ts:** the pinned `SystemErrorEvent` block replaced the five
   existing per-field docblocks (which were non-ASCII and included the now-retired
   claim "The log's short message - never a body/PII payload"). Following the pin
   literally removes that stale PII claim; the interface's own docblock (the
   `GET /api/system/errors ... (PII-safe projection ONLY)` line) was left in place
   because worklist G4 assigns it to Task 15.
2. **T11, useSystemStatus.ts header:** the file header enumerated exactly three
   hooks. Five ASCII comment lines were added listing the two new on-demand reads,
   so the header does not go stale - nothing else in the mission owns this file's
   header. This is the source of 5 of the 9 shifted lines below. A 7-line ASCII
   section comment (`// --- Row detail + correlation trace (on demand) ---`, padded
   to 79 chars to match the file's other three section rules) precedes the hooks;
   the hook bodies themselves are byte-for-byte the pin.

## LINE-SHIFT DATA FOR TASK 15 (G2 perf ledger)

`dashboard/src/routes/settings/useSystemStatus.ts`

- New total: **320 lines** (was 235). Net +85 = +5 header, +4 imports, +76 hooks.
- All insertions are ABOVE line 36 or BELOW line 244, so **every line in the
  alarms/errors region shifted by exactly +9**. Verified by identity check:
  old :77 == new :86, old :124 == new :133, old :132 == new :141.

| Ledger site | Current pinned string | Recompute to |
|---|---|---|
| `e2e/performance/routes.ts:680` (the `/settings/system` base, second citation) | `dashboard/src/routes/settings/useSystemStatus.ts:77-132` | `dashboard/src/routes/settings/useSystemStatus.ts:86-141` |
| `e2e/performance/routes.ts:762` (`background.systemAlarms`) | `dashboard/src/routes/settings/useSystemStatus.ts:124-132` | `dashboard/src/routes/settings/useSystemStatus.ts:133-141` |
| `e2e/performance/collect.test.ts:353` (pinned literal, must equal routes.ts:762 byte-for-byte) | `dashboard/src/routes/settings/useSystemStatus.ts:124-132` | `dashboard/src/routes/settings/useSystemStatus.ts:133-141` |

Reference points in the NEW file: `// --- Flags` :36, `// --- Alarms` :81,
`useSystemAlarms` declaration :91, initial-load effect :122-127, auto-refresh
effect :132-161, `// --- Errors` :170, `useSystemErrors` :186,
`// --- Row detail + correlation trace` :245, `useErrorDetail` :253,
`useErrorTrace` :286.

Negative pin (`collect.test.ts:366`) is satisfied: neither `86-141` nor `133-141`
contains the substring `140-155`.

The endpoint registry is untouched, per G3.

## WHAT SLICE F CONSUMES (exact names)

All from the barrel: `import { ... } from '../../api/index.js';` - never from
`types.js` / `endpoints.js` directly.

Types (`dashboard/src/api/types.ts`):

- `SystemErrorSource` = `'app' | 'worker' | 'system' | 'unknown'`
- `SystemErrorEvent` - `timestamp, level, message, messageTruncated,
  correlationId, errorCode?, jobName?, event?, errType?, errMessage?,
  errMessageTruncated, requestId?, pollRunId?, source, ref`
- `SystemLogRecord` - `fields: Record<string, string>`, `rawText?`,
  `rawTextTruncated?`, `responseTruncated`, `logGroup`
- `SystemTraceLine` - `timestamp, level, message, source, method?, path?,
  statusCode?, durationMs?, jobName?, jobId?, hopCount?`
- `SystemErrorDetailResult` = `{ available: true; record: SystemLogRecord }` |
  `{ available: false; reason: string }`
- `SystemTraceResult` = `{ available: true; lines: SystemTraceLine[];
  truncatedBefore: boolean; truncatedAfter: boolean }` |
  `{ available: false; reason: string }`

Client functions (`dashboard/src/api/endpoints.ts`) - these are the names the
Slice F barrel mock must add to its `importActual` factory, each
`mockResolvedValue`d with a degraded result by default (never a bare `vi.fn()`):

- `getSystemErrorDetail(ref: string, signal?: AbortSignal): Promise<SystemErrorDetailResult>`
- `getSystemTrace(kind: 'correlationId' | 'requestId' | 'pollRunId', id: string, at: string, signal?: AbortSignal): Promise<SystemTraceResult>`

Hooks (`dashboard/src/routes/settings/useSystemStatus.ts`):

- `useErrorDetail(): { status: FetchStatus; result: SystemErrorDetailResult | null;
  load: (ref: string) => void; reset: () => void }`
- `useErrorTrace(): { status: FetchStatus; result: SystemTraceResult | null;
  load: (kind, id, at) => void; reset: () => void }`

F3 note confirmed against the shipped signature: the trace assertion should read
`expect(getSystemTrace).toHaveBeenCalledWith('requestId', 'r-1', base.timestamp, expect.anything())`
- `at` is the row's ISO `timestamp` STRING (the route parses it with `Date.parse`),
and the 4th arg is an `AbortSignal`, always passed (never undefined) by the hook.
