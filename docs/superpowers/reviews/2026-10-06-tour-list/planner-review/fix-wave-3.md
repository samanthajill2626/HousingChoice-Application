# Planner fix wave 3 - feat/tour-list (planner review round 3, terminal)

Implementer: Claude Opus 5.5, 2026-10-07. Worktree `W:\tmp\tour-list`, branch
`feat/tour-list`, started at HEAD 2272c3ee (the round-3 records), ended at
27006c28 (plus this report's commit). Scope: the "Round 3" section of
`adjudications.md` in this directory - R3-1 (= R3-F1) and the notes folded
in (the restart test, the spec 4.5 wording, the GLOSSARY word). Nothing else.

Method: the code item ran TDD (RED for the finding's reason, then the fix,
GREEN), then two hand mutants on the committed state; the restart case was
green on write, so it is a PIN proven by a third hand mutant. Each mutant was
made and undone with the Edit tool; after each, `git hash-object` on
`AllToursView.tsx` matched the committed blob (d30ba634) and
`git diff --quiet` was clean. Before every commit: a separate bare
`git status`, `MERGE_HEAD` absent (checked at `git rev-parse --git-path`),
explicit paths only, 0 non-ASCII bytes in added (and removed) lines. Not run
(the orchestrator's): the full `npm test`, `npm run smoke`, `npm run e2e`,
any Playwright or e2e session.

## Commits

| item | commit | message |
|---|---|---|
| 1. R3-1 | 91d5a1ef | fix(dashboard): an empty page after Load more keeps focus in the list and never scrolls to the top |
| 2. restart focus (N7) | ba0fd771 | test(dashboard): focus after the automatic cursor-400 restart |
| 3. spec 4.5 wording (N1-N4) | c5ad1c10 | docs(spec): 4.5 wording - focus after a rebuild, de-duplication on every page, hidden added rows, the controls named |
| 4. GLOSSARY (N5) | 27006c28 | docs(glossary): the property page, the house word |

## Per item

### 1. R3-1 - an empty page after a pressed control (91d5a1ef)

- Tests first, in the "keyboard focus after the action controls" describe of
  `AllToursView.test.tsx`: a describe-level `scrollIntoView` spy (the return
  restore block's idiom, restored after each case), and two new cases:
  - (a) two rows with a cursor; Load more pressed and answered by an EMPTY,
    complete page. Asserts: rows unchanged, count line "2 tours", no action
    control, focus on the LAST row's link (a2), the count line not focused,
    and the spy's call count unchanged across the press.
  - (b) the same list answered by an EMPTY page WITH a cursor: the automatic
    follow is in flight (held). Asserts: no action control, "Checking more
    tours...", focus on a2 - not the body, not the count line - and no
    scroll. Then the follow's page lands a3 below: focus stays on a2, still
    no scroll (an automatic page moves nothing).
  - The existing Start over case and the first-page Retry rows case now pin
    the rebuild's scroll (Start over: the last scroll call is on the new
    first row; first-page Retry: exactly one call, on a1).
  - The existing Keep checking case's title gained "with no row shown"; its
    list has no rows, so the count line stays its correct target under the
    new chain - assertions unchanged.
- RED (old code, the describe: 2 failed, 9 passed): (a) and (b) both fail at
  their focus assertion (`AllToursView.test.tsx:1531` and `:1547`) with
  `expected <p class="_countLine_..."> to be <a class="_row_...">
  // Object.is equality` - focus went to the count line above the list. The
  two rebuild-scroll pins passed on the old code (it scrolled on every path).
- Fix (`AllToursView.tsx`, the focus effect only): the list's row links (the
  visible rows) are gathered once; on the user's own request path the target
  is the first new visible row, else the action control shown, else the last
  row link, else the count line; focus with `preventScroll`; `scrollIntoView`
  only on the rebuild path. The in-flight / started logic, the list-key check
  and the moved-focus hand-off are untouched. The file header and the
  effect's comment now state the chain and the no-scroll rule.
- GREEN: `AllToursView.test.tsx` 77/77; the tours directory 19 files,
  554/554.
- Mutants on the committed state (each restored byte-identically):
  - M1, the user's path scrolls again (the scroll made unconditional):
    exactly (a) and (b) RED, at their scroll assertions (`:1533`, `:1550`):
    `expected "scrollIntoView" to be called +0 times, but got 1 times`.
  - M2, no scroll on any path (the rebuild loses its scroll): exactly the
    Start over and first-page Retry rows cases RED (`:1637`, `:1673`):
    `expected undefined to be <a ...>` and `expected "scrollIntoView" to be
    called 1 times, but got 0 times`.
- Spec 4.5's focus bullet amended in place, marked "(Amended by the planner
  review, round 3, R3-1, from "else to the count line" with a scroll ...)":
  the chain below, no scroll on this move, and the rebuild's first row
  "scrolled into view (the smallest scroll - a new list starts at its top)".

