# Build research - merged worklist index and orchestrator rulings

Orchestrator: build (Fable 5.1), 2026-10-06. Tree: feat/tour-list @ b3ac0306
(app/, dashboard/, e2e/ byte-identical to main @d839494a; main is now
a5eabcb3, two commits that touch no file this plan edits).

Three read-only readers (opus) checked plan v3 against the live tree. Their
worklists are the build's per-slice must-reads; every implementer brief names
the one for its slices:

- `app-worklist.md` - S1-S7 (20 items: 7 would break a build or test).
- `dashboard-worklist.md` - S8-S12 (23 items + 7 gaps; the plan's code
  type-checks and lints clean against the live tree).
- `e2e-docs-worklist.md` - S8's e2e edits, S13, S14, S15 (28 items: 20
  corrections, 8 guards).

Byte-exact reference for every citation: `.superpowers/sdd/build-research/`
(gitignored, dies with the worktree).

## Rulings on the decision points the readers raised

Format: ruling - rationale - where it lands.

### App

- A-1 (app G2) `unitsRepo.getDisplaysByIds` goes RIGHT AFTER `getById`
  (interface, implementation and the harness fake), not at the end. The
  parallel branch feat/clean-org-names inserts ITS new method at the end of
  the same three blocks, so "end of the interface" (plan section 0) would
  guarantee the conflict that rule exists to avoid; the intent (a small,
  mechanical merge) wins over the letter. - S3.
- A-2 (app item 11 / G3) The 5.1 commit carries the interface method, the
  real implementation, `test/helpers/tourListIndexFake.ts` AND the harness
  fake's `queryListPhase` line (+ import), so `npm run typecheck` is never
  red between commits; 5.2's commit adds the mirror integration test. - S5.
- A-3 (app G1) The shared fake gets the house tie guard: resuming from a
  start key whose range-key value is shared by more than one row THROWS a
  plain Error (never a ValidationException-named one, so a route test sees a
  500, not a misleading 400). Fixtures use distinct values anyway. - S5.
- A-4 (app item 10) Every fixture instant in S5/S6/S7 tests is a full
  `toISOString()` value; the repo stores `scheduledAt` raw and only the
  routes canonicalize. - S5, S6, S7 briefs.
- A-5 (app item 16) Route test 10's allowed key set is: level, time, pid,
  hostname, msg, requestId, userId, correlationId, traceparent, returned,
  evaluated, calls, phases, when. - S7.
- A-6 (app G5) Task 6.2 also asserts `evaluated <= returned + 1` on every
  unfiltered-D page of its walks (spec 9's "at most one row past the page"
  on real DynamoDB). - S6.
