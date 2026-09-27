# Slice S6 report - TourDetail: the `?outcome=1` deep link and the back arrow (plan Task 8)

Date: 2026-09-27
Branch: `feat/staff-notes-past-tours` (worktree `W:\tmp\staff-notes-past-tours`)
Slice base: `d0878018` (the S5 report commit)
Implementer: S6 child, Claude Opus 5.5 (1M context)
Status: DONE - one code commit, strict TDD. The new tests were shown red before
any implementation, then the implementation was built in TWO steps so the
state-carry test could be shown red for its own reason (the strip without
`state`) before the committed strip made it green. Dashboard typecheck exit 0
before the slice, after the implementation and after the commit.

Byte-exact quotations behind every count and citation below (run output,
failure lines, the react-router and jest-dom source excerpts, the word-level
diff, the byte counts) are in the ignored run state
`.superpowers/sdd/slice-S6-reference.md`.

## Commits

- `c4de3fe4` feat(dashboard/tours): ?outcome=1 deep link opens the
  Record-outcome dialog once and strips itself; back arrow honors state.back
  (spec 4.6) - the plan's Task 8 message, real model in the trailer. Files:
  `dashboard/src/routes/tours/TourDetail.tsx`,
  `dashboard/src/routes/tours/TourDetail.test.tsx`. 2 files, 127 insertions,
  9 deletions.
- This report, as its own docs commit.

The code commit was staged by explicit path after a bare `git status
--porcelain` that listed only the two files and a MERGE_HEAD check that found
none.

## What shipped (`dashboard/src/routes/tours/TourDetail.tsx`)

- Router import (`:28`): adds `useLocation` and `useSearchParams`. `useEffect`
  was already in the react import (`:27`).
- `BACK_TARGETS` (`:101-103`): exactly `/tours`, `/tours/past`,
  `/tours/closed`. `backHref(state)` (`:105-110`): returns `state.back` only
  when the state is a non-null object whose `back` is a string that is EXACTLY
  one of those three; everything else - no state, `null`, a non-object, a
  missing or non-string `back`, any other path (`/contacts/...`), and near
  misses such as a trailing slash or a query string - falls back to `/tours`.
  Exact set membership, no prefix matching. Both sit directly below the other
  module constants (`RESCHEDULABLE_UI`, `CANCELABLE`), above `TourDetail`.
- Inside `TourDetailLoaded`, in place of the old `modal` declaration:
  - `location` and `backTo = backHref(location.state)` (`:251-252`), then the
    plan's explanatory comment (`:253-263`).
  - `useSearchParams()` (`:264`); `wantsOutcome` is true only when the
    `outcome` param's value is exactly `'1'` (`:265`).
  - The `modal` state INITIALIZER (`:266-268`): `'outcome'` if and only if
    `wantsOutcome` AND `tour.status === 'toured'` AND `tour.outcome ===
    undefined`, else `null`. Initializer only - it runs once per mount, and
    `TourDetailLoaded` mounts after the tour loads and is keyed by tourId
    (`:143-151`), so the tour's status is known there. No effect opens the
    dialog.
  - The strip effect (`:269-274`): returns at once when the param is absent,
    so without `outcome=1` nothing runs and the location (and its state) is
    untouched. Otherwise it copies the current params, deletes only `outcome`
    (any other param survives), and calls
    `setSearchParams(next, { replace: true, state: location.state })` (`:273`)
    - a replace (no new history entry) that carries the current router state
    forward. Deps (`:274`): `wantsOutcome`, `searchParams`, `setSearchParams`,
    `location.state`. After the strip the param is gone, so every re-run
    returns early. `setSearchParams` is a navigation, not a `useState` setter;
    no `useState` setter is called in any effect body.
  - The strip runs whenever the param is present, whatever the tour's state:
    a scheduled tour, or a toured tour that already has an outcome, loses the
    param too and opens nothing.
- Back link (`:630`): `to={backTo}`; the class and `aria-label="Back to
  tours"` are unchanged.
- Header comment: the plan's one sentence (`:20-23`), placed right after the
  sentence about the "Record outcome" rung so that "the same modal" has its
  antecedent. The rest of that paragraph was re-wrapped (`:23-26`); a
  word-level diff shows only `//` markers moved - no other word changed
  (reference section 7).

