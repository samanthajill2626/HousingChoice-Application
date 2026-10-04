# Properties page: available now vs. coming soon - design note

Date: 2026-10-01. Branch `feat/properties-available-view`, worktree
`W:\tmp\properties-available-view`, cut from main @ae04122d.
Source: Improvements Tracker item #1 (Sam's priority #1; Before WP1, step 1).
Lane: small-fix (Cameron, 2026-10-01): no spec/plan review rounds, built in the
planner session, all five completion gates, one independent plan-blind
reviewer plus a conformance check before handback. Cameron approved every
decision below before signing off; anything not covered here is decided
conservatively and flagged in the handback.

## 1. Problem

Sam opens Properties to see what she can move right now. Today the page opens
on every status, shows no counts, has no voucher-size filter, and its filters
live only in component state (the back button from a property resets them; an
authority picked on Active stays applied on Deleted - the open issue
`properties-authority-filter-invisible-lock`). Her old dashboard opened with a
row of housing authorities and their counts across the top.

## 2. Decisions

Cameron's answers (2026-10-01):

- D1. The page gets a SUMMARY TABLE at the top of the Active tab: one row per
  housing authority, with Available and Coming soon counts; every count is a
  link that filters the list below.
- D2. "Coming soon" is the existing `setup` status. Only the summary says
  "Coming soon (Setup)"; the status dropdown, row badges and property page keep
  "Setup" (which also covers brand-new properties still being set up).
- D3. (REVERSED by Cameron, 2026-10-04, after he hit the result live - see
  `docs/superpowers/reviews/2026-10-01-properties-available-view/fix-voucher-beds-fallback.md`.)
  A property's voucher size is its RECORDED voucher size when there is one,
  otherwise its BEDROOM count; only when BOTH are missing is it "Not recorded".
  The rule lives in ONE reusable function on a property, `acceptedVoucherSizes`.
  (Originally: "NO fallback to bedrooms" - with the import never filling the
  field, that sent nearly every property to Not recorded and emptied the list
  under any size.)
- D4. Both extras are in: filters kept in the page address, and the
  invisible-lock bug fixed.
- D5. DynamoDB Local is NOT restarted overnight; a gate blocked by it is
  reported, not worked around.

Planner calls Cameron approved ("go", 2026-10-01):

- C1. The status filter stays a single dropdown. The Active tab defaults to
  Available; the Deleted tab defaults to All statuses and has no summary.
- C2. Summary rows: "All authorities" first (each property counted ONCE), then
  one row per authority sorted alphabetically (case-insensitive), then "No
  authority recorded" when non-zero. A property accepting several authorities
  counts under each; a one-line note under the table says so. Authority rows
  (and the no-authority row) with BOTH counts zero are hidden; the All row
  always shows. Column headers: "Housing authority", "Available",
  "Coming soon (Setup)".
- C3. The summary counts follow the voucher-size filter ONLY - never the status
  filter, the authority filter, or the search (the summary IS the
  status-by-authority breakdown).
- C4. Clicking a count sets the status to that column's status, sets the
  authority filter to exactly that authority (the All row clears it; the
  no-authority row selects Not recorded), KEEPS the voucher filter, and CLEARS
  the search - so the list shows exactly the properties counted. A zero count
  is plain text, not a link.
