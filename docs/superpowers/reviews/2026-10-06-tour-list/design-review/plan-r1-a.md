# Plan review r1 (reviewer A) - tour list implementation plan v1

Adversarial review of `docs/superpowers/plans/2026-10-06-tour-list.md` (PLAN v1)
against `docs/superpowers/specs/2026-10-06-tour-list-design.md` (DRAFT 6), repo at
`W:\tmp\tour-list` (HEAD 7beb7422, cut from main @d839494a). Read-only review: no
suites, servers, DynamoDB or Docker were run. "plan:N" / "spec:N" are line
numbers in those two files.

Verified and found sound (no finding): the server engine (`listTourPage`) stop
and cursor rules traced case by case, including the peek row, the k-less U
cursor and the budget stop; the phase plan and the status-filter
normalization; cursor decode / locate shape checks; the DynamoDB expression
builder (no unused ExpressionAttributeNames/Values in any phase shape); the
route's placement before `/:tourId` (tours.ts:366-415) and its deps (`tours`,
`contacts`, `units`, `log`, `getNow` all exist, tours.ts:231-249); Express 5
async error propagation (app/package.json `express ^5.2.1`); the seed surfaces
(the four unstamped rows are the only ones; performance.ts:637-668 types its
rows `satisfies TourItem`; live.ts:357-393 stamps; history.ts only reads; no
other writer of the tours table exists outside toursRepo.ts); the undated-wording
reader list (every `scheduledAt` renderer in dashboard/src is covered); the
ToursPage split (ScheduleTourForm takes no contact/unit props,
ToursPage.tsx:812-820, so moving the hooks into TourListsView does not starve
the dialog); react-router 7.18's click predicate
(chunk-4ZMWKKQ3.mjs:7333-7337) and `setSearchParams` as a relative navigate
(chunk-4ZMWKKQ3.mjs:10851-10858); and the lint concern that an
`exhaustive-deps` suppression would silently disable the compiler rules for
`useAllTours` - it does not: in lint mode `validateExhaustiveMemoizationDependencies`
and `validateHooksUsage` are both on, so `findProgramSuppressions` gets no rule
names and the hook is still compiled and validated
(eslint-plugin-react-hooks cjs development.js:50710-50713, 31615, 51793).

---

## 1. [HIGH] The view's local restore record is never dropped, so every later filter or sort change restore-loads the NEW list to the old depth

**What is wrong.** Task 12.4 feeds `useAllTours` with `restoreDepth:
restore?.depth ?? null` (plan:2706), where `restore` is AllToursView LOCAL state
(plan:2580). The only writer of that state after mount is the adoption branch
(plan:2582-2589), which runs only on a POP or an UNSTAMPED navigation. Every
filter change, sort change, blur save, Clear filters and row open is a STAMPED
write (`persist` with `OWN_WRITE`, plan:2596-2599), which is deliberately NOT
adopted - so `restore` keeps the old record for the life of the view. The plan's
own comment (plan:2553-2555) says "a filter change or a blur save drops a
restore record" - true only of the HISTORY entry, not of the local copy that
drives the hook.

In the hook, `restoreWanted` is `restoreDepth !== null && rows < restoreDepth &&
restoreRequests < RESTORE_REQUEST_CAP` (plan:2270-2271), and `freshState` resets
`restoreRequests` to 0 for every new list (plan:2182). So: return from a tour
with depth 300, change When to Past -> the new list loads page 1 (50), then
automatically runs restore-mode requests of 100 rows until it holds 300 rows
(or 10 requests), with Load more hidden (`loader` 'restore'). The same happens
after Clear filters, a sort change, and the cursor-400 restart (a new epoch,
plan:2241). The anchor does not re-fire (`anchoredFor.current === restore`,
plan:2732), so the only visible effect is unrequested loading.

