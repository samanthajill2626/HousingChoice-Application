# Plan review r1-b - Tours page All tab (adversarial, plan-blind of rationale)

Reviewer: plan-r1-b (2026-10-06). Inputs: the plan
(`docs/superpowers/plans/2026-10-06-tour-list.md`, PLAN v1), the spec
(`docs/superpowers/specs/2026-10-06-tour-list-design.md`, DRAFT 6) and the
worktree at `W:\tmp\tour-list` (HEAD 7beb7422). Read-only: no repo file was
edited except this one; no suite, server, DynamoDB or Docker was run.

## What was verified empirically (so it is NOT a finding)

- The plan's app code compiles under the repo's compiler options (strict,
  NodeNext, noUncheckedIndexedAccess, TS 5.9.3): `tourListQuery.ts` (plan
  409-776), `queryListPhase` (plan 854-918, against the real
  `@aws-sdk/lib-dynamodb` types), `tourListPage.ts` (plan 1101-1214),
  `tourListIndexFake.ts` (plan 942-1021) and the route's `let page` try/catch
  shape - copied verbatim into a scratch project, `tsc` exit 0.
- The plan's dashboard code compiles (bundler resolution, strict,
  noUncheckedIndexedAccess): `tourListSelection.ts` + `parseTourListRestore`
  (plan 1708-1911, 2630-2646) and `useAllTours.ts` (plan 2081-2399) against
  stubs of the plan's 9.1 types - `tsc` exit 0.
- The React Compiler rules (react-hooks 7.1.1 `recommended-latest`: every
  compiler rule is `error`, `exhaustive-deps` is `warn`): `useAllTours` verbatim
  and an assembly of every `AllToursView` fragment the plan gives (adoption
  block, layout-effect index, persist/change, debounce timer, user-intent
  guard, anchor layout effect, row onClick) both lint with ZERO errors via
  `npx eslint --stdin --stdin-filename dashboard/src/routes/tours/...`.
- Tours table key: hash `tourId` only (`app/src/lib/tables.ts:526-551`), so a
  byScheduledAt LEK is exactly `{tourId, _schedPartition, scheduledAt}` and a
  byStatus LEK `{tourId, status, createdAt}` - the cursor's exact-key-set check
  will accept real LEKs. No phase FilterExpression names a key attribute of the
  index it queries.
- `ApiError.code` is the body's `error` string (`dashboard/src/api/client.ts:75-81`),
  so `isCursorRejection` will see `'invalid cursor'` / `'cursor_mismatch'`.
- The tours router already holds `contacts`, `units`, `log` and
  `getNow = deps.now ?? (() => new Date().toISOString())`
  (`app/src/routes/tours.ts:231-247`); the harness forwards `toursNow` as `now`
  (`app/src/routes/api.ts:945`); Express is 5.2.1, so a rethrown error reaches
  the 500 handler (`app/src/lib/errors.ts:200`).
- The only full typed fakes of `ToursRepo` / `UnitsRepo` are in
  `app/test/helpers/twilioWebhookHarness.ts:2690,3470`
  (`placementNudges.test.ts:182` casts through `unknown`); `app/test` IS
  type-checked (`app/tsconfig.test.json`), so the harness RED steps are real.
- Playwright runs `workers: 1`, `fullyParallel: false`
  (`e2e/playwright.config.ts:140-141`) with a `baseURL`, so the per-file reseed
  and the relative `page.request.get('/api/tours/list?...')` are sound.

---

## F1 [HIGH] The restore record is never dropped from the view's state: every later filter, sort, Clear filters, Retry or Start over re-runs the restore loader to the old depth

