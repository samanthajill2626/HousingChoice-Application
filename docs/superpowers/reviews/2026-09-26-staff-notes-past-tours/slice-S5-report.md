# Slice S5 report - dashboard Part 2 page (plan Task 7) + the gate-2 collision

Date: 2026-09-27
Branch: `feat/staff-notes-past-tours` (worktree `W:\tmp\staff-notes-past-tours`)
Slice base: `5561400d` (the S4 report commit)
Implementer: S5 child, Claude Opus 5.5 (1M context)
Status: DONE - two code commits, strict TDD. The Past tests (and the `view`
prop rename they drive) were shown red before the page existed, then green;
the route-registry pin was shown red between the App.tsx edit and the
exclusion, then green; dashboard typecheck exit 0 before the slice, after the
implementation and after the commits.

Byte-exact quotations behind every count and citation below (run output,
failure lines, hex dumps, typecheck tails) are in the ignored run state
`.superpowers/sdd/slice-S5-reference.md`.

## Commits

- `c39989fe` feat(dashboard/tours): Past tab - /tours/past view, state rows
  with date-time labels, Mark toured + Record outcome actions, sequential
  re-read-then-PATCH bulk Mark toured (spec 4.1, 4.3-4.5) - the plan's Task 7
  message, real model in the trailer. Files: `ToursPage.tsx`,
  `ToursPage.module.css`, `ToursPage.test.tsx`, `dashboard/src/App.tsx`.
- `0ad6200a` test(perf): exclude /tours/past from the route-registry pin - a
  new list view, not yet a profiler surface (issue perf-pages-tours-past-surface)
  - `e2e/performance/routes.test.ts` alone.
- This report, as its own docs commit.

