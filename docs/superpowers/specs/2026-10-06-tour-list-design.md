# Tours page: the All tab - every tour, filtered and paged by the server (Sam #18, final part)

Status: DRAFT 6 (2026-10-06) - design review closed after round 4 (rulings:
`docs/superpowers/reviews/2026-10-06-tour-list/design-review/adjudications.md`);
Cameron's spec-gate changes applied (D4 clarified, D8, D9) - otherwise approved.
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
  probably need it in the future"). A fresh, unsearched visit loads one page;
  more loads only when the user asks (Load more / Keep checking) or returns to
  a list they had already loaded further (P14, capped).
- D3. Free-text search is FRONTEND-only: it filters the rows the server returned
  for the current filters. Because the list is paged, a search loads the REST of
  the current filtered list so it covers every match, not just the pages already
  shown (section 6; explained to Cameron 2026-10-06). A search is the one thing
  that loads a whole filtered list on its own.
- D4. There must be a way to list JUST the undated OPEN tours (Cameron: "still
  open, not canceled, closed, or marked toured, and that don't have a date").
  As the dashboard can produce them, these are exactly the `requested` tours
  (3.4), and two ways cover it: the Active tab's Needs booking section, and,
  on the All tab, the **Needs booking** status chip (status `requested`) with
  When on Any time. NO separate filter is added (Cameron at the spec gate,
  2026-10-06, correcting an earlier draft that read his ask as a dedicated
  filter).
- D5. The date-range read is paged to completion
  (`docs/issues/tours-scheduled-range-query-unpaginated.md`), so every existing
  date-window list (Active, Past, Today) is guaranteed complete.
- D6. Active, Past, Closed, Today and the auto-close keep their behavior (the one
  wording change of D8 aside).
- D7. No housing authority filter here (tracker #2 owns clean names).
- D8. The undated wording is aligned EVERYWHERE in this change (Cameron at the
  spec gate, 2026-10-06): "Needs booking" for a requested tour - replacing "Not
  booked", so the actionable state has one actionable name - and "Undated" for
  any other tour without a date (P7).
- D10. On the All tab, the status chip for `requested` reads **Needs booking**
  (Cameron, 2026-10-06). The rows' status badge keeps "Requested" (P12).
- D9. Keep the return-to-where-you-were restore (P14) - "scrolling down and
  finding the next one each time is kind of annoying" (Cameron at the spec
  gate, 2026-10-06).

### 2.2 Planner calls (accepted at the spec gate, 2026-10-06)

- P1. Filters: **When** (Any time / Upcoming / Past / Date range), **Status**
  chips (multi-select), **Tour type** (single select),
  **Search** (tenant name or property address), **Sort** (Latest first /
  Earliest first). Not included: an outcome filter (closed rows already show the
  outcome), counts on the chips, sorting by name, separate tenant/property
  pickers (the search covers both).
- P2. The tab opens on: Any time, every status, every type, no search, latest
  first.
- P3. Until the user picks a sort, the order follows When: Upcoming lists
  earliest first; Any time, Past and Date range list latest first. A sort the
  user picked sticks across When changes. (So the undated open tours of D4 -
  the Needs booking chip under Any time - open newest request first; Earliest
  first matches the Active tab's oldest-first Needs booking section.)
- P4. Upcoming / Past split at an instant the SERVER pins on the first page of a
  list and carries in the cursor (5.5), so every page of one list uses the same
  boundary.
- P5. Pages of 50 rows; a search walk and a return-restore (P14) ask for 100,
  the server's maximum (the house convention, `dashboard/src/api/paging.ts:33-40`),
  after the list's usual 50-row first page.
- P6. Undated tours: Any time lists the undated tours AFTER every dated tour,
  in either sort direction: requested first, then toured, no-show, canceled,
  closed. Upcoming, Past and Date range list dated tours only. The Needs booking
  chip alone under Any time is D4's list (5.3: phase D is skipped and only the
  requested partition is read).
- P7. ONE wording rule for a tour's missing date, in ONE shared helper
  (`undatedTourLabel(tour)` beside `tourStatusLabel` in
  `dashboard/src/api/types.ts`): "Needs booking" for a requested tour, "Undated"
  for any other tour without a date (D8). Its readers: the All rows' date column
  (dated rows show date and time via `whenLabel`), the Past rows
  (`ToursPage.tsx:206` - every Past row is non-requested, so its output does not
  change), the tour page's facts line and Schedule card (both from
  `TourDetail.tsx:312`; `:783` reuses it), the tenant file
  (`TenantFile.tsx:334-337`), the landlord file (`LandlordFile.tsx:214-217`),
  the property page (`ListingDetail.tsx:1082-1084`), Today's past-tours row
  (`Today.tsx:215` - a literal "Undated" today; Today lists Past-tab rows,
  never a request, so its output does not change) and the Closed tab's date
  column (`ToursPage.tsx:131-136` - an undated closed or canceled tour shows an
  EMPTY date there today; it reads "Undated"). The tour page and the three
  lists say "Not booked" for EVERY undated tour today; after this change no
  surface says "Not booked". This resolves `docs/issues/undated-tour-wording.md`.
  The tests and e2e steps that assert "Not booked" for a REQUEST today move to
  "Needs booking": `TourDetail.test.tsx:307-308`, `ListingDetail.test.tsx:432-433`,
  `files.test.tsx:266-278, 458-470`, `e2e/tests/dashboard-next/tours-page.spec.ts:242`
  (and its comment at `:238-239`, which splits the phrase across two lines),
  `e2e/scenarios/steps.ts:1147, 1168-1169, 1176, 1854-1856`, the comment at
  `e2e/tests/scenarios/tours.spec.ts:417`, and the living doc
  `documentation/sequence-diagram-to-test.md:262-263`. The comment at
  `TourModals.tsx:203` describes an undated TOURED tour and moves to "Undated".
  (Amended 2026-10-06 from the plan research.)
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
- P12. A requested tour now carries two staff words: its STATUS is "Requested"
  (the badge on every row and the tour header - `TOUR_STATUS_LABELS`,
  unchanged), and everything that names the work - the Active section, the All
  tab's chip (D10) and its missing date on every surface (D8) - says "Needs
  booking". So on the All tab, the Needs booking chip lists rows whose date
  column reads "Needs booking" and whose badge reads "Requested". The GLOSSARY
  records both words and retires "Not booked".