**Evidence.** plan:2580, 2582-2589, 2596-2599, 2706, 2270-2282, 2182; spec:360-361
("A filter or sort change aborts whichever is running and loads the first page
(`limit=50`)"); spec:410-412 (a filter change or blur save drops the record);
spec:31-34 (D2: more loads only when the user asks or returns to a list); spec:38-39
(D3: a search is the ONE thing that loads a whole list on its own). The spec's
test list requires "a filter change dropping the record" (spec:799); Task 12.4's
RED list (plan:2683-2702) has no such case, so the GREEN code would pass every
planned test while failing the spec.

**What it implies.** The most common return flow (open a tour, come back, refine
the filters) ships an automatic multi-page reload on every subsequent filter
change - a D2/D3 violation and up to 10 x 100-row reads per change. The plan
must say when the local record dies (at minimum on every `change()`/blur save
and on any new list key; arguably as soon as the anchor has run) and add the
spec's "a filter change dropping the record" case as a RED test that observes
NO limit-100 request after the change.

## 2. [MEDIUM] Clear filters leaves the debounced walk flag (and its pending timer) set, so it walks the whole default list with an empty search box

**What is wrong.** The walk is driven by `walkQ`, separate from the displayed
search `chosen.q` (plan:2577-2579, 2604: `walk: walkQ.trim() !== ''`). `walkQ` is
written only by adoption (plan:2586) and by the search box's own onChange
(plan:2599-2603: cleared at once "when the trimmed value is empty"). Clear
filters "resets every control ... the search included" (spec:328-329;
plan:2456-2457, 2477) but nothing in the plan resets `walkQ` or cancels the
armed 300 ms timer; the natural implementation `change(DEFAULT_TOUR_LIST_SELECTION)`
is a stamped write that is not adopted. Result: after a search, Clear filters
(top bar or the empty-state button) shows an empty box and the default list,
while `walk` stays true and the hook walks every tour (up to 50 x 100 rows,
plan:2272-2277, 2302) with Load more hidden; a timer still pending from the last
keystroke can also fire after the clear and re-arm the walk.

**Evidence.** plan:2577-2579, 2586, 2599-2604, 2272-2277; spec:31-34 (D2),
spec:38-39 (D3).

**What it implies.** An unrequested whole-table read on a common action. The
plan should either derive `walk` from both (`walkQ` and `chosen.q` non-empty) or
specify that every programmatic reset of `q` clears `walkQ` and the timer, and
add a RED case: search, Clear filters, assert no further `listTours` call.

## 3. [MEDIUM] Task 10.1 test 6 asserts `listTours` is called, but S10 ships AllToursView as a stub that calls nothing

**What is wrong.** Task 10.1 RED 6 (`ToursPage.walks.test.tsx`, real hooks)
ends "then click All: the counts still do not grow and `listTours` was called"
(plan:1956-1958). The same task's GREEN makes AllToursView a stub
`<section aria-label="All tours" />` (plan:1999-2001) that S12 replaces. Nothing
on `/tours/all` can call `listTours` until Task 12.1.

**Evidence.** plan:1949-1959, 1999-2001, 2489.

**What it implies.** A literal builder cannot take Task 10.1 to green; they must
silently drop or defer an assertion. Move the `listTours` assertion to S12 (or
assert only that the walks do not run on All in S10).

## 4. [MEDIUM] Several RED cases contradict the plan's own GREEN code

**What is wrong.** A builder who writes the tests as stated and pastes the
GREEN code gets failures that are the test's fault, inviting a "fix" in the
wrong place:

- Engine case 9 (plan:1087-1090): "when every U phase is empty the next page is
  `{ items: [], nextCursor: null }`" under the stated default injection
  `{ queryPageLimit: 3, maxQueryCalls: 3 }` (plan:1051). With every status there
  are five U phases; the GREEN loop (plan:1180-1186) spends its 3 calls on
  requested, toured and no_show and returns `{ ph: 'u', i: 3 }`, not null. The
  case only holds with a status set of at most three U statuses or a bigger
  budget - neither is stated. The tempting wrong fix is to stop counting empty
  calls against the budget.
- Hook case 7 (plan:2056): "`loadMore` is a no-op while walking". The GREEN
  `loadMore` guard is `!ready || cursor === null || moreInFlight || dead`
  (plan:2322) - no `autoMode` check - so a call during a walk sets
  `moreInFlight`, which blocks the auto effect and aborts the walk request
  (plan:2269, 2316), then issues a 50-row Load more. Not a no-op.
- Hook case 9 (plan:2061-2065) and view case 12.4-2 (plan:2688-2690) say the
  restore requests `limit: 100` pages, "at most 10 requests". The GREEN first
  page is always `limit: FIRST_PAGE_LIMIT` (50, plan:2255) and the cap counts
  only restore-mode requests after it (plan:2271), i.e. up to 11 requests, the
  first at 50 (see finding 5).

**Evidence.** As cited.

**What it implies.** Each needs the test or the code corrected in the plan so
the TDD loop's red is red for the stated reason.

## 5. [LOW] The return restore deviates from spec 4.9 / P5 (50-row first page, 11-request cap, follow after the cap)

**What is wrong.** Spec 4.9 loads restore pages at `limit=100` until depth, the
end, "or 10 requests have run (the cap: past it, the view keeps what it has)"
(spec:449-453); P5 says a return-restore asks for 100 (spec:82-83). The plan's
first page is 50 rows (plan:2255) and the cap excludes it (plan:2271), so the
cap is 11 requests. Also, once `restoreWanted` turns false at the cap, the mode
falls through to `follow` whenever the last page was empty with a cursor
(plan:2278-2282), adding up to 10 more automatic requests after a capped
restore - "keeps what it has" is not what happens.

**Evidence.** plan:2255, 2270-2282; spec:449-453, 82-83.

**What it implies.** Small, but undocumented; the handback's "planner calls that
narrowed the spec" (plan:2990-2993) does not list it. Either align (first page
at 100 when a record is present; count it; no follow after a capped restore)
or record the deviation.

