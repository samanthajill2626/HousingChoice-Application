# Plan review R3 - reviewer A (narrow: the v6 Past-only child)

Plan: `docs/superpowers/plans/2026-09-26-staff-notes-past-tours.md` v6 @b6e08711
Inputs: `plan-r2-adjudications.md` and the spec 4.5 reword.

Bottom line: the v6 child design is correct as written. It lints clean,
typechecks, and behaves as the spec says. None of the three findings below is
needed for the build to succeed; all are LOW.

## Method

- Rebuilt the WHOLE dashboard delta from the v6 plan text into a fresh scratch
  copy of `dashboard/src` at base: Tasks 2-4 and 6-8. Every block was located by
  its instruction anchor, not by line number. The rebuilt files are
  `ToursPage.tsx`, `ToursPage.test.tsx`, `App.tsx`, `useTours.ts`,
  `useTours.test.ts`, `TourDetail.tsx`, `TourDetail.test.tsx`,
  `StaffNotesCard.*`, `TenantFile.*`, `ContactDetail.tsx` and `types.ts`.
- **Typecheck:** `tsc` with the dashboard compiler options over the full
  `src/**` (tests included; the same harness gave 0 errors at base) gives
  **0 errors**. The R2 `waitFor` error is gone.
- **Lint:** each tours file went through the repo's ESLint (react-hooks 7.1.1
  `recommended-latest`) via `--stdin --stdin-filename <real repo path>`.
  - `ToursPage.tsx`, `App.tsx`, `ToursPage.test.tsx`, `useTours.test.ts`,
    `TourDetail.test.tsx`: **0 problems**.
  - `useTours.ts`: only the baseline `set-state-in-effect` in `useClosedTours`.
  - `TourDetail.tsx`: only the baseline `react-hooks/purity`, now at line 302.
- **Sanity check that the rules actually cover the child.** I injected two known
  violations into `PastToursView`, one at a time:
  - (A) a `setBulkBusy` inside a `useEffect` was reported as
    `set-state-in-effect`;
  - (B) replacing `disabled={bulkBusy || ...}` with `bulkBusyRef.current` was
    reported twice as "Cannot access refs during render" (`react-hooks/refs`).
  Both rules are live on the child, so the clean result is a real pass.
- No vitest, Playwright or e2e was run. Where test outcomes are argued from
  reading, they are marked "by reading".

## Answers to the charge

**1. Does the child lint clean?** Yes. The child has no effect at all, so
`set-state-in-effect` has nothing to flag.

The indeterminate callback ref is clean under `react-hooks/refs`:
```
ref={(el) => { if (el) el.indeterminate = someSelected; }}
```
It writes a DOM property from a render value inside a ref callback, and it does
not read a ref's `.current` during render. Injection (B) shows the rule would
fire if it did. `bulkBusyRef` is read and written only inside the async
`markToured` handler.

Rules-of-hooks is also satisfied: every hook in `PastToursView` (`usePastTours`,
four `useState`, `useRef`, three `useMemo`) runs before the two early returns.

**2. Does the Past view's loading/error contract still match spec 4.2?** Yes.
- The page gates Past on the cross-reference lookups only (`loading = past ?
  crossRefLoading`, `error = past ? crossRefError`).
- The child renders `<Spinner center />` while `usePastTours` is `idle` (the
  first load only; a reload keeps `ready` and the rows).
- A failed first load renders the child's
  `<p className={styles.error} role="alert">We couldn't load tours...</p>` in
  place of the list, which is spec 4.2's "page-level error that replaces the
  list".
- A failed reload keeps the rows and adds the one refresh alert inside the
  region.
- The plan's test "shows the page error when the FIRST Past fetch fails" still
  holds by reading: one alert, and no "Past tours" region.

**3. Do the existing Active/Closed tests still pass under the v6
`renderPage`?** By reading, yes.
- `renderPage` is the base wiring with no keys, plus the `/tours/past` route and
  a `/tours/:tourId` probe route.
- The Active and Closed paths through the page are unchanged apart from
  `PAGE_TITLE` / `PAGE_INTRO` / `VIEW_TABS` keyed by `t.view` and the Active
  block's `view === 'active'` condition. The strings match the base literals
  exactly.
- The new Active-test assertion `expect(usePastToursSpy).not.toHaveBeenCalled()`
  holds. Only `PastToursView` calls the hook, and it is not rendered on `/tours`.
  `beforeEach` clears the spy.
- The existing `useClosedToursSpy.mock.calls.every(enabled === false)` assertion
  is untouched.