### The fallback chain as built

- The user's own request (pending kind 'more': Load more, Keep checking,
  Retry after a failed page): the first NEW row's link among the links in
  the list (rows from `rowsBefore` on; DOM order) -> the button in the action
  area then shown (the pressed one when it stayed, or the Retry / Start over
  that replaced it) -> the LAST row link in the list -> the count line, only
  when the list renders no row link (no visible row; the list element itself
  is absent then). Focused with `preventScroll`; never `scrollIntoView`.
- The rebuild (kind 'rebuild': Start over, the first-page Retry): the first
  row's link (every row is new, `rowsBefore` 0) -> the count line, which the
  press already focused (so no move). Focused with `preventScroll`, then
  `scrollIntoView({ block: 'nearest' })`.
- Both: no move when the target already has focus; nothing settles until the
  request was seen in flight; a changed list key, or focus the user put
  anywhere but the body, the pressed control or the count line, hands off.
- The row links in the list are exactly the visible (search-filtered) rows,
  so "added but all hidden by the search" falls through the same chain.

### 2. Focus after the automatic restart (ba0fd771)

- What the code does (traced, then pinned): the pressed Load more's request
  is refused by the first cursor 400; the hook bumps its epoch and reports
  `status` 'loading', `loader` 'first', no rows, `refreshed` true. The
  pending 'more' record was marked started while the loader was 'more', so
  it settles on that render: the list key is unchanged by a restart; the
  pressed Load more left with the action area, so the active element is the
  body and the hand-off guard lets it through; `rows.slice(rowsBefore)` is
  empty; there is no list and no action area. Target: the count line,
  focused with `preventScroll` (no scroll since item 1). When the restarted
  page 1 lands, the record is already cleared, so nothing moves.
- Finding: focus is on the COUNT LINE while page 1 reloads and stays there
  once it lands, when the count line reads "Showing 2 tours The list was
  refreshed." Never the body - no fix was needed.
- The case: a Load more answered by `new ApiError(400, 'invalid cursor',
  'invalid cursor')`; asserts page 1 re-requested (limit 50), the loading
  state, focus on the count line; then the restarted page lands (n1, n2 with
  a cursor): rows n1 n2, the refreshed copy, focus not the body and on the
  count line, no scroll.
- Green on write -> PIN. Mutant M3, the focus effect returns early while
  `data.refreshed`: the new case RED at its first focus check (`:1715`,
  `expected <body> to be <p class="_countLine_...">`); the Start over case
  RED collaterally (`:1627`, `expected <body> to be <button>` - it also
  passes through a first 400). Restored byte-identically.
- GREEN: the tours directory 19 files, 555/555.

### 3. Spec 4.5 wording (c5ad1c10)

All in place, each marked "(Wording amended by the planner review, round 3
...)"; no behavior changed.

