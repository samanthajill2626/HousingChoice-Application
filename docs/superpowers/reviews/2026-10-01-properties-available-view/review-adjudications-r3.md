# Code review round 3 - adjudications (TERMINAL round)

Branch `feat/properties-available-view` at e9b9e421 (the round-2 fix wave). Same two
reviewers, continued with the re-review charge: adversarial plan-blind
(`code-review-adversarial-r3.md`, A3-1..A3-3) and conformance
(`code-review-conformance-r3.md`, C3-1..C3-4; 61/64 re-amended-note items delivered).
All 7 findings are LOW. The adversarial reviewer CONCEDED round-2 A2-4 (the
idle-timer write). Adjudicated by the planner, 2026-10-01.

## Why this round is terminal

No ruling below changes a decision: none alters what gets built, adds or removes a
surface, or moves an invariant. They are precision fixes - one timing bug in how
the round-2 guard records its baseline, test claims tightened to what they pin,
two more pins, a scroll option, stale citations, and a record correction. Per the
review loop's stop rule they are folded in and the review stops here.

## Rulings

| # | Finding | Ruling |
|---|---|---|
| A3-1 / C3-1 | The committed history index is captured in a PASSIVE effect, so a filter write right after a count click or Back/Forward commits is wrongly skipped as "pending" (chip lit, URL unchanged) | ACCEPT: `useLayoutEffect`, which runs inside the commit, before any later event. Both reviewers proved it under a real BrowserRouter. A test that writes right after a committed navigation is added. |
| A3-2a | The perf terminal-copy test passes for "Properties" on unrelated text | ACCEPT: the check is role-aware - a `text` contract needs the exact text, a `list` contract needs `aria-label="<name>"`. |
| A3-2b | e2e step 5's save comes from the blur, not the row-open save it claims to prove | ACCEPT: the step opens the row with a dispatched click (no pointer, so no blur), which only the row-open save can survive. The blur save stays pinned by the component suite. |
| A3-2c | "...so that navigation wins" verifies only the skip | ACCEPT: renamed to what it proves (the pending entry is left untouched). |
| A3-3 | "Show all statuses" focuses the select with default scrolling, jumping a phone view up | ACCEPT: `focus({ preventScroll: true })`. |
| C3-2 | Perf source-ledger citations went stale in the round-2 wave | ACCEPT: re-pointed to the current lines. A content check for every route's citations would be a change to the whole ledger contract; not in #1. |
| C3-3 | Unpinned: Back/Forward onto a page-stamped entry must still be adopted; no pruning while loading (the tab-link mutant was caught only jointly) | ACCEPT: added "a count, then Back onto the page's own stamped entry, is adopted" and "a blur while the view loads keeps the authority filter". |
| C3-4 | The round-2 A2-5 ruling describes a KEY comparison; the code compares the history INDEX | ACCEPT: the code is right (a key check would skip the second of two quick writes: our own REPLACE mints a new key but keeps the index). `review-adjudications-r2.md` is corrected in place with a note pointing here. |
