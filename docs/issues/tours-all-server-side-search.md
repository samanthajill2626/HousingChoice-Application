---
id: tours-all-server-side-search
title: The Tours All tab's search matches in the browser, so a search loads the rest of the filtered list to find every match
type: improvement
severity: low
status: open
area: dashboard/tours
created: 2026-10-06
refs: dashboard/src/routes/tours/useAllTours.ts:31, dashboard/src/routes/tours/AllToursView.tsx, app/src/routes/tours.ts:440, docs/issues/typeahead-scale-needs-server-side-search.md
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