- P13. All's Upcoming and Past are pure date splits at the pinned instant,
  across every status (the Status chips narrow them). They deliberately differ
  from Active's Upcoming section (scheduled tours from the start of today -
  `useTours.ts:1-7, 76-80`, the 2026-07-15 ruling) and from the Past tab (90 days
  of tours still needing a decision, `useTours.ts:159-212`), which are curated
  work lists. So a canceled tour next week shows under All > Upcoming with its
  Canceled badge, and a tour at 9 am today is Past on All after 9 am.
- P14. Opening a row records, in the list's own browser-history entry, how deep
  the list was loaded and which row was opened (its id and position). Coming
  back to that entry - the tour page's back arrow or the browser's Back -
  reloads the list to that depth (capped) and puts the user back at that row,
  or, when the row has left the list (the user marked, rescheduled, decided or
  canceled it), at the row now in its position - the next one to work on
  (4.9) - unless the user has already started typing, clicking or scrolling. A
  fresh arrival (the tab, the nav) starts at page 1. Kept at the spec gate (D9).
- P15. Re-clicking the All tab while on it does not navigate: it keeps the
  filters and any unsaved search. (#1 keeps filters on a re-click too,
  `ListingsList.tsx:321-324`; here the tab strip lives in the parent, which cannot
  see the child's local state, so doing nothing is the faithful version.) Only an
  unmodified primary click is suppressed; Ctrl/Cmd/Shift-click and middle-click
  keep the browser's open-in-new-tab behavior.

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
(`app/src/lib/seed/index.ts:127-157`), and FOUR full-profile rows lack it: the
cast requested tour (`cast.ts:548-561`), the cast toured tour, which HAS a date
(`cast.ts:799-817`), and the two matrix requested tours (`matrix.ts:930-946`
emits `tour-mx-requested-01` and `-02`) - a test even requires the absence
(`app/test/seedMatrixCoherence.test.ts:410-417`).
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
- P15: while on All, an unmodified primary click on the All tab is prevented
  (no navigation); a modified or middle click keeps the browser's default. The
  other tabs keep their bare links, so switching views always starts clean.

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

- **When** - a select: Any time, Upcoming, Past, Date range.
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
  Needs booking (status `requested`, D10), Scheduled, Toured, No show,
  Canceled, Closed; none pressed = every status; a Clear button once any is
  pressed. Under Upcoming, Past and Date range the Needs booking chip is NOT
  shown (a requested tour has no date). Needs booking alone, under Any time,
  lists exactly the undated open tours (D4).
- **Tour type** - a select: All types, Self-guided, Landlord-led, PM team.
- **Search** - a text box, "Search tenant or property".
- **Sort** - a select: Latest first, Earliest first (default per P3).
- **Clear filters** - shown when anything differs from the defaults (P2);
  resets every control.

THE INVARIANT (from #1 and the Tenants list): a selection the user can neither
see nor clear must never filter. So the effective selection is PRUNED before it
is sent: the Needs booking chip (`requested`) under a dated When, `from`/`to`
under any When but Date range, and any unknown URL value drop out individually;
a pruned-to-empty status set means every status. (The URL and the API keep the
status VALUE `requested`; only the chip's label is "Needs booking".)

At phone width the controls wrap; at 480px or less they stack full width.

### 4.4 Rows

Each row matches the other tabs (`ToursPage.tsx:128-168`): tenant name,
property address, the date column (date and time via `whenLabel`, else
`undatedTourLabel` - "Needs booking" or "Undated", P7), the status label
(`tourStatusLabel`), the outcome badge
on a closed tour, the type badge. Accessible name: "Tour for <tenant> at
<property>, <date column>, <status label>" plus ", <outcome>" on a closed row
with one (the Past tab ruling: the state rides in the name,
`ToursPage.tsx:231-234`). Names come from the page's name maps (5.6); a missing
entry falls back to the raw id, like `tenantName` / `propertyLabel` today
(`ToursPage.tsx:72-84`). The link goes to `/tours/:tourId` with the router state
of 4.8.

### 4.5 Paging and the count line

- ONE LOADER AT A TIME. Every request that starts or advances the list's
  cursor chain is a loader: the first-page load, Load more, Keep checking, the
  empty-page follow, the search walk (6) and the return restore (4.9). Exactly
  one runs at a time; while ANY runs, Load more and Keep checking are hidden. A
  filter or sort change aborts whichever is running and loads the first page
  (`limit=50`). Typing a search while a restore runs aborts the restore and the
  walk continues from the cursor it reached; typing one while the first-page
  load or a Load more / Keep checking request is in flight lets that request
  finish (its rows are valid for the same filters), then the walk continues
  from its cursor; an automatic empty-page-follow request in flight is aborted
  and re-requested from the SAME cursor as a walk page - no row lost or
  repeated (amended from the plan: one automatic loader, one effect).
- **Load more** appears while the last response carried a `nextCursor` and no
  loader is running; it appends the next page.
- De-duplication by `tourId` on append: the LATER copy's data replaces the
  earlier row in place (a tour rescheduled between two pages can come back).
- Empty pages: a page that comes back EMPTY with a cursor (a sparse filter met
  the server's read budget, 5.4) is followed automatically, up to 10 in a row.
  While following, the count line reads "Checking more tours...". If the tenth
  is still empty the list stops and shows, below any rows, "No more matches in
  the tours checked so far." with a **Keep checking** button - shown INSTEAD of
  Load more (the same request), never beside it.
- An empty page with `nextCursor: null` simply completes the list.
- Count line (`role="status"`): "Showing N tours" (more remain), "N tours"
  (complete), "Checking more tours..." (following), and during a search the
  copy of section 6.
- States: a first-page failure shows "We couldn't load tours. Please try
  again." with a Retry button; a Load more failure keeps the rows and shows the
  same message beside a Retry. A 400 on a request that carried a cursor
  (`cursor_mismatch` / `invalid cursor` - say a tab left open across a deploy)
  is never retried with that cursor: the list restarts at page 1 and the count
  line says "The list was refreshed." (until the next page lands - the count
  line is an atomic live region, so a lasting notice would be repeated with
  every later count; plan review r2). At most ONE automatic restart per list (a
  filter change starts a new list): a second cursor 400 stops any walk or
  restore and shows "We couldn't load more tours." with a **Start over** button
  (page 1, a new list) - never a Retry that would resend the rejected cursor -
  so a persistent rejection cannot become a restart loop. A complete empty list
  shows "No tours match these filters." (plus Clear filters when filters are
  set).

### 4.6 Search

Section 6.

### 4.7 URL persistence

`/tours/all?when=&status=&type=&sort=&from=&to=&q=` - defaults omitted;
`status` a comma list; `from` / `to` local `YYYY-MM-DD`, written only under
Date range; `sort` written only when the user picked one (P3). The state model
is #1's (3.5), in a child component that mounts only on the All view: filters
live in local state; control changes REPLACE the URL with a stamped write; the
URL is adopted on mount, on POP and on any unstamped navigation; writes are
skipped while a navigation is pending (a row open included - the skip always
wins); the search text is written on blur, and opening a row with an unmodified
primary click writes too (its history state also carries the restore record,
4.9) - never per keystroke. Every write REPLACES the whole history state with
the stamp (as #1's `state: OWN_WRITE` does, `ListingsList.tsx:257-260`), so a
filter change or a blur save drops any restore record the entry held. (P15
replaces #1's current-tab link.)

### 4.8 The back arrow

- Each row's link carries router state `{ back, restore }`, built AT CLICK TIME:
  `back` from the view's LOCAL selection - filters and search text, serialized
  exactly as 4.7 writes the URL - never from `location` (a search typed but not
  yet saved would be dropped, and the back arrow and the browser's Back would
  disagree); `restore` per 4.9.
- `TourDetail` additionally accepts a `state.back` whose pathname is exactly
  `/tours/all`, with any query string, and returns there ("Back to tours"). Its
  back link to that target also carries the row's `restore` record (4.9)
  unchanged. Every other rule in `TourDetail.tsx:113-124` is unchanged.

### 4.9 Returning from a tour (P14)

- The restore record is `{ depth, openedTourId, openedIndex }`: how many rows
  the list had LOADED, and the opened row's id and 0-based position among the
  VISIBLE rows (the search's matches when a search is active), at the moment the
  row was opened.
- Where it lives - in history state, never module memory (so it is per history
  entry, Back/Forward-correct, and needs no test reset seam):
  - An UNMODIFIED primary click on a row makes the stamped REPLACE of 4.7, and
    its history state carries the stamp AND `restore`, so the list's own entry
    remembers where the user was. "Unmodified primary" is exactly
    react-router's own rule for a click it navigates (button 0, no Meta, Alt,
    Ctrl or Shift, no target other than `_self`;
    `node_modules/react-router/dist/development/chunk-4ZMWKKQ3.mjs:7330-7337`):
    any other click opens the tour elsewhere and writes nothing (react-router
    runs a Link's own onClick even for a modified click, so the handler
    checks). While a navigation is pending the write is skipped (4.7) - that
    entry then has no record, and only the back arrow's copy remains.
  - Every other write replaces the whole state (4.7), so a filter change or a
    blur save drops the record.
  - The row link's router state carries `{ back, restore }` (4.8), and the tour
    page's back arrow hands `restore` back.
- On mount (or on adoption of a POP) with a `restore` record - the entry's own
  state on a browser Back or a reload, or the back arrow's state - the view
  loads its first page as every list does (`limit=50`), then restore pages
  (`limit=100`, fresh reads, never a cache) until it holds at least `depth`
  rows, the list ends, or 10 restore pages have run (the cap: past it, the
  view keeps what it has - no further automatic request, not even the
  empty-page follow; Load more continues). The record drives only the list it
  was made for: a filter, sort or search-save change, Clear filters or Start
  over drops it, and the automatic cursor-400 restart (4.5) ends the restore
  (the refreshed list starts at page 1). (Amended by plan review r1.) Then it
  scrolls to, and focuses the link of, among the VISIBLE rows:
  - the row with `openedTourId`, when it is visible; else
  - when the list was loaded to `depth` (or ended), the row now at
    `openedIndex` (the next one to work on), clamped to the last visible row;
  - else (an empty list, or a capped restore that stopped short of `depth`)
    nothing - Load more continues from there.
- The anchor is a convenience, never a hijack: if the user acts before the load
  ends, the anchor is dropped and neither scroll nor focus moves. "Acts" means a
  user-intent event - `pointerdown`, `keydown`, `wheel` or `touchstart` -
  listened for on the document from the view's mount. Not `scroll` (the browser
  scrolls on its own: clamping, scroll anchoring, focus), and not `click`,
  `keyup` or `pointerup` (they can be the tail of the gesture that navigated
  back, such as a mouse back button or Alt+Left). The restore's own scroll and
  focus come after the load ends and never trip it.
- With a search, the walk of section 6 loads the whole filtered list instead,
  and the same anchor rule applies when it ends.
- Any arrival without a `restore` record (the All tab, the nav, a typed URL, a
  POP to an entry whose rows were never opened) starts at page 1.

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

- `when`: `any` (default) | `upcoming` | `past` | `range`.
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

- Phase D sorts with `ScanIndexForward` and applies a FilterExpression for the
  status set (`status IN ...`) and the type. The status filter is omitted when
  the set holds every status that can carry a date (scheduled, toured, no_show,
  canceled, closed - with or without requested), since it could exclude nothing.
- Phase U walks byStatus for each U_ORDER status that is in the status set, in
  U_ORDER, each by createdAt in the sort direction. For toured, no_show,
  canceled and closed it applies FilterExpression
  `attribute_not_exists(scheduledAt)` (plus the type): those partitions
  re-evaluate their dated tours to find the few undated ones, and the filter
  keeps a dated tour from appearing twice. For `requested` it applies no
  not-exists filter (I1 and P10 make every requested row undated; the client's
  de-duplication would absorb a violation anyway), so with no type filter that
  partition is an unfiltered Query and wastes no reads - which is why it comes
  first.
- Skips: phase D is skipped when the status set holds only `requested` (never
  dated); phase U is skipped when the status set holds no U_ORDER status (the
  set is exactly `scheduled`). So D4's list - `when=any&status=requested` -
  reads only phase U's requested partition, in createdAt order (newest first by
  default, P3).

### 5.4 Filling a page

Named constants, injectable into the paging engine for tests (the route uses
the defaults - amended from the plan research: the router has no test path for
them, and the engine is where the budget logic lives):
`QUERY_PAGE_LIMIT` = 200 (items one filtered Query evaluates) and
`MAX_QUERY_CALLS` = 5 (Queries per HTTP request).

- A Query with NO FilterExpression (phase D with no status or type filter after
  5.3's normalization, and phase U's requested partition with no type filter)
  asks for the rows still needed PLUS ONE (`Limit = limit - rows + 1`):
  an unfiltered page never over-reads by more than that one PEEK row, which
  proves whether more rows follow and is never sent. A filtered Query asks for
  `QUERY_PAGE_LIMIT`.
- The server keeps querying - D, then U's statuses in order - until it has
  `limit` rows, every phase is exhausted, or the call budget is spent.
- Where it stops decides the cursor:
  - Page full and at least one more MATCHED row was already read (the peek row,
    or matched rows left in a filtered batch): `k` = the KEY OF THE LAST
    RETURNED ROW (byScheduledAt: tourId, `_schedPartition`, scheduledAt;
    byStatus: tourId, status, createdAt) - rows after it were read but never
    sent.
  - Last batch fully consumed and it carried a `LastEvaluatedKey`: `k` = that
    key (everything evaluated was sent or filtered out).
  - Last batch fully consumed with NO `LastEvaluatedKey` (its phase or status
    is exhausted): if another phase or U status remains, the cursor names it
    with NO `k` ("start of"); otherwise `nextCursor: null`.
- Phantom pages: an UNFILTERED final phase never leaves a Load more that finds
  nothing (the peek row decides). A FILTERED phase can: DynamoDB returns a
  `LastEvaluatedKey` whenever it stops at its Limit, even when every later item
  would be filtered out. So can a page that fills exactly at the end of a phase
  whose successor turns out to be empty. Either costs one empty page, which 4.5
  absorbs (an empty page with `nextCursor: null` completes the list; one with a
  cursor is followed).

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
  matches appear as pages arrive. ONE RULE for when the walk starts: whenever
  the search is non-empty and the list is not complete - 300 ms after typing
  stops; immediately when a non-empty search is adopted (mount, browser Back,
  the back arrow - 4.7, 4.9); and immediately when a NEW list starts while the
  search is non-empty (a filter or sort change, the cursor-400 restart). The
  request cap and the copy below apply in every case.
- While the walk runs, Load more is hidden and the count line reads
  "Searching... N matches so far"; once the list is complete, "N matches". A
  search over an INCOMPLETE list with no walk running (the walk hit its cap,
  or stopped on a second cursor 400) never reads as complete: "N matches so
  far - not the whole list".
- Cost, stated precisely. What the SERVER reads is set by When (the key
  condition) and by the status set's choice of phases and partitions (it can
  skip phase D or U, and phase U reads only the selected statuses). Within a
  phase, the status and type FILTERS narrow only what is sent (and so how many
  requests the walk takes), not what is read. So a search under Any time with
  every status reads every dated tour once in phase D, and every toured,
  no-show, canceled and closed tour once more in phase U to find the undated
  ones; narrower statuses read less. Tour rows and their names only - never the
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
- Today's `warnIfCapped('tours_today', ...)` call (3.8) is removed: it fires
  on a COUNT of 100 or more over a read that pages to completion, so it could
  only be false; the remaining cap (100 pages of 1 MB, unreachable in
  production) lives in `queryAll`, which warns on its own (amended from the
  plan research).
- `docs/issues/tours-scheduled-range-query-unpaginated.md` is resolved.

## 8. Invariants and every surface

The All tab adds READERS of two invariants; it changes no writer of tour data
(D8 changes display wording only).

I1. `requested` <=> no `scheduledAt`; `scheduled` always has one; every other
status may lack one (3.4). Writers: the repo's create (`toursRepo.ts:345-375`;
a caller-supplied status wins, so a seed can break it), POST `/api/tours`
(`tours.ts:265-361`), PATCH (`tours.ts:986+`), reopen (`tours.ts:1482+`),
auto-close (`app/src/jobs/tourAutoClose.ts`), conversion (`placements.ts:771`),
roster writes (`app/src/services/rosterProvision.ts:398`), seeds (cast, matrix,
live, performance), the dev reseed. Readers relying on it: phase U and the
phase-D skip (5.3), D4's Needs-booking-chip list and the chip's pruning (4.3),
the Active tab's Needs booking (`useTours.ts:72`), and `undatedTourLabel` (P7).

I2. A tour with a `scheduledAt` carries `_schedPartition` = 'tours' (else no
date read finds it). Writers: the repo's create (stamps every tour); PATCH, the
writer that ADDS a date, never stamps it, so it propagates any unstamped row
(3.6); seeds - fixed here (P10): every seeded tour row carries it, the matrix
coherence test's assertion is inverted (a requested tour stays off the index by
having no date), and a seed pin asserts every seeded tour row has it. Readers:
`GET /api/tours?from&to`, `today.ts:550`, phase D.

Labels: All rows read `tourStatusLabel` and `TOUR_OUTCOME_LABELS`, as the
Active and Closed rows and the tour header do. The Past tab and Today keep
`pastState` (their work-list wording). Undated wording (P7, D8): every surface
that shows a tour's missing date reads it through the one helper
`undatedTourLabel` - the All and Past rows, the tour page, and the tenant,
landlord and property tour lists - so "Needs booking" (a request) and
"Undated" (any other undated tour) mean the same thing everywhere. The GLOSSARY
records a requested tour's staff words (P12) - "Requested" (its status: the
badge on rows and the tour header) and "Needs booking" (the work: the Active
section, whose list is named "Unbooked tour requests"; the All tab's chip; its
missing date on every surface) - retires "Not booked", and records "Undated"
for any other tour without a date.

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
    reads at most one row past the ones it returns, and an unfiltered final
    page that ends exactly on the last row answers `nextCursor: null`; the
    status-filter normalization (every dated status pressed = no filter).
  - `unitsRepo.getDisplaysByIds` (chunks, retries, best-effort); the harness
    fakes; the paged range read (`pageLimit: 1`); Today without the cap warning;
    the seed pin and the inverted matrix assertion.
