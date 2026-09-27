# Slice S4 report - dashboard Part 2 data (plan Task 6)

Date: 2026-09-27
Branch: `feat/staff-notes-past-tours` (worktree `W:\tmp\staff-notes-past-tours`)
Slice base: `d2ea1f60` (the S3 report commit)
Implementer: S4 child, Claude Opus 5.5 (1M context)
Status: DONE - one feat commit, strict TDD (16 new tests shown red before the
implementation, then green); dashboard typecheck exit 0 before and after the
commit; the ToursPage suite still green and untouched.

Byte-exact quotations behind the citations below (run output, the diff shape,
the time-zone probe) are in the ignored run state
`.superpowers/sdd/slice-S4-reference.md`.

## Commit

- `2bac788c` feat(dashboard/tours): Past tab data - 90-day window through end of
  today, client selection, state chip, lazy usePastTours with reload (spec 4.2,
  4.3) - `dashboard/src/routes/tours/useTours.ts` and `useTours.test.ts` only.
- This report, as its own docs commit: `docs(staff-notes-past-tours): slice S4 report`.

Staged by explicit path after a bare `git status --porcelain` that listed only
those two files and a MERGE_HEAD check that found none.

## What shipped (the contract S5 consumes)

All in `dashboard/src/routes/tours/useTours.ts`. Imports at `:29-30` (adds
`useCallback`, the value `TOUR_STATUS_LABELS` and the type `TourStatus` from the
api barrel). Header comment third bullet at `:14-22`. The new section is
appended after `useClosedTours` (banner `:152-154`); the `useTours` and
`useClosedTours` bodies are unchanged (the only removed lines in the diff are
the two old import lines).

### Exports

| name | where | signature / value |
|---|---|---|
| `PAST_TAB_DAYS` | `:157` | `number`, 90 |
| `PAST_TAB_STATUSES` | `:161-165` | `ReadonlySet<TourStatus>`: scheduled, toured, no_show |
| `pastToursDateRange` | `:178-182` | `(now?: Date) => { from: string; to: string }` |
| `selectPastTours` | `:197-209` | `(tours: Tour[], now?: Date) => Tour[]` |
| `pastState` | `:213-219` | `(tour: Tour) => string` |
| `PastToursState` | `:221-235` | interface, below |
| `usePastTours` | `:238-278` | `(enabled: boolean) => PastToursState` |

Module-private helpers: `startOfLocalDay` (`:168-170`), `needsPlacement`
(`:186-188`, true iff status toured AND `convertible === true` AND
`convertedPlacementId === undefined`). `now` defaults to `new Date()` in both
pure functions.

### `PastToursState` (`:221-235`)

- `status: 'idle' | 'ready' | 'error'` - there is NO `'loading'` value.
- `past: Tour[]` - the selected rows, most recent first.
- `reload: () => void`
- `reloadFailed: boolean`

The plan's ToursPage test types its mock as `Omit<PastToursState, 'reload'>`;
that resolves against this interface.

### Status values - when each is set

- `'idle'`: the initial state (`:243`); stays while `enabled` is false (the
  effect returns early, `:248`); and stays through the FIRST in-flight fetch -
  nothing is written synchronously in the effect body (`:251-255`). The page
  must render its spinner for `'idle'` (the plan's `PastToursView` does:
  `pastStatus === 'idle'` renders `<Spinner center />`).
- `'ready'`: every successful fetch, first load or reload, writes
  `{ status: 'ready', past: selectPastTours(rows, now), reloadFailed: false }`
  (`:263`). A failed fetch while already `'ready'` keeps `'ready'` (`:268-270`).
- `'error'`: a failed fetch while the status is NOT `'ready'` (`:268-270`) -
  the first load, or a retry from `'error'`. It writes `past: []`,
  `reloadFailed: false`. It never follows a successful load.
- `reloadFailed`: set true ONLY by a failed fetch while `'ready'`; the rows and
  their array identity are kept (`{ ...s, reloadFailed: true }`). Cleared by
  the next successful fetch. Never true alongside `'error'`.
- An abort (signal aborted, or a DOMException named AbortError) is swallowed
  with no state write (`:262`, `:265`).

### `reload` semantics

- Stable identity: a `useCallback` with empty deps (`:245`). Safe to hold in a
  ref or an effect dep (worklist D2-R5's page-owned `pastReloadRef`
  registration effect will run once per Past mount, not per render).
