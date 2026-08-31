# SLICE F report - T13 ErrorTrace, T12 widened row + expander (2026-08-24)

Branch feat/error-surface-detail. Started at f5922e2e, ends at 17928dcd. Tree clean.

## Commits (T13 first, as F1 requires - T12 imports ErrorTrace)

- `8b4cac96` feat(observability): add the correlation trace view (T13) -
  ErrorTrace.tsx (NEW), ErrorTrace.test.tsx (NEW), SystemStatusSection.module.css.
  3 files, +232/-0.
- `17928dcd` feat(observability): widen the error row and add the detail expander
  (T12) - RecentErrors.tsx, RecentErrors.test.tsx, SystemStatusSection.module.css.
  3 files, +468/-5.

Both carry `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
Each was amended ONCE immediately after creation, before any report: the T13 one
to strip a PowerShell here-string artifact from the subject (pre-amend 52b38c05),
the T12 one to apply the `.errorDetail` class reconciliation in divergence 1
below (pre-amend 559379ba). No other history rewriting.

## Verification (per run, bare commands, absolute cwd)

| Run | Command | Result |
|---|---|---|
| T13 RED | `dashboard> npx vitest run src/routes/settings/ErrorTrace.test.tsx` | FAIL to collect - "Failed to resolve import ./ErrorTrace.js". 0 tests. |
| T13 GREEN (file) | same | 1 file / **7 tests PASS** |
| T13 GREEN (dir) | `dashboard> npx vitest run src/routes/settings/` | 16 files / **144 tests PASS** |
| T13 gate | `npm run typecheck` (root, bare) | PASS - all 5 workspaces |
| T12 RED | `dashboard> npx vitest run src/routes/settings/RecentErrors.test.tsx` | 24 tests: **14 failed / 10 passed** (9 pre-existing + 1 new that passes vacuously pre-implementation, see note) |
| T12 GREEN (file) | same | 1 file / **24 tests PASS** (9 pre-existing + 15 new) |
| T12 GREEN (dir) | `dashboard> npx vitest run src/routes/settings/` | 16 files / **159 tests PASS** |
| T12 gate | `npm run typecheck` (root, bare) | PASS - all 5 workspaces |
| post-amend re-run | dir tests + root typecheck | 16 files / 159 PASS; typecheck PASS |

RED note: `does not render errMessage when the ladder already put it in message`
passed before implementation because the old row rendered no errMessage at all.
It is still load-bearing after (it fails if a null errMessage ever renders, or if
`message` is duplicated). Every other new test failed for the right reason
("Unable to find ... app / relay.warmNumber / RestException / /truncated/i /
button /show all/i / button /^trace$/i").

ASCII check on added diff lines, every commit:
`git diff -U0 <files> | grep '^+' | LC_ALL=C tr -d '\11\12\15\40-\176' | wc -c` = 0
for all five touched files.

No pre-existing red. The one `act(...)` warning in the settings-directory run is
PRE-EXISTING and comes from `NumbersSection.test.tsx` ("shows a loading spinner
before the fetch resolves"); my two files emit zero act warnings when run alone.
No importer/contract mismatch: the only importers of RecentErrors/ErrorTrace are
inside `dashboard/src/routes/settings/`, which the directory run covers in full.
Slice E's shipped signatures matched its report exactly.

## What landed

### T13 - `W:\tmp\error-surface-detail\dashboard\src\routes\settings\ErrorTrace.tsx`

The pinned component, byte-for-byte in behavior: `useErrorTrace` + a
`useEffect` load keyed `[load, kind, id, at]`; spinner while loading; `role="alert"`
on a true failure; DEGRADED and EMPTY as DISTINCT copy; `<ol>`/`<li>` timeline
with a source chip per line; the anchor (`l.timestamp === at`) marked by the TEXT
"this failure" as well as by `.traceAnchor`; per-side truncation notices above
and below the list. A 12-line ASCII header block was added (the pin has none);
every other line is the pin.

Tests (7): pivot args passed through (`getSystemTrace` called with kind/id/at);
order + source chips; anchor by TEXT; truncation BEFORE side; truncation AFTER
side (added - the pin only covers BEFORE); empty vs degraded distinct in both
directions; a rejected fetch reads as an alert, not as an empty trace (added).

### T12 - `...\dashboard\src\routes\settings\RecentErrors.tsx`

- `import { useState } from 'react';` added (the file imported nothing from react).
- `tracePivot()` and `SOURCE_LABEL` added verbatim from the pin.
- `ErrorRow` extended per the pinned JSX; every pre-existing affordance kept
  (errorCode chip, `id: <correlationId>` line, warn styling) - tests :79/:81/:99/:100
  still pass untouched.
- Row key is now `ev.ref`.
- `ErrorDetail` written per worklist F7 (the plan left it unspecified).
- Buttons wrapped in a `.errorActions` row.

Tests (15 new, in three new describes): four-value source chip; jobName-else-event
chip (both branches); errType chip; truncated message marker; errMessage + its OWN
flag with `getAllByText(/truncated/i)` length 1; no errMessage when null; per-row
expander state for two same-looking rows; aria-expanded toggle with `load` on OPEN
only (call count stays 1 after open->close); trace pivot precedence proven for ALL
THREE kinds with the row timestamp as `at`; NO trace control when all three ids are
null; trace hides on second click; detail degraded (local) vs degraded (other
reason); fields+stack+rawText+both truncation markers; rawText and its marker
omitted when absent.

### CSS - `SystemStatusSection.module.css`

Commit 1: `.traceList`, `.traceLine`, `.traceAnchor`.
Commit 2: `.errorChip`, `.truncated`, `.errorActions`, `.errorDetail`,
`.detailBlock`, `.detailFields`, `.detailField`, `.detailKey`, `.detailValue`,
`.detailStack`, `.detailRaw`. All token-only (`var(--sp-N)`, `var(--c-*)`,
`var(--fs-*)`, `var(--radius-*)`, `var(--font-mono, monospace)`), following the
file's `.errorCode` / `.errorLevel` conventions. Status is conveyed by TEXT as
well as colour throughout (file-header rule): the anchor carries "this failure",
the truncation classes only style words that already say what happened.

## Divergences from the pin (4, all deliberate)

1. **`.errorDetail` vs `.detailBlock`.** The pinned row JSX puts
   `styles.errorDetail` on the errMessage paragraph (which is what worklist F5
   means when it says the plan's Step 4 forgets the class). I first put it on the
   ErrorDetail container instead; the amend restores the pin exactly - errMessage
   gets `.errorDetail` (a muted secondary text line), and the expanded-record
   container gets a new `.detailBlock` in the `detail*` family. No test depends on
   either (css:false), but the pinned JSX now matches literally.
2. **The two row controls use the repo's `<Button variant="secondary" size="sm"
   type="button">` rather than the pin's bare `<button>`.** `Button` renders a
   real `<button>` and spreads `aria-expanded` straight through
   (`ui/Button.tsx:66-75`), so the spec's a11y contract and the accessible names
   are unchanged - but the panel's other controls (Refresh, Retry) are `Button`s,
   and two browser-default buttons in the middle of the row failed the UI bar.
3. **ErrorTrace does NOT render `level` or the per-row diagnostic fields**
   (method/path/statusCode/durationMs/jobName/jobId/hopCount) that spec S6's
   TRACE VIEW paragraph mentions. The plan's pinned component renders
   timestamp + source + message only, and the worklist's authority order puts the
   plan above the spec. Flagged below for self-QA - it is additive if wanted.
4. **Test-shape adaptations mandated by worklist F2/F3** (not really divergences,
   recorded for the reviewer): no `RecentErrorsHarness` exists, so rows are driven
   by a local `renderRows(events)` helper that sets
   `getSystemErrors.mockResolvedValue` and renders `<RecentErrors />` with no
   props; every assertion is awaited (`findBy*`) because the fetch is async; the
   trace-kind assertion is
   `expect(getSystemTrace).toHaveBeenCalledWith(kind, id, base.timestamp, expect.anything())`
   instead of the plan's non-existent `getByTestId('trace-kind')`. No new testids
   were introduced anywhere.

## Accessible names and exact strings shipped (for Slice G's e2e assertions)

**Row controls** (rendered ONLY when the errors read is `available:true` AND the
window has rows - the degraded state renders no rows at all, so
`getByRole('button', { name: 'Show all' })` and `'Trace'` are `toHaveCount(0)` in
the hermetic degraded state, exactly as G7 needs):

- Button `Show all` <-> `Hide details`, with `aria-expanded="false"|"true"`.
- Button `Trace` <-> `Hide trace`; ABSENT when requestId, pollRunId and
  correlationId are all null.

**Row chips** (plain `<span>`s, no role): the source label is one of
`app` / `worker` / `host` / `unknown` (`system` reads as **host**); then
jobName-else-event; then errType; then the pre-existing `error <code>`.

**Truncation markers** (each a `<span>` whose own text is ` (truncated)`, so
`getByText(/truncated/i)` matches the span and NOT its parent paragraph):
one on the message line, a SEPARATE one on the errMessage line.

**ErrorDetail** (inside an expanded row):

- degraded, `reason === 'unavailable_local'`: `Available in deployed environments.`
- degraded, ANY other reason: `Could not load the full record.`
- true fetch failure: `role="alert"`, `Couldn't load details for this row.`
- loading: Spinner. `result === null`: renders nothing.
- fields: a `<dl>` of `<dt>{key}</dt><dd>{value}</dd>`, **sorted by key**, with
  `err.stack` EXCLUDED from the list and rendered in its own `<pre>` scroll
  container (`max-height: 240px; overflow: auto`).
