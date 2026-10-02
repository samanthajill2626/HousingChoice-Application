# Code review r1 - spec conformance

Branch `feat/properties-available-view` @ddeb6b58 (base main @ae04122d), worktree
`W:\tmp\properties-available-view`. Contract: the design note
`docs/superpowers/specs/2026-10-01-properties-available-view-design.md` (sections 2-6),
with the plan `docs/superpowers/plans/2026-10-01-properties-available-view.md` for the
intended layout and test list. Reviewer: conformance check (Opus), read-only.

Question: does the code deliver EVERY decision in the design note, exactly, and does
anything contradict or exceed it?

## What was run

- Read in full: `ListingsList.tsx`, `PropertySummary.tsx` (+ CSS module),
  `propertyFacets.ts`, `ListingsList.test.tsx`, `propertyFacets.test.ts`,
  `tenantFacets.ts`, `listingFormat.ts`, the e2e spec, and the diffs of
  `e2e/performance/routes.ts`, `e2e/support/selectors.md` and both issue docs. Main's
  `ListingsList.tsx` was read for the "unchanged" claims.
- `npx vitest run src/routes/listings src/routes/contacts/tenantFacets.test.ts
  src/routes/listing/listingFormat.test.ts` (dashboard): 5 files, 130 tests, green.
- `npx eslint` on `ListingsList.tsx`, `PropertySummary.tsx`, `propertyFacets.ts`: exit 0
  (the render-time search resync passes the react-hooks rules).
- 12 throwaway probe tests under `dashboard/src/routes/listings/__probe_conf__/`, all
  green, directory deleted afterwards. What each proved is in the "Probe log" below.
- NOT run (out of bounds for this review): `npm run e2e`, `npm test`, `npm run typecheck`,
  `npm run smoke`, `npm run perf:pages`. Every runtime claim about the e2e spec or the
  perf profiler below is code-traced and marked UNVERIFIED where it matters.

## Conformance table

Paths: `LL` = `dashboard/src/routes/listings/ListingsList.tsx`, `PS` =
`dashboard/src/routes/listings/PropertySummary.tsx`, `PF` =
`dashboard/src/routes/listings/propertyFacets.ts`, `LLT` = `ListingsList.test.tsx`, `PFT` =
`propertyFacets.test.ts` (same directory), `TF` =
`dashboard/src/routes/contacts/tenantFacets.ts`, `LF` =
`dashboard/src/routes/listing/listingFormat.ts`, `SPEC` =
`e2e/tests/dashboard-next/properties-available-view.spec.ts`.

### Section 2 - decisions and planner calls

