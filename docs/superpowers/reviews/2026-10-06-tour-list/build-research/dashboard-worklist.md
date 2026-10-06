# Tour list - build research: dashboard drift check (S8-S12) - worklist

Reader: dashboard build-research reader, 2026-10-06, READ-ONLY, against
`W:\tmp\tour-list` @ b3ac0306 (plan v3). No dashboard/e2e/app code changed
between base d839494a and HEAD (`git diff --stat d839494a HEAD -- dashboard e2e
app` is empty), so the plan research's line numbers still hold; this pass
re-verified every one against the live files. Byte-exact quotes backing every
citation: `.superpowers/sdd/build-research/dashboard-reference.md` (ignored).

Method beyond reading: the plan's S8/S9 code blocks, `tourListSelection.ts`
(9.2 + 12.3), `useAllTours.ts` (11.1) VERBATIM, the 12.2/12.4 fragments
VERBATIM inside minimal glue, and the 12.3 `backHref` were type-checked with
the real TypeScript 5.9.3 (strict + noUncheckedIndexedAccess, dashboard
compiler options) against the LIVE api barrel and the LIVE `ApiError` (a shim
re-exported `dashboard/src/api/index.ts` and added the plan's declarations;
a planted error proved coverage) - exit 0 - and linted with the repo's
`eslint.config.mjs` via `--stdin --stdin-filename dashboard/src/routes/tours/...`
(react-hooks 7.1.1 recommended-latest; a planted set-state-in-effect + refs
violation proved the rules fire) - exit 0, no warnings. Nothing was written to
the worktree except the two output files.

Facts the builder needs (all verified):

- Versions: react-router + react-router-dom 7.18.0 (package-lock.json:7383-7384,
  7403-7404); TypeScript 5.9.3; eslint 9.39.4; eslint-plugin-react-hooks 7.1.1;
  vitest 3.2.6; jsdom 25.0.1; @testing-library/react 16.3.2.
- Lint (eslint.config.mjs:48-52 applies `recommended-latest` to
  `dashboard/**/*.{ts,tsx}`): ERRORS = rules-of-hooks, static-components,
  use-memo, void-use-memo, preserve-manual-memoization, immutability, globals,
  refs, set-state-in-effect, error-boundaries, purity, set-state-in-render,
  config, gating. WARN = exhaustive-deps, incompatible-library,
  unsupported-syntax. Test files turn globals/refs/purity/immutability/
  set-state-in-render/set-state-in-effect/static-components OFF (:58-69).
- `dashboard/package.json` declares ONLY `react-router-dom`; import routing
  hooks from 'react-router-dom' (as ListingsList.tsx:37 does).
- api barrel `dashboard/src/api/index.ts:3,5` is `export * from './types.js'`
  and `export * from './endpoints.js'`; `ApiError` is an explicit re-export
  (:4). New names in types.ts/endpoints.ts reach `../../api/index.js` with NO
  barrel edit.
- `ApiError` (client.ts:13-33): `status: number`, `code: string`, `body`,
  `detail?`; constructor `(status, code, message, body?)` - message REQUIRED.
  `code` = the response body's `error` string, else `http_<status>`
  (client.ts:75-81); network failure = `ApiError(0, 'network_error')`; an
  AbortError DOMException is rethrown untouched (:125). So the hook's
  `err.status === 400 && err.code === 'invalid cursor' | 'cursor_mismatch'`
  matches the S7 route's `{ error }` strings exactly.
- `request<T>(path, { method?, body?, query?, signal?, rawBody?, headers? })`
  (client.ts:37-49); `query: Record<string, string | number | null |
  undefined>`, undefined/null DROPPED, '' SENT (buildUrl :51-60).
- `getTours` = endpoints.ts:2636-2663 (docblock 2636-2640; 2636 non-ASCII).
  Tour type imports = endpoints.ts:75-82 inside the block 6-88.