- `rawText` in its own `<pre>` when present.
- `Raw text was cut off (limit reached).`
- `Some fields were cut off (response limit reached).`
- `log group: <logGroup>` as the last line.

**ErrorTrace**:

- loading: Spinner. true failure: `role="alert"`, `Couldn't load the trace.`
- never-loaded (`result === null`): `No trace loaded.`
- degraded (any reason): `Available in deployed environments.`
- empty: `No lines found around this event.`
- lines: `<ol>` of `<li>` (role `listitem`), each = raw ISO timestamp + source
  chip + message; the anchor line adds a chip whose text is exactly
  `this failure`.
- `Earlier lines were cut off (limit reached).` /
  `Later lines were cut off (limit reached).`

**Degraded-string count (F6) is safe:** neither component renders
`Available in deployed environments.` until an operator clicks, and the errors
panel renders no rows while degraded, so `SystemStatusSection.test.tsx:67`
(EXACTLY 2 page-wide on initial load) and `settings.spec.ts:156` still hold -
verified green in the 16-file run.

## For self-QA / the reviewer to eyeball

1. **Trace source chip shows the RAW union value** (`system`), while the row's
   source chip maps `system -> host` via SOURCE_LABEL. That asymmetry is the pin's;
   decide whether the trace should use SOURCE_LABEL too.