| # | Design item | Verdict | Evidence | Test that pins it |
|---|---|---|---|---|
| D1 | Summary table at the top of the Active tab, one row per authority, Available and Coming soon counts, each count a link that filters the list | DELIVERED | PS:67-114; LL:178-181, 240; PF:250-278 | LLT:239-260, 278-294; SPEC:109-127 |
| D2 | Coming soon = `setup`; only the summary says "Coming soon (Setup)"; dropdown, row badges, property page keep "Setup" | DELIVERED | PF:30, 236-240; PS:82-84; dropdown labels LL:38-41 from `LISTING_STATUS_LABELS` (dashboard/src/api/types.ts:792-793); badge LL:70 (`statusLabel`); property page not in the diff | LLT:244 (header). Dropdown/badge "Setup" not asserted by a shipped test (probe P10 proves it) |
| D3 | No fallback to bedrooms; no voucher size = "Not recorded" | DELIVERED | LF:82-87 reads `voucher_size_accepted` only; PF:172-189 | PFT:187-190; LLT:375-384 |
| D4 | Filters kept in the address; invisible-lock fixed | DELIVERED | LL:146, 159-176, 185-189, 222-237; PF:62-95, 162-169 | LLT:540-619 |
| D5 | DynamoDB Local not restarted overnight; a blocked gate is reported, not worked around | N/A (process) | Not a property of the code; no gate records exist yet in this records folder | - |
| C1 | Status stays a single dropdown; Active defaults to Available; Deleted defaults to All statuses and has no summary | DELIVERED | LL:248-259; PF:37-39, 69-72; LL:178-181 (summary is null on Deleted) | PFT:43-64; LLT:182-206; SPEC:103-107, 155-159 |
| C2 | All row first (each property once); authority rows sorted case-insensitively; "No authority recorded" last when non-zero; multi-authority property counts under each + one-line note; zero/zero rows hidden; All row always shows; headers "Housing authority" / "Available" / "Coming soon (Setup)" | DELIVERED | PS:68-71 (All prepended unconditionally), 78-84 (headers), 111 (note); PF:146-148 (sort on the normalized, lower-cased key), 255-262 (All once; each distinct key once; no key -> `__none__`), 269-276 (zero/zero dropped; no-authority last) | PFT:229-251; LLT:239-260, 331-339, 514-518 (key order differs from raw-label order, so case-insensitivity is pinned). The "Housing authority" header and the All row at 0/0 are not asserted at component level (probe P7) |
| C3 | Counts follow the voucher filter ONLY - never status, authority or search | DELIVERED | LL:178-181 passes the unfiltered `units` and `selection.voucher` only; PF:250-254 takes no status/ha/q | PFT:243-247; LLT:331-346 (status and authority). Search not asserted (probe P6) |
| C4 | A count sets that column's status and exactly that authority (All clears, no-authority selects Not recorded), keeps voucher, clears search, so the list = what was counted; a zero is plain text | DELIVERED | PF:286-297; LL:191-198; PS:50. Equivalence holds: a non-zero count implies its key is a chip, so the prune keeps it (PF:162-169 vs PF:131-150 use the same non-empty-key test) | PFT:254-268; LLT:262-329; SPEC:116, 120-127 |
| C5 | Six chips from `VOUCHER_BUCKETS` + Not recorded; multi-select, OR; one number or a list, matching any listed size; 4 and up = 4+; no counts on chips | DELIVERED | LL:46-50, 111, 262-268; TF:45-51, 96-100; PF:172-189 | LLT:350-373; PFT:167-186 |
| C6 | Stored spelling on chips and summary; `humanizeAuthority` deleted; no name mapping | DELIVERED | PF:131-150 (`displaySpelling` over raw spellings, no transform), 275 (summary rows reuse the option labels); no code reference to `humanizeAuthority` remains (grep: docs only) | LLT:388-404, 483-522 |
| C7 | Status, authority, voucher, search in the address; Back from a property returns to the same view; Active/Deleted switch starts clean; an off-screen selection never filters | DELIVERED (search via deviation b) | LL:152-176, 222-237; PF:162-169 | LLT:541-619; SPEC:128-132, 143-159 |
| C8 | Rows unchanged; Active subtitle says Available is the default | DELIVERED | LL:59-77 is byte-identical to main's `Row` (main:46-64); LL:215-219 | LLT:171-179, 194-198 |

### Section 3.1 - data

| # | Design item | Verdict | Evidence | Test that pins it |
|---|---|---|---|---|
| 3.1a | All data from the loaded unit list (`useListings`, every page); dashboard-only - no API, repo, seed or data change | DELIVERED | LL:147, 169, 176, 179 all derive from `units`; the diff stat touches no `app/` or seed path (r1-package.txt:8-25) | structural |
| 3.1b | "Available" = `available`, "Coming soon" = `setup` | DELIVERED | PF:236-240 | PFT:229-238 |
| 3.1c | `authoritiesOf` + `normalizeAuthorityKey`; each DISTINCT non-empty key once per unit; no key = no authority recorded | DELIVERED | PF:102-109, 262 | PFT:116-126, 229-238 (a unit listing `DCA` and `dca` counts once) |
| 3.1d | Display spelling via `displaySpelling` over ALL units of the view; a chip and its summary row read the same | DELIVERED | LL:169 builds ONE `authority` object that feeds both the chips (LL:201-203) and the summary (LL:179); PF:146-147, 275 | LLT:514-521 |
| 3.1e | `voucherSizesOf` in `listingFormat.ts`: finite number -> [n]; array -> its finite members; else [] | DELIVERED | LF:82-87 | `dashboard/src/routes/listing/listingFormat.test.ts`:80-99 |
| 3.1f | ONE shared rule `voucherBucketOfSize`, extracted from `voucherBucketOf` (truncate, clamp 0..4, 4 -> 4plus; "a non-finite size has no bucket"); no bucket = Not recorded | CONTRADICTED (note wording only; unreachable) | TF:96-105: the extraction is exact and `voucherBucketOf` delegates, but +Infinity buckets to `4plus` and -Infinity to `0` - only NaN is null. For properties the note's outcome still holds: LF:84 drops non-finite sizes before PF:174 buckets them (probe P8: an Infinity property reads Not recorded) | `contacts/tenantFacets.test.ts`:77-78 pins Infinity -> `4plus`, as plan Task 1 required. See F4 |

