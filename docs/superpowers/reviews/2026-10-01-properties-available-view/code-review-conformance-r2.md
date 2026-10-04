# Code review r2 - spec conformance (amended note)

Branch `feat/properties-available-view` @0dc265d5. The fix wave reviewed is
91204da2..HEAD (bf681d48, d87786d6, 0dc265d5). The contract is the AMENDED design note
`docs/superpowers/specs/2026-10-01-properties-available-view-design.md` (3.1, 3.2, 3.3,
3.4, 3.5, 6, new 7). Rulings contested: `review-adjudications-r1.md`. Reviewer:
conformance (Opus), read-only.

## What was run

- `npx vitest run src/routes/listings src/routes/contacts/tenantFacets.test.ts
  src/routes/listing/listingFormat.test.ts` (dashboard): 6 files, 146 tests, green.
- `npx vitest run performance/routes.test.ts` (e2e workspace unit tests; no stack, no
  browser): 25 tests, green.
- `npx tsc -p dashboard/tsconfig.json --noEmit`: exit 0.
- `npx eslint` on every touched .ts/.tsx: exit 0. Added lines in the fix diff are ASCII.
- Throwaway probes under `dashboard/src/routes/listings/__probe_conf__/`: 3 files, 92
  tests, all green. Deleted afterwards. See the probe log.
- NOT run: `npm run e2e`, `npm test`, `npm run smoke`, `npm run perf:pages`. The
  360px/wrap claims and perf behavior are code-traced only.

Paths: `LL` = `dashboard/src/routes/listings/ListingsList.tsx`, `AS` =
`.../AuthoritySummary.tsx`, `UF` = `.../unitListFacets.ts`, `LLT` =
`.../ListingsList.test.tsx`, `UST` = `.../ListingsList.urgentState.test.tsx`, `UFT` =
`.../unitListFacets.test.ts`, `SPEC` =
`e2e/tests/dashboard-next/properties-available-view.spec.ts`, `PR` =
`e2e/performance/routes.ts`, `PRT` = `e2e/performance/routes.test.ts`.

## Conformance against the amended note

59 of 62 items are DELIVERED.

- Unchanged items: D1-D4, C1-C8, 3.1a-e, the 3.2 table rows, parsing and the invariant,
  3.3a-d and f, 3.4a-d, the 3.5 subtitles, section 4, and 5a-d. I re-verified each
  against HEAD and the verdicts stand. One change: C7's search is now delivered through
  blur persistence (probe B5).
- D5 stays N/A (process).
- The rows below cover every AMENDED or NEW statement, plus each changed verdict.