- dashboard:
  - The tab order (All first), `/tours` landing on Active, P15's no-op re-click
    (and a Ctrl/Cmd-click left to the browser).
  - `/tours/all` issuing no contact, unit or Active reads; Active -> Past ->
    Closed running each walk ONCE.
  - Filters -> request parameters; pruning; defaults; Clear filters; Date range
    conversion (a 6 pm tour on the To day is in, the From day starts at local
    midnight, both-empty sends no bounds, From after To sends nothing and shows
    the message); the sort default per When.
  - Load more; de-duplication (later copy wins); the empty-page follow, its cap
    copy and Keep checking shown instead of Load more; errors and Retry; a
    cursor 400 restarting the list at page 1; one loader at a time (no second
    request while a walk or restore runs; a search typed during a restore
    takes over its cursor).
  - Search: narrows at once; walks the rest; starts immediately on an adopted
    search AND on a filter or sort change made while searching; hides Load more
    while walking; clearing aborts and keeps rows; the request cap copy; an
    incomplete list never reading "N matches".
  - Loaders: Load more hidden during the first-page load and the empty-page
    follow; a search typed while the first page loads walks on after it lands;
    the second cursor 400 offering Start over, not Retry; the anchor guard
    tripped by `keydown`/`pointerdown`/`wheel`/`touchstart` and NOT by a
    browser-made `scroll`; an Alt-click on a row writing no record.
  - URL adoption and stamped writes; `state.back` built from local state with an
    unsaved search; `TourDetail` accepting `/tours/all?...` and handing `restore`
    back; the row accessible name.
  - `undatedTourLabel` ("Needs booking" for requested, "Undated" otherwise) on
    each surface that reads it, for BOTH a requested tour ("Needs booking" -
    the existing "Not booked" assertions move, P7) and an undated TOURED tour
    ("Undated"): the tour page's facts line and Schedule card, the tenant file,
    the landlord file, the property page, the Past row (output unchanged) and
    the All row.
  - The chip reading "Needs booking" while the URL and the request carry
    `requested`; Any time + that chip alone requesting `status=requested` and
    listing only requests (D4).
  - The return restore, through the back arrow, a browser Back and a reload:
    depth reloaded (and capped at 10 restore pages after the first page, with
    no follow after the cap); the opened row in view and
    focused; when the opened row has left the list, the VISIBLE row now at its
    position; under a search, positions counted over the visible matches; a
    capped restore that never reached the anchor moving nothing; user input
    (typing in the search box during a slow walk, a click, a scroll) cancelling
    the anchor; an empty list; an arrival without a record starting at page 1;
    a Ctrl/Cmd-click on a row writing no record; no record written while a
    navigation is pending; a filter change dropping the record.
  - The cursor-400 restart happening once per list (a second 400 shows the
    error and stops); a search typed during Load more letting that request
    finish, then walking on from its cursor.