### Section 3.2 - address (URL) contract

| # | Design item | Verdict | Evidence | Test that pins it |
|---|---|---|---|---|
| 3.2a | `status`: a `LISTING_STATUSES` value or `all`; absent = view default | DELIVERED | PF:52, 69-72 | PFT:50-64 |
| 3.2b | `ha`: repeated normalized key or `__none__`; absent = no filter | DELIVERED | PF:75-76, 93 | PFT:65-72, 86-98 |
| 3.2c | `voucher`: repeated `0 1 2 3 4plus __none__` | DELIVERED | PF:54-57, 74, 92 | PFT:65-72, 99-108 |
| 3.2d | `q`: the raw search text | DELIVERED | PF:77, 94 | PFT:73-75, 99-108 |
| 3.2e | Parsing: unknown status -> default; unknown voucher values drop one by one; empty `ha`/`q` ignored | DELIVERED | PF:70-77 | PFT:59-72 |
| 3.2f | Writing: every filter change REPLACES the history entry | CONTRADICTED (intentional deviation a - accepted, see below) | Chips, dropdown and search replace: LL:185-189 (called from LL:252, 267, 275, 292). Summary counts PUSH: PS:54-62 renders a `Link` with no `replace`; LL:191-198 | The push is pinned (LLT:296-307). The replace is NOT pinned by any shipped test (probe P11 proves it holds) |
| 3.2g | Writing: default status omitted; empty facets and empty search omitted; unrelated params untouched | DELIVERED | PF:85-95; LL:186 and LL:194 start from the current params (probe P3: a count link keeps `keep=1`) | PFT:78-114 |
| 3.2h | Tabs: the current view's tab keeps the query; the other tab is the bare path | DELIVERED | LL:222-237 (the `to` at LL:230) | LLT:572-582; SPEC:155-157 |
| 3.2i | THE INVARIANT: effective `ha` keeps only keys with a chip (`__none__` only while its chip shows); URL not rewritten on load; the next interaction re-serializes the pruned selection | DELIVERED | PF:162-169; LL:172-175 prunes before both the filter (LL:176) and every write (LL:185-189, 193-198); nothing writes on mount | LLT:587-619. Mutation probe P12: with `pruneSelection` stubbed to identity, LLT:603-619's scenario empties the list - the test pins the prune. "Not rewritten on load" and "re-serialized on the next interaction" are not asserted (probe P1 proves both) |

### Section 3.3 - controls

| # | Design item | Verdict | Evidence | Test that pins it |
|---|---|---|---|---|
| 3.3a | Controls on both tabs once units have loaded and at least one exists | DELIVERED | LL:200, 242 | LLT:164-169, 200-206 |
| 3.3b | Status dropdown: unchanged options; value from the URL | DELIVERED | LL:38-41 equals main:30-33; LL:251 | LLT:182-214, 541-552 |
| 3.3c | Voucher chips (the six of C5); Clear while any is selected | DELIVERED | LL:46-50, 115-124, 262-268 | LLT:350-373 |
| 3.3d | Authority chips: stored spellings; "Not recorded" only when some loaded unit has no authority; Clear | DELIVERED | LL:201-203, 270-276; PF:131-150 | LLT:318-329, 388-404, 524-528 (probe P9: an all-unrecorded view shows only Not recorded) |
| 3.3e | Search: unchanged box; value from `q` | PARTIAL (intentional deviation b - accepted, see below) | Markup unchanged (LL:280-296 vs main:223-236). The value is local text (LL:160) seeded from `q` on mount and re-adopted on every non-REPLACE navigation (LL:161-165); typing writes `q` (LL:290-293) | LLT:218-228, 296-307, 541-552, 554-570, 572-582 |
| 3.3f | AND across status, voucher, authority, search; OR within a facet | DELIVERED | PF:183-215 | PFT:174-216; LLT:350-368, 388-398, 530-537 |