- C5. Voucher-size chips: Studio, 1-BR, 2-BR, 3-BR, 4+ BR, Not recorded - the
  Tenants list's labels (`VOUCHER_BUCKETS`). Multi-select, OR within the facet.
  A property's recorded voucher size may be ONE number (today) or a LIST of
  numbers (after #12, and already in the `full` demo seed); it matches any size
  it lists, and with nothing recorded its bedroom count stands in (D3 as
  amended). Sizes 4 and above count as 4+. No counts on the chips.
- C6. Names: the summary AND the existing authority chips show the STORED
  spelling. `humanizeAuthority` is deleted (step 2 of
  `retire-humanize-authority`; the Tenants list already displays stored
  spellings). Demo/test seeds show slug spellings such as `atlanta_housing`
  until #2 normalizes names. No name mapping is built here (#2 owns it).
- C7. Status, authority, voucher size and search are kept in the page address.
  Back from a property returns to the same view; switching Active/Deleted
  starts clean; a selection that is not on screen never filters.
- C8. Rows are unchanged. The Active subtitle changes from "All property
  records." to copy that says Available is the default.

## 3. Behavior

### 3.1 Data

All data comes from the already-loaded unit list (`useListings`, every page
walked). Dashboard-only: no API, repo, seed, or data change.

- Status: `unit.status`. "Available" = `available`; "Coming soon" = `setup`.
- Authorities: `authoritiesOf(unit)` (existing). Grouping key:
  `normalizeAuthorityKey` (existing: underscores, whitespace, case). A unit
  contributes each DISTINCT non-empty key once, even when two of its stored
  spellings fold to the same key. A unit with no non-empty key is "no
  authority recorded".
- Display spelling per key: `displaySpelling` over the raw spellings of ALL
  units loaded for the current view (existing chip rule), so a chip and its
  summary row always read the same.
- Voucher sizes (amended 2026-10-04): `acceptedVoucherSizes(unit)` in
  `listingFormat.ts` is the ONE reader of the voucher sizes a property takes -
  its recorded `voucher_size_accepted` (a finite number yields `[n]`, an array
  its finite-number members) when that records at least one size; otherwise
  `[beds]` when `beds` is a finite number; otherwise `[]`. Buckets via ONE
  shared rule, `voucherBucketOfSize`, extracted from
  `tenantFacets.voucherBucketOf` (truncate, clamp to 0..4, 4 -> `4plus`; NaN has
  no bucket). A unit with no bucket - neither a voucher size nor a bedroom
  count - reads as "Not recorded". The property page's "Voucher size accepted"
  row and the New/Edit forms keep reading the stored field itself: they show and
  edit what was recorded.

### 3.2 Address (URL) contract

On `/listings` and `/listings/deleted`:

| Param | Values | Absent means |
|---|---|---|
| `status` | a `LISTING_STATUSES` value or `all` | Active: `available`; Deleted: `all` |
| `ha` | repeated; a NORMALIZED authority key, or `__none__` | no authority filter |
| `voucher` | repeated; `0` `1` `2` `3` `4plus` `__none__` | no voucher filter |
| `q` | the raw search text | no search |

- Parsing: an unknown `status` reads as the view default; unknown `voucher`
  values drop individually; empty `ha`/`q` values are ignored.
- State model (amended after code review rounds 1 and 2): the filters are
  LOCAL, urgently-updated component state and the URL is their PERSISTENCE.
  react-router 7's BrowserRouter applies URL changes inside a transition, so
  controls that read the URL lagged their own events (a second tap before the
  first committed dropped the first). Every write the page makes is STAMPED with
  history state (`unitListFilterWrite`). The URL is adopted into local state on
  mount and on every navigation that is not a stamped write: Back/Forward
  always, and any PUSH or REPLACE someone else made - a tab switch, a nav link, a
  summary count, including a same-URL link the router turns into a REPLACE. The
  stamp keeps a late commit of the page's own earlier write from reverting a
  newer choice.
- Writing: a chip or dropdown change REPLACES the history entry at once (Back
  leaves the page, the Tenants-list rule). The search box writes on BLUR and
  when a row is opened (and rides along with any other filter write), never per
  keystroke: WebKit throttles replaceState (100 calls per 10 s) and throws past
  that. Text typed and then abandoned by a browser Back/Forward is not saved -
  leaving the page that way leaves the search. A summary count is a drill-down
  NAVIGATION: its link PUSHES (Back undoes it), or REPLACES when its target
  equals the current URL; either way it is adopted. A write is SKIPPED while a
  PUSH or Back/Forward is still pending (react-router's history index has moved
  past the committed location), so that navigation wins instead of being
  overwritten. A status equal to the view default is omitted; empty facets and
  an empty search are omitted; unrelated params are untouched.
- Tabs: the ACTIVE view's own tab link carries the current (unpruned) choice;
  the other tab links to the bare path, so switching views starts clean.
- THE INVARIANT (the lock fix): a selection the user cannot see must not
  filter. Once the view's units are READY, the effective `ha` selection keeps
  only keys present in the current view's authority chips (plus `__none__` only
  while the Not recorded authority chip shows); while a view loads nothing is
  pruned, because nothing filters and no control shows. The URL is not
  rewritten on load; the next interaction re-serializes the pruned selection.

### 3.3 Controls (both tabs, once units have loaded and at least one exists)