- A-7 (slice C's open point, orchestrator, after S7) `MAX_QUERY_CALLS` is 6,
  not 5. The default list (`when=any`, every status) has SIX phases (D plus
  the five U statuses); a budget of five spent itself before the closed
  phase on every first page that did not fill, so every small deployment's
  default view - even an empty table - answered a cursor and showed a
  phantom Load more (an empty page with a cursor is followed automatically,
  but a non-empty one is not). The budget's purpose is to bound FILTERED
  phases that need several Queries; one Query per possible phase keeps that
  bound (6 x 200 evaluated items at most) and lets a sparse unfiltered list
  complete in one request. Spec 5.4 and the plan's constants table are
  amended in place; engine test 14 pins it (an empty table and a seven-row
  table both answer `nextCursor: null` in one request of six calls). A
  spec-vs-behavior discrepancy where both readings honor D2's intent -
  decided here, recorded for the handback.

### Dashboard

- D-1 (dashboard G1) `sortToursForPanel` (`useListing.ts:84-94`) sorts EVERY
  undated tour first "as an unbooked request" - a reader of invariant I1
  that spec section 8 missed; after D8 an undated toured or closed tour would
  read "Undated" while sitting among the requests. FIX IT in S8: only a
  `requested` tour sorts first; dated and other undated tours keep the
  existing date order; one pin. Small, contained, and exposed by this
  change; recorded as a deviation for the handback. - S8.
- D-2 (dashboard item 9) New api types go AFTER the existing tour types
  (after the `ToursPage` interface that follows `Tour`), `listTours` after
  `getTours`, `undatedTourLabel` right after `tourStatusLabel` - the plan's
  ground rule; the parallel branch edits other regions of both files. - S8, S9.
- D-3 (dashboard item 16) Tests construct `new ApiError(400, 'invalid
  cursor', 'invalid cursor')` (three arguments; gate 1 fails otherwise). -
  S11, S12.
- D-4 (dashboard item 20) The 480px stacking rule is a CONTAINER query
  (`@container (max-width: 480px)`) on the page's inline-size container, the
  house idiom (`ToursPage.module.css`, `ListingsList.module.css`); self-QA
  still measures at a 360px viewport. - S12.
- D-5 (dashboard G2) The CURRENT All tab's link carries the committed
  `location.search` (as #1's current tab does), so a Ctrl/Cmd/middle-click
  opens the same filtered list; P15 still swallows the unmodified click. One
  line + a pin. - S10.
- D-6 (dashboard G3) The count line's `role="status"` element stays MOUNTED
  (empty) while a first page loads or the range is invalid, and receives its
  text when the page lands - a live region inserted with its text is not
  reliably announced. The spec's rule stands: no count TEXT while loading,
  never "Showing 0 tours". The Spinner remains the loading indicator. - S12.
- D-7 (dashboard G4) The 50-request walk cap is per WALK, not per list: the
  hook resets its walk counter on the walk's false -> true edge (the search
  cleared and typed again), so a second search on a list whose first walk
  capped walks again. Spec 6's one rule ("whenever the search is non-empty
  and the list is not complete") requires it. One test. - S11.
- D-8 (dashboard G5) "Showing 0 tours" beside the capped-follow message is
  spec-consistent; unchanged.
- D-9 (e2e C25) The All view's first-page failure renders inside a
  `role="alert"` element (the named views' house pattern, `ToursPage.tsx:724`),
  so the widened perf issue's "the alert" terminal is true. - S12, S14.

### E2E, perf, docs

- E-1 (e2e D1) S8 also rewrites `steps.ts:1853` and
  `tours-page.spec.ts:479` ("(requested, needs booking)"), and its final
  check is `git grep -n -i "not booked" -- dashboard/src e2e app/src`
  (expect empty); S14 repeats it over `documentation/`. - S8, S14.
  AMENDED by the planner review (planner-review/adjudications.md, E-1): the
  GLOSSARY names the retired label "Not booked" per its own convention for
  retired terms, so the check EXCLUDES `documentation/GLOSSARY.md` and
  `docs/issues/` (the issue records keep the old word as history).
- E-2 (e2e D2 / C19) `routes.test.ts:381` is kept verbatim and a NEW comment
  line + `'/tours/all'` are added below it; `e2e/README.md:83-86` gains an
  appended sentence rather than a rewrite; `routes.ts:616-627` likewise adds
  rather than rewrites. S15's expected-conflict list gains `routes.test.ts`,
  `e2e/README.md`, `e2e/performance/routes.ts` and `App.tsx`. - S10, S13, S15.
- E-3 (e2e D3 / C12) S13's run mode: the implementer starts
  `npm run e2e:session` (background) only when HEAD is its final pre-spec
  commit, iterates on the UNCOMMITTED spec with the single-hop command,
  commits once green, stops the session and confirms the lane ports are
  free before returning. The same lane run also takes
  `tests/scenarios/tours.spec.ts`, `tests/dashboard-next/tours-page.spec.ts`
  and `tests/dashboard-next/tours-past.spec.ts` (R1: the S8 step edits run
  from 20 call sites and first execute here). - S13.
- E-4 (e2e D4 / R2 / R3) S14 files the two spec-10 deferrals as issues
  (`tours-all-server-side-search`, `tours-all-live-updates`; improvement,
  low) and adds one Tours-All row to `e2e/support/selectors.md`. - S13 (the
  selectors row, with the spec), S14.
- E-5 (e2e C15 / C16 / dashboard G6) The known-gap wording is "GET
  /api/tours/list?when&sort&limit for the first page, the same plus cursor
  after it"; 13.2's ledger refresh also covers the citations S8/S9 shift
  (`routes.ts:742, 770, 795, 796` and the endpoints.ts ones if moved). - S13.
- E-6 (e2e C22) The two new issue files are written from the template with
  its comment block removed and its non-ASCII line rewritten. - S14.

### Sequencing (orchestrator)

Implementer children, one at a time, each briefed with its worklist file:
A = S1+S2+S3; B = S4+S5; C = S6+S7; D = S8 (+ D-1); E = S9+S10; F = S11;
G = S12; H = S13; I = S14. Gates, review, fix wave, self-QA and the main sync
follow (S15).
