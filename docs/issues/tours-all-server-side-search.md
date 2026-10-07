---
id: tours-all-server-side-search
title: The Tours All tab's search matches in the browser, so a search loads the rest of the filtered list to find every match
type: improvement
severity: low
status: open
area: dashboard/tours
created: 2026-10-06
refs: dashboard/src/routes/tours/useAllTours.ts:31, dashboard/src/routes/tours/AllToursView.tsx, app/src/routes/tours.ts:440, docs/issues/typeahead-scale-needs-server-side-search.md, dashboard/src/routes/tours/tourTime.ts:62, dashboard/src/routes/tours/ToursPage.tsx:324
---

**Problem.** The Tours page's All tab (`/tours/all`) filters and pages on the
server, but its free-text search (tenant name or property address) is
frontend-only by design (spec
`docs/superpowers/specs/2026-10-06-tour-list-design.md`, D3 and section 6). It
narrows the rows already loaded, and while the list is not complete it loads
the REST of the current filtered list in 100-row pages until every match is
in. The walk is capped at 50 requests (`WALK_REQUEST_CAP`,
`dashboard/src/routes/tours/useAllTours.ts:31`); a capped search says "Search
stopped before the end of the list. Narrow the filters to search the rest."

What a walk costs grows with the tour table. Under Any time with every status
the server reads every dated tour once, and every toured, no-show, canceled
and closed tour once more to find the undated ones; the status and type
filters narrow only what is sent, not what is read (spec 6, "Cost, stated
precisely"). Because undated tours come last, a capped Any time search can
miss them. Spec section 10 defers server-side search; spec 6 names it as the
upgrade path "if walks ever get slow".

**Suggested fix.** Match on the server, which already has the names: a search
parameter on `GET /api/tours/list` (`app/src/routes/tours.ts:440`) applied
inside the paging engine, so a page holds only matches and the client walk
goes away. The design question: names are resolved per page today, AFTER the
rows are chosen (spec 5.6), so matching needs the labels at filter time - a
normalized search label stored on the tour item, or a name lookup per
evaluated row. The house precedent is
[`typeahead-scale-needs-server-side-search`](./typeahead-scale-needs-server-side-search.md),
the same browser-side matching limit for the contact and property typeaheads.

**Costs at thousands of tours (2026-10-06, feat/tour-list planner review).**
Two costs the price above leaves out. Neither shows at today's volume
(hundreds of tours); both come from the branch's plan-blind review
(`docs/superpowers/reviews/2026-10-06-tour-list/planner-review/adversarial.md`,
F3 and F2).

- Every return from a tour page to a SEARCHED All list re-runs the whole
  walk. The loaded list lives in `useAllTours` state and dies with the view;
  a row link carries the search in its back URL, and on the return the walk
  outranks the restore, so each return reloads page 1 and walks to the end
  (or the 50-request cap) before the restore can anchor. At about 3,000
  tours one walk is about 30 requests plus the undated tail, so opening 8
  matching tours in turn with the back arrow costs about 250 requests and a
  "Searching..." wait on every return. Options: keep the last list (rows,
  name maps, cursor) in a short-TTL module cache keyed by the list key, and
  reuse it when a restore record for that list arrives - the Past tab's
  batch store, `ToursPage.tsx`'s module store
  (`dashboard/src/routes/tours/ToursPage.tsx:324`), is the house precedent
  for state that outlives the view; or the server-side search above, which
  removes the walk.
- Each landed walk page re-derives every loaded row, so a long walk is
  quadratic in rows formatted (the row views are memoized since the planner
  review's fix wave, so a keystroke no longer re-derives them). Each
  derivation formats a date and a time with `toLocaleDateString` /
  `toLocaleTimeString` and explicit options, which builds a new formatter
  per call. Module-level `Intl.DateTimeFormat` instances in
  `dashboard/src/routes/tours/tourTime.ts` would cut that per-row cost. The
  helper is shared - the Active, Past and Closed tabs and Today format
  through it too - so that change is theirs as well.
