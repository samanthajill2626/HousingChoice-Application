# Code review round 2 - adjudications

Branch `feat/properties-available-view` at 0dc265d5 (the round-1 fix wave). Same two
reviewers, continued with the re-review charge: adversarial plan-blind
(`code-review-adversarial-r2.md`, A2-1..A2-7) and conformance
(`code-review-conformance-r2.md`, C2-1..C2-7; 59/62 amended-note items delivered).
All 14 findings are LOW. The adversarial reviewer CONCEDED round-1 A2 (no chip
counts) and A13 (sentinel collisions). Adjudicated by the planner, 2026-10-01.

## Decisions that changed

The adoption rule is now precise instead of approximate:

- The page STAMPS its own URL writes with history state (`unitListFilterWrite`)
  and adopts the URL on EVERY other navigation - POP always; PUSH or REPLACE
  unless it carries the stamp. So a late commit of the page's own earlier write
  never reverts a newer choice, while a foreign same-URL REPLACE (a nav link the
  router turns into a replace) is adopted like any navigation. `onCount` and its
  plain-click test are REMOVED: a same-URL count is adopted on its own now.
- The prune runs only once the view's units are `ready`, so a loading view never
  strips authority keys out of the URLs it builds.
- A write is SKIPPED while a navigation is pending (the browser's history entry
  key differs from the committed location key): the pending tab switch or Back
  wins, instead of being cancelled and overwritten.
- Opening a property from a row persists the search first, so a tap that does not
  blur the box (iOS) still saves it.

A round 3 re-review follows (the state-model mechanics changed again).

## Rulings

| # | Finding | Ruling |
|---|---|---|
| A2-1 / C2-3 | While loading, the prune drops authority keys and the current tab link / a blur write carry the stripped selection (a round-1 fix-wave regression) | ACCEPT: prune only when `ready`; the current tab link is built from the unpruned choice. Test added. |
| A2-2 / C2-4 | The REPLACE guard skips every replace, including a foreign same-URL replace; comments overclaim | ACCEPT: own-write stamp in history state (above); comments and the design note reworded to match. |
| A2-3 / C2-1 / C2-2 | Contest of A6: the guard IS testable in jsdom, and the claimed same-URL count pin does not exist | ACCEPT, my A6 ruling was wrong on both counts. Added: a late own write does not wipe a newer keystroke (two events in one act); a foreign same-URL replace is adopted; a same-URL count click clears the search. |
| A2-4 | The search reaches the URL only through a blur; leaving by browser Back/Forward/swipe loses it, and an iOS tap may not blur | ACCEPT IN PART: a row-link click persists the search before navigating. REJECT the idle-timer write: it would be a third writer needing its own cancel-on-navigation and pending-navigation rules, for text that is abandoned by leaving the page; documented as a limitation in the design note. |
| A2-5 | A filter write landing before a pending PUSH/POP commits cancels it and overwrites its entry | ACCEPT: skip the write while a PUSH or Back/Forward is pending; tested under a real BrowserRouter. [Corrected in round 3, C3-4: this row first said the skip compares `window.history.state.key` with `location.key`. The shipped code compares react-router's history INDEX (`window.history.state.idx`) with the index recorded for the committed location - a key comparison would also skip the second of two quick writes, because the page's own REPLACE mints a new key but keeps the index.] |
| A2-6 / C2-5 | "Show all statuses" unmounts itself and drops focus; `.clear` is about 4.4:1 on the page background | ACCEPT: focus moves to the status select; the Properties `.clear` color becomes `--c-brand-hover` (about 5.5:1). |
| A2-7 | Contest of A11: the duplicated chip UI already lost a fix - the Tenants Clear still drops focus | ACCEPT the observation; DEFER the fix: filed `docs/issues/tenant-filters-clear-focus-contrast.md` (focus + the same `.clear` contrast on the Tenants list, outside #1's scope). The shared ChipGroup extraction stays out of #1. |
| C2-6 | Stated behaviors no test would catch: perf terminal copy tied to the page copy; a chip write carrying unsaved text; no real-browser blur-save check; visual styling | ACCEPT 1-3: a perf test reads ListingsList.tsx and requires every terminal string; a frozen-router test pins the chip write's `q`; the e2e spec types a search before opening a property and checks Back restores it. Item 4 (styling) is visual - covered by live QA screenshots. |
| C2-7 | Dates: new records said 2026-10-02 while the session date is 2026-10-01 | ACCEPT: 2026-10-01 everywhere (the UTC date had already rolled over). |