| # | Amended / new statement | Verdict | Evidence | Pinned by |
|---|---|---|---|---|
| 3.1f | NaN has no bucket; `voucherSizesOf` drops non-finite sizes first, so such a property reads "Not recorded" | DELIVERED | `tenantFacets.ts`:96-100; `listingFormat.ts`:82-87; UF:175-192 | `tenantFacets.test.ts`:64-86; UFT voucher block |
| 3.2-model | Filters are local urgent state, and the URL is their persistence | DELIVERED | LL:181-187, 204-214 | UST:40-57 (frozen router: every tap applies at once and every write carries every earlier choice) |
| 3.2-adopt | URL adopted "on mount and on every navigation that is not one of the page's OWN REPLACE writes (Back/Forward, a tab switch, a nav link, a summary count)" | PARTIAL | LL:184-187 skips EVERY REPLACE, including the router's same-URL REPLACE for a nav link or the current tab, which the page did not write. Counts compensate (`onCount`, AS:73-75); nav links do not (probe B8). Watch item 6c says "every non-REPLACE navigation", which matches the code, so the note contradicts itself. See R2-4 | Guard unpinned: mutant M2 passes all 41 LLT tests. See R2-2 |
| 3.2-write-chip | A chip or dropdown change REPLACES at once (Back leaves the page) | DELIVERED | LL:204-214, 290, 305, 313 | LLT:645-654; UST:40-57 |
| 3.2-write-q | Search writes on BLUR, rides along with other filter writes, never per keystroke | DELIVERED | LL:216-223, 330-334; `change` writes `selection` including `q` (LL:211-214) | LLT:220-244; UST:59-74 (blur direction only - see R2-6) |
| 3.2-write-count | A count PUSHES (Back undoes it) and a plain click also applies its selection locally (same-URL link = REPLACE) | DELIVERED | AS:44-46, 67-78; LL:226-229, 276 | PUSH: LLT:312-323. Local apply: NOT pinned - mutant M1 (`onCount` disabled) passes all 41 LLT tests. See R2-1 |
| 3.2-omit | Default status, empty facets and empty search omitted; unrelated params untouched | DELIVERED | UF:88-98; LL:73-77 (base = current params) | UFT `applyUnitListSelection` block |
| 3.2-tabs | The current view's tab keeps the current query; the other tab is the bare path | PARTIAL | LL:235, 262 build the current tab from the PRUNED local selection. While units load, the prune runs against zero options, so every `ha` key drops and clicking the tab loses a valid selection (probe B3). Round 1 used the raw URL. See R2-3 | LLT:588-601 (loaded state only) |
| 3.2-inv | Invariant: URL not rewritten on load; next interaction re-serializes the pruned selection | DELIVERED | UF:165-172; LL:194, 204-206 | LLT:619-643 |
| 3.3e | Search text is local (filters as you type), seeded from `q`, saved to `q` on blur | DELIVERED | LL:182, 327-334 | LLT:220-244, 570-586 |
| 3.3g | Clear hands focus to its group's first chip | DELIVERED | LL:115, 141-146 | LLT:718-724 |
| 3.3h | Chips wrap a long unbroken stored spelling | DELIVERED (runtime UNVERIFIED here) | `ListingsList.module.css` `.control` min-width 0 / max-width 100%; `.chip` max-width 100% and `overflow-wrap: anywhere` | SPEC:89-92, 105-110, 173-181 (a long slug at 360px) - not run by me |
| 3.4e | Under a voucher filter that leaves out Not recorded, a line says how many available/coming-soon properties have no size and are not counted | DELIVERED | UF:266-273, 291; AS:131-139 | UFT `buildAuthoritySummary` (2 new tests); LLT:694-703 |
| 3.4f | Count links underlined; zeros muted; All row bold with a heavier rule, no tinted fill | DELIVERED (visual; unpinned) | `AuthoritySummary.module.css`:73-103; tokens exist (`dashboard/src/ui/tokens.css`:11-21) | none (jsdom cannot) |
| 3.5c | Default-only + no rows: "No available properties right now." + a "Show all statuses" button | DELIVERED | UF:297-301; LL:363-375 | LLT:675-692; UFT `isDefaultSelection` |
| 3.5d | Any other empty result keeps the no-match message | DELIVERED | LL:376-385 | LLT:246-251, 391-402, 546-553 |
| 5a | Pure `unitListFacets` module tests | DELIVERED | UFT (31 tests) | - |
| 6a | Terminal accepts the default empty line; resolver binds an AVAILABLE unit; `/listings` baselines not comparable | DELIVERED | PR:403-411, 1103-1108; ledger PR:776-777 cites LL:240, 349-367 / 349-358 (verified) | Resolver: PRT:717-737. Terminal alternative: unpinned (R2-6) |
| 6c | Local state RE-ADOPTED on every non-REPLACE navigation; the tab switch is a PUSH to a bare path; the prune is the second defense | DELIVERED | LL:184-187, 262; UF:165-172 | LLT:603-635; probe B5 |
| 7 | Code names `unitListFacets` (`UnitListSelection`, `UnitListView`, `parse/applyUnitListSelection`, `applyUnitListFilters`), `AuthoritySummary` | DELIVERED | UF:25, 45, 72, 88, 210; AS:83; no stale `Property*` identifier outside the bannered plan (grep) | typecheck |
| C7 | Search kept in the address; Back from a property restores the view | DELIVERED (re-verified under the new model) | Blur persists before the row/tab/count click navigates | LLT:570-586; probe B5 |