- Returns `void`, not a promise: the caller cannot await the refetch; it sees
  completion through `past` / `reloadFailed` / `status` changing.
- It bumps an internal epoch (`:244-245`); the effect (deps `[enabled, epoch]`,
  `:275`) aborts the previous request in its cleanup (`:274`) and issues ONE
  `getTours({ from, to }, signal)` (`:261`) with the window recomputed from a
  fresh `new Date()` (`:259-260`).
- While the refetch is in flight, status and rows stay exactly as they were
  (no spinner flash under the per-row results).
- Several quick calls: each aborts the one before; only the last result lands.
- Called while `enabled` is false: no request (the effect returns early).

### `enabled` semantics - one thing to keep

The hook never resets its state when `enabled` goes false (the cleanup only
aborts). On the SAME hook instance a re-enable would show the previous rows as
`'ready'` until the refetch lands. The plan's Task 7 avoids this by calling
`usePastTours(true)` inside the Past-only child that UNMOUNTS on a tab switch,
so every Past visit starts at `'idle'`. If S5 ever hoists the call to page
level, that stops being true.

### Window - `pastToursDateRange` (`:178-182`)

`from` = start of the local calendar day 90 days before today, built with
calendar arithmetic (`:179`); `to` = start of tomorrow local minus 1 ms
(`:180`); both returned as `toISOString` output (`:181`). It overlaps the
Active window (`from` = start of today) on today only.

### Selection - `selectPastTours` (`:197-209`)

Pure, returns a new array (filter/sort on a filtered copy; the input is never
sorted in place). In order: keep `PAST_TAB_STATUSES` (`:200`); drop a scheduled
row whose `scheduledAt` is at or after the start of today local (`:201`); drop a
toured row with an outcome unless `needsPlacement` (`:202`); sort `scheduledAt`
desc, ties by `tourId` asc (`:203-208`). The today boundary is compared as a
string against `startOfLocalDay(now).toISOString()` (`:198`): both sides are
`toISOString` output (the server canonicalizes `scheduledAt`), so the
lexicographic compare is exact. A toured tour carrying a `pending:` placeholder
in `convertedPlacementId` is NOT `needsPlacement` and is excluded, per spec 4.2
step 3.

### State chip - `pastState` (`:213-219`), in precedence order

1. status scheduled -> "Not marked"
2. status toured with `outcome === undefined` -> "Needs outcome" (wins even when
   `convertible` is true - the API-only shape)
3. `needsPlacement` -> "Needs placement"
4. status no_show -> "No show"
5. anything else -> `TOUR_STATUS_LABELS[status]`, falling back to the raw status

"Not marked" is exactly `status === 'scheduled'` and "Needs outcome" is exactly
toured-without-outcome, so S5's gating (checkbox + "Mark toured" on Not marked,
the "Record outcome" link on Needs outcome) can key on the chip text or the
status with the same result.

## Tests (`dashboard/src/routes/tours/useTours.test.ts`)

- `act` added to the Testing Library import (`:11`); type-only
  `import type { Tour }` from the api barrel (`:13`, erased, so it cannot load
  the module ahead of the mock).
- The api mock is now the spread `importActual` form (`:21-24`, repo idiom,
  e.g. `src/routes/contact/CallMenu.test.tsx:14`): the hook module now
  value-imports `TOUR_STATUS_LABELS`, which the old bare `{ getTours }` object
  did not provide (worklist S4).
- Post-mock import widened to the six names (`:26`); the first
  `toursDateRange` import (`:14`) stays.
- Appended block (banner `:208-210`): `pastToursDateRange` 3 tests (`:212`),
  `selectPastTours` 2 (`:241`), `pastState` 6 (`:287`), `usePastTours` 5
  (`:309`) = 16 new. File total 26.

## Verification (quoted)

All commands run from `/w/tmp/staff-notes-past-tours/dashboard`.

- Baseline at `d2ea1f60`, before any edit:
  `npx vitest run src/routes/tours/useTours.test.ts` -> exit 0,
  "Tests 10 passed (10)".
- RED (tests + spread mock, no implementation): same command -> exit 1,
  "Tests 16 failed | 10 passed (26)". Every failure was
  "TypeError: <name> is not a function" for `pastToursDateRange`,
  `selectPastTours`, `pastState`, `usePastTours` - the plan's predicted red.
  The 10 pre-existing tests passed under the new spread mock.