Each commit was staged by explicit path after a bare `git status --porcelain`
that listed only the intended files and a MERGE_HEAD check that found none.
At `c39989fe` alone the routes pin is red (the route lands one commit before
its exclusion - the mission's two-commit split); `0ad6200a` closes it.

## What shipped

### The `view` prop and the routes

- `ToursView` is `'active' | 'past' | 'closed'` (`ToursPage.tsx:520`);
  `ToursPageProps` carries `view?: ToursView` (`:522-526`), default `'active'`
  (`:571`). The old `closed?: boolean` prop is gone; its only two callers
  (`App.tsx` and the test's `renderPage`) were rewritten, per the worklist's
  importer checklist.
- `VIEW_TABS`: Active `/tours`, Past `/tours/past`, Closed `/tours/closed`, in
  that order, keyed by view (`:530-534`, rendered `:669-680`); the current tab
  carries `aria-current="page"`.
- `App.tsx:237-242`: routes `tours` (default), `tours/past` (`view="past"`),
  `tours/closed` (`view="closed"`). No route keys: the three tabs render ONE
  page instance at one tree position, as before.

### Page copy (exact strings, all ASCII)

- h1 per view (`PAGE_TITLE`, `:536-540`): "Tours", "Past tours", "Closed tours".
- Intro (`PAGE_INTRO`, `:542-546`), Past: "Last 90 days: tours that were never
  marked toured, toured tours still waiting on an outcome or a placement, and
  no-shows." Active and Closed intros unchanged.
- "+ New tour" stays Active-only (`:661`).
- Past empty state: "No past tours need attention in the last 90 days."
  (`:467`).
- Past FIRST-load failure: the page's existing "We couldn't load tours. Please
  try again." as `role="alert"`, replacing the region (`:430-436`).
- Failed RELOAD: one `role="alert"` line above the toolbar, "Could not refresh
  the list. Reload the page to see the latest." (`:440-444`).
- Toolbar: a checkbox whose wrapping label reads "Select all not marked"
  (`:472-484`), and a button whose text is "Mark toured (N)" with NO aria-label
  (`:485-493`).
- Per-row result under the row: "Marked toured" (`role="status"`) or "Could not
  mark toured: <message>" (`role="alert"`) (`:262-272`).
- Above-toolbar blocks for results whose id the reload no longer lists, named
  from the snapshot: one `role="status"` block of "<tenant> at <property> on
  <date-time>: Marked toured" lines and one `role="alert"` block of "<tenant>
  at <property> on <date-time>: <message>" lines (`:445-463`).
- The three fixed messages (`MarkFailure`, `:555`): "Could not check the tour",
  "Changed since the list loaded", "The update failed". Never a server code.

### Accessible names - every one ends with the row's date-time

`<who>` is "<tenant> at <property> on <date-time>" (`:203`), where
`<date-time>` is `whenLabel` = the page's `formatDate` + ", " + `formatTime`,
e.g. "Jun 30, 2026, 2:00 PM" (`:564-569`), with U+202F / U+00A0 mapped to a
plain space (OD-6).

| control | accessible name | where |
|---|---|---|
| row link (every row) | "Tour for <who>" | `:224` |
| checkbox (Not marked only) | "Select tour for <who>" | `:217` |
| row button (Not marked only) | "Mark toured: <who>" | `:244` |
| Record outcome link (Needs outcome only) | "Record outcome: <who>" | `:254` |
| bulk button | its text, "Mark toured (N)" | `:492` |
| select-all checkbox | "Select all not marked" | `:483` |
| the Past body | region "Past tours" | `:439` |
| the rows | list "Past tours list" | `:495` |

The chip is S4's `pastState(tour)` (`:232`); there is no tour-type badge on a
Past row. Selection is S4's too: the page renders `usePastTours`'s rows in the
hook's order and never re-selects.

### Row actions

- Not marked (`status === 'scheduled'`, `:204`): the checkbox and the "Mark
  toured" button, both disabled while a batch runs (`:215`, `:242`).
- Needs outcome (toured, `outcome === undefined`, `:205`): the "Record
  outcome" link (`:249-258`).
- Needs placement and No show: no checkbox (it renders only when Not marked,
  `:210`) and no action (`:235`).

### `PastToursView` props contract after OD-3 (`:277-294`)

- `contacts: Map<string, Contact>`
- `units: Map<string, UnitItem>`
- `bulkBusy: boolean`
- `setBulkBusy: (busy: boolean) => void`
- `bulkBusyRef: React.RefObject<boolean>` (D2-R3, not `MutableRefObject`)
- `pastReloadRef: React.RefObject<(() => void) | null>`

### Who owns and who writes each piece of batch state

- The PAGE (`ToursPage`, survives a tab switch) owns the busy flag
  (`useState(false)`, `:579`), the in-flight guard (`useRef(false)`, `:580`) and
  the reload pointer (`useRef` of function-or-null, `:581`), and hands all four
  handles to the child (`:748-755`). The page writes none of them.
- The CHILD (`PastToursView`, mounted only on the Past view, `:747`):
  - calls `usePastTours(true)` (`:308`) - the page never calls it, so the hook
    is never even invoked on Active or Closed;
  - registers its hook's `reload` in the pointer in an effect and clears it in
    the cleanup (`:313-318`) - a ref write, no state set; S4's `reload` is
    identity-stable, so this runs once per mount;
  - writes the guard and calls `setBulkBusy` ONLY inside `markToured`
    (`:383-419`), an event-handler path;
  - owns the selection, the results and the snapshot (`:325-327`), which
    therefore reset on every tab switch (the child unmounts).
- No `useState` setter runs synchronously in any effect body in this slice.

### The runner's exact sequence (`markToured(ids)`, `:382-427`)

1. Return at once if the guard is set (a batch is in flight) (`:383`).
2. Build the snapshot source (the listed rows by id) and the eligible ids (the
   given ids that are listed as Not marked); return if none (`:384-386`).
3. Set the guard; `setBulkBusy(true)`; clear the previous results; store the
   snapshot (`:387-390`).
4. For each eligible id, one at a time, in order: `await getTour(id)` - on a
   throw record "Could not check the tour" and continue; if the re-read status
   is not scheduled OR its `scheduledAt` differs from the listed one, record
   "Changed since the list loaded" and continue; else `await patchTour(id, {
   status: 'toured' })` and record ok, or "The update failed" on a throw
   (`:392-410`). The bulk button passes the derived selection, which iterates
   in list order (`:490`); a row button passes its one id (`:504`).
5. Store the results; drop the succeeded ids from the raw selection (failed
   ones stay ticked) (`:411-416`).
6. Call the page's reload pointer, if set - the Past view mounted NOW (`:417`).
7. Clear the guard; `setBulkBusy(false)` (`:418-419`).

The PATCH body is exactly `{ status: 'toured' }` - never an outcome, never
`closed`. The closing comment (`:420-426`) was rewritten for OD-3.

### Loading and request ordering

For the Past view the page's `loading` / `error` wait only for the four
cross-reference lookups (`:608-619`); the child shows its own spinner while
S4's hook is `'idle'` and its own error on `'error'` (`:429-436`). Per D2-R4:
the Past fetch lives in the child, which mounts only after the four list
lookups land, so Past adds ONE request round trip after them. This is NOT the
Closed tab's ordering: Closed's fetch runs at page level, in parallel with the
lookups.

### CSS (`ToursPage.module.css`)

The plan's Past block is appended verbatim (`:249-363`): `.pastRow`, `.check`,
`.rowActions`, `.actionLink` (+ focus ring), `.rowResult`, `.rowResultError`,
`.vanished`, `.vanishedOk`, `p.vanished`, `.toolbar`, `.selectAll`, and a
560px container query that wraps the actions onto a full-width right-aligned
line with the checkbox still leading (`:355-363`). The stale header (`:1-3`)
and tabs comment (`:36-38`) now name the three views (D2-R8).

### The routes.test.ts exclusion (OD-1)

`e2e/performance/routes.test.ts:380-381`: `'/tours/past'` added to the local
`excluded` set, with a one-line comment saying it is a new list view, not yet a
profiler surface, tracked by issue `perf-pages-tours-past-surface`. Nothing
else in that file changed. The issue file itself is the orchestrator's (MINE,
worklist S8); the comment names it ahead of that commit.

## Tests (`ToursPage.test.tsx`, 19 pre-existing + 14 new = 33)

- Mock plumbing: the `./useTours.js` mock is the spread `importActual` form
  (`:54-62`), so `pastState` renders for real (S4's requirement); the Past hook
  mock (`:41-50`) answers from `pastRows` with the `reloadPast` spy through a
  NAMED default, `pastHookAnswer`, re-installed in `beforeEach` (`:285`);
  `getTour` / `patchTour` join the api mock (`:78-79`, `:87-88`); `ApiError` is
  a value import (`:92`); `renderPage` wires the three views plus a
  `LocationProbe` on `/tours/:tourId` that prints path, search and router
  state (`:231-255`); `beforeEach` resets `reloadPast` with `mockReset`
  (D2-R7, `:283`).
- The Active tabs test also checks the Past tab (no `aria-current`, href
  `/tours/past`) and that the Past hook is never called on Active (`:484-488`).
- The Past describe (`:651-988`): the plan's 12 tests, with D2-R2 (the held
  promise declared with no initializer, `:782`, `:879`) and OD-6 in the test's
  own `whenLabel` helper (`:662-669`), plus two additions: the OD-6 portability
  test (`:724-749`) and the OD-3 mid-batch round-trip test (`:875-918`).

## Verification (quoted; all from `/w/tmp/staff-notes-past-tours/<workspace>`)

- Baseline at `5561400d`, before any edit: the four dashboard suites -> exit 0,
  "Tests 69 passed (69)" (ToursPage 19, useTours 26, App 10, AppFrame 14);
  `e2e` `npx vitest run performance/routes.test.ts` -> exit 0, "Tests 24 passed
  (24)"; `npm run typecheck` (dashboard) -> exit 0.
- RED, tests only: `npx vitest run src/routes/tours/ToursPage.test.tsx` -> exit
  1, "Tests 20 failed | 12 passed (32)". The 13 new Past tests failed on the
  missing Past view ("Unable to find ... region ... Past tours", "... Mark
  toured: Alice Smith at ... on Jun 30, 2026, 2:00 PM", etc.); 7 pre-existing
  tests failed because `renderPage` now passes `view="closed"` to a page that
  still read `closed`, and the tabs test expects the Past tab.
- GREEN after the page: same command -> exit 0, "Tests 32 passed (32)"; the
  capture holds no stderr and no act warning.
- Routes pin RED after the App.tsx edit, before the exclusion: exit 1, "Tests 1
  failed | 23 passed (24)", failing "mechanically matches App route elements
  and proves generated placeholders are empty" with `+ "/tours/past"` in the
  received set. GREEN after the exclusion: exit 0, "Tests 24 passed (24)".
- The four-suite set (ToursPage, useTours, App, AppFrame) -> exit 0, "Tests 82
  passed (82)"; dashboard typecheck exit 0; e2e workspace typecheck exit 0 (its
  tsconfig sets `noEmit`, so nothing was written).
- OD-6 test added: RED with the page's normalization line temporarily removed
  (`-t "plain spaces"` -> exit 1, "Tests 1 failed | 32 skipped (33)", "Unable to
  find an accessible element with the role "link" and name "Tour for Alice
  Smith at 123 Peachtree St, Atlanta, GA, 30303 on Jun 30, 2026, 2:00 PM"");
  GREEN with the line restored. Four-suite set -> exit 0, "Tests 83 passed
  (83)"; dashboard typecheck exit 0.
- Flake check: the ToursPage suite three more times -> exit 0, "Tests 33 passed
  (33)" each time.
- After both commits, clean tree at `0ad6200a`: the four-suite set -> exit 0,
  "Tests 83 passed (83)"; the routes pin -> exit 0, "Tests 24 passed (24)";
  dashboard typecheck -> exit 0.
- OD-3 discrimination (after the commits, restored after): with the runner's
  pointer call temporarily swapped back to the plan's direct `reloadPast()`,
  the mid-batch test -> exit 1, "Tests 1 failed | 32 skipped (33)", "expected
  "spy" to be called 1 times, but got 0 times". Restored; tree clean; 33/33.
- ASCII, added lines only (all five files, vs the slice base): 0, 0, 0, 0, 0;
  `routes.test.ts` is also 0 whole-file. All five files LF-only (0 CR).
- Not run, per the mission: full `npm test`, `npm run smoke`, `npm run e2e`,
  lint. No server or e2e session was started.

## Divergences from the plan (and why)

1. OD-3 (worklist, binding): the busy flag moved from child state to PAGE
   state, and a page-owned reload pointer replaced the runner's direct
   `reloadPast()`. Why: in the plan's shape, Past -> Active -> Past while a
   batch runs remounted a view whose controls were enabled but inert (the
   page-owned guard dropped the click), and the old batch's refresh landed on
   the unmounted hook, leaving the new view with a list fetched mid-batch.
   Spec 4.5 says EVERY mark control is disabled while a batch runs.
2. D2-R3: the guard prop is `React.RefObject<boolean>` (the installed
   @types/react deprecates `MutableRefObject`).
3. OD-6: `whenLabel` maps U+202F / U+00A0 to a plain space, in the page
   (`:559-569`) and in the test's helper (`:662-669`), following
   `dashboard/src/routes/inbox/inboxTime.ts:13,39-41`; the character class is
   written with backslash-u escapes, so the source is ASCII.
4. D2-R2: the bulk test's held-promise variable has no initializer (`:782`).
5. D2-R7: `beforeEach` resets `reloadPast` with `mockReset` (`:283`).
6. D2-R8: stale comments refreshed - `ToursPage.tsx:1-2` and the header gained
   the Past paragraph (`:12-21`, the plan's step 7 wording plus one sentence on
   the page-owned flag, guard and pointer); CSS `:1-3` and `:36-38`. Line 1's
   em dash became a hyphen, because a touched line must be ASCII.
7. OD-1: `e2e/performance/routes.test.ts` edited (outside the plan's file
   list) - the one exclusion entry plus its comment.
8. Additions beyond the plan, all in `ToursPage.test.tsx`:
   - the mid-batch round-trip test (`:875-918`) pins both OD-3 halves: while a
     PATCH is held across Past -> Active -> Past, the remounted view's row
     buttons and checkboxes are disabled; after release the refresh reaches
     the SECOND visit's reload and never the first's (the test swaps the
     mocked hook's reload for the second visit). Shown to fail against the
     plan's direct call (above); the busy half fails by construction under a
     child-owned flag, which would start false on the remount;
   - the OD-6 portability test (`:724-749`) forces U+202F before AM/PM through
     a `Date.prototype.toLocaleTimeString` spy and compares the aria-labels and
     the time text EXACTLY (Testing Library normalizes only the node side, so
     a text matcher alone would not catch it);
   - the Past hook's default answer is a named function re-installed in
     `beforeEach` (`:45-50`, `:285`), so the round-trip test's override cannot
     leak under any Vitest version (the D2-R7 concern, applied to this spy);
   - the file header lists the Past view (`:12-14`), and the dropped-rows
     test's comment names the pointer and the page's flag (`:829-835`).
9. Comments beyond the plan in `ToursPage.tsx`: a line above `loading` saying
   the Past view waits only for the lookups (`:608-609`), and the Past block's
   JSX comment naming page ownership (`:744-746`).

Recorded, no change:

- Leaving the Tours page altogether mid-batch (to another route, not a tab
  switch) unmounts the page with its flag, guard and pointer; a fresh page
  starts with the guard clear, so a second batch could start while the first
  finishes. The per-id re-read keeps it safe (a tour the first batch already
  marked re-reads as toured and is skipped as "Changed since the list
  loaded"). Outside the plan's and OD-3's scope; for the handback.
- A view remounted mid-batch shows no result lines for that batch (fresh
  state, consistent with spec 4.5's "results reset on a view change"); its
  refreshed list shows the outcome (a marked row reads "Needs outcome").
- Gate 5 was not run (mission). By construction: the only new effect writes a
  ref and sets no state; both refs are `*Ref`-named props (the compiler
  treats them as refs by name, worklist S5 anchors); the test's new mocked-hook
  arrow mirrors the existing `useClosedTours` line.

## A tool trap for later slices

Writing a backslash-u escape into source was not reliable in this session: the
first edit landed the decoded characters (U+202F / U+00A0 bytes, non-ASCII),
a doubled backslash landed as two backslashes, and a GNU `sed` collapse
consumed the `u` (sed read a case-conversion escape). The final lines were
written by a Node one-off that built the backslash from its char code, and
were hex-verified (`5b 5c 75 32 30 32 66 5c 75 30 30 61 30 5d`). Anyone in S6
or S7 who writes such an escape should hex-check the line and run the
added-lines ASCII check; a green test run does not catch it.

## For S6 (TourDetail) and S7 (Past-tab e2e)

S6:

- Row link: href `/tours/<tourId>`, router state `{ back: '/tours/past' }`
  (`ToursPage.tsx:220-222`; the constant `BACK_TO_PAST`, `:550`). Every Past
  row carries it.
- Record outcome link: href `/tours/<tourId>?outcome=1`, the same state
  (`:250-252`), only on a toured row with no outcome (`:205`, `:249`).
- Proven in the unit suite: the probe reads `/tours/p1|{"back":"/tours/past"}`
  after the row link and `/tours/p2?outcome=1|{"back":"/tours/past"}` after
  Record outcome (`ToursPage.test.tsx:721`, `:769`).
- `state.back` is exactly the string `/tours/past`. Only the Past tab produces
  it; Active and Closed rows (`TourRow`, `ToursPage.tsx:153-157`, unchanged)
  link with no state and so fall back to `/tours`.

S7:

- `/tours/past`: tab link "Past" (`aria-current="page"` there), h1 "Past
  tours", region "Past tours" (it holds the refresh alert, the above-toolbar
  blocks, the toolbar and the list - the right target for
  `expectNoHorizontalOverflowIn`), list "Past tours list".
- Two spinners in sequence, both `role="status"`: the page's while the four
  lookups load, then the child's while the Past fetch is in flight. The Past
  `GET /api/tours?from=...&to=...` starts only after the lookups land.
- Bulk button: text "Mark toured (N)", no aria-label - locate it anchored
  (`/^Mark toured \(1\)$/`); the row buttons' names begin "Mark toured: ".
- Every label's date-time uses plain spaces (OD-6), e.g. "Sep 24, 2026, 10:00
  AM", so a plain-space pattern matches on any ICU.
- Per id the wire shows `GET /api/tours/<id>` then `PATCH /api/tours/<id>`
  with body exactly `{"status":"toured"}`; the list refetches once at the end.
- After a successful mark the refetched row reads "Needs outcome" with a
  "Record outcome" link, and its "Marked toured" status line stays under it
  (the id is still listed).
- Every mark control is disabled while a batch runs, including on a view
  remounted by a tab round trip.
- 360px: the row wraps and the actions take a full, right-aligned line with
  the checkbox still leading (CSS `:355-363`).