- endpoints.test.ts mocks `./client.js` with ONLY `request` and
  `requestWithStatus` (:5-8), resets both in beforeEach (:56-59), top-level
  `it`s, asserts via `toHaveBeenCalledWith` + `mock.calls[0]![1]`
  (:522-539 getTours precedent).
- types.ts: `TourType` :871, `TOUR_TYPE_LABELS` :874-878, `TourStatus`
  :881-887, `TOUR_STATUS_LABELS` :890-897, `tourStatusLabel(tour: Pick<Tour,
  'status' | 'outcome' | 'convertible' | 'convertedPlacementId'>): string`
  :904-912, `TourOutcome` :918, `TOUR_OUTCOME_LABELS` :921-925, `Tour`
  :939-976 (index signature :975), `ToursPage` (GET /api/tours response)
  :979-981, `Address` :2227-2234, `UnitItem` :2261, `UnitItem.address?:
  Address | string` :2282. `dashboard/src/api/types.test.ts` EXISTS (imports
  from './types.js' :2-11; `describe('tourStatusLabel')` :13-43).
- contact/format.ts: `formatAddress(address: Address | string | undefined):
  string` :102-112 (returns '' for undefined); `contactDisplayName(firstName:
  string | undefined, lastName: string | undefined, phone: string | undefined):
  string` :138-147 - POSITIONAL args; falls back to the formatted phone, then
  'Unknown contact', never the id.
- tours/tourTime.ts: `formatTime` :62-67, `formatDate` :72-77, `whenLabel`
  :86-91 - all `(iso: string | undefined): string`, '' for falsy/unparseable;
  whenLabel normalizes U+202F/U+00A0 to spaces.
- ui/index.ts:3-4 exports `Button` and `Spinner`; `Spinner({ size?, center?,
  label = 'Loading' })` renders `role="status" aria-label={label}`
  (Spinner.tsx:6-24) - accessible name 'Loading'.
- Derived-loading pattern: useContacts.ts:44-53 (state carries `forFilter`)
  and :82-84 (mismatch -> 'loading'); same in useListings.ts:18-27, 47-49.
  useContacts('all') and ('deleted') each call `getAllContacts` 4 times
  (TYPES_FOR :30-41); useListings calls `getAllUnits` once -> 8 + 2 per round.
- react-router chunk exists: `node_modules/react-router/dist/development/
  chunk-4ZMWKKQ3.mjs`; `isModifiedEvent` :7330-7332 and
  `shouldProcessLinkClick` :7333-7337 (button 0, no meta/alt/ctrl/shift,
  target absent or _self). Link runs the caller's onClick FIRST, then
  navigates unless defaultPrevented (:10552-10557); same-URL target defaults
  to REPLACE (:10796); `setSearchParams` = `navigate("?" + params, opts)`
  (:10851-10858); RenderedRoute is created unkeyed (:6329-6340), so sibling
  tours routes keep ONE ToursPage instance.
- ListingsList.tsx imports `useLayoutEffect, useMemo, useRef, useState` (:36)
  and `Link, useLocation, useNavigate, useNavigationType, useSearchParams`
  from 'react-router-dom' (:37).
- Test setup is `dashboard/src/test/setup.ts`: Date pinned to
  2026-07-01T12:00:00Z with bare `vi.setSystemTime` (:32-36, real timers);
  `HTMLElement.prototype.scrollIntoView` no-op stub (:50-55); no console
  trap. vitest 3.2.6 `vi.restoreAllMocks()` calls mockRestore -> mockReset
  -> mockClear on EVERY vi.fn (@vitest/spy dist/index.js:104-122, 166), so
  ToursPage.test.tsx's `afterEach(vi.restoreAllMocks)` (:302-304) clears call
  history between tests and keeps each vi.fn(impl)'s impl.
- Gate-5 baseline (`npx eslint` on every file S8-S12 touches, today): exactly
  two PRE-EXISTING errors - `TenantFile.tsx:15` @typescript-eslint/
  no-unused-vars (`FieldSource`) and `TourDetail.tsx:327` react-hooks/purity
  (`Date.now()` in render). All other touched files are clean. Name both in
  the handback; do not fix them here.