### Section 3.4 - summary table

| # | Design item | Verdict | Evidence | Test that pins it |
|---|---|---|---|---|
| 3.4a | A `<table>` captioned "By housing authority", above the controls; Active only; once at least one unit has loaded | DELIVERED | PS:74-75; LL:240 renders before the controls at LL:242; LL:178-181, 200 | LLT:164-169, 200-206, 239-251; SPEC:111, 159. DOM order (above the controls) is not asserted |
| 3.4b | Rows and columns per C2, counts per C3, links per C4 | DELIVERED | see C2-C4 | see C2-C4 |
| 3.4c | Count accessible names: "Show 12 available properties for X" / "Show 1 coming soon property for DCA" / "... for all authorities" / "... with no housing authority recorded" | DELIVERED | PS:25-35, 51, 59 (the name contains the visible number) | LLT:262-276, 284, 313, 322; SPEC:120, 135 |
| 3.4d | No sideways overflow at 360px; authority names wrap | DELIVERED (runtime UNVERIFIED here) | `PropertySummary.module.css`:13-22 (width 100%), 54-60 (`overflow-wrap: anywhere`), 62-71 (only the count cells refuse to wrap) | SPEC:161-169 (`expectNoHorizontalOverflow`) - not run by this reviewer |

### Section 3.5 - copy

| # | Design item | Verdict | Evidence | Test that pins it |
|---|---|---|---|---|
| 3.5a | Active subtitle: "Available properties by default - change the status filter to see the rest." | DELIVERED | LL:218, byte-exact | LLT:194-198 (prefix regex only) |
| 3.5b | Deleted subtitle unchanged | DELIVERED | LL:217 equals main:152 | not asserted |
| 3.5c | No-match message unchanged | DELIVERED | LL:323-330 renders the same text as main:263-267; the curly quotes moved from literal characters to `&ldquo;`/`&rdquo;` entities (ASCII rule) | LLT:230-235, 383, 536 |

### Section 4 - out of scope (verdict = respected)

| # | Design item | Verdict | Evidence | Test that pins it |
|---|---|---|---|---|
| 4a | No authority name mapping or cleanup; no seed slug normalization or PATCH tombstones | DELIVERED (respected) | No `app/` or seed path in the diff (r1-package.txt:8-25) | - |
| 4b | No voucher-size write path; no property-page display of a list value | DELIVERED (respected) | `UnitItem.voucher_size_accepted` still `number` (dashboard/src/api/types.ts:2287); `voucherSizesOf` is used only at PF:174; no property page or form file in the diff | - |
| 4c | No backend, data, seed or matching change; the Tenants list | DELIVERED (respected) | The only Tenants-module change is the extraction 3.1 orders; `voucherBucketOf` (TF:102-105) delegates to logic identical to main's | `tenantFacets.test.ts` green (39 tests) |

### Section 5 - tests

