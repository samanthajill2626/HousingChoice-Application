# Code review r1 - spec conformance (Tours page All tab)

Reviewer: spec-conformance reviewer (Claude Opus 5.5), 2026-10-06.
Tree: `feat/tour-list` @ 38695b70, merge base main @d839494a, worktree
`W:\tmp\tour-list`. Contract: spec DRAFT 6 (as amended in place), the plan's
section 1 tables (binding copy), the plan's section 2 work map, the mission
block, build rulings A-1..A-7 / D-1..D-9 / E-1..E-6, and the adjudications'
"Plan research", "Plan round 1" and "Plan round 2" rulings.

Method: read the spec, plan sections 1-2, the rulings, the diff package and
the nine slice reports; then the LIVE files for every rule. Gate 4 (full
e2e) was running in this worktree for almost the whole review (the
`.superpowers/sdd/gate4-e2e.exit` marker appeared only at the end), so NO
existing file under app/, dashboard/ or e2e/ was modified and no mutant was
applied. Two throwaway tests (`app/test/zz-review-spec-parse.test.ts`,
`app/test/zz-review-spec-range.test.ts`) were created, run and deleted by
exact name; afterwards `git status` shows only this record and another
reviewer's own `zz-review-adv-*` file (untouched).

**Summary: 109 items judged - 83 CONFORMS (18 of them copy-string groups),
19 DEVIATES-RULED, 5 PARTIAL, 2 DEVIATES-UNRULED, 0 MISSING. Findings:
0 HIGH, 1 MEDIUM, 5 LOW (SC-1..SC-6).**

## Conformance table

Paths are abbreviated: `tours.ts` = `app/src/routes/tours.ts`, `tLQ` =
`app/src/lib/tourListQuery.ts`, `tLP` = `app/src/services/tourListPage.ts`,
`ATV` = `dashboard/src/routes/tours/AllToursView.tsx`, `uAT` =
`dashboard/src/routes/tours/useAllTours.ts`, `tLS` =
`dashboard/src/routes/tours/tourListSelection.ts`, `TP` =
`dashboard/src/routes/tours/ToursPage.tsx`, `TD` =
`dashboard/src/routes/tours/TourDetail.tsx`.

### Work map (plan section 2)