## Task 8.1 - `undatedTourLabel` and its eight readers

Anchors verified: types.ts:904-912; TourDetail.tsx:312 (+:313 factsLine,
:783 Schedule card reuse); TenantFile.tsx:334-337; LandlordFile.tsx:214-217;
ListingDetail.tsx:1082-1084; ToursPage.tsx:131-136 (rendered :155, Closed
passes 'date' :804), :205-206; Today.tsx:198, :201, :215; TourModals.tsx:203;
TourDetail.test.tsx:300-309 (assert :307-308); files.test.tsx:266-283 and
458-474 (asserts :278, :470); ListingDetail.test.tsx:432-433;
ToursPage.test.tsx:1216-1229 (Past undated PIN); Today.test.tsx:356-361;
e2e tours-page.spec.ts:238-239, :242; steps.ts:1147, :1168-1169, :1176,
:1854, :1856; tours.spec.ts:417. Every listed literal is where the plan says.

1. Missing import instructions (would break `npm run typecheck` if followed
   literally). The plan says "adding the import" for TourDetail, TenantFile,
   LandlordFile and ListingDetail, but not for the two other readers:
   ToursPage.tsx (api import block :47-56) and Today.tsx (api import block
   :17-23) both need `undatedTourLabel` added. Today.test.tsx spreads the real
   barrel (:38-45), so the Today PIN keeps working.
2. ListingDetail.tsx has TWO api import blocks (:16-32 and :34-42);
   `tourStatusLabel` lives in the second (:40) - add `undatedTourLabel` there.
3. `dashboard/src/api/index.ts` needs NO edit (star re-export, see facts); the
   plan's conditional ("export it ... if that barrel lists names explicitly")
   resolves to nothing.
4. TourModals.tsx: the docblock is :194-207 (plan says 195-207) and line 203
   is ASCII - no ASCII trap there (TourModals.tsx's non-ASCII lines are 7, 87,
   137, 144, 158, 160).
5. ASCII traps NEXT to the e2e edits (the plan names only steps.ts:1168):
   tours-page.spec.ts:237 (box-drawing + U+2014) sits directly above the
   :238-239 comment and :244 two lines below :242; steps.ts:1148 (U+2014) sits
   directly below the :1147 doc comment (non-ASCII in that region: 1143, 1148,
   1152, 1158, 1160, 1168). Keep those lines out of each Edit, or ASCII-fy any
   one that is re-emitted.
6. Test-shape traps (each would fail a test if done the obvious way):
   (a) the undated CANCELED Closed row must be a NEW `it` - the existing Closed
   test pins `toHaveLength(3)` and row order (ToursPage.test.tsx:530-541);
   (b) the undated toured property-page row must be a NEW `it` or use a
   narrower regex - `/Fixture Tenant.*Toured/s` (ListingDetail.test.tsx:436)
   would match both toured links and `getByRole` throws on multiple matches;
   (c) TourDetail.test.tsx `makeTour` defaults `scheduledAt:
   '2026-07-10T14:00:00Z'` (:132) - the undated toured case must pass
   `scheduledAt: undefined` explicitly, as the requested case does (:302);
   the Schedule card value renders as `<span class=v>` (Card.tsx:153), so
   `getByText('Undated')` (exact) hits only it, not the facts line.
7. The final grep (`git grep -n "Not booked"`) is case-sensitive: lowercase
   prose "not booked" stays at steps.ts:1853 ("Requested + not booked - ...")
   and tours-page.spec.ts:479 ("(requested, not booked)"). They describe the
   state, not the UI word - leave them (recommended) or reword; either way the
   plan's grep will not report them.
8. Gate 5: TenantFile.tsx:15 and TourDetail.tsx:327 already fail lint (see
   facts). Both files are touched here - attribute by baseline, not line.


## Task 9.1 - api types and `listTours`

