# Handback - Tours page All tab (feat/tour-list, Sam #18 final part)

Orchestrator: build (Fable 5.1), 2026-10-06, one sitting (about 6.5 h wall
clock: research 30 min, build 2 h 50 min across 9 children, gates + three
review rounds + three fix waves 2 h, self-QA 45 min, sync + final battery).
Zero recoveries, zero cold-dispatch misfires, no QUESTION raised: every
spec-vs-tree call was a both-readings-honor-intent decision, recorded.

## MERGE VERDICT

MERGE-READY @5441b090 on feat/tour-list (W:\tmp\tour-list), 0 behind main
(@a5eabcb3, synced once at acb2f832 with zero conflicts), UNMERGED (human
gate). The code-final commit is acb2f832; 5441b090 adds only the self-QA
record, and this handback's commit follows it (docs only).

NO infra / post-merge ops: no new index, no Terraform, no migration, no
secret, no feature switch. It rides the next deploy with #1 (properties
available view) and the auto-close backlog run - Cameron's call. Nothing is
BROKEN until anything is applied.

## Gates (bare, from the worktree, real exit codes)

On acb2f832 (code-final, synced):

1. `npm run typecheck` - exit 0.
2. `npm test` - exit 0: app 410 files / 8370 passed + 1 skipped (the
   by-design "built dashboard identity tags - PASS or SKIP, never FAIL"
   diagnostic, no built dashboard present); dashboard 220 files / 3898
   passed; e2e workspace 22 files / 503; fake-twilio 34 / 275;
   fake-twilio-web 13 / 111. Zero `[dynamoAdmin]` lines.