- Status dropdown: unchanged options; value from the URL contract.
- Voucher size chips (new): the six chips of C5; Clear while any is selected.
- Housing authority chips: stored spellings (C6); a "Not recorded" chip appears
  only when some loaded unit in the view has no authority; Clear while any is
  selected.
- Search: unchanged box; its text is local state (filtering as you type), seeded
  from `q` and saved to `q` on blur or when a row is opened (3.2).
- Filtering: AND across status, voucher, authority, search; OR within a facet.
- Clear hands keyboard focus to its group's first chip (it unmounts itself).
- Chips wrap a long unbroken stored spelling rather than widen the page.

### 3.4 Summary table (Active tab only, once at least one unit has loaded)

- A `<table>` captioned "By housing authority", above the controls.
- Rows and columns per C2; counts per C3; links per C4. Each count link has an
  accessible name such as "Show 12 available properties for Atlanta Housing
  Authority" / "Show 1 coming soon property for DCA" / "... for all
  authorities" / "... with no housing authority recorded".
- Phone width: the table must not overflow sideways at 360px; authority names
  wrap.
- Under a voucher filter that leaves out Not recorded, a line under the table
  says how many available or coming-soon properties have no voucher size or
  bedroom count recorded and are not counted (amended after review round 1: a
  size filter must not shrink the counts silently; copy amended 2026-10-04 with
  the bedrooms fallback).
- Count links are underlined (not color alone); zeros use the muted text tone;
  the All row is bold with a heavier rule, not a tinted fill (contrast).

### 3.5 Copy

- Active subtitle: "Available properties by default - change the status filter
  to see the rest." Deleted subtitle unchanged.
- When nothing but the default status is in play and no row shows: "No
  available properties right now." with a "Show all statuses" button, which
  hands keyboard focus to the status filter (amended after review rounds 1-2).
  Any other empty result keeps the existing no-match message.

## 4. Out of scope

- Authority name mapping or cleanup (#2); seed slug normalization and the PATCH
  tombstones (remaining steps of `retire-humanize-authority`, now owned by #2).
- The voucher-size write path and the property page's display of a list value
  (#12).
- Any backend, data, seed, or matching change; the Tenants list.

## 5. Tests

- Unit (dashboard): a pure `unitListFacets` module (URL parse/write, prune,
  filtering, summary, count-click selection) and `voucherSizesOf`; the shared
  bucket rule keeps the Tenants suites green; `ListingsList` component tests
  for the default, the summary, count clicks, the voucher filter (number and
  list), URL restore, stored spellings, and the lock regression (Active ->
  Deleted with a stale authority selection does not empty the list).
- e2e (lean lane, self-cleaning): a new spec creates its own properties under a
  run-unique authority via the API, then proves the default, the summary counts
  (including a multi-authority property), a count click, the voucher filter,
  reload and Back restore, the clean Deleted tab, and no sideways overflow at
  360px.

## 6. Watch items

- The page-performance profiler's `/listings` terminal waits for the
  "Properties" rows list; the perf seed cycles every status, so Active still
  renders rows. Update its source-ledger line citations for the moved lines.
  (Review round 1 added: the terminal also accepts the default view's empty
  line, and the property-detail resolver binds an AVAILABLE unit - the only
  rows the default list renders. `/listings` timings are not comparable with
  pre-merge baselines, since the default view now renders far fewer rows.)
- The e2e scenario step that opens `/listings` looks for an AVAILABLE property:
  unaffected by the default.
- The component stays MOUNTED across `/listings` and `/listings/deleted`
  (sibling routes, same element position). Amended after review rounds 1-2:
  the filter state is local but RE-ADOPTED from the URL on every navigation that
  is not one of the page's own stamped writes, and the tab switch is a PUSH to a
  bare path - so nothing carries from one tab to the other, and the prune is the
  second defense.
- `docs/issues/properties-authority-filter-invisible-lock.md` closes with this
  branch; `retire-humanize-authority.md` gets a progress note (step 2 done).

## 7. Code names (amended after review round 1)

Code says `unit`, per documentation/GLOSSARY.md, and `propertyId` already names
the parent building group in code. So the new module is `unitListFacets`
(`UnitListSelection`, `UnitListView`, `parseUnitListSelection`,
`applyUnitListSelection`, `applyUnitListFilters`) and the summary component is
`AuthoritySummary`; staff-facing copy still says "property".
