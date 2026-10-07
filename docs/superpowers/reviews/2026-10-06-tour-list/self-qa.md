# Live self-QA - Tours page All tab (feat/tour-list @ acb2f832, synced to main @a5eabcb3)

Driver: the orchestrator, through the project Playwright MCP (bundled
Chromium) against a hermetic `npm run e2e:session` lane (lane 7,
dashboard http://127.0.0.1:9711, app commit acb2f832 - the lane's
`/__dev/ping` says so). Fixture: 76 tours for the lean tenant (Tasha Nguyen)
created through the lane's API by `.superpowers/sdd/selfqa-seed.mjs` after a
VA dev-login: 40 upcoming scheduled (day +3..+42, 10:00 local), 20 past
scheduled (day -3..-22, 09:00), 5 past toured, 3 past no-shows, 2 canceled
(one at day +4 15:00, one at day -50 15:00), 4 requests (undated), 2 undated
toured. Every check below is a MEASURED DOM or network fact returned by
`browser_run_code_unsafe` (accessible names, counts, request URLs, rects),
not a screenshot read; screenshots are kept for the eye only under
`.playwright-mcp/selfqa-0*.png` (gitignored). The lane was stopped after
(`e2e:stop` exit 0; no listener on 9701/9711/9721/9731; `session.pid` gone).

## Scenarios

1. `/tours` lands on Active (tab `aria-current="page"`); the strip reads
   All | Active | Past | Closed with hrefs /tours/all, /tours, /tours/past,
   /tours/closed; regions "Upcoming tours" and "Needs booking" present.
   Clicking All -> /tours/all, h1 "All tours", the intro copy verbatim, count
   line "Showing 50 tours", 50 rows, a Load more button, chips in order
   (Needs booking, Scheduled, Toured, No show, Canceled, Closed), controls
   When / Status / Tour type / Search / Sort.
2. Load more: ONE request `/api/tours/list?when=any&sort=latest&limit=50&cursor=...`;
   "76 tours" (complete), 76 rows, Load more gone. Order: dated latest-first
   (Nov 17 ... Aug 17), then the 4 requests ("..., Needs booking, Requested"),
   then the 2 undated toured ("..., Undated, Toured - needs outcome"); zero
   dated rows after the first undated one.
3. When = Upcoming (`?when=upcoming`): 41 rows ("41 tours"), earliest first
   (Oct 9 10:00 first, Nov 17 last), the canceled Oct 10 3:00 PM row present
   with its "Canceled" badge (spec P13), the Needs booking chip HIDDEN (five
   chips), Sort reads Earliest first, no undated rows. When = Past: 29 rows,
   latest first (Oct 3 first, Aug 17 canceled last), no undated rows.
4. Any time + Needs booking (`?status=requested`): exactly 4 rows, every
   name "..., Needs booking, Requested", the chip pressed plus a Clear button
   (aria-label "Clear status filter"), URL `status=requested` (D4, D10).
   Past + No show: exactly 3 rows, all "No show". Tour type PM team: 23 rows,
   all with the PM team badge.
5. Date range From=day-52 To=day-50 (local days): the request carried
   `from=<From>T04:00:00.000Z&to=<To+1>T03:59:59.999Z` (the To day's END in
   EDT) and returned exactly the Aug 17 3:00 PM canceled tour - the To day's
   afternoon tour is IN. From set after To through the From input: the
   sentence "From must be on or before To." under the inputs AND once as the
   only `role="alert"` (two copies in the DOM, one alert), both date inputs
   `aria-invalid="true"` with `aria-describedby="tours-all-range-error"`,
   the count region empty, the list gone, ZERO `/api/tours/list` requests
   while invalid, the URL still written (`from=<later>&to=<earlier>`);
   fixing From sent exactly one request.
