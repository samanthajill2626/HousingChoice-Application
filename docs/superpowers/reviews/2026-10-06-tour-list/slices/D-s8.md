# Slice D report - S8 (+ ruling D-1) (implementer D)

Implementer: Claude Opus 5.5, 2026-10-06 (about 18:07-18:25 EDT). Worktree
`W:\tmp\tour-list`, branch `feat/tour-list`, started at HEAD 44796c08, ended at
e9e6229a (plus this report's commit). Inputs: plan v3 sections 0, 1 and S8;
`build-research/dashboard-worklist.md` (facts, Task 8.1 items 1-8, the
invariant sweep, gap G1); `build-research/e2e-docs-worklist.md` section 8.1
(C1-C3); `build-research/README.md` rulings D-1, D-2, E-1; spec D8, D10, P7,
P12 and section 8 ("Labels").

Both tasks ran strict TDD: tests written, run RED and read for the stated
reason, implementation, run GREEN, typecheck, commit. No `npm test`, no
`npm run smoke`, no e2e or Playwright run (S13/S15 run the e2e edits).

## Commits

| task | commit | message |
|---|---|---|
| 8.1 | 68b94b20 | feat(dashboard): one undated wording - Needs booking / Undated |
| D-1 | e9e6229a | fix(dashboard): only a requested tour sorts first on the property page's Tours card |

## Task 8.1 - `undatedTourLabel` and its eight readers

- Helper: `dashboard/src/api/types.ts`, right after `tourStatusLabel` (D-2),
  the plan's code and docblock verbatim. No barrel edit (worklist item 3: the
  barrel is `export *`).
- Readers switched (eight): `TourDetail.tsx:313` (facts line; `:784` Schedule
  card reuses `whenText`), `TenantFile.tsx:338`, `LandlordFile.tsx:218`,
  `ListingDetail.tsx:1085`, `ToursPage.tsx:210` (Past row), `ToursPage.tsx:
  133-140` (TourRow `'date'` display: an undefined `scheduledAt` now reads
  `undatedTourLabel(tour)`; `'time'` / `'none'` and dated rows unchanged; the
  TourRowProps docblock says so), `Today.tsx:216` (output unchanged).
  Comment: `TourModals.tsx:203` -> "Undated". Line numbers are post-change.
- Imports: added to SIX api import blocks - TourDetail, TenantFile,
  LandlordFile, ListingDetail (the SECOND block, beside `tourStatusLabel` -
  item 2), ToursPage and Today (item 1).

RED evidence (one run of the six files: 15 failed / 317 passed):

- `types.test.ts` (6 of 34 red): `TypeError: (0 , undatedTourLabel) is not a
  function` - the helper did not exist.
- `TourDetail.test.tsx` (2 of 120 red): the facts line rendered "Not booked -
  Self-guided - Ann Tenant -> 123 Main St, Atlanta, GA" for both the request
  and the undated TOURED tour.
- `files.test.tsx` (4 of 37 red): link text "1450 Joseph Blvd, Atlanta, GA -
  Not bookedRequested" / "... - Not bookedToured - needs outcome" (tenant and
  landlord blocks).
- `ListingDetail.test.tsx` (2 of 68 red): link names "Fixture Tenant Not
  booked Requested" / "Fixture Tenant Not booked Toured - needs outcome".
- `ToursPage.test.tsx` (1 of 45 red): the undated canceled Closed row's
  `.time` span was EMPTY (the DOM dump shows `<span class="_time_..."/>`).
  The Past "Undated" PIN (RED 5) was green.
- `Today.test.tsx` (0 of 28 red): the "Undated" PIN (RED 7) was green.

GREEN (same six files): types.test.ts 34/34, TourDetail.test.tsx 120/120,
files.test.tsx 37/37, ListingDetail.test.tsx 68/68, ToursPage.test.tsx 45/45,
Today.test.tsx 28/28 (332/332).

Tests added or moved (the worklist's item-6 traps honored):

- `types.test.ts`: new `describe('undatedTourLabel')` - requested -> "Needs
  booking"; `it.each` over scheduled, toured, no_show, canceled, closed ->
  "Undated".
- `TourDetail.test.tsx`: the requested case asserts `/Needs booking -
  Self-guided/` (comment moved) and ALSO the Schedule card's exact "Needs
  booking"; NEW case for `status: 'toured', scheduledAt: undefined` (explicit,
  trap 6c): facts line `/^Undated - Self-guided - /`, Schedule card exact
  "Undated", no "Needs booking" anywhere.
- `files.test.tsx`: both requested titles rewritten as ASCII ("Needs booking"
  - never "Invalid Date"), regexes moved; NEW undated-toured case in each
  block (`... - Undated`, never "Needs booking").
- `ListingDetail.test.tsx`: regex and comment moved; a NEW `it` (trap 6b) for
  an undated toured row: `/Fixture Tenant.*Undated.*Toured/s`.
- `ToursPage.test.tsx`: a NEW `it` (trap 6a - the existing Closed test keeps
  its `toHaveLength(3)`) with a dated closed row and an undated canceled row
  (`TOUR_CANCELED_UNDATED`, k3): the dated row keeps "Jul 14, 2026" and no
  "Undated"; the undated row reads "Undated", then "Canceled", then "PM team",
  never "Needs booking".