Anchors verified: types.ts:904-912 (insert after :912); UnitItem :2261,
address :2282; endpoints.ts type block :6-88 (tour types :75-82), getTours
:2636-2663; endpoints.test.ts client mock :5-8. The plan's types and
`listTours` type-check against the live client (`query` value types,
`signal` spread) and the `TourListRow` -> `tourStatusLabel` /
`undatedTourLabel` / `TOUR_OUTCOME_LABELS[row.outcome]` uses compile. The
RED's `toHaveBeenCalledWith(..., { query: {... undefined ...} })` matches
(the call carries the undefined keys; no `signal` key without a signal).

9. Placement wording conflict (LOW, no compile impact): ground rules (plan
   :52-53) say new api types/endpoints go "after the existing tour ones", S9.1
   says types go right after `undatedTourLabel` (mid tour section, before
   `TourOutcome` :918 / `Tour` :939). Pick one before S9 - the parallel #2
   branch also edits types.ts/endpoints.ts. Forward type references are fine
   either way.
10. Inserting `TourListPage`/`TourListParams` into the endpoints.ts type block
    shifts every later endpoints.ts line by +2; the perf ledger cites
    endpoints.ts:823-831, :1229-1240, :1494-1504 (routes.ts:741, :812, :813).
    Task 13.2's refresh list does not include them (see gaps).


## Task 9.2 - the selection model

Anchors verified: `pastToursDateRange` calendar arithmetic useTours.ts:175-185
(matches `localDayEndIso`); `TourListParams` reaches the module through the
barrel. The whole module (plus 12.3's `TourListRestore` /
`parseTourListRestore`) type-checks and lints clean as written. No
corrections.


## Task 10.1 - tabs, route, P15, the split

Anchors verified: App.tsx:237-243 (comment :237-239, routes :240-242, detail
route :245); ToursPage.tsx:1-44 header, :575-606 (ToursView :579,
ToursPageProps :581-585, VIEW_TABS :589-593, PAGE_TITLE :595-599, PAGE_INTRO
:601-606), :617-823 ToursPage; tab strip :708-719 = `<nav className=
{styles.tabs} aria-label="Tours view">` of plain `Link`s (not NavLink),
`aria-current="page"` spread on the current tab, class `tabActive`;
ToursPage.test.tsx renderPage :252-263 (MemoryRouter; routes /tours,
/tours/past, /tours/closed, /tours/:tourId -> LocationProbe `<output
data-testid="loc">` :233-248), tab-order pin :507-511;
routes.test.ts:376-385 (comment :381). Mocks today: the useTours.js mock
:54-62 with a BARE `useTours: () => toursState` (:58) and
`useClosedTours`/`usePastTours` routed to vi.fn spies (:35-50), `useContacts`
and `useListings` as plain factories (:65-70); the barrel spread with 5
overrides (:80-90).
Full hook list in ToursPage today (so the split misses none): `useNavigate`
:618 and `useState` creating :632 STAY in ToursPage; `useTours` :621,
`useContacts('all')` :622, `useListings()` :623, `useContacts('deleted')`
:626, `useListings(true)` :627, `useClosedTours(closed)` :635, `useMemo`
contactsMap :662, unitsMap :669, upcomingGroups :677 MOVE. PastToursView's
own hooks (inside :348-573) stay inside it. Exports: `resetBulkBatchStoreForTests`
:330, `ToursView` :579, `ToursPageProps` :581, `ToursPage` :617 -
`PastToursView` is NOT exported; importers are App.tsx:47 and
ToursPage.test.tsx:93 only. Existing accessible names the split must keep are
all present: regions :732, :759, :498, :791; lists :742, :766, :554, :797.

11. ToursPage.test.tsx imports `{ render, screen, waitFor, within }` (:15) -
    add `fireEvent` for the P15 case (compile error otherwise).
12. ASCII: ToursPage.tsx header non-ASCII lines are 5, 6, 9, 41 (plus :624,
    which the plan names) - add the All view as NEW ASCII lines; ASCII-fy any
    of 5/6/9/41 that an Edit re-emits. ToursPage.test.tsx:64 (U+2014) is the
    comment directly above the `useContacts` mock the plan wraps in a spy
    (:63-67); other non-ASCII test lines: 1, 25, 206, 216, 354, 443, 458, 559,
    720. App.tsx:244 (U+2014) is the comment directly below the insertion
    point - add the new Route after :242 without touching :244.