Non-DELIVERED (3): D5 is N/A (process); 3.2-adopt and 3.2-tabs are PARTIAL.

Behavior in the code that the note does not state:

- The blur write is skipped when the URL would not change (LL:216-223). The adjudication
  records it under A1; the note does not mention it. Probe B7 shows it works; nothing
  pins it.
- The current tab carries the LOCAL selection: it includes unsaved text and drops stale
  keys. That is the source of R2-3.
- "Show all statuses" REPLACES (consistent with the dropdown) and drops keyboard focus
  (R2-5).
- Unsaved search text is lost on a reload or tab close with focus still in the box, and
  on a keyboard Back/Forward across two /listings entries. All of these follow from
  "writes on BLUR"; informational only.

## Findings

### R2-1 - LOW - The count's local apply (3.2) is unpinned; the adjudication says otherwise

Evidence:

- The A6 ruling says: "Pinned: ... a same-URL count click clears the search". No shipped
  test makes a same-URL count click.
  - LLT:294-310 types into the box. userEvent's click then blurs the box, which saves
    `q` first, so the count becomes a PUSH.
- Mutant M1 replaces `AuthoritySummary` with a wrapper that passes a no-op `onCount`.
  All 41 LLT tests stay green.
- The case is easy to pin in jsdom:
  1. At bare `/listings`, `fireEvent.change` the box to "Two" (no focus, so no blur
     write).
  2. Click "Show 2 available properties for all authorities". Its target equals the
     current URL, so the router does a REPLACE.
  3. Real code: the box clears and 2 rows show (probe B1). Mutant: "Two" stays and 1 row
     shows (M1's mutant-only test).

Suggested fix: add that test to LLT. Optionally add a ctrl-click case: a modified click
changes nothing (probe B2).

### R2-2 - LOW - The REPLACE guard can be pinned in jsdom; the ruling says it cannot

Evidence:

- A6 says the guard's job "needs a transition that lags past a newer event, which act()
  cannot produce in jsdom".
- It can be produced by dispatching native events OUTSIDE act, with
  `IS_REACT_ACT_ENVIRONMENT` false for the test:
  1. Raw click on 2-BR.
  2. One microtask later, the URL is still uncommitted.
  3. A raw `input` event types "T".
  4. Wait for macrotasks.
- Real code: the URL commits `?voucher=2` and the box keeps "T" (probe B6).
- Mutant M2 mocks `useNavigationType` to always return POP, so every commit is adopted.
  All 41 LLT tests stay green, but the late commit wipes the "T".
- This is the guard's real job under the new model: protecting anything typed between a
  page write and its commit.

Suggested fix: add the outside-act test (restore the act flag in `afterEach`).

### R2-3 - LOW - While loading, the current tab link drops every `ha` key

Evidence:

- LL:235 builds `currentSearch` from `selection`, which is pruned against
  `authorityOptions(units)`. While the view loads, `units` is empty, so every `ha` key
  is pruned.
- From `/listings?ha=dca` while loading, the Active tab's href is `/listings`. Clicking
  it PUSHes the bare path and adopts it. Once data arrives, no chip is pressed (probe B3).
- Round 1 built the link from the raw URL (r1 LL:230). This is a fix-wave regression of
  3.2 "keeps the current query", and it is reachable on any slow first load or on Back
  into the Active tab.

Suggested fix: build the current tab's `to` from `chosen` (unpruned) instead of
`selection`. It still carries unsaved text, and stale keys stay harmless because the
render prunes them.

### R2-4 - LOW - Note 3.2's adoption rule is broader than the code and contradicts watch item 6c

Evidence:

- 3.2 promises adoption on every navigation that is not "one of the page's own REPLACE
  writes", naming "a nav link".
- The code skips EVERY REPLACE (LL:184-187). The router turns a same-URL link into a
  REPLACE, so a nav link that lands before the blur write commits is ignored. The box
  keeps "Two" while the URL is bare (probe B8; only reachable in that race).
- Counts carry their own compensation (`onCount`); nav links and the current tab have
  none.
- 6c says "every non-REPLACE navigation", which matches the code. The comments at LL:18-21
  and 178-180 repeat 3.2's wording.

Suggested fix: reword 3.2 and the two comments to "every non-REPLACE navigation; a
same-URL link is a REPLACE, which is why a count also applies locally". No code change
needed for a race-only window.

### R2-5 - LOW - "Show all statuses" unmounts itself and drops keyboard focus to `<body>`

Evidence:

- The button lives in the empty state it replaces (LL:363-375), so clicking it removes it.
  Focus lands on `document.body` (probe B4).
- This is the defect A9 fixed for Clear (3.3g); the new button reintroduces it.

Suggested fix: after `change`, focus the status select (now reading "All statuses") or
the rows list. Pin it like LLT:718-724.

### R2-6 - LOW - Other stated behaviors that no test would catch regressing

1. The perf terminal's new empty alternative (PR:408) duplicates LL:367's copy. Nothing
   ties them together: PRT:422-455 checks citation FORMAT only. A copy edit would turn
   every default-empty `/listings` sample into a misattributed `ready_timeout` again.
   This is the same exposure "No properties yet" already had.
2. 3.2 "rides along with any other filter write" (a chip write carries unsaved text) is
   untested in that direction. userEvent always blurs the box first, so the blur write
   carries `q` and the chip write's own `q` is never observed. A frozen-router (UST)
   check of the LAST write would pin it.
3. No real-browser check covers the blur-save. SPEC never types in the search box, so
   "Back from a property returns the same view" with search text rests on jsdom's focus
   emulation. Typing an address before SPEC step 5's row click, then asserting the text
   after Back, would cover it in Chromium.
4. 3.4f (underline, muted zeros, All-row rule) is visual and unpinned. That is
   acceptable.

### R2-7 - LOW - Date nit in the new records

`docs/issues/unit-voucher-size-readers-diverge.md` has `created: 2026-10-02`, and the plan
banner and the adjudications say 2026-10-02. The same wave dates the GLOSSARY entry and
the drift-issue update 2026-10-01, the design note is 2026-10-01, and the local clock at
review was 2026-10-01 23:xx. Pick one date (issue frontmatter feeds `npm run issues`).

## Fix diff reviewed cold - checked and fine

- Two taps before a commit: each discrete event re-renders synchronously, so the second
  handler reads the first tap's state. UST pins the accumulation. `persist` takes only
  UNRELATED params from the committed URL; the owned params always come from the full
  local selection.
- Blur then count, real ordering: mousedown blurs and saves `q`; by the click the count
  target differs, so it is a PUSH and adopted. The same-URL case only arises in a race,
  which `onCount` covers.
- Tab switch with unsaved text: the blur saves `q` on the Active entry, then the PUSH to
  Deleted adopts clean, and Back restores the text (probe B5).
- `isPlainLeftClick` (AS:44-46) mirrors the router's own in-place test (button 0, no
  modifier). A ctrl-click changes nothing (probe B2).