2. **Divergence 3**: no `level` and no diagnostic fields on trace rows (spec S6
   asks for them, the plan's pin omits them).
3. **`RecentErrors.tsx:1-10` still carries the retired "PII-SAFE projection ONLY"
   claim**, and `RecentErrors.test.tsx:2` / `:63` still say "PII-safe". Worklist G4
   assigns all three to Task 15; I deliberately left them so T15 owns one coherent
   rewrite. Same for the `SystemErrorEvent` docblock in types.ts.
4. **Commit 1 in isolation** renders `styles.errorChip` / `styles.truncated` from
   ErrorTrace before commit 2 defines those classes (the plan splits the CSS that
   way). The branch as a whole is consistent; only a bisect landing exactly on
   8b4cac96 would show unstyled chips.
5. Re-open of an already-fetched row **refetches** (the pin's `if (!open)
   detail.load(...)`). Intentional and asserted; a record can change (it cannot,
   but the read is cheap and always fresh).
6. Live look worth taking: two `Button variant="secondary" size="sm"` controls
   inside a row, plus the `.detailBlock` on `--c-surface-2` inside the row's own
   `--c-surface` card - nesting reads fine in the tokens but has not been seen in
   a browser (no e2e/live run was in this slice's scope).

Not run, per the brief: `npm test`, `npm run smoke`, `npm run e2e`, `db:start`,
docker, terraform.