13. Spy hygiene (note, not a defect): the existing `afterEach(() =>
    vi.restoreAllMocks())` clears every vi.fn's calls, so "useToursSpy / the
    useContacts spy / the useListings spy were NEVER called" holds per test
    without new mockClear calls (the file still mockClears its other spies in
    beforeEach :280-300 - mirror it for symmetry if wanted).
14. P15's Ctrl-click assertion: an unprevented click on an `<a href>` runs
    jsdom's anchor activation (HTMLAnchorElement-impl.js:16-18), which reports
    "Not implemented: navigation (except hash changes)" (navigation.js:77) to
    console.error through vitest's VirtualConsole. The test still passes
    (setup.ts has no console trap); expect the noise, or silence it with a
    local `vi.spyOn(console, 'error')`. Same for Task 12.4 case 1.
15. The location probe for P15 must render OUTSIDE `<Routes>` (the existing
    LocationProbe renders only on /tours/:tourId) and be a plain span - a
    second `<output>` would add a `status` role and break "shows a spinner"
    (`getByRole('status')`, ToursPage.test.tsx:313). Use a new component name
    (LocationProbe is taken).


## Task 11.1 - `useAllTours`

Anchors verified: house async-callback pattern (usePastTours useTours.ts:302-337
with the set-state-in-effect comment :306-310; useContacts derived loading).
The hook as written type-checks against the live barrel/ApiError and lints
with zero errors and zero warnings (the conditional `setListGen` in render is
accepted by set-state-in-render; no ref is read in render).

16. `ApiError` needs THREE constructor arguments (client.ts:22). The plan's
    shorthand `ApiError(400, 'invalid cursor')` / `ApiError(400,
    'cursor_mismatch')` (plan :2187-2188) copied into a test compiles under
    vitest (types stripped) but fails gate 1 `npm run typecheck` (TS2554).
    Write `new ApiError(400, 'invalid cursor', 'invalid cursor')`, as
    TourDetail.test.tsx:293 does. Applies to S11 case 10 and S12.1 case 7.
17. Behavior note for the test writer: on a FAILED first page during a return
    the hook reports `restoreOutcome: 'reached'` (freshState(key, null) has
    `cursor: null`) - by design since ruling P2-3 (the anchor settles, finds
    no rows, and is spent). Do not assert 'pending' there.


## Task 12.1 - filter bar, rows, count line, states

Anchors verified: ListingsList.module.css:70-208 (all 11 copied classes
present, ASCII); ToursPage.module.css has `rows rowItem row main tenant
property meta time badge`; ChipGroup ListingsList.tsx:130-185 (docblock
:130-132); Spinner house pattern ToursPage.tsx:721 / ListingsList.tsx:398;
row-label fallbacks ToursPage.tsx:72-84.

18. ChipGroup copy also needs `toggled` (ListingsList.tsx:74-78) and an
    adaptation: it takes `{ key, label }` options and `ReadonlySet<string>` /
    `(next: Set<string>) => void`; TOUR_LIST_STATUS_CHIPS is `{ value, label }`
    over TourStatus - map the options or make the copy generic. The Clear
    aria-label `Clear ${label.toLowerCase()} filter` with label 'Status'
    yields 'Clear status filter' as required.
19. Property fallback: mirror ToursPage.tsx:83 - `formatAddress(entry.address)
    || row.unitId` (an entry whose address is absent or blank must show the
    unitId, not ''). Tenant: the raw tenantId only when the map has NO entry;
    an entry with no name or phone reads 'Unknown contact'
    (format.ts:146) - that text is what the search matches.