- CSS:
  - `--c-border-strong`, `--c-brand-hover` and `--c-text-muted` exist (tokens.css:12, 21,
    15).
  - `.allRow` now only sets weight and border colour, so the corner artifact is gone.
  - Brand on white is about 4.6:1 and muted on white about 6.0:1.
- `isDefaultSelection` cannot fire on the Deleted tab (its default is `all`, so a loaded
  view always shows rows). A whitespace-only search counts as default, consistent with
  `matchesQuery`.
- The new issue's citations match the code: `BroadcastComposer.tsx`:219-227,
  `unitFields.ts`:294-306, `ListingDetail.tsx`:752-754, `ListingEditForm.tsx`:28-33 and
  66-68. Its coverage of `voucher_size_accepted` readers is complete (grep: types,
  ListingDetail, ListingEditForm, UnitCreateForm, listingFormat; app: unitFields
  allowlist, unitsRepo).
- No stale pre-rename identifier remains outside the bannered plan.

## Adjudications - contest or concede

- A6: CONTESTED on both halves. The same-URL count is not pinned (R2-1), and the guard CAN
  be pinned in jsdom (R2-2). Both mutants pass all 41 shipped component tests.
- A9: contested in part. The Clear focus fix is in, but the new "Show all statuses" button
  repeats the defect (R2-5).