## 6. [LOW] Task 10.1 turns `npm test` red until Task 13.2 (the perf route pin)

**What is wrong.** Task 10.1 adds `<Route path="tours/all" ...>` to App.tsx
(plan:1963-1966). `e2e/performance/routes.test.ts` parses every `<Route path>` in
App.tsx and fails on any path not registered or excluded
(routes.test.ts:376-388); it runs under root `npm test` (package.json `test`
runs every workspace; e2e/package.json `"test": "vitest run"`, e2e/vitest.config.ts
includes `performance/**/*.test.ts`). The exclusion only lands in Task 13.2
(plan:2847-2849), three slices later.

**Evidence.** As cited.

**What it implies.** Every intermediate full-suite run between S10 and S13 is
red for a reason the builder caused; a mid-build gate or reviewer sees a
spurious failure. Move the one-line `excluded` addition into Task 10.1.

## 7. [LOW] Spec-mandated dashboard test cases missing from the plan

**What is wrong.** Spec section 9 requires, for the return restore, "through the
back arrow, a browser Back and a reload" and "an empty list" (spec:791-797), and
"a filter change dropping the record" (spec:799). Task 12.4's RED list
(plan:2683-2702) covers the back arrow and Browser back but not a reload (a
remount whose initial entry carries the stamped state with `restore`), not an
empty list, and not the filter-change drop (finding 1).

**Evidence.** spec:791-799; plan:2683-2702.

**What it implies.** The coverage walk from spec to tasks is incomplete; the
filter-change case in particular is the one that would have caught finding 1.

## 8. [LOW] The route's log line drops "items evaluated", which spec 5.7 requires

**What is wrong.** Spec 5.7: one info line per request "with COUNTS only (rows
returned, items evaluated, Query calls, phases touched)" (spec:640-641). The
engine result carries `calls` and `phasesTouched` only (plan:1139-1145); the
repo method does not surface `ScannedCount` (plan:914-917); the route logs
`{ returned, calls, phases, when }` (plan:1410-1413) and route test 10 pins
that key set (plan:1295-1297).

**Evidence.** As cited.

**What it implies.** A spec field silently dropped and then pinned absent by a
test. Either thread an evaluated count through `queryListPhase` (DynamoDB
returns `ScannedCount`) or record the narrowing.

## 9. [LOW] "The list was refreshed." is asserted but absent from the count-line rules, and the flag outlives its list

**What is wrong.** Spec 4.5: after the automatic restart "the count line says
'The list was refreshed.'" (spec:384-387). Task 12.1 RED 7 asserts the text
(plan:2474-2475), but the GREEN count-line rules (plan:2512-2520) never consult
`refreshed`, leaving its placement to the builder. In the hook, `refreshed` is
`refreshedFor === listKey` (plan:2379) and `restartUsedFor` is keyed by
`listKey`, not by list (`listKey#epoch`) (plan:2229-2245): the notice stays up
for the rest of that filter set and reappears after an A -> B -> A filter round
trip, and that round trip also starts the new A list with its one restart
already spent.

**Evidence.** As cited.

**What it implies.** Specify where the notice renders and when it clears (for
example, until the next page lands), and key the allowance and the flag by the
list, not by the filter key.

## 10. [LOW] "Clear filters" and the chip Clear are judged on the UNPRUNED selection