20. CSS idiom (LOW): the plan prescribes `@media (max-width: 480px)`; the house
    stacks on the CONTENT PANE with container queries - ToursPage.module.css:11
    makes `.page` an inline-size container and :200 uses `@container
    (max-width: 560px)` (same in ListingsList.module.css:13/:298). AllToursView
    renders inside ToursPage's `.page`, so `@container (max-width: 480px)`
    works and matches the house; no `@media (max-width: 480px)` exists in
    dashboard CSS today.
21. Route names: import `useLocation`, `useNavigationType`, `useSearchParams`,
    `Link` from 'react-router-dom' (see facts).


## Task 12.2 - URL state and the debounced walk flag

Anchors verified: ListingsList.tsx:7-37 (header + imports), :87-106
(OWN_WRITE, isOwnWrite, historyIdx), :199-297 (component through
currentSearch/statusRef; adoption :213-218, layout-effect index :245-248,
persist :255-261, change :266-269, persistSearch :277-279), :228-231 (pruned
`selection`), :257-260 (stamped REPLACE), :315-332 (tab nav; the current tab
carries `currentSearch` :324); ListingsList.urgentState.test.tsx:17-24;
ListingsList.test.tsx:90-137 (span LocationProbe, BackButton,
ForeignReplaceButton, two-entry renderAt) and :867-923 (BrowserRouter
describe; pushState idx+1 :916-917; replaceState reset :870-872);
ContactDetail.test.tsx:1459-1489 (fake-timer idiom). The plan's module
helpers and component fragment, glued as the prose describes (persist /
change / onChange / onBlur / row onClick), type-check and lint clean.
No corrections.


## Task 12.3 - the back state and the tour page

