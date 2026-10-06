# Tours page: the All tab - every tour, filtered and paged by the server (Sam #18, final part)

Status: DRAFT 2 (2026-10-06) - after design review round 1 (rulings:
`docs/superpowers/reviews/2026-10-06-tour-list/design-review/adjudications.md`).
For review round 2, then Cameron's spec gate.
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
  selected. (All holds every tour; the other three are narrower subsets.)
- D2. The All list is filtered and paged BY THE SERVER, built now ("we'll
  probably need it in the future"). The first screen of an UNSEARCHED list never
  loads every tour.
- D3. Free-text search is FRONTEND-only: it filters the rows the server returned
  for the current filters. Because the list is paged, a search loads the REST of
  the current filtered list so it covers every match, not just the pages already
  shown (section 6; explained to Cameron 2026-10-06). A search is the one way
  the All tab loads a whole filtered list.
- D4. A filter shows the undated OPEN tours (Cameron: "still open, not canceled,
  closed, or marked toured, and that don't have a date"). As the dashboard can
  produce them, these are exactly the `requested` tours (3.4).
- D5. The date-range read is paged to completion
  (`docs/issues/tours-scheduled-range-query-unpaginated.md`), so every existing
  date-window list (Active, Past, Today) is guaranteed complete.
- D6. Active, Past, Closed, Today and the auto-close keep their behavior.
- D7. No housing authority filter here (tracker #2 owns clean names).

### 2.2 Planner calls (flagged for the spec gate)

- P1. Filters: **When** (Any time / Upcoming / Past / Needs booking / Date
  range), **Status** chips (multi-select), **Tour type** (single select),
  **Search** (tenant name or property address), **Sort** (Latest first /
  Earliest first). Not included: an outcome filter (closed rows already show the
  outcome), counts on the chips, sorting by name, separate tenant/property
  pickers (the search covers both).
- P2. The tab opens on: Any time, every status, every type, no search, latest
  first.
- P3. Until the user picks a sort, the order follows When: Upcoming and Needs
  booking list earliest first; Any time, Past and Date range list latest
  first. A sort the user picked sticks across When changes.
- P4. Upcoming / Past split at an instant the SERVER pins on the first page of a
  list and carries in the cursor (5.5), so every page of one list uses the same
  boundary.
- P5. Pages of 50 rows; a search walk and a return-restore (P14) ask for 100,
  the server's maximum (the house convention, `dashboard/src/api/paging.ts:33-40`).
- P6. Undated tours: Needs booking = `requested`. Any time lists the undated
  tours AFTER every dated tour, in either sort direction: requested first, then
  toured, no-show, canceled, closed. Upcoming, Past and Date range list dated
  tours only.
- P7. The date column reads the tour's date and time for a dated tour, "Not
  booked" for a requested tour (the tour page's word, `TourDetail.tsx:312`), and
  "Undated" for any other undated tour (the Past tab's word, `ToursPage.tsx:206`).
- P8. No total count from the server (it cannot count without reading
  everything). The count line (4.5) says "Showing N tours" while more pages
  remain and "N tours" once the list is complete.
- P9. Each page carries the names its rows need (5.6), so the All tab never loads
  the contact or property lists.
- P10. Every seeded tour row carries `_schedPartition` = 'tours', exactly as the
  repo's create writes every tour (3.6).
- P11. perf:pages: `/tours/all` joins `/tours/past` in the route-pin exclusion,
  the existing gap issue widens to cover both, and the ledger citations the
  4.2 split moves are refreshed (4.11).
- P12. The undated-open filter is named **Needs booking** - the Active tab's
  existing name for the same tours - rather than a new phrase ("not scheduled
  yet" was Cameron's description of the set). The GLOSSARY records every staff
  label a requested tour carries (3.7).
- P13. All's Upcoming and Past are pure date splits at the pinned instant,
  across every status (the Status chips narrow them). They deliberately differ
  from Active's Upcoming section (scheduled tours from the start of today -
  `useTours.ts:1-7, 76-80`, the 2026-07-15 ruling) and from the Past tab (90 days
  of tours still needing a decision, `useTours.ts:159-212`), which are curated
  work lists. So a canceled tour next week shows under All > Upcoming with its
  Canceled badge, and a tour at 9 am today is Past on All after 9 am.
- P14. Returning to the All list from a tour - the tour page's back arrow or the
  browser's Back - reloads the list to the depth already loaded and brings the
  opened row back into view (4.9). Every other arrival starts at page 1. (The
  cheaper alternative, accepting the reset, is offered at the spec gate.)
- P15. Re-clicking the All tab while on it does not navigate: it keeps the
  filters and any unsaved search. (#1 keeps filters on a re-click too,
  `ListingsList.tsx:321-324`; here the tab strip lives in the parent, which cannot
  see the child's local state, so doing nothing is the faithful version.)

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
  Its `from`/`to` are any `Date.parse`-able strings compared RAW
  (`tours.ts:136-140, 383-387`). Callers: the tenant file
  (`useContactFile.ts:162`), the landlord file per unit (`useContactFile.ts:172`),
  the property page, the Tours tabs, Today's fallback range read
  (`useToday.ts:65`) and Today's past-tours list (`usePastTours`).
- Tours GSIs (`infra/envs/{dev,prod}/tables.auto.tfvars.json`, generated from
  `app/src/lib/tables.ts`; every index projects ALL): byTenant (hash tenantId),
  byUnit (hash unitId), byScheduledAt (hash `_schedPartition` = 'tours', range
  `scheduledAt`; an item is indexed only when it has BOTH), byStatus (hash
  status, range createdAt).
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
  `unitsRepo` has NO batch read.
- Typed fakes of both repos live in `app/test/helpers/twilioWebhookHarness.ts`
  (`UnitsRepo` at :2690, `ToursRepo` at :3470); a new repo method must be added
  there too or the typecheck gate fails.

### 3.3 The back arrow

`TourDetail` returns to `state.back` only when it EXACTLY equals one of
`/tours`, `/tours/past`, `/tours/closed`, `/`; anything else falls back to
`/tours` (`TourDetail.tsx:113-124`). The arrow is a plain `<Link>` (a PUSH,
`TourDetail.tsx:683`).

### 3.4 Which tours can be undated

- `requested` NEVER has a date: create omits `scheduledAt` and defaults to
  requested (`toursRepo.ts:351-364`, `tours.ts:309-316`); a `scheduledAt` patch
  on a requested tour advances it to scheduled (`tours.ts:1139-1149`); nothing
  moves back to requested (`tours.ts:1060-1065`).
- `scheduled` always has a date (`tours.ts:1096-1105`).
- `toured` can be undated ("already toured" with the date left blank,
  `tours.ts:1067-1083`); `canceled` can be (a request canceled before booking);
  `closed` can be (an undated toured tour decided, converted or auto-closed).
  Conversion (`placements.ts:771-775`), auto-close (`toursRepo.ts:685+`) and
  reopen never touch `scheduledAt`.
- `no_show` CAN be undated through the API: only requested -> no_show is
  refused (`tours.ts:1084-1087`); requested -> canceled -> no_show and requested
  -> toured -> no_show pass every guard (`tours.ts:1051-1106`). The dashboard
  offers Mark no-show only on a scheduled tour (`TourDetail.tsx:319`), so through
  the dashboard an undated OPEN tour is always `requested`. (Filed:
  `docs/issues/tour-no-show-without-date.md`.)

### 3.5 #1's URL-filter pattern

The Properties list keeps filters in LOCAL state and treats the URL as
persistence: stamped REPLACE writes, adoption on POP and on any unstamped
navigation, writes skipped while a navigation is pending (history index
recorded in a LAYOUT effect), search saved on blur and on row open, never per
keystroke; the current tab's link is built from local state, typed text
included (`dashboard/src/routes/listings/ListingsList.tsx:7-36, 209-296,
315-330`). The traps it answers are real: react-router 7 applies URL changes
inside a transition (URL-driven controls lag and drop taps), and WebKit throws
past 100 `replaceState` calls in 10 seconds.

### 3.6 Seed rows outside the date index

The repo's create stamps `_schedPartition` on EVERY tour, dated or not
(`toursRepo.ts:355-364`), and tours are never imported. Seeds write raw items
(`app/src/lib/seed/index.ts:127-157`), and three full-profile rows lack it: the
cast requested tour (`cast.ts:547-561`), the cast toured tour, which HAS a date
(`cast.ts:799-812`), and the matrix requested tours (`matrix.ts:940-946`) - a
test even requires the absence (`app/test/seedMatrixCoherence.test.ts:410-417`).
The live, matrix-dated and performance seeds stamp it. PATCH, the writer that
ADDS a date (booking; "already toured" with a date), never writes
`_schedPartition` (`toursRepo.ts:168-170, 439+`) - so a seeded request that is
booked leaves every date read. The lean (e2e) world has no tours.

### 3.7 Tour labels in use

- `tourStatusLabel` (`dashboard/src/api/types.ts:904-912`): Active and Closed
  rows, the tour header, tenant/landlord/property tour lists.
- `pastState` (`useTours.ts:264-270`): the Past tab and Today ("Not marked",
  "Needs outcome", "Needs placement", "No show").
- A requested tour reads "Requested" (status badge), sits under "Needs booking"
  on Active (list name "Unbooked tour requests", `ToursPage.tsx:759-766`), and
  its tour page says "Not booked" - which the tour page says for EVERY undated
  tour (`TourDetail.tsx:312`).

### 3.8 Today's cap warning

The Today route calls `warnIfCapped('tours_today', ..., GROUP_FETCH_LIMIT)`
after the range read (`today.ts:551`; message "results truncated",
`today.ts:412-415`). It assumes the single-page read D5 removes.

## 4. The All tab (dashboard)

### 4.1 Tabs and routes

- Tab strip: All (`/tours/all`) | Active (`/tours`) | Past (`/tours/past`) |
  Closed (`/tours/closed`). The nav item "Tours" still goes to `/tours` (Active).
- `App.tsx` adds `<Route path="tours/all" element={<ToursPage view="all" />} />`
  beside the other static tours routes (above `tours/:tourId`).
- Title "All tours". Intro: "Every tour, upcoming and past. Filter by date,
  status or type, or search by tenant or property." No "+ New tour" button
  (it stays on Active).
- P15: while on All, the All tab's click is prevented (no navigation). The other
  tabs keep their bare links, so switching views always starts clean.

### 4.2 Page loading split

`ToursPage` keeps the header, the tab strip and the "+ New tour" dialog. Its
body becomes either `AllToursView` (view `all`) or ONE component that holds
TODAY's reads and rendering for Active, Past and Closed. Requirements:

- On `/tours/all` NOTHING else loads: no Active reads, no contact or unit walks.
- Active, Past and Closed issue exactly the GETs they issue today, and switching
  among those three still does not refetch the contact and unit walks (one
  mounted component). A dashboard test pins it (perf:pages cannot - its warm
  mode treats the walks as conditional, `e2e/performance/routes.ts:886-891`).
- Moving from All to another tab mounts that component fresh (its walks load
  then); back again remounts `AllToursView`.

### 4.3 The filter bar

Labels, roles and order:

- **When** - a select: Any time, Upcoming, Past, Needs booking, Date range.
- **From** / **To** - date inputs, shown only under Date range. Each is a local
  calendar day; either or both may be empty (both empty = every dated tour,
  P6). Conversion: From -> the start of that local day; To -> the END of that
  local day (the next local midnight minus 1 ms), by calendar arithmetic as
  `pastToursDateRange` does across DST (`useTours.ts:175-185`); both sent as
  `toISOString()`. An input value is parsed from its year/month/day parts -
  never `new Date('YYYY-MM-DD')`, which is UTC midnight (the previous evening
  in Atlanta). From after To shows "From must be on or before To." under the
  inputs and sends NO request; the list area keeps that message until fixed.
- **Status** - a chip group of aria-pressed buttons (the #1 ChipGroup idiom):
  Requested, Scheduled, Toured, No show, Canceled, Closed; none pressed = every
  status; a Clear button once any is pressed. Under Upcoming, Past and Date
  range the Requested chip is NOT shown (a requested tour has no date). Under
  Needs booking the whole group is hidden.
- **Tour type** - a select: All types, Self-guided, Landlord-led, PM team.
- **Search** - a text box, "Search tenant or property".
- **Sort** - a select: Latest first, Earliest first (default per P3).
- **Clear filters** - shown when anything differs from the defaults (P2);
  resets every control.

THE INVARIANT (from #1 and the Tenants list): a selection the user can neither
see nor clear must never filter. So the effective selection is PRUNED before it
is sent: a `requested` chip under a dated When, any status under Needs booking,
`from`/`to` under any When but Date range, and any unknown URL value drop out
individually; a pruned-to-empty status set means every status.

At phone width the controls wrap; at 480px or less they stack full width.

### 4.4 Rows

Each row matches the other tabs (`ToursPage.tsx:128-168`): tenant name,
property address, the date column (P7: date and time via `whenLabel`, "Not
booked", or "Undated"), the status label (`tourStatusLabel`), the outcome badge
on a closed tour, the type badge. Accessible name: "Tour for <tenant> at
<property>, <date column>, <status label>" plus ", <outcome>" on a closed row
with one (the Past tab ruling: the state rides in the name,
`ToursPage.tsx:231-234`). Names come from the page's name maps (5.6); a missing
entry falls back to the raw id, like `tenantName` / `propertyLabel` today
(`ToursPage.tsx:72-84`). The link goes to `/tours/:tourId` with the router state
of 4.8.

### 4.5 Paging and the count line

- A filter change aborts any in-flight request and loads the first page
  (`limit=50`).
- **Load more** appears while the last response carried a `nextCursor` and no
  search walk is running; it appends the next page.
- De-duplication by `tourId` on append: the LATER copy's data replaces the
  earlier row in place (a tour rescheduled between two pages can come back).
- Empty pages: a page that comes back EMPTY with a cursor (a sparse filter met
  the server's read budget, 5.4) is followed automatically, up to 10 in a row.
  While following, the count line reads "Checking more tours...". If the tenth
  is still empty the list stops and shows, below any rows, "No more matches in
  the tours checked so far." with a **Keep checking** button (the same request
  as Load more).
- An empty page with `nextCursor: null` simply completes the list.
- Count line (`role="status"`): "Showing N tours" (more remain), "N tours"
  (complete), "Checking more tours..." (following), and during a search the
  copy of section 6.
- States: a first-page failure shows "We couldn't load tours. Please try
  again." with a Retry button; a Load more failure keeps the rows and shows the
  same message beside a Retry. A complete empty list shows "No tours match these
  filters." (plus Clear filters when filters are set).

### 4.6 Search

Section 6.

### 4.7 URL persistence

`/tours/all?when=&status=&type=&sort=&from=&to=&q=` - defaults omitted;
`status` a comma list; `from` / `to` local `YYYY-MM-DD`, written only under
Date range; `sort` written only when the user picked one (P3). The state model
is #1's (3.5), in a child component that mounts only on the All view: filters
live in local state; control changes REPLACE the URL with a stamped write; the
URL is adopted on mount, on POP and on any unstamped navigation; writes are
skipped while a navigation is pending; the search text is written on blur and
on row open, never per keystroke. (P15 replaces #1's current-tab link.)

### 4.8 The back arrow

- Each row's link carries router state `{ back }`, built AT CLICK TIME from the
  view's LOCAL selection - filters and search text, serialized exactly as 4.7
  writes the URL - never from `location` (a search typed but not yet saved
  would be dropped, and the back arrow and the browser's Back would disagree).
- `TourDetail` additionally accepts a `state.back` whose pathname is exactly
  `/tours/all`, with any query string, and returns there ("Back to tours"). Its
  back link to that target also carries `{ returnToList: true }` (4.9). Every
  other rule in `TourDetail.tsx:113-124` is unchanged.

### 4.9 Returning from a tour (P14)

- A module-level memory, one per browser tab (the Past tab's batch-store
  idiom, `ToursPage.tsx:290-333`), keeps for the All view: the normalized filter
  key (everything but the search text), how many rows were loaded, and the
  `tourId` of the row last opened.
- On mount, when the navigation is a POP or carries `returnToList`, and the
  filter key matches the memory, the view loads pages (`limit=100`, fresh reads)
  until it holds at least that many rows or the list ends, then scrolls the
  opened row into view and moves focus to its link (when the row is still in
  the list). Any other mount starts at page 1 and resets the memory.
- With a search, the walk of section 6 loads the whole filtered list anyway; the
  opened row is then brought into view the same way.

### 4.10 Data hook

`useAllTours(selection)` owns the paged state (rows, name maps, cursor, status,
the empty-page follow, the search walk, the return restore) and calls a new API
function `listTours(params, cursor, limit, signal)` -> `GET /api/tours/list`.

### 4.11 perf:pages

`e2e/performance/routes.test.ts` pins every `App.tsx` route against the
profiler's surfaces (`routes.test.ts:287, 376-385`). `/tours/all` is added to
its `excluded` set beside `/tours/past`, and
`docs/issues/perf-pages-tours-past-surface.md` widens to cover both. The
registered `/tours` and `/tours/closed` surfaces keep their GET contracts
(`e2e/performance/routes.ts:282-290, 614-615`) because 4.2 keeps their reads,
and the `CONTRACT_SOURCE_LEDGER` citations that the 4.2 split moves
(`routes.ts:724-725, 753-755, 778-779`, and the App.tsx resolver citation) are
refreshed in the same change - their test checks only the citation format
(`routes.test.ts:422-455`).

## 5. Server: `GET /api/tours/list`

### 5.1 Request

Query parameters (all optional):

- `when`: `any` (default) | `upcoming` | `past` | `unscheduled` (the UI's
  "Needs booking") | `range`.
- `from`, `to`: ISO 8601 instants, accepted ONLY with `when=range` (400
  otherwise). Each is canonicalized with `new Date(x).toISOString()` before it
  is used anywhere (key condition, comparison, fingerprint) - the existing
  route compares raw strings, the index holds canonical ones. Either or both may
  be absent (both absent = every dated tour). `from <= to` when both are given.
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
createdAt, updatedAt - what a row and `tourStatusLabel` need. Never the roster,
the ladder pointer or claim timestamps. (`convertedPlacementId` can hold the
`pending:` sentinel during a conversion, `placements.ts:714`, exactly as
`GET /api/tours` already returns it.)

### 5.3 Query plan

N = the pinned instant (5.5). Statuses = the request's set, or all six.
U_ORDER = [requested, toured, no_show, canceled, closed] - every status except
`scheduled`, which always has a date (3.4).

| When | Phase(s) read | Default order |
|---|---|---|
| any | D: byScheduledAt, whole partition; then U: undated tours | latest first |
| upcoming | D: byScheduledAt, `scheduledAt >= N` | earliest first |
| past | D: byScheduledAt, `scheduledAt < N` | latest first |
| range | D: byScheduledAt, `BETWEEN from AND to`, `>= from`, `<= to`, or the whole partition | latest first |
| unscheduled | R: byStatus, `status = requested` (order by createdAt) | earliest first |

- Phase D sorts with `ScanIndexForward` and applies a FilterExpression for the
  status set (`status IN ...`, omitted when it is all six) and the type.
- Phase U walks byStatus for each U_ORDER status that is in the status set, in
  U_ORDER, each by createdAt in the sort direction, with FilterExpression
  `attribute_not_exists(scheduledAt)` (plus the type). The not-exists filter
  keeps a dated tour from appearing twice. `requested` comes first because every
  requested tour is undated: that partition wastes no reads, while the others
  re-evaluate their dated tours to find the few undated ones.
- Phase R applies the type filter only; the status parameter is ignored.
- Skips: phase D is skipped when the status set holds only `requested` (never
  dated); phase U is skipped when the status set holds no U_ORDER status (the
  set is exactly `scheduled`).

### 5.4 Filling a page

Named constants, injectable through the router's deps for tests:
`QUERY_PAGE_LIMIT` = 200 (items one filtered Query evaluates) and
`MAX_QUERY_CALLS` = 5 (Queries per HTTP request).

- A Query with NO FilterExpression (phase D with every status and type, phase R
  with every type) asks for exactly the rows still needed (`Limit = limit -
  rows`), so an unfiltered page never over-reads. A filtered Query (phase U
  always) asks for `QUERY_PAGE_LIMIT`.
- The server keeps querying - D, then U's statuses in order - until it has
  `limit` rows, every phase is exhausted, or the call budget is spent.
- Where it stops decides the cursor:
  - Page full with matched rows still unreturned in the last batch: `k` = the
    KEY OF THE LAST RETURNED ROW (byScheduledAt: tourId, `_schedPartition`,
    scheduledAt; byStatus: tourId, status, createdAt) - rows after it were
    evaluated but never sent.
  - Last batch fully consumed and it carried a `LastEvaluatedKey`: `k` = that
    key (everything evaluated was sent or filtered out).
  - Last batch fully consumed with NO `LastEvaluatedKey` (its phase or status
    is exhausted): if another phase or U status remains, the cursor names it
    with NO `k` ("start of"); otherwise `nextCursor: null`. So a page that ends
    on the final row of the final phase never leaves a phantom Load more.

### 5.5 The cursor

base64url(JSON) of `{ v: 1, f, n, ph, i?, k? }`:

- `f`: a fingerprint of the normalized filters (when, canonical from and to,
  sorted status set, type, effective sort). A cursor presented with different
  filters -> 400 `cursor_mismatch`.
- `n`: the pinned instant (canonical ISO), set on the first page (no cursor) to
  the request time and reused by every later page. Without it, an Upcoming list
  read again hours later would start from a key the new `>= now` condition
  excludes.
- Legal combinations, everything else -> 400 `invalid cursor`:
  - `ph: 'd'` with `k` (byScheduledAt key; `k._schedPartition` must be
    'tours') - for any, upcoming, past, range, and never when phase D is
    skipped.
  - `ph: 'u'` with `i` (an integer index into U_ORDER whose status is in the
    request's set) and an optional `k` (byStatus key; `k.status` must equal
    `U_ORDER[i]`; absent = start of that status) - only for any, and never when
    phase U is skipped.
  - `ph: 'r'` with `k` (byStatus key; `k.status` must be 'requested') - only for
    unscheduled.
  - `k`, when present, has EXACTLY the attribute names of its index plus
    `tourId`, all strings.
- A DynamoDB ValidationException on a request that CARRIED a cursor is answered
  400 `invalid cursor`; on a request without one it is a 500 (a defect in the
  query, not the client's input).

### 5.6 Names

After the page is assembled: the distinct tenantIds through
`contactsRepo.getDisplaysByIds` (best-effort), and the distinct unitIds through
a NEW `unitsRepo.getDisplaysByIds` - BatchGetItem by `unitId`, projection
`unitId, address`, 100-key chunks, `UnprocessedKeys` retried, best-effort,
modeled on the contacts walk (`contactsRepo.ts:849-892`), with the typed fake in
`twilioWebhookHarness.ts` (3.2) implementing it. Soft-deleted contacts and
units still answer (they keep their rows), so closed tours of removed records
are named, as on the Closed tab today. A short map is a label problem, never an
error.

### 5.7 Placement and logging

The route is registered BEFORE `GET /:tourId` (`tours.ts:406`), so `list` never
reaches the tour lookup. It sits behind the `/api` auth mount like the rest of
the router. One info log line per request with COUNTS only (rows returned,
items evaluated, Query calls, phases touched) - never an id, name or address.

## 6. Search (client)

- Matching: case-insensitive substring of the trimmed text against the row's
  tenant label and property label, as displayed (4.4). A row whose name did
  not load (best-effort names, 5.6) shows the raw id and cannot match by name -
  rare, a throttled read.
- It narrows the rows already loaded at once. If the list is not complete, the
  hook then loads the REST of the current filtered list (100-row pages) and
  matches appear as pages arrive. Triggers: 300 ms after typing stops, AND
  immediately whenever a non-empty search is adopted (mount, browser Back, the
  back arrow - 4.7, 4.9).
- While the walk runs, Load more is hidden and the count line reads
  "Searching... N matches so far"; once complete, "N matches".
- Cost, stated precisely: only When narrows what the SERVER reads (it is the
  key condition); status and type narrow what is SENT and how many requests
  the walk takes. A search under Any time therefore reads every tour once in
  phase D, and every toured, no-show, canceled and closed tour once more in
  phase U to find the undated ones. Tour rows and their names only - never the
  contact or property lists.
- The walk is aborted by any filter change and by clearing the search (the rows
  loaded so far and the last completed page's cursor stay, so Load more resumes
  there). It is capped at 50 REQUESTS (a budget-stopped page can hold few
  rows); a capped search says so: "Search stopped before the end of the list.
  Narrow the filters to search the rest." Because undated tours come last, a
  capped Any time search can miss them. Saying so is a deliberate departure
  from `paging.ts:20-26`'s no-flag rule: that rule governs whole-list walks
  feeding code; a user-facing search presented as complete would be the silent
  truncation that module exists to forbid.
- The upgrade path, if walks ever get slow, is matching on the server, which
  already has the names (`docs/issues/typeahead-scale-needs-server-side-search.md`
  is the house precedent). Not built now.

## 7. The date-range read and Today

- `listByScheduledRange` walks every page through `queryAll`
  (`app/src/lib/dynamoPaging.ts`), like the other tours reads, and gains an
  optional third argument `{ pageLimit?: number }` (the Query's `Limit`, used
  only by tests). Its two callers (`tours.ts:387`, `today.ts:550`) are unchanged.
- A DynamoDB Local integration test writes several tours in one window, reads
  it with `pageLimit: 1`, and proves the window comes back whole.
- Today's `warnIfCapped('tours_today', ...)` call (3.8) is removed: the read can
  no longer be truncated, so the warning could only be false.
- `docs/issues/tours-scheduled-range-query-unpaginated.md` is resolved.

## 8. Invariants and every surface

The All tab adds READERS of two invariants; it changes no writer of tour data.

I1. `requested` <=> no `scheduledAt`; `scheduled` always has one; every other
status may lack one (3.4). Writers: the repo's create (`toursRepo.ts:345-375`;
a caller-supplied status wins, so a seed can break it), POST `/api/tours`
(`tours.ts:265-361`), PATCH (`tours.ts:986+`), reopen (`tours.ts:1482+`),
auto-close (`app/src/jobs/tourAutoClose.ts`), conversion (`placements.ts:771`),
roster writes (`app/src/services/rosterProvision.ts:398`), seeds (cast, matrix,
live, performance), the dev reseed. Readers relying on it: phase R and phase U
(5.3), the Requested-chip pruning (4.3), the Active tab's Needs booking
(`useTours.ts:72`).

I2. A tour with a `scheduledAt` carries `_schedPartition` = 'tours' (else no
date read finds it). Writers: the repo's create (stamps every tour); PATCH, the
writer that ADDS a date, never stamps it, so it propagates any unstamped row
(3.6); seeds - fixed here (P10): every seeded tour row carries it, the matrix
coherence test's assertion is inverted (a requested tour stays off the index by
having no date), and a seed pin asserts every seeded tour row has it. Readers:
`GET /api/tours?from&to`, `today.ts:550`, phase D.

Labels: All rows read `tourStatusLabel` and `TOUR_OUTCOME_LABELS`, as the
Active and Closed rows and the tour header do. The Past tab and Today keep
`pastState` (their work-list wording). The GLOSSARY records a requested tour's
staff labels: "Requested" (status), "Needs booking" (Active section and All
filter; the Active list's name "Unbooked tour requests"), "Not booked" (tour
page and All date column).

## 9. Tests

- app:
  - Route tests for `GET /api/tours/list`: validation (each parameter, bounds
    with a non-range when, from > to, canonicalization); each When's key
    condition and order; status / type filters; phase skips; the D-to-U
    transition; the budget ending EXACTLY at the D-to-U boundary and at a U
    status boundary (k-less cursor, next request starts there); every
    illegal (ph, i, k) combination and a wrong-partition `k`; `cursor_mismatch`;
    the pinned instant; the ValidationException mapping (400 with a cursor,
    500 without); name maps; `list` never hitting the tour lookup.
  - DynamoDB Local integration tests with tiny `QUERY_PAGE_LIMIT`, budget and
    `limit`: a page that fills mid-batch resumes at the next row; a sparse
    filter returns partial pages and still reaches every match; undated rows
    come after dated ones in both directions; no duplicates; an unfiltered page
    evaluates only the rows it returns.
  - `unitsRepo.getDisplaysByIds` (chunks, retries, best-effort); the harness
    fakes; the paged range read (`pageLimit: 1`); Today without the cap warning;
    the seed pin and the inverted matrix assertion.
- dashboard:
  - The tab order (All first), `/tours` landing on Active, P15's no-op re-click.
  - `/tours/all` issuing no contact, unit or Active reads; Active -> Past ->
    Closed running each walk ONCE.
  - Filters -> request parameters; pruning; defaults; Clear filters; Date range
    conversion (a 6 pm tour on the To day is in, the From day starts at local
    midnight, both-empty sends no bounds, From after To sends nothing and shows
    the message); the sort default per When.
  - Load more; de-duplication (later copy wins); the empty-page follow, its cap
    copy and Keep checking; errors and Retry.
  - Search: narrows at once; walks the rest; starts immediately on an adopted
    search; hides Load more while walking; clearing aborts and keeps rows; the
    request cap copy.
  - URL adoption and stamped writes; `state.back` built from local state with an
    unsaved search; `TourDetail` accepting `/tours/all?...` and passing
    `returnToList`; the return restore (depth reloaded, opened row in view and
    focused); the row accessible name.
- e2e: a spec that creates its own uniquely named tenant contact and property
  through the API, then its tours (a request, an upcoming, a past no-show, a
  canceled, an undated toured), and checks: the tab order and `/tours` landing on
  Active; Needs booking; Upcoming; Past + No show; Any time with a search for
  the unique tenant name (the walk covers the whole list) listing the undated
  rows after the dated; a row opened from a search and the back arrow
  returning to the same filtered list with the search. Every assertion scopes
  to its own rows (the lane holds other specs' tours), selectors stay inside the
  "Tours view" nav (Playwright names are case-insensitive substrings), and an
  API-level step walks `GET /api/tours/list?limit=2` to `nextCursor: null`
  through the real stack.
- perf: the `routes.test.ts` exclusion; the refreshed ledger citations.

## 10. Not in this change (follow-ups)

- The Closed tab still loads every closed and canceled tour (that list only
  grows); the new read can serve it later.
- Active, Past and Closed still load every contact and property for names; the
  new read's name maps are the way out.
- Server-side search (6).
- Registering `/tours/all` and `/tours/past` as profiler surfaces (4.11).
- Live updates on tour events (the list refreshes on mount, on filter changes
  and on a return restore only).
- `docs/issues/tour-no-show-without-date.md` (3.4): the API accepts a no-show
  on a tour that never had a date.

## 11. Rollout

App + dashboard. No new index, no Terraform, no data migration, no switch.
Rides the next deploy with #1 and the auto-close.