| # | Design item | Verdict | Evidence | Test that pins it |
|---|---|---|---|---|
| 5a | Unit: pure `propertyFacets` (parse/write, prune, filtering, summary, count-click selection) | DELIVERED | PFT:43-268 (27 tests) | - |
| 5b | Unit: `voucherSizesOf` | DELIVERED | `listingFormat.test.ts`:80-99 | - |
| 5c | The shared bucket rule keeps the Tenants suites green | DELIVERED | `tenantFacets.test.ts`:64-86 plus the existing `voucherBucketOf` block; green in this run | - |
| 5d | `ListingsList` component tests: default, summary, count clicks, voucher (number and list), URL restore, stored spellings, lock regression | DELIVERED | LLT:182-206, 239-346, 350-373, 541-552, 483-522, 587-619 (31 tests green) | - |
| 5e | e2e (lean lane, self-clean, run-unique authority via the API): default, summary counts incl. a multi-authority property, a count click, voucher filter, reload and Back, clean Deleted tab, 360px | DELIVERED (not run here) | SPEC:77-171; self-clean means run-unique data and no reseed (the repo's usage, e.g. `landlord-activity.spec.ts`:10) | Weak spots in F5: step 1 (SPEC:103-107) proves the dropdown value, not that the Setup property is hidden; step 6 (SPEC:155-159) omits the plan's "Status = All statuses" |

### Section 6 - watch items

| # | Design item | Verdict | Evidence | Test that pins it |
|---|---|---|---|---|
| 6a | Perf `/listings` terminal still met (the perf seed cycles every status); ledger citations updated | DELIVERED | `e2e/performance/routes.ts`:766-767 now cite LL:208 (the h1) and LL:308-317 (empty-state title through the rows `ul`), the same anchors as main's 144 / 248-257. Perf seed: `app/src/lib/seed/performance.ts`:590 cycles the 7 statuses and :606 deletes index%7==0 - exactly the `setup` units - so live Available units exist | - . An adjacent perf surface the item did not consider: F1 |
| 6b | The e2e scenario step that opens `/listings` looks for an AVAILABLE property | DELIVERED | `e2e/scenarios/steps.ts`:1129-1139 confirms `status=available` via the API before looking for the link. No other spec opens the Properties list | - |
| 6c | The list stays mounted across both routes, so every piece of filter state derives from the URL, never component state | PARTIAL (intentional deviation b - accepted, see below) | status, voucher and ha come from the URL (LL:172-175); the search text is local state (LL:160) re-synced on every PUSH/POP (LL:161-165). The tab switch is a PUSH, so the text never carries across views | LLT:572-582 (the box empties on Deleted); probe P4 (Back restores it) |
| 6d | The invisible-lock issue closes; `retire-humanize-authority` gets a step-2 progress note | DELIVERED | `docs/issues/properties-authority-filter-invisible-lock.md`:6-7, 13-22; `docs/issues/retire-humanize-authority.md`:12-20 | - |

Tally: 53 items. 48 DELIVERED, 2 CONTRADICTED (3.1f wording, 3.2f deviation a), 2 PARTIAL (3.3e and 6c, both deviation b), 1 N/A (D5).

## The two known deviations - judgment

### (a) A summary count PUSHES; chips, dropdown and search REPLACE - SOUND, amend the note

- A count is a real anchor (PS:54-62), so it already carries link semantics:
  open-in-new-tab works, and a user expects Back to undo it.
- It is a drill-down navigation, not an incremental refinement. Under the note's literal
  rule, Back from a drilled view would LEAVE the page and drop the view the user drilled
  from. That is the loss the replace rule exists to prevent, not the clutter it targets.
- The replace rule's real purpose survives intact: chips, dropdown and search replace
  (LL:185-189; probe P11). A chip toggled after a drill-down replaces the drilled entry, so
  one Back from any refinement returns to the pre-drill view (probe P2).
- A count whose target equals the current URL degrades to a replace (react-router's `Link`
  default), so re-clicking does not stack entries.
- Pinned: LLT:296-307. Documented: `e2e/support/selectors.md`:117.
- Amend: design 3.2 "Writing" (count links are the one PUSH) and plan Task 3 ("links via
  `<Link to={{ search }} replace>`").

### (b) The search box keeps local text and adopts `q` only on non-REPLACE navigations - SOUND, amend the note

- Why the code does it: react-router 7 commits URL changes inside a transition. An input
  bound straight to `q` would render its old value on the urgent pass and lose keystrokes.
  Local text is the standard fix. The adjust-during-render resync (LL:161-165) passes the
  react-hooks lint rules (eslint exit 0).
- Why it cannot diverge in practice: REPLACE is skipped, and inside this component every
  REPLACE writes the box's own text as `q`. Typing does (LL:290-293); chip and dropdown
  writes spread `selection`, whose `q` IS the box text (LL:173), so their `q` matches too.
  Re-clicking the current tab navigates to the same query. Every other way in - mount
  (reload, Back from a property page, which remounts), the tab switch, the sidebar link, a
  count, browser Back/Forward - is a PUSH or POP and re-adopts `q`.
- The filter and the no-match copy read the same text the box shows (LL:173, LL:325), so
  C7's "a selection not on screen never filters" holds for search too.
- Watch item 6c's hazard is closed: the tab switch is a PUSH (LLT:572-582), and Back
  restores the text (probe P4).
- Amend: design 3.3 "Search" and watch item 6 - name the one local piece of state and its
  resync rule.

## Exceeds the note (benign, no action)

- Both Clear buttons now carry an accessible name, "Clear voucher size filter" / "Clear
  housing authority filter" (LL:119). The authority Clear was "Clear" on main. This
  disambiguates the two Clears; no other spec uses the Properties list, and LLT uses
  `/clear/i`.
- `e2e/support/selectors.md`:115-117 gains three Properties rows (repo convention, not in
  the plan's file list).
- The All row has emphasis styling (`PropertySummary.module.css`:73-77).

## Findings

### F1 - MEDIUM - The perf profiler's Property-detail warm sample now likely skips as `fixture_not_navigable`

Evidence:

- `resolveUnitDetail` takes the FIRST live unit of ANY status from a paged Scan
  (`e2e/performance/routes.ts`:1090-1103, predicate at :1094). The Scan order is not
  insertion order (`app/src/repos/unitsRepo.ts`:930-946).
- The warm path first loads the route's source `/listings` (`routes.ts`:634;
  `e2e/performance/collect.ts`:792-798). It then waits for `a[href="/listings/<id>"]` to
  be visible (`e2e/performance/cli.ts`:1368-1376).
- Under C1 the default list renders Available rows only (LL:172-176; PF:37-39).
- In the perf seed, 1 in 6 live units is Available (`app/src/lib/seed/performance.ts`:590,
  606).
- So unless the first scanned live unit happens to be Available, every warm
  Property-detail sample becomes `skipped_fixture_not_navigable`. The outcome is fixed per
  seeded world, and the harness substitutes no other row by design (`routes.test.ts`:698-708).
- No gate catches it: `perf:pages` is not a completion gate, and `routes.test.ts` uses a
  FakeDom. A later comparison lists the skip (`compare.ts`:129-135, 185).
- Separately, `/listings` now renders about 1/6 of its former rows by default, so its
  timings are not comparable with pre-merge baselines.
- Runtime UNVERIFIED: `perf:pages` was not run.

Suggested fix: make the resolver pick a unit the default list shows. Add
`row.status === 'available'` to the find predicate at `routes.ts`:1094 and give the
`routes.test.ts`:700 fixture `status: 'available'`. Record both effects under the design's
watch item 1, including the `/listings` baseline break.

### F2 - LOW - Deviation (a): design 3.2 says every filter change replaces; summary counts push

Evidence: PS:54-62, LL:191-198 vs design 3.2 "Writing" and plan Task 3. Judged sound above.

Suggested fix: amend the note and the plan. No code change.

### F3 - LOW - Deviation (b): local search text vs 3.3 "value from q" and watch item 6

Evidence: LL:152-165, 289-293. Judged sound above.

Suggested fix: amend 3.3 and watch item 6. No code change.

### F4 - LOW - Note 3.1 says "a non-finite size has no bucket"; the shared rule buckets +/-Infinity

Evidence:

- TF:96-100 maps +Infinity to `4plus` and -Infinity to `0`, and `tenantFacets.test.ts`:77-78
  pins that, as plan Task 1 asked. The rule is unchanged from main's `voucherBucketOf`.
- It is unreachable on both lists. LF:84 drops non-finite sizes before PF:174 buckets
  them (probe P8), and JSON cannot carry Infinity to either list.

Suggested fix: amend the note to "NaN has no bucket; `voucherSizesOf` drops non-finite
sizes, so such a property reads Not recorded". Do not change the shared rule, which would
silently alter the Tenants facet.

### F5 - LOW - Delivered behaviors that no shipped test pins

Each item below was proven true by a probe in this review but would survive a regression:

1. Invariant 3.2i: the URL is not rewritten on load, and the next interaction drops a stale
   `ha` (probe P1).
2. C3: the search never moves the counts (probe P6). LLT:331-346 moves only status and
   authority.
3. 3.2f: chips, dropdown and search REPLACE (probe P11). No test walks Back after a filter
   change, so a regression to push would pass.
4. D2: the dropdown option and the row badge still read "Setup" (probe P10).
5. C2: the "Housing authority" header and the All row at 0/0 with no links (probe P7).
6. 3.5b: the Deleted subtitle. 3.4a: the summary renders above the controls.
7. e2e step 1 (SPEC:103-107) asserts the dropdown value and the bare URL but not that the
   Setup property (`soon`) is absent from the default list. Step 6 (SPEC:155-159) omits the
   plan's "Status = All statuses" (perhaps on purpose: the controls need a deleted unit to
   render).

Suggested fix: lift items 1-5 into `ListingsList.test.tsx`; the probe log below gives each
assertion. Add a `toHaveCount(0)` check for `soon` in the list to e2e step 1.

### F6 - LOW - Stale cross-references left by the move and the deletion

Evidence:

- TF:197-200: the `displaySpelling` docblock still says `routes/listings/ListingsList.tsx`
  tallies the spellings. The tally now lives at PF:131-150. This branch touched that file.
- `docs/issues/housing-authority-free-text-drift.md`:48-49, 62-65 and 85 still describe
  `humanizeAuthority` (`ListingsList.tsx:36-42`) as live.
- Optional, under the AGENTS.md vocabulary rule: the staff-facing alias "Coming soon
  (Setup)" is recorded nowhere beside Setup in `documentation/STATUS-MODEL.md`:222.

Suggested fix: update the docblock, and add a dated one-line note to the drift issue. The
STATUS-MODEL line is optional.

## Probe log (throwaway, deleted)

Run with `npx vitest run src/routes/listings/__probe_conf__` from `dashboard/`: 3 files,
12 tests, all green. Each probe mirrored LLT's harness: a per-view mocked `useListings`,
sibling routes, `LocationProbe` and Back.

- P1: load `/listings?status=all&ha=stale&ha=dca`. The location is unchanged after load.
  Clicking 2-BR gives `/listings?status=all&voucher=2&ha=dca` - the stale key is dropped.
- P2: count "Show 1 coming soon property for DCA" gives `?status=setup&ha=dca`. 2-BR then
  gives `?status=setup&voucher=2&ha=dca`, and Back gives `/listings`.
- P3: from `/listings?keep=1`, the count link href is `/listings?keep=1&status=setup&ha=dca`.
- P4: type "Two", click the Deleted tab - the box is empty. Back restores `?q=Two`, the box
  text "Two" and the filtered row.
- P5: type "Avail", then click 3-BR - the URL is `?status=all&voucher=3&q=Avail`.
- P6: at `/listings?q=zzz` there are 0 rows, yet All is 2/2 and DCA is 2/1.
- P7: with only an occupied unit, the All row reads 0/0, it is the only row, the table has
  no links, and the no-match copy shows.
- P8: an available unit with `voucher_size_accepted: Infinity` is hidden by 4+ BR and shown
  by Not recorded.
- P9: with one unit and no authority, the authority group holds exactly "Not recorded".
- P10: at `?status=setup`, the dropdown option reads "Setup" (no "Coming soon" option) and
  the row badge reads "Setup".
- P11: entries [`/elsewhere`, `/listings`]. 2-BR, then status All, then typing "Two" gives
  `?status=all&voucher=2&q=Two`, and Back lands on `/elsewhere` - every write replaced.
- P12 (mutation): `pruneSelection` stubbed to identity via `vi.mock`. The stale-link
  scenario of LLT:603-619 renders 0 rows and the no-match copy. The shipped test therefore
  pins the prune, matching the claim in the issue's resolution paragraph.