**4. Does "switching tabs unmounts the Past view" really exercise an
unmount?** Yes.
- React Router creates `RenderedRoute` without a key
  (`react-router/dist/development/chunk-4ZMWKKQ3.mjs:6329-6339`). So in the
  test's unkeyed `renderPage`, the one `ToursPage` instance survives
  `/tours/past -> /tours` and re-renders with `view='active'`.
- There `past` is false and `{... && past ? <PastToursView .../> : null}`
  renders nothing, which unmounts the child.
- The new assertion that the "Past tours" region is ABSENT right after the
  Active click proves the child left the tree. Clicking Past mounts a fresh
  child, and the `findByRole('region')` / no-alert / `Mark toured (0)` disabled /
  unchecked-boxes checks then observe brand-new state.
- The earlier alerts are awaited with `findAllByRole` (R2-5 applied), so the
  test does not read before the batch render commits.

---

## Findings

### R3-1 [LOW] The plan header still says the page resets by REMOUNT (`key={view}`)

Plan lines 14-17, in the "Lint rule that shapes three tasks" paragraph:
"the page resets by REMOUNT (`key={view}`)".

v6 does the opposite. Task 7 step 8 says App.tsx carries "no keys - the page
instance is shared across tabs exactly as today; only the Past child unmounts",
and the adjudication R2-2 says "App.tsx and the test wiring carry NO keys".

A builder who reads the header first gets contradictory instructions. If they
add the key, the R2-2 regression comes back: every tab click refetches all
contacts and units behind a spinner. Fix: change the sentence to "the Past
view's batch state lives in a Past-only child that unmounts on a tab switch".

### R3-2 [LOW] CONTEST R2-2 (residue): the in-flight guard still does not survive a mid-batch tab switch

My R2 N2 named this sub-point: "`bulkBusyRef` stops guarding across a mid-batch
switch". The R2-2 ruling moves `bulkBusyRef` into the child, which unmounts on a
tab switch just as the keyed page did. So:

1. Past -> Active -> Past while a batch runs leaves the first runner PATCHing on
   the unmounted child.
2. The fresh child's `bulkBusyRef` is `false`, so its "Mark toured (N)" accepts a
   second runner.

Spec 4.5 says "the runner also ignores a call while one is in flight". The
per-tour re-read (4.5 step 2c) prevents wrong writes, but tours both runners
touch come back "Changed since the list loaded", although the user's own first
batch marked them.

v6 now keeps ONE `ToursPage` instance across tabs, so the fix is cheap:
- hold the in-flight ref in `ToursPage` (`const pastBatchInFlight = useRef(false)`);
- pass it to `<PastToursView inFlight={pastBatchInFlight} .../>`;
- have the runner check and set `inFlight.current` instead of a local ref.

This stays lint-clean: ref access happens only in the handler, and injection (B)
shows the rule targets render-time reads. The local `bulkBusy` state still drives
the disabled controls. Edge case: needs a tab switch in the middle of a
seconds-long batch.

### R3-3 [LOW] The Past fetch now starts only after the lookups finish (sequential, not parallel)

The child mounts only when `!loading && !error && past`, and for Past, `loading`
is `crossRefLoading`. So `usePastTours(true)` fires only after:
- `useContacts('all')` and `useContacts('deleted')` have each walked every page
  of four types;
- both unit lists have loaded.

In v4/v5 the Past range query ran in parallel with those lookups. First paint of
Past is now lookups + one query, instead of max(lookups, query). The query is a
single request, so the cost is small.

If it matters: mount the child whenever `past && !crossRefError`, pass
`lookupsReady={!crossRefLoading}`, and show its spinner while `status === 'idle'
|| !lookupsReady`. Otherwise leave it and note it in the slice report. Nothing in
the spec requires either shape.

---

## R2 adjudications: everything else conceded

- **R2-1 (`waitFor`)** is fixed: the full-src typecheck gives 0 errors.
- **R2-3 (orphan recipe)** is fixed:
  - `lane.json` is read before `e2e:stop`;
  - `lane.mjs` is explicitly forbidden, with the reason;
  - `Get-NetTCPConnection -State Listen` is used per port;
  - the no-failure branch re-runs with `timeout 3600`.
- **R2-4 (baseline note)** is fixed: all three pre-existing errors are named, and
  attribution goes by rule and context.
- **R2-5 (findBy)** is fixed in both tests.
- **R2-6 (Task 6 header)** is fixed: "end of today" and the Needs-placement
  exception are both present.
