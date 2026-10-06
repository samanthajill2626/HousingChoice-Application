# Tours page: the All tab - every tour, filtered and paged by the server (Sam #18, final part)

Status: DRAFT 1 (2026-10-06) - for adversarial review, then Cameron's spec gate.
Branch `feat/tour-list`, worktree `W:\tmp\tour-list`, cut from main @d839494a.
Records: `docs/superpowers/reviews/2026-10-06-tour-list/`.

## 1. Why

Sam (Improvements Tracker items 18 and 20) wants to see every tour, past and
upcoming, so she knows whom to follow up with (a text or a call), without having
to mark each tour just to move it into Closed. She first asked for a calendar;
on Sep 30 that became a list that can be filtered and sorted - by status
(no-show, canceled, toured), past or upcoming, and a date range - instead of a
calendar. The rest of item 18 is done and stays as it is: the Past tab
(Sep 27), Today's past-tours list (Sep 30), and the two-week auto-close with
Reopen (merged Oct 5).

Today the Tours page has three tabs, each a FIXED slice with no filter, sort or
search (section 3). No tab lists all tours: a tour scheduled more than 30 days
out, or a "needs placement" tour older than 90 days, is on none of them.

## 2. Decisions

### 2.1 Cameron's (2026-10-06)

- D1. A fourth tab, **All**, at `/tours/all`, listed FIRST: All | Active | Past |
  Closed. Opening Tours (`/tours`) still lands on Active, with the Active tab
  selected. (The tabs read from the widest set to the narrowest.)