## Tests (`dashboard/src/routes/tours/TourDetail.test.tsx`, 82 pre-existing + 7 new = 89)

- `useLocation` joins the `react-router-dom` import (`:15`). The file's router
  mock re-exports `actual` and stubs only `useNavigate`; react-router 7.18.0's
  `useSearchParams` calls its own module-internal `useNavigate`, so the strip
  is a real MemoryRouter navigation in these tests and never reaches
  `navigateSpy` (reference section 6).
- The plan's describe block, verbatim, appended at top level (`:1817-1898`),
  inheriting the module-level loaded-page `beforeEach`: a `SearchProbe` that
  renders `location.search` (`:1819`) and a `renderAt(search, state)` helper
  (`:1824`). The seven tests:
  1. `:1842` opens the Record-outcome dialog on a toured tour with no
     outcome, and strips the param (then Cancel closes it and the header
     "Record outcome" CTA remains).
  2. `:1853` strips the param WITHOUT losing state.back.
  3. `:1862` opens nothing on a scheduled tour (and still strips the param).
  4. `:1871` opens nothing on a toured tour that already has an outcome.
  5. `:1878` opens nothing without the param.
  6. `:1885` the back arrow honors `state.back = '/tours/past'`.
  7. `:1892` the back arrow falls back to `/tours` for a foreign path.

## Verification (quoted; all from `/w/tmp/staff-notes-past-tours/dashboard`)

- Baseline at `d0878018`, before any edit: `npx vitest run
  src/routes/tours/TourDetail.test.tsx` -> exit 0, "Tests 82 passed (82)", no
  stderr, no act warning; `npm run typecheck` -> exit 0.
- RED 1, tests only (implementation untouched): same command -> exit 1,
  "Tests 4 failed | 85 passed (89)". Red: test 1 and test 2 ("Unable to find
  role="dialog" and name "Record outcome""), test 3 (the probe still read
  `?outcome=1`), test 6 (received `href="/tours"`). Already green, by
  design, because today's page opens nothing and links to `/tours`: tests 4,
  5 and 7 (they guard the no-op and fallback paths).
- RED 2, the implementation in two steps: the plan's full change but with the
  strip as `setSearchParams(next, { replace: true })` - no `state` - (never
  committed): exit 1, "Tests 1 failed | 88 passed (89)". The ONLY failure was
  test 2, "strips the param WITHOUT losing state.back", at its post-strip
  back-link assertion (`TourDetail.test.tsx:1859`), received `href="/tours"`:
  the strip had nulled the router state (react-router `createLocation`
  defaults `state` to `null`, reference section 6). Tests 1, 3 and 6 turned
  green at this step. This pins test 2 to the state carry itself, not merely
  to the dialog opening.
- GREEN, `state: location.state` added (the committed code): `npx vitest run
  src/routes/tours/TourDetail.test.tsx` -> exit 0, "Tests 89 passed (89)", 0
  stderr blocks, 0 act warnings. `npx vitest run
  src/routes/tours/TourDetail.test.tsx src/routes/tours/ToursPage.test.tsx`
  -> exit 0, "Test Files 2 passed (2)", "Tests 122 passed (122)" (verbose run
  lists all seven new tests as passed). `npm run typecheck` -> exit 0.
- After the commit, clean tree at `c4de3fe4`: TourDetail alone -> exit 0,
  "Tests 89 passed (89)"; the pair -> exit 0, "Tests 122 passed (122)"; no
  stderr, no act warning; `npm run typecheck` -> exit 0. Four green runs of
  the TourDetail suite in all.
- ASCII, added lines only (both files already carry non-ASCII elsewhere; this
  slice touched none of it - `TourDetail.tsx`'s only non-ASCII line is the
  untouched em dash at `:232`): 0 and 0 bytes. Both files LF-only: 0 CR
  bytes; `git ls-files --eol` reports `i/lf w/lf` for both.
- Not run, per the mission: full `npm test`, `npm run smoke`, `npm run e2e`,
  lint. No server or e2e session was started.

## Divergences from the plan (and why)

None in the code: the router import, `BACK_TARGETS`, `backHref`, the
`modal`/strip block and the back link are the plan's Task 8 text, and the
test block is the plan's Step 1 text. Two process or placement notes:

1. The implementation went in two steps (strip without `state`, then with),
   as the mission allowed, so the state-carry test was shown red for its own
   reason. The interim was never committed.
2. The plan named the header paragraph ("lines 17-22") but not a position
   inside it. The sentence went after the "Record outcome" rung sentence, and
   the paragraph's tail was re-wrapped with no word changes (see above).

## Recorded, no change

- The red-run message on the strip assertion, "Checking with empty string
  will always match, use .toBeEmptyDOMElement() instead", is misleading: in
  the installed jest-dom (6.9.1) `toHaveTextContent('')` passes ONLY when the
  text is exactly empty and prints that message exactly when it FAILS, so the
  three strip assertions are not vacuous (reference section 6).
- Gate 5 (lint) was not run (mission). By construction: the new effect calls
  no `useState` setter (`react-hooks/set-state-in-effect`), the initializer is
  pure, and the deps list is complete. The pre-existing `react-hooks/purity`
  error (`Date.now()`) moved from base `:269` to `:304` - baseline debt, not
  this slice's.
- The strip navigates to `?` plus the remaining params, so a URL hash would
  not survive it; the tour page uses no hash today.
- Only the exact value `1` triggers anything: `?outcome=true` or
  `?outcome=0` opens nothing and is left in the URL (spec 4.6: "ONLY when
  `outcome=1` is present").
- A direct visit to `/tours/<id>?outcome=1` with no router state (typed URL,
  bookmark) still opens the dialog on an eligible tour; its back arrow goes to
  `/tours`.
- React StrictMode (the app's root, `dashboard/src/main.tsx:3,15-19`) runs the
  mount effect twice in dev with the same closure: two identical replace
  navigations, both carrying the state - still one history entry, no visible
  effect.

## For S7 (the Past-tab e2e)

- Landing: the Past row's "Record outcome: <who>" link goes to
  `/tours/<id>?outcome=1` with router state `{ back: '/tours/past' }`
  (S5 report). The tour page first shows its spinner; once loaded, the dialog
  (role `dialog`, name "Record outcome"; its form is named "Record outcome
  form") is ALREADY open - nothing needs a click.
- The URL loses `?outcome` in a replace right AFTER the loaded render, so
  assert it with an auto-retrying check (Playwright `expect(page).toHaveURL`
  on a pattern ending `/tours/<id>` with no query), never a one-shot
  `page.url()` read taken the instant the dialog appears.
- Click the dialog's "Cancel" SCOPED to the dialog (the "Record outcome"
  dialog locator, then its "Cancel" button), or with `exact: true`.
  Playwright's role-name match is a substring match, and the page's
  RemindersPanel renders buttons whose accessible names begin "Cancel the
  ..." for any upcoming reminder rung (`RemindersPanel.tsx:485-488`). The
  unit test's bare `getByRole('button', { name: 'Cancel' })` is safe only
  because Testing Library's string name is an exact match. The app frame has
  no "Cancel". The other dialog button is "Save decision". After Cancel the
  dialog is gone and the header CTA "Record outcome" remains (the tour is
  toured with no outcome).
- The back arrow is a LINK with accessible name "Back to tours" (an
  `aria-label` over an arrow glyph). Arrived from Past - through either the
  row link or "Record outcome" - its href is `/tours/past`, before and after
  the strip; clicking it lands on `/tours/past`. From Active or Closed rows,
  or with no state, it is `/tours`.
- Real-app mounting: `BrowserRouter` under `StrictMode`
  (`dashboard/src/main.tsx:3,15-19`); the `tours/:tourId` route element is
  unkeyed (`dashboard/src/App.tsx:245`); nothing in non-test dashboard source
  keys a component on the location; `useTour` reloads only when `tourId`
  changes (`dashboard/src/routes/tours/useTour.ts:106`). So the strip neither
  remounts the page nor refetches the tour, and the dialog stays open across
  it.
- Browser Back from the tour page returns to `/tours/past` (the strip
  replaced the `?outcome=1` entry, so it never reopens the dialog). A reload
  after the strip keeps `state.back`: `BrowserRouter`'s history reads it back
  from `history.state` (react-router 7.18.0 `createBrowserHistory`; reference
  section 10 quotes the source lines), and the dialog stays closed because the
  param is gone.