6. Search (page-side MutationObserver on the count line, ms after fill):
   "Sycamore" over the 50-row first page showed 24 matches at once; the count
   read "24 matches so far - not the whole list" (271 ms, inside the 300 ms
   debounce), then "Searching... 24 matches so far" (583 ms, the walk's one
   `limit=100` request), then "37 matches" (620 ms); all 37 names contain
   Sycamore; no Load more while complete. Clearing the box kept the rows
   ("76 tours", 76 rows); typing "Tasha" and blurring wrote `?q=Tasha`.
7. 360 px viewport: `document.scrollWidth` 360 = innerWidth (no horizontal
   overflow); the pane 345 wide; When / Tour type / Search / Sort each 297
   wide at left 24 (stacked full width), the chip group and the rows the
   same width. 480 px: the four controls each 417 wide (stacked). 768 px:
   the controls wrap to rows at 465 wide, no overflow (768 = 768).
8. Return restore through the back arrow: Scheduled chip pressed, Load more
   -> 60 rows; opened row index 54 (a past scheduled tour); on the tour page
   "Mark toured" opened the Record outcome dialog; "No - not a fit" + Save
   decision closed the tour (header badge Closed); "Back to tours" href
   `/tours/all?status=scheduled`; the return made page 1 (`limit=50`) then
   ONE restore page (`limit=100&cursor=...`); 59 rows ("59 tours"); the
   opened row gone; `document.activeElement` = the row now at index 54
   (the next one to work on), inside the viewport (pane scrolled 2724 px);
   the chip still pressed.
9. Return through the browser's Back, at 1280 and at 360 px, after waiting
   for the tour page to COMMIT (its header present, the list gone - React
   Router navigates inside a transition, so a `goBack()` fired before the
   commit merely cancels it and nothing remounts; an earlier probe of mine
   did exactly that and was discarded): Back REMOUNTED the view (a new list
   node), loaded page 1 then one `limit=100` restore page, 60 rows, the
   OPENED row focused (index 55 / 52), the pane scrolled 2740 px so the row
   sits flush at the bottom edge (rect 692..740 in a 740 px pane - `block:
   'nearest'`), history state `{ tourListFilterWrite: true, restore: {
   depth: 60, openedTourId, openedIndex } }`. A reload of that entry did the
   same (page 1 + one restore page, 60 rows, the opened row focused).
10. After a return, changing When to Past sent exactly ONE request
    (`when=past&status=scheduled&sort=latest&limit=50`), "19 tours" - no
    automatic reload to the old depth.
11. Undated wording: the request's tour page facts line "Needs booking -
    Self-guided - Tasha Nguyen -> 88 Sycamore St ..." with the badge
    "Requested", zero "Not booked" anywhere; the tenant file
    (/contacts/contact-tenant-0001) Tours card rows "<address> - Needs
    booking" and "<address> - Undated"; the undated toured tour's page
    "Undated - Landlord-led - ..." with the badge "Toured - needs outcome";
    a request canceled through the API lists on the Closed tab as
    "... Undated Canceled PM team" (the date column reads Undated, D8 /
    research F1); the Past tab's undated toured row still reads "Undated"
    with the name "..., undated, Needs outcome" (output unchanged).
12. P15 / D-5: on /tours/all?status=scheduled the current All tab's href is
    `/tours/all?status=scheduled`; clicking it left the URL and the 59 rows
    unchanged.

## Observations (not defects)

- Every fresh mount of the All view issues the first-page request TWICE in
  this dev lane; the first is `net::ERR_ABORTED`, the second 200. That is
  React StrictMode's double effect under Vite dev (`dashboard/src/main.tsx`
  mounts under `<StrictMode>`); the hook's cleanup aborts the first. A
  production build does not double-invoke effects.
- During the 300 ms debounce after typing, an incomplete list reads
  "N matches so far - not the whole list" before "Searching..." appears -
  spec 6's wording for an incomplete list with no walk running; a brief
  flicker, noted in the handback.
- Not exercised live (no fixture can produce it cheaply): the empty-page
  follow and its cap ("Checking more tours..." / Keep checking) - covered by
  the hook and view unit tests; the cursor-400 restart - covered by unit and
  route tests.