3. `npm run smoke` - exit 0: "smoke-dist: OK - 1556 import specifier(s)
   across 272 emitted file(s) resolve under plain Node."
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- ...)`
   over the branch's 53 lintable files - exit 1 as expected, and by baseline
   comparison (same paths at the merge base through `--stdin`, `-f json`,
   normalized to file|rule|message) 13 rows on the branch = 13 rows at the
   base, ZERO new, zero fixed. The 13 pre-existing: `app/src/lib/seed/cast.ts`
   no-unused-vars x4 (CP, UNIT_SEARCHING_A, listingSendId, poolNum);
   `seed/matrix.ts` DEADLINE_TYPES; `dashboard/.../TenantFile.tsx` FieldSource;
   `useListing.test.tsx` PlacementsPage, UnitsPage; `TourDetail.tsx`
   react-hooks/purity (Date.now in render); `e2e/.../tours-page.spec.ts`
   UNIT_A_ADDRESS, todayLinkForRequestedTour; `tours.spec.ts` two unused
   eslint-disable warnings. The 17 files new on the branch are clean.

On 5441b090 (acb2f832 + the self-QA record):

4. `npm run e2e` (under `timeout 2700`, output to a file) - exit 0:
   "315 passed (17.8m)"; `e2e/.artifacts/results.json` stats expected 315,
   unexpected 0, flaky 0, skipped 0 (315 = the 314 of the pre-review run
   plus main's new `stream-hidden-label-overflow.spec.ts`). The 5
   `tours-all.spec.ts` tests, the 4 regression specs of the S8 edits
   (tours-page, tours-past, scenarios/tours, sending-unit) all green.

Earlier full runs, for the record: at 38695b70 (pre-review build) e2e exit 0,
314 passed, 17.2 min, 0 flaky; `npm test` exit 0 at 38695b70 and again at
b459de9f after fix wave 1 (identical counts). No gate flaked at any point.

## Work map (plan section 2)

| item | verdict |
|---|---|
| S1 range read + Today warning | SHIPPED (17f07803, cb0bee40): `listByScheduledRange` walks every page through `queryAll` with a test-only `pageLimit`; Today's `warnIfCapped('tours_today')` removed |
| S2 seeds | SHIPPED (fa24547b): four unstamped rows stamped, the matrix assertion inverted, pure pin + seedLive pin; fix wave 1 added the performance world to the pin (SC-1) |
| S3 `unitsRepo.getDisplaysByIds` | SHIPPED (37b84a3a) - DEVIATED by ruling A-1: placed right after `getById` (not at the end) because feat/clean-org-names inserts its own method at the end of the same three blocks |
| S4 query model | SHIPPED (276c29b3, e5825a6d, ca4c50dc); fix waves added the strict ISO bound parser (SC-2, R2-1, R3-1) and the cursor-key cap + well-formedness (AD-4) |
| S5 phase read + shared fake | SHIPPED (28070f6e, 2e6838a0) - DEVIATED by A-2 (the harness line and the fake land with 5.1 so typecheck never goes red) and A-3 (the fake's tie guard, a plain Error). DynamoDB Local DOES reject out-of-range start keys (name ValidationException; message "The provided starting key does not match the range key predicate", differs from the plan's quote; nothing matches on the text) |
| S6 paging engine | SHIPPED (b52329a3, afbe5d3b) - DEVIATED by A-7: `MAX_QUERY_CALLS` 6, not 5 (below) |
| S7 route | SHIPPED (db467e66) - DEVIATED by A-5 (the log line's allowed keys include the request context) and AD-1 (a 400 only for the client's own start key; spec 5.5 amended in place) |
| S8 undated wording | SHIPPED (68b94b20): `undatedTourLabel` + ten readers (the spec's eight plus Today and the Closed column); "Not booked" gone from app/, dashboard/, e2e/, documentation/ (case-insensitive grep empty). Plus ruling D-1 (e9e6229a): `sortToursForPanel` sorts only a REQUEST first; other undated tours read last |
| S9 api + selection | SHIPPED (58ef2203, b539e140) - D-2: the types sit after the existing tour types; the restore record pulled forward into 9.2 |
| S10 tabs + split | SHIPPED (8923503d) - D-5: the CURRENT All tab's href carries the committed search; E-2: `routes.test.ts:381` kept verbatim with a new line below |
| S11 `useAllTours` | SHIPPED (811c8cf0) - D-7: the 50-request walk cap is per WALK (resets when the search is cleared and typed again); O1 fixed in S12 (`refreshed` never true once `dead`) |
| S12 view | SHIPPED (8644f0dd, 17eeca43, 7488752b, 74dd836a) - D-4 (container query), D-6 (the status region stays mounted, empty while loading), D-9 (first-page failure in `role="alert"`); fix waves: Search between Tour type and Sort (SC-3), the range message in the list area (SC-4) and announced (R2-2) |
| S13 e2e + perf | SHIPPED (df99e178, 5441882d): `tours-all.spec.ts` 5 tests (passed twice on a lane, then in both full runs); the ledger refreshed beyond the plan's list; a selectors.md row; the viewport assertion made discriminating at 240 px (R2-3, mutant-proven on a lane) |
| S14 docs + issues | SHIPPED (dd3765ab, f603ff89): GLOSSARY entry; `tours-scheduled-range-query-unpaginated` and `undated-tour-wording` RESOLVED; `perf-pages-tours-past-surface` widened; issues filed (below) |
| S15 | DONE: one main sync (acb2f832), the five gates, live self-QA (`self-qa.md`), this handback |

Nothing skipped.

## Planner calls that narrowed the spec's wording (plan S15 step 4)

- 5.4's budget constants are injected into the engine, not the router (the
  route uses the defaults; no dead production seam).
- An automatic follow request in flight when a search starts is aborted and
  re-requested from the same cursor as a walk page (one automatic effect).
- Two extra undated surfaces read the helper: Today's past-tours row and
  the Closed tab's date column (both inside D8's "everywhere").
- A return restore loads the usual 50-row first page then up to 10 restore
  pages of 100; no follow after a capped restore; the cursor-400 restart
  ends it (spec 4.9 amended at plan review).
- The e2e spec uses the lean seed's tenant with a per-file reseed instead
  of a uniquely named tenant (spec 9 amended at plan review).

## Build rulings (orchestrator; all recorded in build-research/README.md and the review adjudications; all reversible)

- A-7 `MAX_QUERY_CALLS` = 6, one per possible phase. The plan's 5 made every
  default first page over a SMALL table (fewer than 50 rows under Any time /
  every status) spend its budget before the closed phase and answer a
  cursor - a phantom Load more over an empty table. Spec 5.4 and the plan
  amended in place; engine test 14 pins one-request completion. Found by
  slice C's open point, not by a review.
- D-1 `sortToursForPanel` (property page Tours card): only a requested tour
  sorts first; dated tours keep their newest-first order; any other undated
  tour reads last (P6's rule). A reader of invariant I1 that spec section 8
  missed; without it an "Undated" toured tour sat among the requests.
- D-5 the current All tab links to `/tours/all` + the committed search, so a
  Ctrl/Cmd/middle click opens the same filtered list (P15 still swallows the
  unmodified click).
- D-6 the count line's `role="status"` element stays mounted and empty while
  a first page loads (a region inserted with its text is not announced).
- D-7 the search-walk cap is per walk, not per list.
- D-9 the All view's first-page failure renders inside `role="alert"`.
- AD-1 a DynamoDB ValidationException is a 400 `invalid cursor` ONLY from the
  page's first Query while it carried the cursor's key; everything else is a
  500 with the app's error log (spec 5.5 amended).
- REJECTED AD-3 (PATCH stamping `_schedPartition`): the design review's R1-2
  ruling stands (create stamps every tour; tours are never imported; seeds
  were the only gap and S2 fixed them); the plan-blind reviewer re-derived
  it independently - noted for Cameron.

## Review rounds and resolutions

- r1 spec-conformance (opus): 109 items - 83 CONFORMS, 19 DEVIATES-RULED,
  5 PARTIAL, 2 DEVIATES-UNRULED, 0 MISSING; SC-1 MEDIUM (seed pin omits the
  performance world - FIXED; r2 showed gate 1 already caught it, so LOW),
  SC-2..SC-6 LOW (all FIXED: strict ISO bounds, the Search position, the
  range message in the list area, a route-level range case, two DynamoDB
  Local walks) + two coverage gaps FIXED (sort change while searching; the
  restored row in the viewport).
- r1 adversarial, plan-blind (opus): 0 HIGH, 0 MEDIUM; AD-1 LOW FIXED;
  AD-2 LOW FILED (`tours-date-range-reads-unbounded-span`); AD-3 LOW
  REJECTED (harness-fake half FILED: `harness-date-range-fake-ignores-sched-partition`);
  AD-4 PLAUSIBLE - the cheap half FIXED (keys capped at 1024 bytes, well-
  formed), the hosted-dev probe is Cameron's; AD-5 PLAUSIBLE FILED
  (`tour-list-restore-anchor-trackpad-swipe`).
- r2 fresh re-review of fix wave 1: 0 HIGH/MEDIUM, 4 LOW - R2-1 (the ISO
  regex rejected legal 6-digit fractions and admitted Feb 30) FIXED, R2-2
  (the range message unannounced) FIXED, R2-3 (viewport assertion could not
  fail) FIXED at 240 px, R2-4 (spec drift) FIXED; SC-1's severity corrected;
  all other fixes confirmed real by the reviewer's own mutants.
- r3 fresh review of fix wave 2: 0 HIGH/MEDIUM, 3 LOW - R3-1 (a year-9999
  bound canonicalizes to an extended year and inverts the range; reachable
  from the dashboard's To picker) FIXED both halves, R3-2 / R3-3 (unpinned
  field checks, a lone low surrogate) FIXED as tests; every fix confirmed
  real (a 234,080-input parser comparison; 22,620 strings against
  `isWellFormed`). Fix wave 3 verified by the orchestrator (diff read; app
  269/269; tours dir 541/541).

Review records: `code-review/r1-spec-conformance.md`, `r1-adversarial.md`,
`r1-adjudications.md`, `fix-wave-1.md`, `r2-re-review.md`,
`r2-adjudications.md`, `fix-wave-2.md`, `r3-review.md`, `r3-adjudications.md`,
`fix-wave-3.md`.

## Self-QA (`self-qa.md`; screenshots under .playwright-mcp/selfqa-0*.png, gitignored)

Hermetic lane 7 at acb2f832 with 76 API-seeded tours; 12 scenarios, every
check a measured DOM or network fact: tab order and `/tours` landing on
Active; Load more to "76 tours" with the undated rows last; Upcoming earliest
first with the canceled future row and the Needs booking chip hidden; Past
latest first; the Needs booking chip alone = the 4 requests; Past + No show;
type filter; a date range whose To day's 3:00 PM tour is IN (the request
carries the To day's local end); From after To (one alert, both inputs
aria-invalid + described, zero requests); the search walk ("24 matches so
far - not the whole list" -> "Searching..." -> "37 matches", one limit=100
page); 360 / 480 / 768 px with zero horizontal overflow and full-width
stacked controls; the back-arrow return after closing the opened tour
(page 1 + one restore page, focus on the row now at the opened index, in
view); the browser's Back at 1280 and 360 (remount, page 1 + one restore
page, the opened row focused flush at the pane bottom) and a reload of that
entry; a filter change after a return sends ONE page; the undated wording on
the tour page, the tenant file, the Closed tab and the Past tab; P15 and
D-5. Observations, not defects: StrictMode doubles the first-page request in
dev lanes (the first aborted); the 300 ms debounce briefly shows "N matches
so far - not the whole list" before "Searching...".

## Files, commits, delta

- 82 commits since the base d839494a: 26 mission records, 45 code / test /
  docs commits (listed in `git log --reverse d839494a..HEAD`), the spec and
  plan commits, and the one merge of main (acb2f832).
- Feature files touched (records excluded, main's five merged files
  excluded): 73 - app 8 source + 13 tests, dashboard 25 (new:
  `tourListQuery.ts`, `tourListPage.ts`, `tourListIndexFake.ts`,
  `tourListSelection.ts`, `useAllTours.ts`, `AllToursView.tsx` + css, 10
  new test files), e2e 7 (new `tours-all.spec.ts`), docs 20 (spec, plan,
  GLOSSARY, sequence-diagram doc, 14 issue files, e2e README, selectors.md).
- Net delta vs the base, records excluded and main's merged 149/4 lines
  removed: about +13,800 / -148 lines (tests are the bulk: the hook, view,
  engine, query, repo and route suites).

## Issues

- RESOLVED: `tours-scheduled-range-query-unpaginated`, `undated-tour-wording`.
- WIDENED: `perf-pages-tours-past-surface` (now `/tours/past` and `/tours/all`).
- FILED (all low): `tours-closed-tab-loads-every-tour`,
  `tours-tabs-load-every-contact-for-names`, `tours-all-server-side-search`,
  `tours-all-live-updates` (spec 10's deferrals), `error-handler-logs-router-relative-path`
  (debt: the 500 log label is router-relative, every router),
  `tours-date-range-reads-unbounded-span` (debt: the paged range read on
  client-supplied windows; from > to on `/api/tours` is a pre-existing 500),
  `harness-date-range-fake-ignores-sched-partition` (debt),
  `tour-list-restore-anchor-trackpad-swipe` (bug, PLAUSIBLE, needs a macOS
  trace). `tour-no-show-without-date` stays open (spec 10).

## Known flakes

None met. No gate flaked; the two full e2e runs passed 314/314 with 0 flaky.

## Open questions and "your eye" items for Cameron

1. Keep rulings D-1, D-5, D-7 and A-7? Each is one line to reverse.
2. AD-4: one probe against hosted dev with an oversized / ill-formed crafted
   cursor key, recording `err.name` - the route now refuses such keys before
   DynamoDB sees them, so this is belt-and-braces.
3. AD-5: whether a macOS trackpad swipe-back cancels the return anchor
   (issue filed with the trace to take).
4. The plan-blind reviewer re-proposed PATCH stamping `_schedPartition`
   (the design review's rejected R1-2); the rejection stands on evidence,
   but it is now the second independent eye to ask.
5. Minor UX notes: during the 300 ms search debounce an incomplete list
   reads "N matches so far - not the whole list" before "Searching..."; after
   a capped empty-page follow with zero rows the count line reads "Showing 0
   tours" beside the Keep checking message (D-8, spec-consistent); Keep
   checking is one request plus up to ten more follows before the cap shows
   again (plan case 6).
6. Housekeeping: `app/src/lib/tourListQuery.ts` no longer carries the
   `/// <reference lib="es2024.string" />` directive (replaced by a
   `\p{Surrogate}` regex); `app/test/tourListQuery.test.ts` is the repo's
   first use of `expect.soft` (so one mutant can show every row red).
7. Lint baseline: the 13 pre-existing rows above are untouched on purpose.

## Tracker #18 note (neutral third person, for Cameron to paste)

The Tours page now has an All tab, listed first, that shows every tour -
upcoming and past - filtered and paged by the server (When, status chips,
tour type, a tenant/property search and a sort), with Load more past 50 rows
and a return that puts the staff member back on the row they opened; the
Active tab still opens by default. Unbooked requests are listed by pressing
the Needs booking chip under Any time, and a tour without a date now reads
"Needs booking" (a request) or "Undated" (any other) everywhere - the tour
page, the tenant, landlord and property files, and every tours list. It goes
live with the next deploy.

## Post-merge

NO infra/post-merge ops. Worktree `W:\tmp\tour-list` and branch
`feat/tour-list` are left at their final commit for Cameron's cleanup go.
Run state (ledger, heartbeat, gate logs, diff packages) is under
`W:\tmp\tour-list\.superpowers\` and dies with the worktree.