- GREEN: same command -> exit 0, "Tests 26 passed (26)" (10 pre-existing + 16
  new); no stderr and no act warning in the capture.
- `npm run typecheck` -> exit 0 (before the commit).
- ToursPage neighbor run: `npx vitest run src/routes/tours/ToursPage.test.tsx`
  -> exit 0, "Tests 19 passed (19)". Unchanged, as predicted: its bare
  `./useTours.js` mock (`ToursPage.test.tsx:37`) is untouched and the page
  imports none of the new exports yet.
- After the commit, at `2bac788c` with a clean tree: the hook suite -> exit 0,
  "Tests 26 passed (26)"; `npm run typecheck` -> exit 0.
- Extra, beyond the plan (the window is a DST claim): the hook suite at 26/26,
  exit 0, under four zones - the host default America/New_York (the November
  case genuinely crosses the EDT to EST change there), and Pacific/Auckland,
  UTC and Europe/London set through PowerShell `$env:TZ`. On this host a Git
  Bash `TZ=...` prefix does NOT reach Node (it still reported New York), so a
  bash-driven zone probe proves nothing here.
- ASCII, added lines only (both files already carry non-ASCII): 0 on
  `useTours.ts`, 0 on `useTours.test.ts`. Both files' pre-existing non-ASCII
  lines were left untouched. Both files are LF-only at `2bac788c`, as at the
  slice base (0 CR bytes in each).
- Not run, per the mission (orchestrator gates): full `npm test`,
  `npm run smoke`, `npm run e2e`, lint. No server or e2e session was started.

## Divergences from the plan

None in code or tests: the imports, the header bullet, the appended section
and the appended test block are the plan's text; the commit message is the
plan's, with the real model named in the trailer.

Recorded, no change:

1. 16 new tests, not the plan's "15" - the plan's block defines 16 (worklist
   D2-R8 already noted it).
2. Placement choices the plan left open: the header bullet sits after the
   Closed-view bullet and before the blank comment line that opens the fetch
   mechanics (`useTours.ts:14-22`); the type-only `Tour` import sits between
   the vitest import and the first `./useTours.js` import (`useTours.test.ts:13`).
3. The test file's header "Asserts:" list (`useTours.test.ts:3-10`) was not
   extended to name the Past tests - outside the scope this slice was granted
   (imports, mock, appended blocks); the appended block carries its own banner.

## For S5 (ToursPage) and later slices

- The plan's page import (`pastState, useClosedTours, usePastTours, useTours`)
  resolves; `PastToursState` is exported for the test's
  `Omit<PastToursState, 'reload'>`.
- `ToursPage.test.tsx`'s `./useTours.js` mock must become the spread
  `importActual` form, as plan Task 7 says: the page renders the chip through
  `pastState`, which must be REAL in that suite; a bare object mock would throw
  on the missing `pastState` export at render.
- `'idle'` IS the loading state. Do not wait for `'loading'` - it never occurs.
- `reload` is void and identity-stable (see above). Worklist D2-R5's
  `pastReloadRef` can register it once per mount.
- A reload from `'error'` shows `'error'` until the result lands (no spinner);
  unreachable in the plan's UI, whose error branch offers no retry.
- `past` keeps its array identity across a failed reload and changes on every
  successful load (a new array from `selectPastTours`).
- Today's toured and no-show rows, and a tour marked toured early for later
  today, ARE on Past; a still-scheduled tour dated today is NOT (Active's Today
  group shows it).
- For S7: the app mounts under `<StrictMode>` (`dashboard/src/main.tsx:15`), so
  in the Vite dev server the Past child's mount effect runs twice and the first
  `GET /api/tours?from=...&to=...` is aborted (swallowed). Same as `useTours`
  and `useClosedTours` today; it matters only to a spec that counts requests.
- Gate 5 attribution: the pre-existing `react-hooks/set-state-in-effect` error
  in `useClosedTours` (the synchronous `'loading'` write, `:116` on the slice
  base) is the same statement, now at `useTours.ts:125` because the header
  comment grew by nine lines. Baseline debt, not this slice's; attribute by
  baseline comparison, not by line number. The new hook's only state writes are
  inside the async callback (`:263`, `:268-270`) and the `reload` callback
  (`:245`), none in an effect body.