E2E text edits (no run): `tours-page.spec.ts:238-239` (rewritten, "Needs
booking" on one line, line count kept), `:242`, `:479` ("(requested, needs
booking)" - E-1); `steps.ts:1147`, `:1168-1169` ("<unit> - Needs booking",
the U+00B7 gone), `:1176`, `:1853` (C1: "Requested + Needs booking - ..."),
`:1854`, `:1856`; `tours.spec.ts:417`. The non-ASCII neighbours
(`steps.ts:1143, 1148`, `tours-page.spec.ts:237, 244`) are untouched.

## Ruling D-1 - `sortToursForPanel`

- Test first, `useListing.test.tsx` (extends the existing sort test's
  neighbourhood; the old case kept): five tours in a mixed order - an undated
  toured, a dated toured, an undated canceled, a request, a dated scheduled.
- RED (1 of 9): received `[undated-toured, undated-canceled, request, new,
  old]` - every undated tour sorted above the request and the dated history.
- Fix (`useListing.ts:85-100`): a group rank - 0 an unbooked request, 1 dated
  (newest first, the unchanged comparison), 2 any other undated tour - and
  `0` within groups 0 and 2 (the stable sort keeps input order, as before for
  undated pairs). A consistent total preorder. The docblock is rewritten in
  ASCII (its old line 86 carried a U+2014) and states the rule.
- GREEN: useListing.test.tsx 9/9, ListingDetail.test.tsx 68/68.

## Final checks (on the committed tree, e9e6229a)

- `cd "W:/tmp/tour-list"; git grep -n -i "not booked" -- dashboard/src e2e
  app/src` - prints NOTHING (exit 1).
- `git grep -n -i -E "not$" -- e2e/scenarios/steps.ts
  e2e/tests/dashboard-next/tours-page.spec.ts` - 4 hits, all pre-existing
  prose (`steps.ts:320, 3648, 3814, 3895`); none of their next lines starts
  with "booked". A wider multiline search (`not\s*\n\s*(//|\*)?\s*booked`,
  case-insensitive, over dashboard/src, e2e, app/src) finds nothing, and no
  touched line ends in "Needs" (no new split of the new phrase).
- ASCII: `git diff -U0 | grep '^+' | grep -v '^+++' | tr -d
  '\11\12\15\40-\176' | wc -c` printed 0 before each commit. The only removed
  non-ASCII lines are the intended ones: the two old files.test.tsx titles,
  `steps.ts:1168` and `useListing.ts:86`.
- `npm run typecheck`: exit 0 before each commit (it compiles e2e too).
- Extra safety net (not a gate): the whole dashboard vitest suite (`cd
  dashboard; npx vitest run`, jsdom only) - 215 files, 3750/3750 before
  commit 1 and 3751/3751 on the final HEAD.

## Lint (gate 5 by baseline)

`npx eslint` on all 19 dashboard and e2e files this slice touches or pins,
run at 44796c08 BEFORE any edit and again after: identical - 6 errors and 2
warnings, all pre-existing, only shifted by the new import lines:

- `TenantFile.tsx:15` (now :16) no-unused-vars `FieldSource`.
- `TourDetail.tsx:327` (now :328) react-hooks/purity `Date.now()`.
- `useListing.test.tsx:4` no-unused-vars `PlacementsPage` and `UnitsPage`
  (NOT in the brief's baseline list - pre-existing all the same).
- `e2e/tests/dashboard-next/tours-page.spec.ts:27` `UNIT_A_ADDRESS` and
  `:269` `todayLinkForRequestedTour` no-unused-vars (also pre-existing).
- `e2e/tests/scenarios/tours.spec.ts:57, 61` warnings: unused
  eslint-disable directives.

No new error or warning. None fixed here (not this slice's change).

## Divergences from the plan / worklists, and why

1. Final grep is the case-insensitive one (E-1), and the lowercase prose at
   `steps.ts:1853` and `tours-page.spec.ts:479` was rewritten (C1, C2), not
   left as the dashboard worklist's item 7 recommended - the brief and ruling
   E-1 decide it.
2. My first draft of the new negative assertions read `/Needs booking|Not
   booked/`; the E-1 grep caught them. Narrowed to `/Needs booking/` - the
   positive "Undated" match already rules the old word out.
3. The requested tour-page case also pins the Schedule card's exact "Needs
   booking" (the plan asserts only the facts line); spec 9 lists the Schedule
   card for BOTH a request and an undated toured tour.
4. TourRow's undated test is `tour.scheduledAt !== undefined` (as the plan
   words it and as the four list readers do), not the Past row's
   `typeof === 'string' && length > 0`. An empty-string `scheduledAt` (never
   written by the app) would still show a blank on the Closed tab.
5. D-1 placement of the non-request undated tours: the ruling says only that
   they must not sort first and that dated tours keep the date order; they
   now read LAST, after every dated tour (the pin's "does not sort above a
   dated one"), matching the All tab's undated-after-dated rule (spec P6). A
   requested tour that somehow carries a date (I1 broken, seeds only) keeps
   its date position, exactly as before - "dated tours keep the existing
   date order".
6. Line counts: the rewritten e2e comments keep each file's line count, so
   later citations into `tours-page.spec.ts` and `steps.ts` do not shift.
   The six new import lines DO shift lines +1 below them (worklist G6 - the
   perf-ledger refresh in S13 already owns that).

## Not done / open

- Nothing in the S8 scope is left. Not run by design: `npm test`,
  `npm run smoke`, `npm run e2e`; the S8 step edits (`steps.ts:1176`, `:1856`,
  called from 20 sites) first execute in S13's lane run (e2e worklist R1).
- No surface outside the plan's eight was found showing a missing tour date
  (a re-sweep of every non-test `scheduledAt` reader in dashboard/src agreed
  with the worklist's invariant table).