**What is wrong.** The restore depth that drives loading lives in
`AllToursView`'s local `restore` state, and the plan only ever sets that state
from history (the initializer and the POP/unstamped adoption block). A filter
change is a stamped REPLACE, which is deliberately NOT adopted - so the history
entry loses its record (as the spec wants) but the in-memory `restore` keeps
it. `useAllTours` receives `restoreDepth: restore?.depth ?? null` forever, and
its restore budget (`restoreRequests`) is per LIST (reset by `freshState` on
every first page). So after a user returns from a tour with depth > 50 (the
normal case for P14 - Cameron kept the restore precisely for deep lists), each
subsequent new list auto-loads `limit=100` pages until it holds `depth` rows,
up to 10 requests, with no user action.

**Evidence.**
- `setRestore` appears only at plan 2580 (initializer) and 2587 (adoption, which
  runs only for `navigationType === 'POP' || !isOwnWrite(...)`, plan 2584);
  `change(next)` = `setChosen(next); persist(next)` (plan 2599) and `persist`
  writes `state: OWN_WRITE` (plan 2596-2597), so the REPLACE is never adopted.
- `useAllTours({ listKey, walk, restoreDepth: restore?.depth ?? null })`
  (plan 2706); `restoreWanted = restoreDepth !== null && state.rows.length <
  restoreDepth && state.restoreRequests < RESTORE_REQUEST_CAP` (plan 2270-2271);
  `restoreRequests: 0` in `freshState` (plan 2182); `retry`/`startOver` only
  bump the epoch (plan 2346-2351).
- Spec 4.5 (lines 360-361): "A filter or sort change aborts whichever is
  running and loads the first page (`limit=50`)"; D2 (lines 31-34): more loads
  only when the user asks; 4.7/4.9 (lines 411-413, 445-446): a filter change or
  a blur save drops the record; spec 9 requires the test "a filter change
  dropping the record" (spec 799) - the plan's Task 12.4 RED list (plan
  2681-2702) does not include it, so nothing would catch this.

**What it implies.** Ships silently: every filter tweak after a return reads up
to 1,000 extra rows (10 x 100) and the list grows on its own, contradicting D2.
The anchor does not re-fire (`anchoredFor.current === restore`, plan 2732), so
there is no visible symptom to catch it in self-QA. Fix in the plan: clear the
local record whenever the history record is dropped (`change()`, Clear filters,
the blur save, Start over/Retry) - or key `restoreDepth` to the list it was
adopted for - and add spec 9's "a filter change dropping the record" case as an
assertion that the new list issues exactly one `limit=50` request.

## F2 [HIGH] Clear filters never resets the debounced walk flag: an empty search box keeps walking the whole list

**What is wrong.** `walk` is derived only from `walkQ`, and `walkQ` changes only
in the search box's `onChange` (300 ms timer, or immediately when the box is
emptied) and on adoption. Clear filters goes through `change()`, which resets
`chosen.q` but not `walkQ` and does not cancel a pending timer. Results: (a)
with only a search set, Clear filters leaves the same `listKey`, so the walk
keeps loading the rest of the list with the box empty; (b) with filters set,
the new default list (Any time, every status - every tour) is walked from page
1 up to the 50-request cap (5,000 rows); (c) typing then clicking Clear filters
within 300 ms lets the timer fire `setWalkQ(oldText)` afterwards.

