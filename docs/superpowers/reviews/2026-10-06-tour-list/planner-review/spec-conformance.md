# Planner review - spec conformance (feat/tour-list @ 1b896aa4)

Reviewer: independent spec-conformance reviewer reporting to the planner
(Claude Opus 5.5), 2026-10-06. Not the builder's reviewer.

Tree: `feat/tour-list` @ 1b896aa4, worktree `W:\tmp\tour-list`, merge base
main @a5eabcb3; the branch's own change is `git diff a5eabcb3...HEAD`.

Contract: `docs/superpowers/specs/2026-10-06-tour-list-design.md`, read in
full, as amended in place (plan review r1 / r2, build ruling A-7, code review
r1 AD-1). Amended text is treated as the contract, so a rule the spec now
states (MAX_QUERY_CALLS 6, the first-Query-only cursor 400) is CONFORMS, not
a deviation. Rulings used to classify deviations: `build-research/README.md`
(A-1..A-7, D-1..D-9, E-1..E-6) and `code-review/r1..r3-adjudications.md`; the
plan's section 1 tables (binding copy strings and page sizes) where the spec
defers to them.

Method: read-only. Every production file the branch adds or changes under
`app/src` and `dashboard/src` was read in full; every new or changed test
file was read for its ASSERTIONS, not its titles; the e2e spec was read in
full. No test, server, lane, build, install, Docker or Playwright was run
(the planner's gate run is live in this worktree). Read-only `git` and grep
only. The earlier conformance report (`code-review/r1-spec-conformance.md`,
@38695b70) was read only after this walk; its SC-1..SC-6 and coverage gaps
4-5 are verified fixed at HEAD and are not re-reported.

Path abbreviations: `tours.ts` = `app/src/routes/tours.ts`; `tLQ` =
`app/src/lib/tourListQuery.ts`; `tLP` = `app/src/services/tourListPage.ts`;
`repo` = `app/src/repos/toursRepo.ts`; `unitsRepo` =
`app/src/repos/unitsRepo.ts`; `ATV` =
`dashboard/src/routes/tours/AllToursView.tsx` (`ATV.css` its module); `uAT`
= `dashboard/src/routes/tours/useAllTours.ts`; `tLS` =
`dashboard/src/routes/tours/tourListSelection.ts`; `TP` =
`dashboard/src/routes/tours/ToursPage.tsx`; `TD` =
`dashboard/src/routes/tours/TourDetail.tsx`; `types` =
`dashboard/src/api/types.ts`. Tests: `apiT` = `app/test/toursApi.test.ts`;
`pageT` = `app/test/tourListPage.test.ts`; `qT` =
`app/test/tourListQuery.test.ts`; `intT` =
`app/test/toursRepo.integration.test.ts`; `atvT` =
`dashboard/src/routes/tours/AllToursView.test.tsx`; `uatT` =
`dashboard/src/routes/tours/useAllTours.test.ts`; `tlsT` =
`dashboard/src/routes/tours/tourListSelection.test.ts`; `tpT` =
`dashboard/src/routes/tours/ToursPage.test.tsx`; `walksT` =
`dashboard/src/routes/tours/ToursPage.walks.test.tsx`; `tdT` =
`dashboard/src/routes/tours/TourDetail.test.tsx`; `e2e` =
`e2e/tests/dashboard-next/tours-all.spec.ts`.

## 1. Summary

**159 items judged: 138 CONFORMS, 19 DEVIATES-RULED, 0 DEVIATES-UNRULED,
2 PARTIAL, 0 MISSING.** (The work-map rows and a few section rows
cross-reference the same ruling - S10 and P15 both cite D-5, S8 / P12 / the
section 8 GLOSSARY row cite E-1; each row is counted once where it stands.)

Findings: **0 BLOCKING, 0 HIGH, 0 MEDIUM, 2 LOW** - F1 (untested: a
Cmd/Shift-click on a row writes no record), F2 (the first page is not
de-duplicated, so spec 5.3's "the client's de-duplication would absorb a
violation anyway" has a hole). One RULED deviation judged wrong, LOW (E-1:
the GLOSSARY retires "Not booked" without naming it). Four notes with no
verdict change (N1-N4).

Nothing here blocks the merge. The user-visible behavior the planner asked
about - the filters and their pruning, the count line and its states, Load
more / Keep checking / Retry / Start over, the search walk, URL persistence
and the back arrow, the return restore and its anchor, and the Needs booking
/ Undated wording on every surface - matches the spec on every rule, each
with a test whose assertions can fail, except the two LOW items below.

## 2. Per-item table

### Work map (what the build claims it shipped)

| item | verdict | evidence | note |
|---|---|---|---|
| S1 range read + Today warning | CONFORMS | `repo:417-426`; `app/src/routes/today.ts:551`; `intT:279-310`; `app/test/todayApi.test.ts:594` | queryAll + `pageLimit`; the warn call is gone |
| S2 seeds stamp `_schedPartition` | CONFORMS | `app/src/lib/seed/cast.ts:553,805`; `seed/matrix.ts:943`; `app/test/seedTourPartition.test.ts:31-52` (lean, cast, matrix, performance); `app/test/seedMatrixCoherence.test.ts:415-418`; `app/test/seedLive.test.ts:507-510` | SC-1 fixed (performance world pinned) |
| S3 `unitsRepo.getDisplaysByIds` | DEVIATES-RULED (A-1) | `unitsRepo:348,581-618`; `app/test/helpers/twilioWebhookHarness.ts:2714-2725` | placement after `getById` only |
| S4 `tourListQuery.ts` | CONFORMS | `tLQ:118-186` (parse), `:223-243` (plan), `:269-362` (cursor) | |
| S5 `queryListPhase` + shared fake | DEVIATES-RULED (A-2, A-3) | `repo:832-897`; `app/test/helpers/tourListIndexFake.ts`; harness `:3534-3538` | commit order; fake tie guard |
| S6 `listTourPage` engine | CONFORMS | `tLP:20-26,53-123` | MAX_QUERY_CALLS 6 is the amended contract (A-7) |
| S7 `GET /api/tours/list` | DEVIATES-RULED (A-5) | `tours.ts:454-562` | log line adds `when` |
| S8 `undatedTourLabel` + readers | DEVIATES-RULED (D-1, E-1) | `types:920-922`; readers under P7 | `git grep -i "not booked"` over app/src, dashboard/src, e2e, documentation: empty |
| S9 api types + `listTours` + selection | DEVIATES-RULED (D-2) | `dashboard/src/api/endpoints.ts:2672-2690`; `types:996-1040`; `tLS` | placement only |
| S10 tabs, route, P15, split | DEVIATES-RULED (D-5, E-2) | `TP:611-644,659,828-874`; `dashboard/src/App.tsx:244` | |
| S11 `useAllTours` | DEVIATES-RULED (D-7) | `uAT:154-352` | walk cap per walk |
| S12 `AllToursView` | DEVIATES-RULED (D-4, D-6, D-9) | `ATV`, `ATV.css` | SC-3 / SC-4 / R2-2 fixed |
| S13 e2e + perf registry | CONFORMS | `e2e:174-379`; `e2e/performance/routes.test.ts:383-384`; `e2e/performance/routes.ts:628-634` + ledger | E-2..E-5 are procedural |
| S14 GLOSSARY + issues | DEVIATES-RULED (E-1, E-4, E-6) | `documentation/GLOSSARY.md:355-373`; `docs/issues/*` | see section 4 for E-1 |

### Decisions D1-D10

| item | verdict | evidence | note |
|---|---|---|---|
| D1 All first at `/tours/all`; `/tours` lands on Active | CONFORMS | `TP:611-616`; `App.tsx:241-244`; `tpT:546,1362`; `e2e:184-196` | |
| D2 server-paged; a fresh visit loads one page; more only on ask or return | CONFORMS | `uAT:200-216` (one first page), `:283-309` (Load more), `:224-238` (restore) | the automatic empty-page follow is 4.5's own rule |
| D3 search is client-only over the current filtered list; a search loads the rest | CONFORMS | `ATV:384-389`; `tLS:172-186` (q never sent); `uAT:225-230` | |
| D4 Needs booking chip under Any time = the undated open tours; no separate filter | CONFORMS | `tLS:47`; `tLQ:228-240` (D skipped for requested alone); `apiT:5790`; `e2e:211-226` | |
| D5 date-range read paged to completion | CONFORMS | `repo:417-426` | |
| D6 Active, Past, Closed, Today, auto-close keep their behavior | DEVIATES-RULED (D-1) | `TP:659-824` (named views' body unchanged); `dashboard/src/routes/listing/useListing.ts:91-100` | property card now lists undated non-requests last |
| D7 no housing authority filter | CONFORMS | `ATV:448-574` | |
| D8 "Needs booking" / "Undated" everywhere; no "Not booked" | CONFORMS | `types:920-922` + every reader (P7 row) | |
| D9 keep the return restore | CONFORMS | `ATV:266-277,412-434,441-444`; `uAT:224-238` | |
| D10 chip reads Needs booking; row badge keeps Requested | CONFORMS | `tLS:47`; `ATV:219` (`tourStatusLabel`); `atvT:305` | |

### Planner calls P1-P15

| item | verdict | evidence | note |
|---|---|---|---|
| P1 the filter set; no outcome filter, chip counts, name sort, pickers | CONFORMS | `ATV:448-574` | |
| P2 opens on Any time, every status and type, no search, latest first | CONFORMS | `tLS:27-35`; `atvT:305` | |
| P3 sort follows When until picked; a picked sort sticks | CONFORMS | `tLS:140-143`; `tLQ:131-132`; `ATV:558`; `atvT:353` | |
| P4 pinned instant on page 1, carried in the cursor | CONFORMS | `tours.ts:464,477`; `apiT:5751` | canonicalized |
| P5 pages of 50; walk and restore 100 after the 50-row first page | CONFORMS | `uAT:28-29,207,250,297` | follow pages are 50 (Keep checking's size) |
| P6 undated after dated in both directions, in U_ORDER; dated Whens list dated only | CONFORMS | `tLQ:27,237-241`; `apiT:5681`; `intT:1470,1484`; `e2e:261-278` | |
| P7 one helper and its readers | CONFORMS | `types:920`; `TP:155` (Closed), `:226` (Past); `TD:326` (facts), `:797` (Schedule card); `TenantFile.tsx:338`; `LandlordFile.tsx:218`; `ListingDetail.tsx:1085`; `Today.tsx:216`; `ATV:218`; `TourModals.tsx:203` | every listed test / e2e move done (steps.ts, tours-page.spec.ts, tours.spec.ts, sequence-diagram doc) |
| P8 no server total; "Showing N tours" / "N tours" | CONFORMS | `ATV:240-249` | singulars per plan copy |
| P9 each page carries its names; All never loads the lists | CONFORMS | `tours.ts:527-544`; `walksT:67-100` | |
| P10 every seeded tour row stamped | CONFORMS | as S2 | |
| P11 perf exclusion, issue widened, ledger refreshed | CONFORMS | `routes.test.ts:383-384`; `routes.ts:628-634` + ledger; `docs/issues/perf-pages-tours-past-surface.md` | |
| P12 two staff words; GLOSSARY records both and retires "Not booked" | DEVIATES-RULED (E-1) | `GLOSSARY.md:355-373` | the retired label is not named - judged wrong, section 4 |
| P13 pure date splits at the pinned instant, every status | CONFORMS | `tLQ:203-217`; `e2e:228-245` (dated canceled under Upcoming) | |
| P14 restore record per history entry | CONFORMS | see 4.9 rows | |
| P15 All-tab re-click does not navigate; modified clicks keep the browser default | DEVIATES-RULED (D-5) | `TP:640-644,854-861`; `tpT:1396`; `atvT:936` | current All tab's href carries the committed query |

### Section 3 constraints the build must honor

| item | verdict | evidence | note |
|---|---|---|---|
| 3.1 one ToursPage instance across the named views | CONFORMS | `TP:872` (one `TourListsView` element at one position) | |
| 3.2 a new repo method is added to the typed harness fakes | CONFORMS | harness `:2714-2725` (units), `:3534-3538` (tours) | |
| 3.3 the back arrow's other rules unchanged | CONFORMS | `TD:118` (BACK_TARGETS), `:127-133` | |
| 3.5 #1's traps (URL-driven controls lag; WebKit replaceState cap) | CONFORMS | `ATV:258-277,308-315`; `AllToursView.urgentState.test.tsx:50-66` | writes only on discrete changes, blur, row open |
| 3.6 the four unstamped seed rows | CONFORMS | as S2 | |
| 3.8 Today's stale cap warning | CONFORMS | `today.ts:551` | |

### 4.1 Tabs and routes

| item | verdict | evidence | note |
|---|---|---|---|
| tab strip All, Active, Past, Closed; nav Tours still `/tours` | CONFORMS | `TP:611-616`; `tpT:546,1362` | |
| `tours/all` route beside the static tours routes, above `tours/:tourId` | CONFORMS | `App.tsx:244` | |
| title "All tours", the intro, no "+ New tour" on All | CONFORMS | `TP:619,626,841-848`; `tpT:1374` | exact copy |
| P15 suppression: unmodified primary click prevented; other tabs bare | CONFORMS | `TP:640-644,861`; `tpT:1396,1432` | href change counted under P15 |

### 4.2 Page loading split

| item | verdict | evidence | note |
|---|---|---|---|
| on `/tours/all` nothing else loads | CONFORMS | `TP:872`; `tpT:1374` (no named-view hook called); `walksT:84-95` | |
| Active, Past, Closed: same GETs; walks run once across the three | CONFORMS | `TP:659-824` unchanged body; `walksT:67-82` | perf contracts for `/tours`, `/tours/closed` unchanged |
| All -> another tab mounts it fresh; back remounts All | CONFORMS | `walksT:97-100` | |

### 4.3 The filter bar

| item | verdict | evidence | note |
|---|---|---|---|
| When: Any time, Upcoming, Past, Date range | CONFORMS | `tLS:37-42`; `ATV:453-465`; `atvT:353` | |
| From / To only under Date range; local-day start / end by calendar arithmetic; never `new Date('YYYY-MM-DD')`; both empty sends no bounds | CONFORMS | `tLS:74-103,172-186`; `ATV:468-507`; `tlsT:215-257,278-295`; `atvT:461` | R3-1 clamp at year 9999 |
| From after To: message under the inputs, no request, the list area keeps it | CONFORMS | `tLS:162-165,172-173`; `ATV:501-505,593-597`; `atvT:461,496,523` | SC-4 and R2-2 fixed |
| Status chips (aria-pressed), labels, Clear once pressed | CONFORMS | `tLS:46-53`; `ATV:136-188`; `atvT:378` | |
| Needs booking chip hidden under Upcoming, Past, Date range | CONFORMS | `ATV:374-375`; `atvT:378,408` | |
| Tour type: All types, Self-guided, Landlord-led, PM team | CONFORMS | `tLS:55-60`; `atvT:417` | |
| Search box, "Search tenant or property" | CONFORMS | `ATV:536-549`; `atvT:426` | |
| Sort: Latest first, Earliest first, default per P3 | CONFORMS | `tLS:62-65`; `ATV:551-567` | |
| Clear filters when anything differs; resets every control | CONFORMS | `ATV:352-357,376,569-573`; `atvT:432,1054` | judged on the pruned selection |
| control order When, From/To, Status, Tour type, Search, Sort, Clear filters | CONFORMS | `ATV:448-574`; `atvT:558` | SC-3 fixed |
| the pruning invariant (chip under a dated When, dates outside range, unknown URL values; pruned-to-empty = every status) | CONFORMS | `tLS:105-138`; `ATV:372`; `tlsT:162-202,309-320`; `atvT:408` | |
| phone width wraps; 480 px or less stacks full width | DEVIATES-RULED (D-4) | `ATV.css:10-16,212-229` | container query on the page container |

### 4.4 Rows

| item | verdict | evidence | note |
|---|---|---|---|
| tenant, property, date column (whenLabel else undatedTourLabel), status, outcome on a closed row, type badge | CONFORMS | `ATV:203-226,625-634`; `atvT:305` | |
| accessible name `Tour for <t> at <p>, <date>, <status>[, <outcome>]` | CONFORMS | `ATV:230-233`; `atvT:305` | |
| a missing name entry falls back to the raw id | CONFORMS | `ATV:211-217` (parity with `TP:88-100`); `atvT:305` | |
| link to `/tours/:tourId` with the 4.8 state | CONFORMS | `ATV:617-624` | |

### 4.5 Paging and the count line

| item | verdict | evidence | note |
|---|---|---|---|
| one loader at a time; Load more and Keep checking hidden while any runs | CONFORMS | `uAT:221-238,286`; `ATV:671,678` | |
| a filter or sort change aborts the running loader and loads page 1 (50) | CONFORMS | `uAT:200-219`; `ATV:327-333`; `uatT:220,236`; `atvT:852` | |
| a search typed during a restore: restore aborted, walk continues from its cursor | CONFORMS | `uAT:225-238`; `uatT:521` | see N2 for a search then cleared |
| a search typed during the first page or a Load more lets it finish, then walks | CONFORMS | `uAT:221`; `uatT:457,878` | |
| a follow in flight is aborted and re-requested from the same cursor as a walk page | CONFORMS | `uAT:225-238,256`; `uatT:405` | |
| Load more while a cursor exists and no loader runs; appends | CONFORMS | `ATV:678-683`; `atvT:616` | |
| de-duplication on append: the later copy replaces the row in place | CONFORMS | `uAT:120-140`; `uatT:278` | page 1 is not de-duplicated - F2 (under 5.3) |
| empty-page follow up to 10; "Checking more tours..."; then "No more matches in the tours checked so far." + Keep checking instead of Load more | CONFORMS | `uAT:236-238,269,337-338`; `ATV:246,671-677`; `uatT:292,332`; `atvT:592,601` | |
| an empty page with `nextCursor: null` completes the list | CONFORMS | `uAT:104,136`; `uatT:186` | |
| count line forms (role="status") | CONFORMS | `ATV:240-249,579-587`; `atvT:580-590` | |
| count line mounted and empty while a first page loads | DEVIATES-RULED (D-6) | `ATV:579-580`; `atvT:629` | spec silent on the loading text |
| first-page failure + Retry; Load more failure keeps rows + Retry | DEVIATES-RULED (D-9) | `ATV:601-608,664-670`; `atvT:662,679` | alert role |
| cursor 400: restart once per list, "The list was refreshed." until the next page; a second one -> "We couldn't load more tours." + Start over, never Retry | CONFORMS | `uAT:146-148,189-197,314,346`; `ATV:586,657-663`; `uatT:562-720`; `atvT:698,718,732` | |
| complete empty list: "No tours match these filters." + Clear filters when set | CONFORMS | `ATV:641-650`; `atvT:759` | |

### 4.7 URL persistence

| item | verdict | evidence | note |
|---|---|---|---|
| params, defaults omitted, status a comma list, from/to only under range, sort only when picked | CONFORMS | `tLS:147-160`; `tlsT:88-160`; `atvT:886` | |
| local state; control changes REPLACE with a stamped write | CONFORMS | `ATV:88,308-315,327-333`; `atvT:886` | |
| adopted on mount, on POP, on any unstamped navigation | CONFORMS | `ATV:258-277`; `atvT:874,920` | |
| writes skipped while a navigation is pending (row open included) | CONFORMS | `ATV:283-286,309`; `atvT:1093,1222` | |
| search written on blur and on row open, never per keystroke | CONFORMS | `ATV:338-350,441-444`; `atvT:886,1158` | |
| every write replaces the whole history state | CONFORMS | `ATV:310-313` | |
| a child component that mounts only on All | CONFORMS | `TP:872` | |

### 4.8 The back arrow

| item | verdict | evidence | note |
|---|---|---|---|
| row link state `{ back, restore }`; `back` from the LOCAL selection, as 4.7 writes it | CONFORMS | `ATV:381-382,617-619`; `atvT:1112,1127` | computed per render = click-time value |
| TourDetail accepts `/tours/all` with any query ("Back to tours"); other rules unchanged | CONFORMS | `TD:122-133,136-138`; `tdT:2309,2322,2330` | |
| the back link hands `restore` back unchanged | CONFORMS | `TD:281-285,697`; `tdT:2309` | |

### 4.9 Returning from a tour

| item | verdict | evidence | note |
|---|---|---|---|
| record `{ depth, openedTourId, openedIndex }`: rows loaded, id, index among VISIBLE rows | CONFORMS | `ATV:443,619`; `atvT:1112` | |
| an unmodified primary click writes the record; any other click writes nothing | CONFORMS | `ATV:441-444`; `atvT:1158,1179` | Cmd / Shift untested - F1 |
| the record lives in history state, never module memory | CONFORMS | `ATV:266-277,312`; `tLS:212-221` | |
| page 1 (50), then restore pages (100, fresh) to depth / end / 10 pages; no follow past the cap; Load more continues | CONFORMS | `uAT:224-238,250`; `uatT:475,493,503`; `atvT:1282,1336` | |
| the record drives only its list: filter, sort, search save, Clear filters, Start over drop it; the cursor-400 restart ends it | CONFORMS | `ATV:298,331,349,362`; `uAT:184,224`; `atvT:1401,1423`; `uatT:678,690` | |
| anchor: the opened row; else (depth reached or ended) the row at its index, clamped; else nothing | CONFORMS | `ATV:412-434`; `uAT:322-329`; `atvT:1282,1297,1308,1327,1336` | |
| guard: pointerdown / keydown / wheel / touchstart on the document from mount; not scroll, click, keyup, pointerup | CONFORMS | `ATV:396-406`; `atvT:1351,1368` | trackpad momentum `wheel` filed (AD-5) |
| with a search the walk loads the whole list; same anchor rule when it ends | CONFORMS | `uAT:225-230,325`; `atvT:1308` | |
| an arrival without a record starts at page 1 | CONFORMS | `atvT:1378` | |

### 4.10 and 4.11

| item | verdict | evidence | note |
|---|---|---|---|
| 4.10 `useAllTours` owns the paged state; `listTours` -> `GET /api/tours/list` | DEVIATES-RULED (plan 9.1 / 11.1) | `uAT:154`; `endpoints.ts:2672-2690` | `listTours(params, { cursor, limit }, signal)`; hook takes `{ listKey, walk, restoreDepth }` |
| 4.11 perf:pages exclusion, issue widened, ledger refreshed | CONFORMS | `routes.test.ts:383-384`; `routes.ts:628-634` + ledger; `e2e/README.md:87-89` | |

### 5. Server

| item | verdict | evidence | note |
|---|---|---|---|
| 5.1 `when` values, default `any` | CONFORMS | `tLQ:119-125` | |
| 5.1 `from` / `to`: ISO instants, range only, canonical before any use, `from <= to` | CONFORMS | `tLQ:74-114,151-162`; `qT:83-188`; `apiT:5652,6094` | stricter parser by SC-2 / R2-1 / R3-1; canonical output equals `toISOString()` |
| 5.1 `status` comma list, `isTourStatus`, duplicates ignored, empty = every | CONFORMS | `tLQ:134-143`; `qT:62` | all six normalize to empty |
| 5.1 `type`, `sort`, `limit` 1..100 default 50, `cursor` | CONFORMS | `tLQ:127-132,145-149,164-175`; `qT:46-132` | |
| 5.1 any invalid value -> 400 naming the parameter | CONFORMS | `tours.ts:456-459`; `apiT:5652` | |
| 5.2 response shape and the slim row (no roster, ladder, claims) | CONFORMS | `tours.ts:217-232,556-561`; `apiT:5681` | |
| 5.3 phase table (D key ranges per When; U only under `any`) | CONFORMS | `tLQ:203-243`; `repo:832-897`; `intT:1196` | |
| 5.3 D status filter omitted when every dated status is picked | CONFORMS | `tLQ:233`; `qT:235`; `intT:1526` | |
| 5.3 U per picked status in U_ORDER, createdAt in sort order; not-exists filter except `requested` | CONFORMS | `tLQ:237-241`; `repo:861-873`; `intT:1247` | |
| 5.3 skips (D for requested alone, U for scheduled alone) | CONFORMS | `tLQ:228-229,237`; `apiT:5790` | |
| 5.3 "the client's de-duplication would absorb a violation anyway" | PARTIAL | `uAT:97-116` vs `:120-140` | true from page 2 on, not on page 1 - F2 |
| 5.4 constants injectable into the engine; the route uses the defaults | CONFORMS | `tLP:20-26,56-59`; `pageT:491` | |
| 5.4 `MAX_QUERY_CALLS` = 6 (amended, A-7) | CONFORMS | `tLP:26`; `pageT:506` | ruling judged sound |
| 5.4 unfiltered Limit = needed + 1 (peek); filtered 200 | CONFORMS | `tLP:96`; `pageT:175`; `intT:1505` | |
| 5.4 stop rules and cursor placement (last returned row; LEK; k-less start of next phase; null) | CONFORMS | `tLP:94,101-121`; `pageT:175-367,414` | |
| 5.4 accepted phantom pages, absorbed by the client | CONFORMS | `pageT:222,344`; `uAT:236-238` | |
| 5.5 cursor `{ v: 1, f, n, ph, i?, k? }` base64url JSON | CONFORMS | `tLQ:257-276,308-337` | |
| 5.5 fingerprint of normalized filters; mismatch -> 400 `cursor_mismatch` | CONFORMS | `tLQ:269-272`; `tours.ts:473-476`; `apiT:5830` | |
| 5.5 `n` pinned on page 1 and reused | CONFORMS | `tours.ts:464,477`; `apiT:5751` | |
| 5.5 legal (ph, i, k) combinations; else 400 `invalid cursor` | CONFORMS | `tLQ:300-354`; `qT:344-460`; `apiT:5830,6075` | AD-4 key caps |
| 5.5 ValidationException: 400 only from the first Query carrying the cursor's key (amended, AD-1) | CONFORMS | `tours.ts:237-248,490-524`; `apiT:5908,6019,6053` | |
| 5.6 names: contacts best-effort; new units BatchGet (100-key chunks, retries, best-effort); soft-deleted answer | CONFORMS | `tours.ts:527-544`; `unitsRepo:581-618`; `app/test/unitsRepoDisplays.test.ts:62-158`; `app/test/unitsRepo.integration.test.ts:106` | |
| 5.7 registered before `/:tourId`, behind the `/api` auth mount | CONFORMS | `tours.ts:454` vs `:565`; `app/src/routes/api.ts:937-940`; `apiT:5898` | |
| 5.7 one info line per request, counts only | DEVIATES-RULED (A-5) | `tours.ts:546-555`; `apiT:5965` | adds `when` (an enum, no id) |

### 6. Search

| item | verdict | evidence | note |
|---|---|---|---|
| matching: trimmed, case-insensitive, tenant or property label as displayed | CONFORMS | `ATV:384-389`; `atvT:783` | |
| narrows the loaded rows at once | CONFORMS | `ATV:339,384-389`; `atvT:783` | |
| one rule for the walk start: 300 ms after typing; at once on adoption; at once on a new list | CONFORMS | `ATV:262,274,301,330,338-343`; `atvT:783,874,997,1026`; `uatT:700` | |
| copy: "Searching... N matches so far", "N matches", "N matches so far - not the whole list" | CONFORMS | `ATV:240-245`; `atvT:783,808,834` | N1: debounce window reads "not the whole list" |
| Load more hidden while the walk runs | CONFORMS | `ATV:678`; `atvT:783` | |
| aborted by a filter change and by clearing; rows and cursor stay | CONFORMS | `uAT:225-230`; `atvT:817,852` | N2 |
| 50-request cap + "Search stopped..." copy | DEVIATES-RULED (D-7) | `uAT:31,169-171,258-266`; `ATV:581-585`; `uatT:416,431`; `atvT:834` | per walk, not per list - ruling judged sound |
| tour rows and names only, never the contact / property lists | CONFORMS | `ATV` imports no list hooks; `walksT:84-95` | |

### 7. The date-range read and Today

| item | verdict | evidence | note |
|---|---|---|---|
| `listByScheduledRange` via `queryAll` + optional `{ pageLimit }`; callers unchanged | CONFORMS | `repo:210,417-426`; `tours.ts` `GET /` untouched; `today.ts:550` | |
| DynamoDB Local test with `pageLimit: 1` | CONFORMS | `intT:279-310` | |
| Today's `warnIfCapped('tours_today')` removed | CONFORMS | `today.ts:551`; `todayApi.test.ts:594` | |
| `tours-scheduled-range-query-unpaginated` resolved | CONFORMS | issue `status: resolved` | |

### 8. Invariants and labels

| item | verdict | evidence | note |
|---|---|---|---|
| I1 readers (phase U, D skip, chip pruning, Active Needs booking, `undatedTourLabel`) | CONFORMS | `tLQ:228-241`; `tLS:131`; `types:920` | D-1 found and fixed one more reader (`sortToursForPanel`); no other found (grep of `scheduledAt` readers) |
| I2 writers: create stamps, seeds fixed, matrix assertion inverted, seed pin | CONFORMS | `repo:376`; S2 evidence | AD-3 (PATCH stamping) rejected - agreed |
| labels: All rows read `tourStatusLabel` + outcome labels; Past and Today keep `pastState`; one undated helper | CONFORMS | `ATV:219-223`; `TP:226-228`; `Today.tsx:199,216` | |
| GLOSSARY records Requested / Needs booking / Undated and retires "Not booked" | DEVIATES-RULED (E-1) | `GLOSSARY.md:355-373` | same item as P12 |

### 9. Tests (is there a test that can fail when the rule breaks?)

| item | verdict | evidence | note |
|---|---|---|---|
| app route tests (validation, each When, filters, skips, D-to-U, cursor errors, mismatch, pinned instant, ValidationException mapping, names, no tour lookup) | CONFORMS | `apiT:5652-6113` | budget-boundary cases live in the engine per the 5.4 amendment: `pageT:284,303,344` |
| app DynamoDB Local (mid-batch resume, sparse filter, undated last both ways, no duplicates, peek bound, unfiltered final page null, status normalization) | CONFORMS | `intT:1184-1540` | SC-6 fixed |
| app units display, fakes, paged range read, Today, seed pin, inverted matrix assertion | CONFORMS | `unitsRepoDisplays.test.ts`; `tourListIndexFakeMirror.integration.test.ts:176-277`; `intT:279`; `todayApi.test.ts:594`; `seedTourPartition.test.ts` | |
| dashboard: tab order, `/tours` on Active, P15 + Ctrl/Cmd-click left to the browser | CONFORMS | `tpT:546,1362,1396` | ctrl, meta, shift and middle tested on the tab |
| dashboard: `/tours/all` issues no contact, unit or Active reads; walks once across the named views | CONFORMS | `tpT:1374`; `walksT:67-100` | |
| dashboard: filters -> params, pruning, defaults, Clear filters, date range conversion, From after To, sort default | CONFORMS | `tlsT`; `atvT:353-577` | N4 (runner zone) |
| dashboard: Load more, de-dup, follow + cap + Keep checking, errors + Retry, cursor 400 restart, one loader | CONFORMS | `uatT:251-358,521,562-794`; `atvT:580-774` | |
| dashboard: search bullets (narrow, walk, adopted / filter / sort change, Load more hidden, clearing, cap copy, never "N matches" when incomplete) | CONFORMS | `atvT:783-871,874,997,1026` | |
| dashboard: loaders (Load more hidden during first page and follow, search during first page, Start over not Retry, guard events, not scroll, Alt-click) | CONFORMS | `atvT:592,629,732,1179,1351,1368`; `uatT:878` | |
| dashboard: URL adoption, stamped writes, `back` with an unsaved search, TourDetail `/tours/all?...` + restore, row name | CONFORMS | `atvT:874-1135`; `tdT:2309-2337`; `atvT:305` | |
| dashboard: `undatedTourLabel` on every surface for a request AND an undated toured tour | CONFORMS | `tdT:308,312`; `files.test.tsx:266,284,474,491`; `ListingDetail.test.tsx:432,440`; `tpT:735` (Closed), Past `tpT:1287`; `atvT:305`; `dashboard/src/api/types.test.ts` | |
| dashboard: chip reads Needs booking while URL and request carry `requested`; D4 list | CONFORMS | `atvT:378`; `tlsT:97-112`; `e2e:214-226` | |
| dashboard: the return restore bullets (back arrow / Back / reload, depth + cap, focus + view, row left, search positions, capped moves nothing, input cancels, empty, no record, Ctrl/Cmd-click writes nothing, pending nav, filter drop) | PARTIAL | `atvT:1158-1449` | every bullet tested except the Cmd half of "Ctrl/Cmd-click" - F1 |
| dashboard: restart once per list; a search typed during Load more | CONFORMS | `uatT:588,628,457` | |
| e2e: reseed once per file, own tours per test, the five steps, every step searching, scoped selectors, the API walk | CONFORMS | `e2e:174-379` | viewport assertion mutant-proven (R2-3) |
| perf: route-pin exclusion and ledger | CONFORMS | `routes.test.ts:383-384`; `routes.ts` ledger | citation format test only |

## 3. Findings

### F1 [LOW] A Cmd (meta) or Shift click on a row is untested

- Spec: 4.9 ("any other click opens the tour elsewhere and writes nothing";
  the rule is react-router's: button 0 with no Meta, Alt, Ctrl or Shift),
  and section 9 names "a Ctrl/Cmd-click on a row writing no record".
- Code conforms: `ATV:442` returns early on `e.metaKey || e.altKey ||
  e.ctrlKey || e.shiftKey`.
- Test gap: `atvT:1179-1198` clicks a row with `ctrlKey` and `altKey` only;
  no test in `atvT` or `AllToursView.urgentState.test.tsx` uses `metaKey` or
  `shiftKey` on a row (grep). A mutant that drops `e.metaKey` (or
  `e.shiftKey`) from line 442 passes every test. (The All TAB's P15 test,
  `tpT:1396`, does cover meta and shift - but that is `stayOnAllTab`, a
  different handler.)
- Failure scenario: a later edit narrows the guard to the Windows modifiers.
  On a Mac, a Cmd-click on a row opens the tour in a new tab while the list
  tab stays put - and `openRow` REPLACEs the list's own entry with a restore
  record for a row the user never left the list for. The next reload of
  that tab (or a Back/Forward onto that entry) reloads to the recorded depth
  and moves focus and scroll to that row, unasked.
- Smallest fix (tests only): add `fireEvent.click(linkFor('a1'), { metaKey:
  true })` and `{ shiftKey: true }` to the `atvT:1179` case and wait for
  four jsdom navigation reports instead of two.

### F2 [LOW] The first page is not de-duplicated, so 5.3's safety net has a hole

- Spec: 5.3 lets phase U's `requested` partition run with NO not-exists
  filter because "I1 and P10 make every requested row undated; the client's
  de-duplication would absorb a violation anyway". 4.5 specifies the
  de-duplication "on append".
- Code: `uAT:97-116` (`freshState`) takes `page.tours` as the rows verbatim;
  only `withPage` (`uAT:120-140`) de-duplicates, and it runs for page 2 on.
  So the code matches 4.5's letter, but the absorption 5.3 relies on does
  not happen for page 1 - which is exactly where a violation lands on a
  small deployment.
- Failure scenario: one `requested` tour that carries `scheduledAt` and
  `_schedPartition` (an I1 violation: the spec itself notes a
  caller-supplied status can break it at create, and seeds are raw puts) in
  a table of fewer than 50 tours. Under Any time the server returns it in
  phase D AND again in phase U `requested`, inside the SAME first page. The
  view renders two `<li key={tourId}>` siblings with one key (`ATV:613`):
  React warns about duplicate keys and does not guarantee correct
  reconciliation on later updates, the count line says one tour too many,
  and the restore record's `depth` counts the duplicate.
- Severity LOW: I1 holds for every current writer (create, PATCH's
  auto-advance, reopen, auto-close, conversion, the fixed seeds).
- Smallest fix: build the first page through the same merge as appends
  (for example `withPage({ ...freshState(forKey, null), status: 'ready',
  pages: 0 }, page)`, or a shared `dedupeRows` used by both), plus one hook
  test whose first page carries the same `tourId` twice and expects one row
  holding the later copy.

## 4. Ruled deviations judged wrong

### E-1 (as applied to the GLOSSARY) [LOW] - "Not booked" is retired without being named

- Ruling E-1 made S14 repeat `git grep -n -i "not booked"` over
  `documentation/` and expect it EMPTY. That is right for every surface and
  every living how-to doc (`sequence-diagram-to-test.md` was correctly
  rewritten), but it also forbids the GLOSSARY from naming the label it
  retires. The entry at `GLOSSARY.md:367-369` says the two new labels
  "retire the single label every undated tour used to show" and points at
  the issue file.
- Why it is wrong: P12 says the GLOSSARY "retires 'Not booked'", and the
  GLOSSARY's own convention for a retired term is to NAME it so a reader
  who meets the old word can find its replacement - `GLOSSARY.md:111`
  ("stuck nudge" ... that is gone) and `:300` (`HCV`, `Section 8`, `VASH`
  retired). "Not booked" still lives in Sam's tracker, meeting transcripts
  and screenshots; a teammate who searches the GLOSSARY for it finds
  nothing.
- Smallest fix: name it in the entry (one clause: `"Not booked" is
  retired`) and scope the E-1 grep to exclude `documentation/GLOSSARY.md`
  (and `docs/issues/`, which already names it legitimately).

Every other ruling was judged on its merits and stands: A-1, A-2, A-3,
A-4, A-6 (placement, commit order, fake guard, fixtures, an extra
assertion); A-5 (an enum in the log line, no identifier); A-7 (one Query
per possible phase is the only budget that lets a sparse default list end
in one request - with 5, every small table's first page showed a phantom
Load more); D-1 (an "Undated" history row must not sit among the "Needs
booking" requests on the property card; last matches P6's rule); D-2,
D-3; D-4 (the house container-query idiom, and the pane is narrow beside
the sidebar too); D-5 (a modified click on the current tab reopens the same
filtered list); D-6 (a live region inserted with its text is not reliably
announced); D-7 (the spec's one walk rule requires a cleared-and-retyped
search to walk again); D-8; D-9; E-2..E-6; AD-1 (now the spec's text);
AD-2 / AD-5 filed, AD-3 rejected (create has stamped every tour since its
first commit; tours are never imported).

## 5. Notes (no verdict change)

- N1 - The 300 ms debounce window. Between a keystroke and the walk's start
  (and while a first page or a Load more is in flight with a search typed),
  an incomplete list's count line reads "N matches so far - not the whole
  list" (`ATV:244`, loader is not `walk` yet). Spec 6 gives that copy to "an
  INCOMPLETE list with no walk running", and its parenthetical names the
  two STOPPED cases (cap, second cursor 400); a scheduled walk is not
  stopped. It is literally conformant and true, recorded by self-QA, but
  the count line is a live region updated per keystroke, so a screen reader
  user may hear a terminal-sounding "not the whole list" before
  "Searching...". If polish is wanted: treat "searching, incomplete, not
  capped, not dead, not failed" as "Searching... N matches so far".
- N2 - A search typed during a restore, then cleared before blur. The walk
  takes over the restore's cursor (4.5); clearing hands back to the RESTORE,
  which keeps loading to its depth with Load more hidden (pinned by
  `atvT:1423-1448`), rather than leaving "Load more resumes there" (spec 6).
  4.9 drops the record only on a search SAVE, and says the load continues
  after a user act (only the anchor is dropped - here the keystroke already
  dropped it), so the build's reading is consistent with 4.9. Worth one
  line in the handback so the behavior is a recorded choice.
- N3 - The hidden Needs booking selection. Under a dated When the local
  selection keeps `requested` (never sent, never in the URL - correct), and
  it reappears pressed on a return to Any time (`atvT:1054-1077`); but
  toggling any other chip under a dated When rebuilds the set from the
  pruned one (`ATV:164,514`), so it is then gone. The spec is silent; the
  e2e clears it explicitly before Upcoming (`e2e:228-233`). Harmless.
- N4 - The local-day tests run in the runner's zone (no TZ pin in the
  dashboard workspace). On an EDT machine they prove "the From day starts
  at local midnight" and the DST ends; on a UTC runner a
  `new Date('YYYY-MM-DD')` regression would pass them. House-wide, not this
  branch's to fix; the gates run on the EDT dev machine.