Anchors verified: TourDetail.tsx BACK_TARGETS :116 (doc :113-115), backHref
:121-124 (doc :118-120), backLabel :127-129 ('Back to tours' unless '/');
`const location = useLocation()` :270, `backTo = backHref(location.state)`
:271 (inside `TourDetailLoaded` :183); the `?outcome=1` strip effect
:288-293 forwards `state: location.state`; back Link :683-685 is `<Link
to={backTo} className={styles.backBtn} aria-label={backLabel(backTo)}>`
with NO state. TourDetail.test.tsx `renderAt(path, state)` :2178-2194 mounts
ONLY `/tours/:tourId` (TourDetail + `<output data-testid="search">`),
passing state via `initialEntries={[{ pathname: '/tours/tour-abc', search:
path, state }]}`; back-arrow cases :2238-2265; `useNavigate` is mocked
(:86-90) but Link navigation still works (the chunk's internal hook). The
plan's `backHref` + `parseTourListRestore` + Link `state` expression
type-check and lint clean.

22. Edit-tool trap (ASCII + behavior): TourDetail.tsx:684 is the source
    escape `{'\u2190'}` directly inside the back Link. Edit ONLY line 683 (the
    open tag) to add `state={...}`; an Edit whose old/new strings include :684
    can decode the escape into a literal U+2190 arrow (non-ASCII, and a changed
    line).
23. The new `/tours/all` probe route goes into that describe's `renderAt`
    (or a local variant) - else `/tours/all` matches `/tours/:tourId` and
    re-renders TourDetail, as the plan says.


## Task 12.4 - row-open write and the return restore

Anchors verified: focus idiom StatusMenu.tsx:211-214 (`focus({
preventScroll: true })` then `scrollIntoView({ block: 'nearest' })`, inside
the effect :202-215); scrollIntoView stub setup.ts:53-55 (own property of
HTMLElement.prototype, so `vi.spyOn(HTMLElement.prototype,
'scrollIntoView')` works - StatusMenu.test precedent); jsdom anchors are
focusable. The anchor layout effect reads refs only inside the effect; lint
clean (no exhaustive-deps warning for `visible`). Note 14 (jsdom
navigation noise) applies to the Ctrl/Alt-click cases. No corrections.


## Invariant sweep (whole dashboard/src; `git grep -i` "not booked",
## "undated", "needs booking"; every non-test `scheduledAt` consumer)

| file:line | what | plan covers? |
|---|---|---|
| routes/tours/TourDetail.tsx:312 (+:313, :783) | 'Not booked' facts line + Schedule card | YES S8 |
| routes/contact/TenantFile.tsx:335-337 | row label 'Not booked' | YES S8 |
| routes/contact/LandlordFile.tsx:215-217 | row label 'Not booked' | YES S8 |
| routes/listing/ListingDetail.tsx:1082-1084 | row sub-label 'Not booked' | YES S8 |
| routes/tours/ToursPage.tsx:205-206 | Past date column 'Undated' | YES S8 (same output) |
| routes/tours/ToursPage.tsx:131-136 (:155) | Active/Closed TourRow date '' when undated | YES S8 (Closed reads Undated) |
| routes/today/Today.tsx:215 | 'Undated' | YES S8 (same output) |
| routes/tours/ToursPage.tsx:207 (:227, :239, :258, :268) | Past names ", undated" | NO - by design (never a request) |
| routes/today/Today.tsx:201 (:208) | Today name ", undated" | NO - by design |
| routes/tours/TourModals.tsx:203 | comment "Not booked" | YES S8 |
| routes/listing/useListing.ts:84-94 | `sortToursForPanel`: EVERY undated tour sorts first as an "unbooked request" | NO - gap G1 |
| routes/today/buildToday.ts:263-266 | Tours-today skips undated | n/a (correct) |
| routes/tours/TourDetail.tsx:327 | `startPassed` typeof check | n/a |
| routes/tours/ToursPage.tsx:133 | Upcoming `formatTime` | n/a (scheduled => dated, I1) |
| routes/tours/ToursPage.tsx:509, :519 | batch results "on <whenLabel>" | n/a (only scheduled rows are batch-marked, I1) |
| routes/tours/ToursPage.tsx:683 | `localDateKey` grouping | n/a (Upcoming only) |
| routes/tours/useTours.ts:84-86, :204-210, :216-217, :243 | sorts / selection with `?? ''`, `isUndated` | n/a (not display) |
| routes/tours/ToursPage.tsx:9, :185-189, :202-204, :758-760; tourTime.ts:85 | comments; the Active "Needs booking" section | n/a |
| routes/contact/Card.tsx:184-192 | TourChip 'Tour requested' (status chip) | n/a |
| TourDetail.test.tsx:307-308; files.test.tsx:266/278, 458/470; ListingDetail.test.tsx:432-433 | assertions | YES S8 |
| Today.test.tsx:356-361; ToursPage.test.tsx:1216-1229 | undated pins | PIN S8 |
| tourTime.test.ts:112; useTours.test.ts:352, :402, :421 | formatter '' / selection | n/a |
| e2e tours-page.spec.ts:238-239, :242; steps.ts:1147, :1168-1169, :1176, :1854, :1856; tours.spec.ts:417 | e2e text | YES S8 |
| e2e steps.ts:1853; tours-page.spec.ts:479 | lowercase prose "not booked" | NO - item 7 |

Tour row accessible-name builders (the "house shape"):

| file:line | name |
|---|---|
| ToursPage.tsx:145 (TourRow, Active + Closed) | `Tour for <tenant> at <property>` (no date, no status) |
| ToursPage.tsx:207 + :239 (Past) | `Tour for <tenant> at <property> on <when>, <state>`; undated: `..., undated, <state>` (also :227 `Select tour for <who>`, :258 `Mark toured: <who>`, :268 `Record outcome: <who>`) |
| Today.tsx:201 + :208 | same as Past |
| Card.tsx:168-182 Row (tenant, landlord, property tour lists) | link text content: label + right (status) |
| NEW All row (S12, spec 4.4) | `Tour for <tenant> at <property>, <date column>, <status label>[, <outcome>]` |

The All shape keeps the Past/Today order (identity, date, state last) but
joins the date with ", " (not " on ") and an undated row reads ", Undated," /
", Needs booking," where Past/Today read ", undated," - spec-sanctioned (4.4),
noted so nobody "fixes" one into the other.


## Mutation catalog and other pins

- `listTours` is a GET (`request('/api/tours/list', { query, ...signal })`).
  The scanner classifies a call with no `method` as GET (mutationCatalog.test.ts
  methodClassFor :180-182; the `...(signal !== undefined && { signal })`
  spread resolves to no method) and `catalogDiscoveries` drops every `:GET`
  (:323-328); the pinned count 111 counts non-GET only (:364-377). NO catalog
  entry, NO count change. The hook calls `listTours`, never `request`.
- Nothing pins the list of endpoints.ts exports or a count of `request(` calls
  (endpoints.test.ts imports named functions only; no dashboard test scans
  endpoints.ts). The only line-based pins are the perf ledger citations
  (routes.ts:124-133, :721-813), checked for FORMAT only.
- e2e pins of the tab strip select tabs by name inside the "Tours view" nav
  (tours-page.spec.ts:427/:450, tours-past.spec.ts:108) - the S10 reorder
  breaks none; only the unit pin ToursPage.test.tsx:507-511 changes.
- routes.test.ts extracts App.tsx paths with `<Route(?:\s|\n)[^>]*?path="..."`
  (:362-366): `<Route path="tours/all" ...>` becomes '/tours/all' and must be
  in the `excluded` set in the same commit (S10 does this).


## Gaps and risks (behavior/correctness; for the orchestrator)

- G1 (LOW-MEDIUM, decide before S8 or file it): `sortToursForPanel`
  (useListing.ts:84-94) sorts every undated tour first as an "unbooked
  request" (its docblock says so). After D8 an undated toured, canceled or
  closed tour reads "Undated" yet sits at the top of the property page's
  Tours card among the requests, above dated history. It is a reader of I1
  missing from spec section 8's list. Options: sort only `requested` first
  (one-line change + a pin), or leave it and file a docs/issues entry.
- G2 (LOW): P15 + a bare href - a Ctrl/Cmd/middle-click on the CURRENT All
  tab opens an UNFILTERED /tours/all, while #1's current tab carries the query
  (ListingsList.tsx:324). The parent can see `location.search` (the committed
  filters), so the current All tab could link to `{ pathname: '/tours/all',
  search: location.search }` at no cost (P15 still swallows the unmodified
  click). Spec P15 accepts the bare link; optional.
- G3 (LOW, a11y): the count line is a `role="status"` region that is
  UNMOUNTED during every first-page load (ruling P2-5) and re-inserted with
  content; screen readers do not reliably announce a live region inserted
  with its text. Also every walk page rewrites the atomic region ("Searching...
  N matches so far"), up to 50 announcements. Consider keeping the region
  mounted but empty while loading.
- G4 (LOW): the walk cap is per LIST - `walkRequests`/`walkCapped` are never
  reset when the search is cleared and retyped, so a second search on a list
  whose first walk capped never walks (Load more stays available). Spec 6 is
  silent; accept or reset on a walk false->true edge.
- G5 (LOW): after a capped follow with zero rows the count line reads
  "Showing 0 tours" beside "No more matches in the tours checked so far." -
  spec-consistent (more remain), reads oddly.
- G6 (LOW, S13 scope, caused by S8/S9): import-line insertions shift perf
  ledger citations that Task 13.2 does not list: routes.ts:741/:812/:813
  (endpoints.ts, +2 from S9.1), :742 and :796 (ListingDetail.tsx, +1),
  :795 (TenantFile.tsx, +1), :770 (Today.tsx, +1). Most are already stale
  today (e.g. TenantFile.tsx:152 is `suggestion={s}`); the format-only test
  will not notice. The `/tours` ledger entries cite ToursPage.tsx:643-647
  (routes.ts:724-725), which today is the `crossRefError` tail (:642-646) plus
  a comment (:647) - already drifted before the split.
- G7 (INFO, S15 sync): main has moved to a5eabcb3 with 13b64f60 touching
  `dashboard/src/ui/twoPaneShell.module.css` and `routes/contact/
  Timeline.tsx` - no file this plan edits, so no conflict expected.