- Conceded without further argument:
  - A1: blur plus the skip is sufficient for the WebKit cap.
  - A2: the partial ruling is within C3/C5 as Cameron approved them.
  - A3: the filed issue is accurate and complete.
  - A4, A5, A7, A8, A10, A11 (partial), A12: verified delivered as ruled.
  - A13: no code path writes those labels.
  - C1-C6: verified delivered. The Deleted-tab "All statuses" e2e exclusion is sound,
    because its controls need a deleted unit.

## Round-1 items - closure

| r1 item | Status | Evidence |
|---|---|---|
| F1 perf resolver | CLOSED | PR:1103-1108 binds an available unit; PRT:717-737; the terminal alternative is also in (PR:403-411); design 6a records both and the baseline break |
| F2 deviation (a), counts push | CLOSED | Design 3.2 Writing states the PUSH and the local apply |
| F3 deviation (b), local search text | CLOSED (superseded by the local-state model) | Design 3.2 State model, 3.3e, 6c. The new model's own wording gap is R2-4 |
| F4 non-finite wording | CLOSED | Design 3.1 (lines 89-94) |
| F5 test gaps | CLOSED | LLT:637-643, 667-673, 645-654, 236-244, 657-665, 675-692, 712-716, 705-710; SPEC:119-120. The Deleted e2e "All statuses" check is conceded |
| F6 stale refs + label | CLOSED | `tenantFacets.ts`:198-203; `housing-authority-free-text-drift.md`:12-18; `documentation/GLOSSARY.md`:312-318 |

## Probe log (throwaway, deleted)

Run from `dashboard/`: `npx vitest run src/routes/listings/__probe_conf__`. 3 files, 92
tests, green.

- B1: at bare `/listings`, `fireEvent.change` "Two", then click "Show 2 available
  properties for all authorities". The location stays `/listings`, the box is empty, and
  2 rows show.
- B2: at `?q=Avail`, ctrl+click a count. Location, status and box are all unchanged.
- B3: loading at `?ha=dca`. The Active tab's href is `/listings`. After clicking it and
  loading the data, no authority chip is pressed.
- B4: with one occupied unit, clicking "Show all statuses" leaves `document.activeElement`
  as `body`.
- B5: type "Two", click the Deleted tab: the URL is `/listings/deleted` and the box is
  empty. Back gives `/listings?q=Two`, the box reads "Two", and 1 row shows.
- B6 (outside act): raw click 2-BR. After a microtask the URL is still `/listings`. Raw
  input "T", then wait for macrotasks: the URL is `?voucher=2`, the box reads "T", and
  2-BR is pressed.
- B7: at `?status=all`, focus the box and tab out. The location key is unchanged.
- B8 (outside act): type "Two", blur, then raw-click a same-URL `<Link to="/listings">`.
  The final URL is `/listings`, yet the box reads "Two" and 1 row shows.
- M1: a byte-copy of LLT with `AuthoritySummary`'s `onCount` stubbed. 41/41 shipped tests
  pass. Its mutant-only test: after B1's steps the box keeps "Two".
- M2: a byte-copy of LLT with `useNavigationType` stubbed to POP. 41/41 shipped tests
  pass. Its mutant-only test: after B6's steps the box is wiped to "".