| item | verdict | evidence | note |
|---|---|---|---|
| S1 range read + Today warning | CONFORMS | `toursRepo.ts:417-425`; `today.ts:551`; `toursRepo.integration.test.ts:252-308`; `todayApi.test.ts:594` | queryAll + `pageLimit`; warn line replaced by a comment |
| S2 seeds | PARTIAL | `cast.ts:553,805`; `matrix.ts:943`; `seedMatrixCoherence.test.ts:415-418`; `seedTourPartition.test.ts:26-30`; `seedLive.test.ts:507-510` | four rows stamped, assertion inverted; the pin omits the performance world (SC-1) |
| S3 `unitsRepo.getDisplaysByIds` + fakes | DEVIATES-RULED (A-1) | `unitsRepo.ts:348,581-617`; `twilioWebhookHarness.ts:2714-2725` | placed after `getById`; 100-key chunks, 4 attempts, WARN counts only |
| S4 query model | CONFORMS | `tLQ:70-138` (parse), `:175-201` (plan), `:221-292` (cursor) | |
| S5 repo phase read + shared fake | DEVIATES-RULED (A-2, A-3) | `toursRepo.ts:832-891`; `test/helpers/tourListIndexFake.ts:71-142`; `twilioWebhookHarness.ts:3534-3537` | fake rejects out-of-range keys as ValidationException; tie guard is a plain Error |
| S6 paging engine | DEVIATES-RULED (A-6, A-7) | `tLP:20-26,53-123`; `tourListPage.test.ts:491-535`; `toursRepo.integration.test.ts:1377-1503` | MAX_QUERY_CALLS 6 |
| S7 route | DEVIATES-RULED (A-5) | `tours.ts:440-530`, `:532` (`/:tourId` after) | log line adds `when` |
| S8 undated wording | DEVIATES-RULED (D-1, E-1) | `dashboard/src/api/types.ts:920-922`; readers listed under P7 | `git grep -i "not booked"` over dashboard/src, e2e, app/src, documentation: empty |
| S9 api + selection | DEVIATES-RULED (D-2) | `endpoints.ts:2672-2690`; `types.ts:996-1040`; `tLS` | types after `ToursPage` |
| S10 tabs, route, P15, split | DEVIATES-RULED (D-5, E-2) | `TP:611-616,640-642,659,849-872`; `App.tsx:244`; `e2e/performance/routes.test.ts:381-383` | |
| S11 `useAllTours` | DEVIATES-RULED (D-7) | `uAT:154-352` | walk cap per walk session |
| S12 view | PARTIAL | `ATV` | control order (SC-3) and the invalid-range list area (SC-4); D-4, D-6, D-9 ruled |
| S13 e2e + perf | DEVIATES-RULED (E-2, E-3, E-4, E-5) | `e2e/tests/dashboard-next/tours-all.spec.ts`; `e2e/performance/routes.ts:628-634` + ledger; `e2e/README.md:87-89`; `e2e/support/selectors.md` new row | |
| S14 docs | DEVIATES-RULED (E-1, E-4, E-6) | `documentation/GLOSSARY.md:355-373`; `docs/issues/*` (2 resolved, 1 widened, 5 new) | glossary retires the old label without naming it (E-1's empty grep) |

### Decisions D1-D10

| item | verdict | evidence | note |
|---|---|---|---|
| D1 All first, `/tours` stays Active | CONFORMS | `TP:611-616`; `App.tsx:241-244`; `ToursPage.test.tsx:1362-1372` | |
| D2 server-paged, one page per fresh visit | CONFORMS | `uAT:200-216` (one first page), `:283-309` (Load more) | the automatic empty-page follow is spec 4.5's own rule |
| D3 search is client-side over the filtered list | CONFORMS | `ATV:377-382`; `tLS:169-183` (q never sent) | |
| D4 undated open = Needs booking chip under Any time | CONFORMS | `tLQ:180-188` (D skipped for requested only); `tLS:47` | |
| D5 date-range read paged to completion | CONFORMS | `toursRepo.ts:417-425` | |
| D6 named views unchanged | DEVIATES-RULED (D-1) | `useListing.ts:91-100` | property card now lists undated non-requests last |
| D7 no housing-authority filter | CONFORMS | `ATV:441-541` | |
| D8 Needs booking / Undated everywhere | CONFORMS | `types.ts:920-922` + the ten readers (P7 row) | |
| D9 keep the return restore | CONFORMS | `ATV:262-273,385-437`; `uAT:224-238` | |
| D10 chip label Needs booking, badge Requested | CONFORMS | `tLS:47`; `ATV:215` (`tourStatusLabel`) | |

### Planner calls P1-P15

| item | verdict | evidence | note |
|---|---|---|---|
| P1 filters set | CONFORMS | `ATV:441-556` | no outcome filter, no counts, no name sort |
| P2 defaults | CONFORMS | `tLS:27-35`; `ATV:369` | |
| P3 sort default per When, picked sort sticks | CONFORMS | `tLS:137-140`; `tLQ:83-84`; `ATV:525-526` | |
| P4 pinned instant in the cursor | CONFORMS | `tours.ts:447-461`; `toursApi.test.ts` case 3 | canonicalized (P13 ruling) |
| P5 50 / 100 page sizes | CONFORMS | `uAT:28-32,250,297` | follow pages use 50 (Keep checking's size) |
| P6 undated after dated, U_ORDER | CONFORMS | `tLQ:27,189-193`; `toursApi.test.ts` case 2 | |
| P7 one helper, all readers | CONFORMS | `types.ts:920`; `TP:155` (Closed), `TP:226` (Past); `TD:326` (facts) + `TD:797` (Schedule card); `TenantFile.tsx:338`; `LandlordFile.tsx:218`; `ListingDetail.tsx:1085`; `Today.tsx:216`; `ATV:214`; `TourModals.tsx:203` | |
| P8 count line forms | CONFORMS | `ATV:236-245` | |
| P9 names per page | CONFORMS | `tours.ts:494-511`; `ToursPage.walks.test.tsx:69-100` | |
| P10 every seeded tour stamped | PARTIAL | `performance.ts:655` stamps every row, but no pin reads it | SC-1 |
| P11 perf exclusion + ledger | CONFORMS | `routes.test.ts:381-383`; `routes.ts` ledger; `docs/issues/perf-pages-tours-past-surface.md` | |
| P12 two staff words | DEVIATES-RULED (E-1) | `tLS:47`; `GLOSSARY.md:355-373` | glossary does not spell out the retired string (E-1 forbids it under documentation/) |
| P13 pure date splits | CONFORMS | `tLQ:155-169` | |
| P14 restore record per history entry | CONFORMS | `ATV:262-273,304-311,434-437`; `TD:282-285,697` | |
| P15 All-tab re-click is a no-op | DEVIATES-RULED (D-5) | `TP:640-642,854-861`; `ToursPage.test.tsx:1396-1430` | current tab href carries committed search |

### Spec sections 4.x (dashboard)

| item | verdict | evidence | note |
|---|---|---|---|
| 4.1 tabs, route, title, intro, no New tour on All | CONFORMS | `TP:611-627,841-847`; `App.tsx:244` | |
| 4.2 loading split; All loads nothing else; walks once | CONFORMS | `TP:659-830,872`; `ToursPage.test.tsx:1374-1394`; `ToursPage.walks.test.tsx:70-100` | |
| 4.3 controls, labels, roles | CONFORMS | `ATV:441-556`; `tLS:37-65` | search is `type="search"` (searchbox, an ARIA textbox subtype) |
| 4.3 control ORDER | DEVIATES-UNRULED | `ATV:441-556` | Search renders after Sort and Clear filters (SC-3) |
| 4.3 date range conversion (local days, DST) | CONFORMS | `tLS:73-100,169-183` | |
| 4.3 From after To | DEVIATES-UNRULED | `tLS:159-162`; `ATV:488`; `uAT:316-318` | no request, message under the inputs; list area blank (SC-4) |
| 4.3 pruning invariant (chip, dates, unknown values) | CONFORMS | `tLS:102-135`; `ATV:365-369` | Clears judged on the pruned selection (P10 ruling) |
| 4.3 phone width / 480px stack | DEVIATES-RULED (D-4) | `AllToursView.module.css:12,54,70,217-238` | container query |
| 4.4 rows, name fallbacks, accessible name | CONFORMS | `ATV:199-229,583-610` | |
| 4.5 one loader at a time | CONFORMS | `uAT:221-238,283-286`; aborts at `uAT:215-219,280` | |
| 4.5 search during restore / first page / Load more / follow | CONFORMS | `uAT:225-238,241-281` | follow aborted and re-requested as a walk page (plan-research precision) |
| 4.5 Load more vs Keep checking (instead, never beside) | CONFORMS | `ATV:628-657` | |
| 4.5 de-duplication, later copy wins in place | CONFORMS | `uAT:120-140` | |
| 4.5 empty-page follow, cap 10, copy | CONFORMS | `uAT:236-238,269,337-338`; `ATV:242,643-649` | |
| 4.5 count line element and loading state | DEVIATES-RULED (D-6, D-8, P2-5) | `ATV:561-571` | region mounted and empty while loading |
| 4.5 first-page failure, Load more failure, Retry | DEVIATES-RULED (D-9) | `ATV:573-580,636-642` | alert role |
| 4.5 cursor 400: restart once, notice until next page, then Start over | CONFORMS | `uAT:146-148,189-197,346`; `ATV:568,629-635` | allowance keyed by `listKey#gen` (P9 ruling) |
| 4.5 empty complete list + Clear filters | CONFORMS | `ATV:613-622` | |
| 4.7 URL params, defaults omitted, sort only when picked | CONFORMS | `tLS:144-157` | |
| 4.7 stamped REPLACE, adoption on mount / POP / unstamped | CONFORMS | `ATV:84-92,254-273,304-311` | |
| 4.7 pending-navigation skip (row open included) | CONFORMS | `ATV:279-282,305` | |
| 4.7 search written on blur and on row open, never per keystroke | CONFORMS | `ATV:334-346,434-437` | |
| 4.7 every write replaces the whole state | CONFORMS | `ATV:306-309` | |
| 4.8 back from the LOCAL selection | CONFORMS | `ATV:374-375,589-592` | computed per render = click-time value |
| 4.8 TourDetail accepts /tours/all?..., hands restore back | CONFORMS | `TD:122-133,282-285,697` | |
| 4.9 record shape, depth = rows loaded, index among visible | CONFORMS | `ATV:436,591`; `tLS:203-218` | |
| 4.9 unmodified-primary rule for the row-open write | CONFORMS | `ATV:434-437` | |
| 4.9 restore: page 1 (50), then 100s to depth, cap 10, no follow after | CONFORMS | `uAT:224-238,250,268` | |
| 4.9 record bound to its list; drops (filter, sort, search save, Clear, Start over); restart ends it | CONFORMS | `ATV:262-264,294,323-359`; `uAT:224` | |
| 4.9 anchor targets (opened row, row at index if reached, else nothing) | CONFORMS | `ATV:405-427`; `uAT:322-329` | |
| 4.9 user-intent guard events (and not scroll/click/keyup/pointerup) | CONFORMS | `ATV:389-399` | document, capture, from mount |
| 4.10 data hook + `listTours` | CONFORMS | `uAT:154`; `endpoints.ts:2672` | signature refined by plan 9.1 / 11.1 (opts object) |
| 4.11 perf:pages | CONFORMS | `routes.test.ts:381-383`; `routes.ts:628-634` | |

### Spec sections 5.x (server), 6, 7, 8

| item | verdict | evidence | note |
|---|---|---|---|
| 5.1 when / sort / status / type / limit / cursor validation, messages name the param | CONFORMS | `tLQ:70-138`; `toursApi.test.ts` case 1 | |
| 5.1 from/to: ISO 8601 instants, range only, canonicalized, from <= to | PARTIAL | `tLQ:62-66,103-114` | any `Date.parse` string is accepted (SC-2) |
| 5.2 response + slim row projection | CONFORMS | `tours.ts:217-232,494-529`; `toursApi.test.ts` case 2 | roster, ladder, claim fields absent |
| 5.3 phase plan, status-filter omission, notExists, skips | CONFORMS | `tLQ:175-201`; `toursRepo.ts:832-891` | |
| 5.4 peek (needed + 1), filtered 200, stop rules, cursor placement | CONFORMS | `tLP:94-121` | |
| 5.4 MAX_QUERY_CALLS | DEVIATES-RULED (A-7) | `tLP:26` | 6, spec amended in place |
| 5.5 cursor fields, fingerprint, pinned `n` | CONFORMS | `tLQ:209-228,238-267`; `tours.ts:450-468` | |
| 5.5 legal (ph, i, k) combinations, everything else invalid | CONFORMS | `tLQ:230-284`; `tourListQuery.test.ts:315-379` | |
| 5.5 ValidationException: 400 with a cursor, 500 without | CONFORMS | `tours.ts:484-494`; `toursApi.test.ts` case 9 | |
| 5.6 names best-effort, soft-deleted answer | CONFORMS | `tours.ts:494-511`; `unitsRepo.ts:581-617`; `unitsRepo.integration.test.ts:106` | |
| 5.7 registered before `/:tourId`, behind /api auth | CONFORMS | `tours.ts:440,532` | |
| 5.7 one info line, counts only | DEVIATES-RULED (A-5) | `tours.ts:513-522`; `toursApi.test.ts` case 10 | adds `when` (no id/name/address) |
| 6 one rule for when the walk starts (debounce, adoption, new list) | CONFORMS | `ATV:258,268-271,297,323-339`; `uAT:225-230` | |
| 6 matching (trimmed, case-insensitive, labels as displayed) | CONFORMS | `ATV:377-382` | |
| 6 copy: Searching / N matches / so far - not the whole list / cap sentence | CONFORMS | `ATV:236-241,563-567` | |
| 6 walk cap 50 requests, abort on filter change / clear | DEVIATES-RULED (D-7) | `uAT:31,169-171,258-266` | per walk session |
| 7 range read, `pageLimit`, callers unchanged, Today warning removed | CONFORMS | `toursRepo.ts:417-425`; `today.ts:550-551`; `tours.ts` `GET /` untouched | |
| 8 I1 readers | CONFORMS | `tLQ:175-195`; `tLS:126-135`; `types.ts:920`; `useListing.ts:93` | D-1 found and fixed the reader spec 8 missed |
| 8 I2 writers (seeds) and the seed pin | PARTIAL | `seedTourPartition.test.ts:26-30` | SC-1 |

### Copy strings (plan section 1, binding)

| string group | verdict | evidence |
|---|---|---|
| title / intro | CONFORMS | `TP:619,626` |
| tab `All` | CONFORMS | `TP:612` |
| When options | CONFORMS | `tLS:37-42` |
| `From` / `To` / `From must be on or before To.` | CONFORMS | `ATV:465,477`; `tLS:161` |
| Status chips; `Clear` with aria-label `Clear status filter` | CONFORMS | `tLS:46-53`; `ATV:166-179` |
| Tour type options | CONFORMS | `tLS:55-60` |
| `Search` label, placeholder `Search tenant or property` | CONFORMS | `ATV:545,551` |
| Sort options | CONFORMS | `tLS:62-65` |
| `Clear filters` | CONFORMS | `ATV:538,618` |
| count line (`Showing N tours`, `N tours`, singulars, `Checking more tours...`) | CONFORMS | `ATV:231-245` |
| capped follow + `Keep checking` | CONFORMS | `ATV:645-647` |
| `Load more`, `Retry`, `Start over` | CONFORMS | `ATV:577,633,640,653` |
| errors + `The list was refreshed.` | CONFORMS | `ATV:568,575,631,638` |
| `No tours match these filters.` | CONFORMS | `ATV:615` |
| search counts | CONFORMS | `ATV:236-241` |
| walk-cap sentence | CONFORMS | `ATV:565` |
| row name | CONFORMS | `ATV:226-229` |
| list label `All tours list` | CONFORMS | `ATV:583` |

## Findings

### SC-1 [MEDIUM] The seed pin does not cover the performance seed

- Spec: 8 I2 ("a seed pin asserts every seeded tour row has it"), P10
  ("Every seeded tour row carries `_schedPartition`"), 9 ("the seed pin").
- Tree: `app/test/seedTourPartition.test.ts:26-30` pins lean, cast and
  matrix; `seedLive.test.ts:507-510` pins the live seed. The performance
  world (`app/src/lib/seed/performance.ts:637-668`, `buildTour`) is in no
  pin. Slice A's report says "The pure pin cannot see the performance seed's
  tours" - not so: `app/test/seedUnreadFlag.test.ts:44-53` already builds
  that world purely with
  `generatePerformanceSeed(resolvePerformanceSeedConfig({}, ANCHOR))`.
- Throwaway check (run, then deleted): `generatePerformanceSeed(resolvePerformanceSeedConfig({}, '2026-07-01T12:00:00.000Z')).tables.tours`
  builds purely - 50 tours, `unstamped: []`.
- Symptom: none today (`performance.ts:655` stamps every row). A future edit
  that drops the stamp there would put perf-lane tours outside every date
  read (Active, Past, Today, the All tab's phase D) with no red test.
- Fix: add `performance: { tours: generatePerformanceSeed(resolvePerformanceSeedConfig({}, ANCHOR)).tables.tours }`
  (with the two imports and a fixed anchor) to `PROFILES` in
  `seedTourPartition.test.ts`.

### SC-2 [LOW] `from` / `to` accept non-ISO, zone-less strings

- Spec: 5.1 "`from`, `to`: ISO 8601 instants"; the 400 text says "must be
  valid ISO 8601 datetimes".
- Tree: `tLQ:62-66` accepts anything `Date.parse` accepts. Throwaway test
  (`parseTourListQuery({ when: 'range', from })`, run and deleted):
  `10/06/2026` -> ok, from `2026-10-06T04:00:00.000Z`; `Oct 6 2026` -> ok,
  `2026-10-06T04:00:00.000Z`; `2026` -> ok, `2026-01-01T00:00:00.000Z`. The
  zone-less forms are read in the SERVER's local zone (EDT here, UTC in
  production), so the same request means different instants per host.
- Symptom: none from the dashboard (it always sends `toISOString()`); a
  direct API caller gets a silently shifted window instead of a 400.
- Fix: require an ISO 8601 date-time with an explicit zone (e.g. a regex
  `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$`)
  before `Date.parse`, and add `10/06/2026` to route test 1.

### SC-3 [LOW] The Search control is out of the spec's order

- Spec: 4.3 "Labels, roles and order": When, From / To, Status, Tour type,
  **Search**, Sort, Clear filters.
- Tree: `ATV:441-541` renders When, From / To, Status, Tour type, Sort,
  Clear filters inside `.controls`; the Search block follows at
  `ATV:543-556`, after Sort and Clear filters (it reads in DOM and tab order
  that way). No ruling or slice report mentions the move.
- Fix: move the Search block between Tour type and Sort, or record a ruling
  that #1's separate search row is the intended layout (spec amended).

### SC-4 [LOW] An invalid date range leaves the list area blank

- Spec: 4.3 "From after To shows 'From must be on or before To.' under the
  inputs and sends NO request; the list area keeps that message until
  fixed"; plan Task 12.1 case 3: "(no new listTours call; the list area
  shows the message)".
- Tree: the message renders once, under the inputs (`ATV:488`); with
  `listKey === 'null'` the hook is `idle` (`uAT:316-318`) and the list area
  renders nothing - no rows, no count, no message. Slice G reports this as
  its divergence 7 without a ruling.
- Fix: either render the same sentence in the list area while `status ===
  'idle'` (outside the count region), or record a ruling that "under the
  inputs" satisfies "the list area keeps that message".

### SC-5 [LOW] Route-level `when=range` key condition and order are untested

- Spec: 9 app route tests, "each When's key condition and order" and
  "validation (... canonicalization)".
- Tree: `toursApi.test.ts` exercises `any` (case 2), `upcoming` / `past`
  (case 3) through the route; `range` appears only in case 1's validation
  rows. Range is covered below the route (planner `tourListQuery.test.ts:209`,
  repo `toursRepo.integration.test.ts:1196`, parse canonicalization
  `tourListQuery.test.ts:83-117`), so a route that passed raw `from` / `to`
  to the plan would still be caught only by type-level wiring, not a test.
- Behavior conforms (throwaway route test, run and deleted): `when=range`
  with `from=2026-10-01T00:00:00-04:00&to=2026-10-31T23:59:59.999-04:00`
  answered 200 `['in3', 'in2', 'in1']` (both inclusive bounds in, the rows
  1 ms outside out, latest first, `nextCursor: null`); the one-sided forms
  returned exactly the rows on their side. The gap is the test only.
- Fix: one route case - `when=range&from=<non-canonical offset form>&to=...`
  returning exactly the in-window rows in latest order, plus both one-sided
  forms.

### SC-6 [LOW] Two DynamoDB Local bullets of spec 9 run only on the fake

- Spec: 9 DynamoDB Local integration tests: "an unfiltered final page that
  ends exactly on the last row answers `nextCursor: null`" and "the
  status-filter normalization (every dated status pressed = no filter)".
- Tree: the engine walks on DynamoDB Local (`toursRepo.integration.test.ts:1470-1503`)
  all end in a FILTERED phase (U closed, or a filtered D). The first bullet
  is proven on the shared fake (`tourListPage.test.ts:212-220`) plus the
  repo fact "no key when the range runs out" (`toursRepo.integration.test.ts:1287-1298`);
  the second only by the pure planner (`tourListQuery.test.ts:184-194`).
  Composite coverage is sound (the mirror test pins the fake), but neither
  bullet is a DynamoDB Local run.
- Fix: add one DynamoDB Local walk with `when: 'past'` (an unfiltered final
  phase D, `limit` equal to the row count -> one page, `nextCursor: null`)
  and one with every dated status picked asserting `evaluated <= returned + 1`.

## Section-9 test-coverage gaps

1. The seed pin omits the performance world (SC-1).
2. Route tests: no `when=range` request through the route (SC-5).
3. DynamoDB Local: the unfiltered-final-page-ends-null bullet and the
   status-filter-normalization bullet run on the fake / the pure planner
   only (SC-6).
4. e2e "the opened row in view": `tours-all.spec.ts:311` asserts the row is
   FOCUSED, never in the viewport (`toBeInViewport`); the scroll half rests
   on the unit test's `scrollIntoView` spy (`AllToursView.test.tsx:1171-1184`). LOW.
5. Dashboard "starts immediately ... on a filter OR SORT change while
   searching": only a When change is tested (`AllToursView.test.tsx:769-788,914-942`);
   sort shares `change()` (`ATV:323-329`), so the gap is nominal.

Every other section-9 bullet has a test whose assertions can fail: checked
by reading the assertions (not the titles) for the route cases 1-10, the
engine cases 1-14, the mirror and repo integration cases, the unitsRepo
display cases, the Today no-WARN case (`toHaveLength(100)` guard), the hook
cases (restore cap with an EMPTY tenth page, walk-from-same-cursor, restart
once / dead, D-7), the view cases (four guard events, scroll not cancelling,
the drop cases' A -> B -> A shape, the pending-navigation positive
controls), TourDetail's back-arrow cases, the files / ListingDetail /
TourDetail Needs booking + Undated pairs, the walks test, and the e2e spec's
five tests.

## Verified claims (slice reports)

- A: `listByScheduledRange` is a `queryAll` walk with `Limit` from `pageLimit`
  (`toursRepo.ts:417-425`) - true.
- A: Today's `tours_today` `warnIfCapped` is gone, replaced by a comment
  (`today.ts:551`) - true.
- A: the four unstamped seed rows now carry the partition (`cast.ts:553,805`,
  `matrix.ts:943`) - true.
- A: `getDisplaysByIds` sits right after `getById` in the interface, the
  implementation and the harness fake (A-1) - true.
- A: "the pure pin cannot see the performance seed" - FALSE (SC-1).
- B: the shared fake rejects an out-of-range start key with a
  ValidationException-named error and guards ties with a plain Error
  (`tourListIndexFake.ts:101-116`) - true.
- C: `/list` is registered before `/:tourId` (`tours.ts:440`, `:532`) - true.
- C: the ValidationException mapping is cursor-conditional (`tours.ts:488`) -
  true.
- A-7: `MAX_QUERY_CALLS` is 6 and engine test 14 pins one-request completion
  (`tLP:26`, `tourListPage.test.ts:506`) - true.
- D: no "Not booked" remains in dashboard/src, e2e, app/src or
  documentation (git grep -i) - true.
- D-1: `sortToursForPanel` sorts only a request first, other undated tours
  last, with a pin (`useListing.ts:93`, `useListing.test.tsx`) - true.
- E: tab order All | Active | Past | Closed; P15 prevents only an unmodified
  primary click; the current All tab href carries the committed search
  (`TP:611-616,640-642,854-861`) - true.
- E: `/tours/all` added to the route-pin exclusion with :381 kept verbatim
  (E-2) - true.
- F: the walk cap is per walk session (`uAT:169-171,186,258-266`) - true.
- G: the count line stays mounted and empty while loading (D-6,
  `ATV:561-569`); first-page failure inside `role="alert"` (D-9,
  `ATV:573-580`); O1 fixed (`uAT:346`, `!state.dead`) - true.
- G: the range message renders under the inputs and the list area is
  otherwise empty (divergence 7) - true, unruled (SC-4).
- H: the e2e spec reseeds once per file, creates its own five tours, scopes
  every assertion to its own hrefs and walks `GET /api/tours/list?limit=2` to
  null (`tours-all.spec.ts:174-177,126-139,327-369`) - true.
- H: perf ledger citations refreshed (spot-checked `TP:662-671`,
  `TP:872`, `TD:697`, `useTours.ts:48-54`) - true.
- I: `undated-tour-wording` and `tours-scheduled-range-query-unpaginated`
  are `status: resolved`; `perf-pages-tours-past-surface` widened to both
  routes; the GLOSSARY entry records Requested / Needs booking / Undated -
  true.