**Evidence.** plan 2577-2579 ("The search the WALK follows: set at once on
adoption and on clearing, 300 ms after typing otherwise"), plan 2599-2604
(only the box's `onChange` touches `walkQ`; `walk: walkQ.trim() !== ''`);
Task 12.1 RED #2 requires Clear filters to reset "the search included"
(plan 2456-2457) but asserts nothing about the walk. Spec 6 (lines 671-673):
the walk is aborted "by clearing the search"; D3 (lines 35-39): "A search is the
one thing that loads a whole filtered list on its own."

**What it implies.** A whole-table read triggered by the reset button, with the
count line growing "Showing N tours" and Load more hidden while it runs - the
exact cost the spec's search design exists to bound. Fix in the plan: one
setter for `q` that also syncs `walkQ` and clears the timer, used by the box,
Clear filters (both instances, incl. the empty state) and any other reset; add
a hook/view test that Clear filters during a walk aborts it and issues no
further `limit=100` request.

## F3 [MEDIUM] Task 10.1's new walks test cannot pass at Task 10.1: it asserts `listTours` was called, but S10 ships a stub that never calls it

**What is wrong.** RED #6 (new `ToursPage.walks.test.tsx`) clicks the All tab and
asserts "the counts still do not grow and `listTours` was called". The same
task's GREEN makes `AllToursView` a stub `<section aria-label="All tours" />`
that issues no request; the real view (and the call) arrives in S12.

**Evidence.** plan 1949-1959 (assertion, line 1957) vs plan 1999-2001 (stub).
Ground rule 0 (plan 12-16): every task goes RED -> GREEN -> commit.

**What it implies.** A literal builder is stuck at S10 (GREEN impossible) or
silently drops the assertion. Fix: assert at S10 that the stub/probe region
mounted and the walk counts did not grow; move "`listTours` was called" to
S12 (or re-run the file there).

## F4 [MEDIUM] The return restore loads its first page at `limit=50` and allows 1 + 10 requests, against spec 4.9; Task 12.4's own RED is written to the spec and contradicts the S11 hook

**What is wrong.** Spec 4.9 and P5 say a return restore loads `limit=100` pages
until it holds `depth` rows, the list ends, or 10 requests have run. The
plan's hook always loads the first page at `FIRST_PAGE_LIMIT` (50) and counts
only restore-mode requests toward the cap, so a restore is 1 x 50 + up to
10 x 100. Task 12.4 RED #2 says "the view requests `limit: 100` pages until it
holds >= 120 rows (at most 10 requests)" and RED #4 ("11 pages needed, cap
10") assumes 100-row pages from the start.

**Evidence.** plan 2255 (`listTours(params, { limit: FIRST_PAGE_LIMIT }, ...)`
for every first page), plan 2270-2271 and 2292 (restore at
`BIG_PAGE_LIMIT`, cap counts `restoreRequests` only), plan 2687-2697 (12.4
RED #2/#4); spec 4.9 lines 449-453, P5 line 82.

**What it implies.** Either the S12 tests fail against the S11 hook, or the
builder edits whichever side is more convenient - the plan does not say which
contract wins, and the handback's "planner calls that narrowed the spec"
(plan 2990-2993) does not list this. Decide one rule (e.g. the first page of a
restore asks for 100 and counts toward the cap) and make S11 RED #9 and S12.4
RED #2/#4 state it identically.

## F5 [MEDIUM] e2e Task 13.1 does not say where the five tours are created, while `afterEach` decides every created tour; the cited helper does not do what the plan says

**What is wrong.** "Tours to create" is a file-level list (plan 2781-2793) with
no statement that EACH test creates its own set; `afterEach` decides everything
in `created` (plan 2774-2780). A builder who creates them once (a `beforeAll`
with `browser`, or in test 1/2 only) gets tests 2-5 running against tours that
are already `toured` + not_a_fit (requests no longer requested, the no-show no
longer a no-show). Also: the plan cites `decide` / `decideQuietly` at
`today-past-tours.spec.ts:203-229`, but that file has 202 lines - the helpers
are at `:70-76` and `:84-90`; and that `decide` PATCHes ANY non-toured status to
`toured` (`today-past-tours.spec.ts:70-76`), so "copy it" contradicts "a canceled
tour is left canceled" (plan 2778). Separately, spec 9 (lines 803-805) asks for
a spec that "creates its own uniquely named tenant contact and property through
the API"; the plan silently substitutes the lean seed's Tasha plus a per-file
reseed (plan 2766-2771, 2800-2801) without recording the deviation.

**What it implies.** At least one wasted full-suite cycle (~18 min per AGENTS.md)
to discover the fixture placement; the deviation from spec 9 is defensible
under `workers: 1` + reseed but must be stated (handback's planner-calls list,
plan 2990-2993). Fix: say "each test that needs them creates its own five in
the test body", give the correct helper lines, and say the canceled tour is
skipped by the copied `decide`.

## F6 [LOW] Spec 9 dashboard cases the plan never schedules

Beyond F1's missing "a filter change dropping the record": the restore through
a RELOAD and on an EMPTY list (spec 791-797), and "a search typed while the
first page loads walks on after it lands" (spec 775-776), appear in no S11/S12
RED list (plan 2035-2076, 2435-2487, 2528-2548, 2681-2702). Spec 9's DynamoDB
Local integration list (spec 746-752) asks for "undated rows come after dated
ones in both directions"; Task 6.2 walks latest-first only (plan 1229-1233).
Add them or record the narrowing.

## F7 [LOW] The `exhaustive-deps` suppression the plan mandates is unused

Linting the plan's `useAllTours` verbatim (plan 2081-2399) reports
"Unused eslint-disable directive (no problems were reported from
'react-hooks/exhaustive-deps')" at the comment of plan 2317-2318. The builder
note (plan 2404-2408) asserts it is needed. Warning-level only (exit 0), but it
adds noise to gate 5's output; drop the directive and its comment.

## F8 [LOW] P15's "`fireEvent.click` returned `false`" assertion cannot fail

react-router's Link calls `event.preventDefault()` for EVERY unmodified primary
click before navigating (`node_modules/react-router/dist/development/chunk-4ZMWKKQ3.mjs:10552-10557, 10794-10795`),
so the click returns `false` with or without P15. The location assertion in
the same case (plan 1940-1944) is the real RED; say so, or drop the return-value
check so nobody reads it as proof.

## F9 [LOW] Two definitions of the client API-params type

Task 9.1 says `tourListSelection.ts` uses `export type TourListApiParams =
TourListParams;` "so the client has ONE shape" (plan 1645-1647); Task 9.2's
GREEN declares a separate `export interface TourListApiParams` (plan
1869-1876). Structurally compatible, but the plan contradicts itself.

## F10 [LOW] The request log line omits "items evaluated"

Spec 5.7 (lines 640-641): counts of rows returned, ITEMS EVALUATED, Query calls,
phases touched. The plan logs `returned`, `calls`, `phases`, `when`
(plan 1410-1413); `queryListPhase` never surfaces `ScannedCount`
(plan 914-917), so evaluated items cannot be logged as written.

## F11 [LOW] Restart allowance is keyed by the filter string, not by the list

`restartUsedFor` stores the `listKey` string (plan 2229, 2237-2245) and is reset
only by `startOver`. After filters A -> B -> A, the new A list inherits A's spent
allowance, so its first cursor 400 goes straight to "We couldn't load more
tours." Spec 4.5 (lines 387-388): "a filter change starts a new list". S11 RED
#10 ("a new `listKey` resets the one-restart allowance", plan 2071) passes for
A -> B and misses the round trip.

## F12 [LOW] A filter change within 300 ms of typing does not walk immediately

Spec 6 (lines 651-656): the walk starts "immediately when a NEW list starts
while the search is non-empty". The plan's `walk` follows the debounced `walkQ`
(plan 2599-2604) and `change()` does not flush it, so that new list walks only
when the old timer fires.

## F13 [LOW] Wording/count inconsistencies a literal builder will copy

- Task 14.2 resolves `undated-tour-wording.md` with "six readers" (plan 2914);
  S8 switches eight (plan 1432-1437).
- Task 12.1's count-line rules (plan 2512-2520) do not say where "The list was
  refreshed.", "We couldn't load more tours." or the loading state render, and
  `refreshed` stays true for the rest of that `listKey` (plan 2379), so the
  notice can outlive the restart indefinitely.
- S15 self-QA "open the ~70th row, mark it toured ... focus lands on the row now
  in that position" (plan 2979-2981): under the default All filters a toured
  tour STAYS in the list, so focus lands on the same row. The step needs a
  status filter (e.g. the Scheduled chip) to exercise the "row left the list"
  branch.