- e2e: a spec that reseeds the lean world once per file (it seeds no tours;
  Playwright runs one worker, files in sequence - the house pattern of
  `tours-past.spec.ts:77-80`) and creates, in each test that needs them, its
  own tours for the lean seed's tenant through the API (a request, an
  upcoming, a past no-show, a canceled, an undated toured) - amended by plan
  review r1 from "its own uniquely named tenant contact and property" - and
  checks: the tab order and `/tours` landing on
  Active; Any time + the Needs booking chip listing only the request, its date
  reading "Needs booking" (D4, D8); Upcoming; Past + No show; Any time listing
  the undated rows after the dated, the undated toured one reading "Undated"
  (and "Undated" on its tour page); a row opened
  and the back arrow returning to the same filtered list with the search, the
  opened row in view. EVERY step also searches for the tenant's name, so
  the walk loads the whole filtered list and no step depends on page depth
  (earlier tests in the file leave their tours behind). Every assertion scopes
  to its own rows, tab selectors stay inside the "Tours view" nav (Playwright names are
  case-insensitive substrings), and "Needs booking" is matched by role and
  scope - it is now the All chip (a button in the Status group), the date text
  of request rows and the Active tab's section heading at once. An API-level
  step walks `GET /api/tours/list?limit=2` to `nextCursor: null` through the
  real stack.
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

(`docs/issues/undated-tour-wording.md` is resolved by this change - D8, P7.)

## 11. Rollout

App + dashboard. No new index, no Terraform, no data migration, no switch.
Rides the next deploy with #1 and the auto-close.