**What is wrong.** `isDefaultTourListSelection` reads the raw selection
(plan:1901-1911; test 11 at plan:1702-1703 pins "false when any field
differs"). After a user leaves Date range with dates set, or hides a pressed
Needs booking chip by switching to a dated When, `chosen` keeps the hidden
values (only `applyTourListSelection` / `tourListApiParams` prune,
plan:1849-1862, 1880-1894), so "Clear filters" shows when nothing visible
differs from the defaults (under Any time with hidden from/to). The chip
group's Clear is copied from #1 (plan:2503-2505) without saying whether it gets
the pruned or the raw set; given the raw set, it shows with no pressed chip in
view.

**Evidence.** As cited; spec:328-336 (Clear filters shown when anything differs
from the defaults; the invariant about selections the user cannot see).

**What it implies.** Evaluate both on the pruned selection (as #1 does with
`selection`, ListingsList.tsx:228-231).

## 11. [LOW] Task 9.1 and Task 9.2 disagree on `TourListApiParams`

**What is wrong.** Task 9.1 says the selection model uses
`export type TourListApiParams = TourListParams;` "so the client has ONE shape"
(plan:1645-1647). Task 9.2's GREEN declares a separate
`export interface TourListApiParams { ... }` (plan:1869-1876).

**Evidence.** As cited.

**What it implies.** A literal builder ships two structurally equal types that
can drift; pick one.

## 12. [LOW] The e2e spec departs from spec section 9 without saying so, and cites helpers at lines that do not exist

**What is wrong.** Spec 9 requires the e2e spec to create "its own uniquely
named tenant contact and property through the API" and search that unique name
(spec:803-813). Task 13.1 instead reseeds and uses the lean seed's Tasha Nguyen
and units `unit-0001` / `unit-0002` (plan:2767-2771, 2800-2801). That is
workable here (playwright.config.ts runs `workers: 1`, `fullyParallel: false`,
and tours-past.spec.ts:77-80 reseeds the same way), but the handback's list of
spec narrowings (plan:2990-2993) omits it. Separately, `decide` /
`decideQuietly` are cited at `today-past-tours.spec.ts:203-229` (plan:2776); the
file has 202 lines and the helpers are at :70-90 (the plan's reseed citation
`tours-past.spec.ts:113-116`, plan:2771, is also off - the hook is at :77-80). Note also that `decide`
records `not_a_fit` WITHOUT `status: 'closed'` (today-past-tours.spec.ts:74-75),
so cleaned-up tours stay `toured` - the plan's "decides ... (toured + not a fit)"
is right, but anything that expects them closed is not.

**Evidence.** As cited.

**What it implies.** Record the fixture deviation as a planner call and fix the
citation.

## 13. [LOW] `pinnedNow` is taken from the injectable clock without canonicalizing it

**What is wrong.** The route sets `pinnedNow = getNow()` (plan:1347) and puts it
in the cursor; `decodeTourListCursor` rejects any `n` that is not
`toISOString()`-canonical (plan:737). The plan asserts `getNow()` is "already
canonical" (plan:1424-1425), true only of the default
(`deps.now ?? (() => new Date().toISOString())`, tours.ts:249). An injected
clock such as `() => '2026-10-06T16:00:00Z'` yields a first-page cursor that the
next request rejects with 400, and an `upcoming` key condition compared against
a non-canonical bound. Route test 3 injects a mutable clock (plan:1269-1273).
Existing tests happen to inject canonical strings (toursApi.test.ts:603, 1491).

**Evidence.** As cited.

**What it implies.** Canonicalize once (`new Date(getNow()).toISOString()`); spec
5.5 calls `n` "the pinned instant (canonical ISO)" (spec:606).

## 14. [LOW] The shared fake resumes by tourId lookup, not by key position, despite its header

**What is wrong.** The fake's header promises it "mirrors the REAL Query
semantics" and "resume is strictly AFTER startKey" (plan:946-957), but resume
finds the row whose `tourId` equals `startKey.tourId` in the CURRENT ordering
(plan:997-1002). DynamoDB resumes by key position. The two diverge for a row
deleted between pages (acknowledged, plan:1024-1026) and also for a row whose
range key moved between pages - a rescheduled tour in D, or a status change in
U - which the plan does not acknowledge. The fake then resumes at the row's
NEW position (skipping or repeating rows) or at the end.

**Evidence.** As cited; spec:370-371 (a tour rescheduled between two pages can
come back).

**What it implies.** Low today (no planned test moves a row mid-walk), but this
fake is named as the ONE model for the harness and the engine; resuming by
comparing `(rangeKey, tourId)` against the start key would match DynamoDB at no
extra cost.

## 15. [LOW] The issue-resolution text understates the reader count

**What is wrong.** Task 14.2 resolves `undated-tour-wording.md` with "S8
(`undatedTourLabel`, six readers)" (plan:2914), while S8 switches eight readers
(plan:1432-1438).

**What it implies.** Write "eight" and name the two extras (Today's past-tours
row and the Closed tab's date column), as the spec's amended P7 does.