- (i) The focus bullet no longer says "never after the first page": focus
  moves never after the INITIAL load (arrival, a filter change) or an
  automatic page, nor after the return restore; a rebuild the user pressed
  (Start over, the first-page Retry) is the exception.
- (ii) De-duplication "on every page, the first included" (was "on append"),
  naming 5.3's reliance (a dated `requested` tour one request could return
  twice) and the origin (round 1, SC-F2).
- (iii) A sentence: added rows the search hides are not visible rows; when
  it hides every added row, focus takes the same chain - the action control
  shown, else the last visible row, else the count line.
- (iv) The controls named: the focus bullet opens with the five (Load more,
  Keep checking, Retry after a failed page, Start over, the first-page Retry)
  and says the first three are the user's own request; the ONE LOADER
  bullet's list of loaders now names what starts a first-page load (arrival,
  a filter change, the automatic restart, Start over, the first-page Retry)
  and Retry after a failed page (a Load more from the same cursor).
- ASCII: 0 non-ASCII bytes added or removed; the spec holds none at all.

### 4. GLOSSARY (27006c28)

- One line in the undated-wording entry: "the tenant, landlord and property
  files' tour lists" -> "the tenant and landlord files' tour lists and the
  property page". Lines 366-372 are ASCII; the file's 22 non-ASCII lines are
  untouched. Not re-wrapped: the file has no strict wrap (88 of 387 lines
  exceed 80 columns).

## Results at the end (HEAD 27006c28)

- `npx vitest run src/routes/tours/` (from `dashboard`): 19 files, 555
  passed, exit 0. Baseline at 2272c3ee: 19 files, 552 passed (+2 item 1,
  +1 item 2).
- `npm run typecheck` (worktree root, bare): exit 0, all five workspaces.
- `npx eslint dashboard/src/routes/tours/AllToursView.tsx
  dashboard/src/routes/tours/AllToursView.test.tsx`: exit 0, no output. The
  same command at the base 2272c3ee: exit 0, no output - no new error, and
  nothing pre-existing in these files. The two Markdown files are outside
  the lint config (gate 5's extension filter).
- No `[dynamoAdmin]` line in any captured run (dashboard suites only).

## Divergences from the adjudications, and why

- Two extra pins inside item 1: the Start over and first-page Retry cases
  now assert the rebuild's scroll. The fix splits the scroll by path; without
  them, deleting the rebuild's scroll would pass every test (M2 proves they
  bite). The binding text says the rebuild "keeps its scroll".
- The conformance reviewer suggested changing the Keep checking case's
  expectation. Not needed: that list has no rows, so the count line remains
  the chain's answer; only its title gained "with no row shown".
- Item 2 also asserts no scroll: the restart settles on the 'more' path, so
  the R3-1 rule (no `scrollIntoView` on that path) applies to it. Flagged
  below in case the planner wants the restart to scroll like a rebuild.
- Item 3 (iv) names the controls in two places (the focus bullet and the ONE
  LOADER list): N4 was about the ONE LOADER list, the brief about "the list
  of controls"; doing both leaves neither list partial.
- Not taken, as ruled: the optional cancel of a pending focus move on the
  anchor's intent events (wheel, touchstart) after the press - its scroll
  half is moot now that this path never scrolls; the focus move itself still
  happens after a wheel or touch scroll (without scrolling) unless the user
  moved focus. The N6 spinner polish (ruled not taken).

## Open points

- The restart's count-line focus does not scroll. While page 1 reloads the
  list area is only the Spinner, so a real browser most likely shows the
  count line anyway; jsdom cannot show layout. Worth a glance if the live
  check can force a cursor 400; otherwise a judgment call for the planner.
- The new last-row target is reachable live on an Any time list whose dated
  tours are an exact multiple of 50 with no undated tour (spec 5.4's empty
  last page); a lane seeded that way would show it.

## Gates (orchestrator)

(appended by the orchestrator after its verification run)