- D2. The All list is filtered and paged BY THE SERVER, built now ("we'll
  probably need it in the future"). Showing the first screen must never load
  every tour.
- D3. Free-text search is FRONTEND-only: it filters the rows the server returned
  for the current filters. Because the list is paged, typing a search loads the
  REST of the current filtered list so the search covers every match, not just
  the pages already shown (section 6; explained to Cameron 2026-10-06).
- D4. A filter shows the undated OPEN tours - not canceled, closed or toured, with
  no date. These are exactly the `requested` tours (3.4). Label: **Not scheduled
  yet**.
- D5. The date-range read is paged to completion
  (`docs/issues/tours-scheduled-range-query-unpaginated.md`), so every existing
  date-window list (Active, Past, Today) is guaranteed complete.
- D6. Active, Past, Closed, Today and the auto-close keep their behavior.
- D7. No housing authority filter here (tracker #2 owns clean names).

### 2.2 Planner calls (flagged for the spec gate)

- P1. Filters: **When** (Any time / Upcoming / Past / Not scheduled yet / Date
  range), **Status** chips (multi-select), **Tour type** (single select),
  **Search** (tenant name or property address), **Sort** (Latest first /
  Earliest first). Not included: an outcome filter (closed rows already show the
  outcome), counts on the chips, sorting by name, separate tenant/property
  pickers (the search covers both).
- P2. The tab opens on: Any time, every status, every type, no search, latest
  first.
- P3. Until the user picks a sort, the order follows When: Upcoming and Not
  scheduled yet list earliest first; Any time, Past and Date range list latest
  first. A sort the user picked sticks across When changes.
- P4. Upcoming / Past split at an instant the SERVER pins on the first page of a
  list and carries in the cursor (5.5), so every page of one list uses the same
  boundary.
- P5. Pages of 50 rows; the search walk (section 6) asks for 100, the server's
  maximum (the house convention: `dashboard/src/api/paging.ts:33-40`).
- P6. Undated tours: Not scheduled yet = `requested`. Any time lists the undated
  tours AFTER every dated tour, in either sort direction: requested first, then
  toured, canceled, closed. Upcoming, Past and Date range list dated tours only.
- P7. The date column reads the tour's date and time for a dated tour, "Not
  booked" for a requested tour, and "Undated" for any other undated tour (the
  Past tab's word, `ToursPage.tsx:206`).
- P8. No total count from the server (it cannot count without reading
  everything): "Showing N tours" while more pages remain, "N tours" once the
  list is complete.
- P9. Each page carries the names its rows need (5.6), so the All tab never loads
  the contact or property lists.
- P10. Fix the full-profile seed tour that has a date but no `_schedPartition`
  (3.6) - the All tab is the first view where its absence shows.
- P11. perf:pages: `/tours/all` joins `/tours/past` in the route-pin exclusion
  and the existing gap issue widens to cover both (4.10).
- P12. GLOSSARY entry: a requested tour now has three staff labels - the
  "Requested" status badge, the Active tab's "Needs booking" section, and the
  All tab's "Not scheduled yet" filter - one entity, named per surface.

## 3. Current state (verified at main @d839494a)

### 3.1 The page

- Three URL-backed views: `/tours` Active, `/tours/past`, `/tours/closed`
  (`dashboard/src/App.tsx:240-242`; tabs `ToursPage.tsx:589-593`). The three
  routes render ONE `ToursPage` instance (same element position), so per-view
  state lives in children that mount per view (`PastToursView`,
  `ToursPage.tsx:348`).
- On EVERY tab the page loads: the Active reads (`useTours()`, unconditional,
  `ToursPage.tsx:621`: `GET /api/tours?from&to` for 30 days + `?status=requested`),
  every contact of four types live AND deleted (`useContacts('all')` and
  `('deleted')`, `ToursPage.tsx:622,626`, each a full cursor walk), and every
  unit live and deleted (`useListings()` / `(true)`, `:623,627`). The contact and
  unit walks exist only to put names on rows (`ToursPage.tsx:660-674`).
- Past adds a 90-day range read and `?status=toured` (`useTours.ts:293-340`);
  Closed adds `?status=closed` and `?status=canceled`, every closed and canceled
  tour ever (`useTours.ts:121-153`).
- The tab order is pinned by a unit test (`ToursPage.test.tsx:507-511`).

### 3.2 The API and repo

- `GET /api/tours` honors exactly ONE filter - tenantId > unitId > from+to >
  status - and returns `{ tours }` unpaged (`app/src/routes/tours.ts:363-403`).
  Callers: the tenant file, the property page, and the Tours tabs.
- Tours GSIs (`infra/envs/{dev,prod}/tables.auto.tfvars.json`, generated from
  `app/src/lib/tables.ts`): byTenant (hash tenantId), byUnit (hash unitId),
  byScheduledAt (hash `_schedPartition` = 'tours', range `scheduledAt`, SPARSE),
  byStatus (hash status, range createdAt).
- `listByScheduledRange` issues ONE Query and drops `LastEvaluatedKey`
  (`toursRepo.ts:399-416`). Its callers: `GET /api/tours?from&to`
  (`tours.ts:387`) and the Today route (`app/src/routes/today.ts:550`). A 1 MB
  page holds several hundred tours, far more than any 30- or 90-day window
  today, so nothing is dropped yet; the cap is latent. Every other tours read
  pages to completion: `listByStatus` (`toursRepo.ts:418-437`) and
  `listByTenant` / `listByUnit` via `queryAll` (`toursRepo.ts:327-342`,
  `app/src/lib/dynamoPaging.ts`).
- Cursor precedent for a client-paged route: `GET /api/placements` -
  base64url(JSON) of `LastEvaluatedKey`, shape-validated, 400 on a bad cursor
  (`app/src/routes/placements.ts:197-221, 509-572`). Paged routes accept
  `limit` 1..100 and 400 anything else (`placements.ts:172-195`).
- Names: `contactsRepo.getDisplaysByIds` batch-reads the display projection
  (contactId, firstName, lastName, phone, deleted_at), best-effort, 100-key
  chunks with `UnprocessedKeys` retries (`contactsRepo.ts:636, 849-904`).
  `unitsRepo` has NO batch read (grep: no BatchGet in `unitsRepo.ts`).

### 3.3 The back arrow

`TourDetail` returns to `state.back` only when it EXACTLY equals one of
`/tours`, `/tours/past`, `/tours/closed`, `/`; anything else falls back to
`/tours` (`TourDetail.tsx:113-124`).

### 3.4 Which tours can be undated

- `requested` NEVER has a date: create omits `scheduledAt` and defaults to
  requested (`toursRepo.ts:351-364`, `tours.ts:309-316`); a `scheduledAt` patch
  on a requested tour advances it to scheduled (`tours.ts:1139-1149`); nothing
  moves back to requested (`tours.ts:1060-1065`).
- `scheduled` always has a date (`tours.ts:1096-1105`); `no_show` is refused
  from requested (`tours.ts:1084-1087`), so it always had one.
- `toured` can be undated ("already toured" with the date left blank,
  `tours.ts:1067-1083`); `canceled` can be (a request canceled before booking);
  `closed` can be (an undated toured tour decided, converted or auto-closed).
  Conversion (`placements.ts:771-775`), auto-close (`toursRepo.ts:685+`) and
  reopen never touch `scheduledAt`.

### 3.5 #1's URL-filter pattern

The Properties list keeps filters in LOCAL state and treats the URL as
persistence: stamped REPLACE writes, adoption on POP and on any unstamped
navigation, writes skipped while a navigation is pending (history index
recorded in a LAYOUT effect), search saved on blur and on row open, never per
keystroke (`dashboard/src/routes/listings/ListingsList.tsx:7-36, 209-287`).
The traps it answers are real: react-router 7 applies URL changes inside a
transition (URL-driven controls lag and drop taps), and WebKit throws past 100
`replaceState` calls in 10 seconds.

### 3.6 A seed defect the All tab would expose

The full-profile cast tour `TOUR_TOURED` (`app/src/lib/seed/cast.ts:799-812`)
has `scheduledAt` but no `_schedPartition`, so it is in no date read. Every
other tours writer stamps it: the repo's create (`toursRepo.ts:358`) and the
live, matrix and performance seeds. The lean (e2e) world has no tours.

## 4. The All tab (dashboard)

### 4.1 Tabs and routes

- Tab strip: All (`/tours/all`) | Active (`/tours`) | Past (`/tours/past`) |
  Closed (`/tours/closed`). The nav item "Tours" still goes to `/tours` (Active).
- `App.tsx` adds `<Route path="tours/all" element={<ToursPage view="all" />} />`
  beside the other static tours routes (above `tours/:tourId`).
- Title "All tours". Intro: "Every tour, upcoming and past. Filter by date,
  status or type, or search by tenant or property." No "+ New tour" button
  (it stays on Active).

### 4.2 Page loading split

`ToursPage` keeps the header, the tab strip and the "+ New tour" dialog. Its
body becomes either `AllToursView` (view `all`) or one component that holds
TODAY's reads and rendering for Active, Past and Closed. Requirements:

- On `/tours/all` NOTHING else loads: no Active reads, no contact or unit walks.
- Active, Past and Closed issue exactly the GETs they issue today, and switching
  among those three still does not refetch the contact and unit walks (one
  mounted component). This keeps the registered perf surfaces `/tours` and
  `/tours/closed` unchanged (4.10).
- Moving from All to another tab mounts that component fresh (its walks load
  then), and back again remounts `AllToursView`.

### 4.3 The filter bar

Labels, roles and order:

- **When** - a select: Any time, Upcoming, Past, Not scheduled yet, Date range.
  Choosing Date range shows **From** and **To** date inputs (local calendar
  days); either may be left empty (open-ended); with both empty the range
  filters nothing.
- **Status** - a chip group of aria-pressed buttons (the #1 ChipGroup idiom):
  Requested, Scheduled, Toured, No show, Canceled, Closed; none pressed = every
  status; a Clear button once any is pressed. Under Upcoming, Past and Date
  range the Requested chip is NOT shown (a requested tour has no date, so it
  could never match). Under Not scheduled yet the whole group is hidden.
- **Tour type** - a select: All types, Self-guided, Landlord-led, PM team.
- **Search** - a text box, "Search tenant or property".
- **Sort** - a select: Latest first, Earliest first (default per P3).
- **Clear filters** - shown when anything differs from the defaults (P2);
  resets every control.

THE INVARIANT (from #1 and the Tenants list): a selection the user can neither
see nor clear must never filter. So the effective selection is PRUNED before it
is sent: a `requested` chip under a dated When, any status under Not scheduled
yet, and any unknown URL value drop out individually; a pruned-to-empty status
set means every status.

At phone width the controls wrap; at 480px or less they stack full width.

### 4.4 Rows

Each row matches the other tabs (`ToursPage.tsx:128-168`): tenant name,
property address, the date column (P7: date and time via `whenLabel`, "Not
booked", or "Undated"), the status label (`tourStatusLabel`), the outcome badge
on a closed tour, the type badge. The link goes to `/tours/:tourId` with
`state.back` set to the current `/tours/all` URL (4.8). Accessible name: "Tour
for <tenant> at <property>, <date column>". Names come from the page's name
maps (5.6); a missing entry falls back to the raw id, like `tenantName` /
`propertyLabel` today (`ToursPage.tsx:72-84`).

### 4.5 Paging

- A filter change aborts any in-flight request and loads the first page
  (`limit=50`).
- **Load more** appears while the last response carried a `nextCursor`; it
  appends the next page. Rows are de-duplicated by `tourId` on append (a tour
  rescheduled between two pages can move in the index and come back).
- A page that comes back EMPTY with a cursor (a sparse filter met the server's
  read budget, 5.4) is followed automatically, up to 5 in a row, so the list
  never shows an empty page above a Load more button.
- Count line (P8), `role="status"`.
- States: a first-page failure shows "We couldn't load tours. Please try
  again." with a Retry button; a Load more failure keeps the rows and shows
  the same message beside a Retry. An empty complete list shows "No tours match
  these filters." (plus Clear filters when filters are set).

### 4.6 Search

Section 6.

### 4.7 URL persistence

`/tours/all?when=&status=&type=&sort=&from=&to=&q=` - defaults omitted;
`status` a comma list; `from` / `to` local `YYYY-MM-DD`; `sort` written only
when the user picked one (P3). The state model is #1's (3.5), applied to a
child component that mounts only on the All view: filters live in local
state; control changes REPLACE the URL with a stamped write; the URL is
adopted on mount, on POP and on any unstamped navigation (the All tab link
clicked while filtered is a PUSH to bare `/tours/all` and resets the filters);
writes are skipped while a navigation is pending; the search text is written on
blur and on row open, never per keystroke.

### 4.8 The back arrow

`TourDetail` additionally accepts a `state.back` whose pathname is exactly
`/tours/all`, with any query string, and returns there ("Back to tours").
Every other rule in `TourDetail.tsx:113-124` is unchanged.

### 4.9 Data hook

`useAllTours(filters)` owns the paged state (rows, name maps, cursor, status,
the auto-follow of empty pages, the search walk) and calls a new API function
`listTours(params, cursor, limit, signal)` -> `GET /api/tours/list`. It reuses
`fetchAllPages`' conventions (100-row pages for a walk, a 50-page cap that
warns with counts only).

### 4.10 perf:pages

`e2e/performance/routes.test.ts` pins every `App.tsx` route against the
profiler's surfaces (`routes.test.ts:287, 376-385`). `/tours/all` is added to
its `excluded` set beside `/tours/past`, and
`docs/issues/perf-pages-tours-past-surface.md` widens to cover both. The
registered `/tours` and `/tours/closed` surfaces keep their GET contracts
(`e2e/performance/routes.ts:282-290, 614-615`) because 4.2 keeps their reads.

## 5. Server: `GET /api/tours/list`

### 5.1 Request

Query parameters (all optional):

- `when`: `any` (default) | `upcoming` | `past` | `unscheduled` | `range`.
- `from`, `to`: ISO 8601 instants (the browser converts its local days, the
  same contract as `GET /api/tours?from&to`); used only by `range`, which needs
  at least one of them; `from <= to` when both are given.
- `status`: comma-separated tour statuses; each must pass `isTourStatus`;
  duplicates ignored; absent or empty = every status.
- `type`: one tour type (`isTourType`); absent = every type.
- `sort`: `latest` | `earliest`; absent = the When default (P3).
- `limit`: 1..100, default 50.
- `cursor`: opaque (5.5).

Any invalid value -> 400 `{ error }` with a message naming the parameter.

### 5.2 Response

```
{
  tours: TourListRow[],
  contacts: { [contactId]: { firstName?, lastName?, phone? } },
  units: { [unitId]: { address? } },
  nextCursor: string | null
}
```

`TourListRow` is a slim projection: tourId, tenantId, unitId, scheduledAt?,
tourType, status, outcome?, convertible?, convertedPlacementId?, autoClosedAt?,
createdAt, updatedAt - what a row and `tourStatusLabel` need, never roster,
ladder or claim internals.

### 5.3 Query plan

N = the pinned instant (5.5). Statuses = the request's set, or all six.

| When | Phase(s) read | Default order |
|---|---|---|
| any | D: byScheduledAt, whole partition; then U: undated tours | latest first |
| upcoming | D: byScheduledAt, `scheduledAt >= N` | earliest first |
| past | D: byScheduledAt, `scheduledAt < N` | latest first |
| range | D: byScheduledAt, `BETWEEN from AND to` (or `>=` / `<=` when open-ended) | latest first |
| unscheduled | R: byStatus, `status = requested` (order by createdAt) | earliest first |

- Phase D sorts with `ScanIndexForward` and applies a FilterExpression for the
  status set (`status IN ...`, omitted when it is all six) and the type.
- Phase U walks byStatus for each of requested, toured, canceled, closed that is
  in the status set, in that order, each by createdAt in the sort direction,
  with FilterExpression `attribute_not_exists(scheduledAt)` (plus the type).
  The not-exists filter keeps a dated tour from appearing twice even if a
  requested row ever carried a date.
- Phase R applies the type filter only; the status parameter is ignored.
- Skips: phase D is skipped when the status set holds only `requested` (never
  dated, 3.4); phase U is skipped when the set holds none of its four statuses.

### 5.4 Filling a page

Named constants, injectable in tests: `QUERY_PAGE_LIMIT` = 200 (items a single
Query evaluates), `MAX_QUERY_CALLS` = 5 (per HTTP request, so at most 1,000
items evaluated).

The server keeps querying - moving from phase D to U, and through U's statuses -
until it has `limit` rows, every phase is exhausted, or the call budget is
spent. Where it stops decides the cursor:

- Page full mid-batch: the cursor holds the KEY OF THE LAST RETURNED ROW
  (byScheduledAt: tourId, `_schedPartition`, scheduledAt; byStatus: tourId,
  status, createdAt), never the batch's `LastEvaluatedKey` - rows evaluated
  after it were never sent.
- Budget spent: the cursor holds the last Query's `LastEvaluatedKey` (every
  evaluated row was returned or filtered out).
- Everything exhausted: `nextCursor: null`.

### 5.5 The cursor

base64url(JSON) of `{ v: 1, f, n, ph, i?, k }`:

- `f`: a fingerprint of the normalized filters (when, from, to, sorted status
  set, type, effective sort). A cursor presented with different filters -> 400
  `cursor_mismatch`.
- `n`: the pinned instant, set on the first page (no cursor) to the request
  time and reused by every later page. Without it, an Upcoming list read again
  hours later would start from a key the new `>= now` condition excludes.
- `ph`: `d` | `u` | `r`, and it must fit `when` (`any`: d or u; upcoming, past,
  range: d; unscheduled: r). `i`: the index into phase U's status order.
- `k`: the exclusive start key - exactly the attribute names of that phase's
  index plus `tourId`, string values only.

Anything else -> 400 `invalid cursor`. A DynamoDB ValidationException on a
start key is also answered 400 `invalid cursor`, never 500.

### 5.6 Names

After the page is assembled: the distinct tenantIds through
`contactsRepo.getDisplaysByIds` (best-effort), and the distinct unitIds through
a NEW `unitsRepo.getDisplaysByIds` - BatchGetItem by `unitId`, projection
`unitId, address`, 100-key chunks, `UnprocessedKeys` retried, best-effort,
modeled on the contacts walk (`contactsRepo.ts:849-892`). Soft-deleted contacts
and units still answer (they keep their rows), so closed tours of removed
records are named, as on the Closed tab today. A short map is a label problem,
never an error.

### 5.7 Placement and logging

The route is registered BEFORE `GET /:tourId` (`tours.ts:406`), so `list` never
reaches the tour lookup. It sits behind the `/api` auth mount like the rest of
the router. One info log line per request with COUNTS only (rows returned,
items evaluated, Query calls, phases touched) - never an id, name or address.

## 6. Search (client)

- Matching: case-insensitive substring of the trimmed text against the row's
  tenant label and property label, as displayed (4.4).
- It narrows the rows already loaded at once. If the list is not complete, the
  hook then loads the REST of the current filtered list (100-row pages, 300 ms
  after typing stops), and matches appear as pages arrive. The count line reads
  "Searching... N matches so far", then "N matches".
- Cost, stated plainly: a search with no other filter loads every tour once
  (tour rows and the names on them - never the contact or property lists). Any
  other filter shrinks what the walk reads.
- The walk is aborted by any filter change and capped at 50 pages (5,000 rows);
  a cap hit warns with counts only and the count line says the search covered
  only the first rows.
- Clearing the search keeps every loaded row and the Load more state.
- The upgrade path, if walks ever get slow, is matching on the server, which
  already has the names (`docs/issues/typeahead-scale-needs-server-side-search.md`
  is the house precedent). Not built now.

## 7. The date-range read

`listByScheduledRange` walks every page through `queryAll`
(`app/src/lib/dynamoPaging.ts`), like the other tours reads. Its two callers
(`tours.ts:387`, `today.ts:550`) are unchanged. A DynamoDB Local integration
test forces a small page size and proves a multi-page window comes back whole.
The issue `tours-scheduled-range-query-unpaginated` is resolved.

## 8. Invariants and every surface

The All tab adds READERS of two invariants; it changes no writer.

I1. `requested` <=> no `scheduledAt`; `scheduled` and `no_show` always have one.
Writers: the repo's create (`toursRepo.ts:345-375`; a caller-supplied status
wins, so a seed can break it), POST `/api/tours` (`tours.ts:265-361`), PATCH
(`tours.ts:986+`), reopen (`tours.ts:1482+`), auto-close
(`jobs/tourAutoClose.ts`), conversion (`placements.ts:771`), roster writes
(`rosterProvision.ts:398`), seeds (cast, matrix, live, performance), dev
reseed. Readers relying on it: phase R and phase U (5.3), the Requested-chip
pruning (4.3), the Active tab's Needs booking (`useTours.ts:72`).

I2. A tour with a `scheduledAt` carries `_schedPartition` = 'tours' (else no
date read finds it). Writers: the repo's create (always stamps), every seed
(cast misses it - fixed here, P10), PATCH and the other updates (never remove
it). Readers: `GET /api/tours?from&to`, `today.ts:550`, phase D.

Status words: the All rows read `tourStatusLabel` and `TOUR_OUTCOME_LABELS`,
the shared readers every other tour list uses.

## 9. Tests

- app: route tests for `GET /api/tours/list` (validation, each When's key
  condition and order, the status/type filters, phase skips, the D-to-U
  transition, cursor fingerprint / pinned instant / phase rules, budget stops,
  name maps, `list` never hitting the tour lookup); DynamoDB Local integration
  tests for the paging mechanics with tiny `QUERY_PAGE_LIMIT` / `limit` (a
  page that fills mid-batch resumes at the next row; a sparse filter returns
  partial pages and still reaches every match; undated rows after dated ones;
  no duplicates); `unitsRepo.getDisplaysByIds`; the paged range read.
- dashboard: the tab order (All first) and Active as `/tours`'s view; `/tours/all`
  issuing no contact, unit or Active reads; filters -> request parameters,
  pruning, defaults, Clear filters; Load more, de-duplication, auto-follow of
  empty pages, errors; the search walk (narrows at once, walks the rest,
  aborts on a filter change, count copy); URL adoption and stamped writes;
  the back-state and `TourDetail`'s acceptance of `/tours/all?...`.
- e2e: a spec that creates its own uniquely named tours through the API (a
  request, an upcoming, a past no-show, a canceled, an undated toured) and
  checks: the tab order and `/tours` landing on Active; Not scheduled yet;
  Upcoming; Past + No show; Any time listing the undated after the dated;
  search; a row opened and the back arrow returning to the same filtered URL.
  It scopes every assertion to its own rows (the lane holds other specs' tours)
  and keeps selectors inside the "Tours view" nav (Playwright names are
  case-insensitive substrings). An API-level step walks
  `GET /api/tours/list?limit=2` to `nextCursor: null` through the real stack.
- perf: the `routes.test.ts` exclusion.

## 10. Not in this change (follow-ups to file)

- The Closed tab still loads every closed and canceled tour (that list only
  grows); the new read can serve it later.
- Active, Past and Closed still load every contact and property for names; the
  new read's name maps are the way out.
- Server-side search (6).
- Registering `/tours/all` and `/tours/past` as profiler surfaces (4.10).
- Live updates on tour events (the list refreshes on mount and on filter
  changes only).

## 11. Rollout

App + dashboard. No new index, no Terraform, no migration, no switch. Rides the
next deploy with #1 and the auto-close.
