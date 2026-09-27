# Research findings - dashboard side of Part 2 (plan Tasks 6-8), live-tree drift check

Date: 2026-09-26. Read-only researcher for the build orchestrator of
`feat/staff-notes-past-tours`. Scope: plan Tasks 6, 7, 8 against the live tree
(dashboard code identical to base `0dafe3c1`; branch head `123e50fb` adds only the
design-phase docs), plus the importer checklist and the tour-status invariant sweep.
Byte-exact quotations backing every citation below live in the gitignored run state
`.superpowers/sdd/research-dashboard-part2-reference.md`.

Verdict: the Task 6-8 anchors and code hold against the tree (lint shapes clean by the
installed rule source, tokens and classes all exist). One BLOCKING item sits OUTSIDE the
plan's file list: the App.tsx route change breaks an `npm test` suite in the e2e
workspace (R-1). One SHOULD-FIX is a typecheck error in the plan's own test code (R-2).
The rest are notes.

## R-1 [BLOCKING] `tours/past` in App.tsx fails the perf route-registry test under `npm test`

- Where: plan Task 7 Step 4.8 (the `dashboard/src/App.tsx:237-240` rewrite); spec
  section 7 does not list any `e2e/performance/` file.
- Tree: `e2e/performance/routes.test.ts:347-388` reads `dashboard/src/App.tsx`, collects
  every `<Route ... path="...">` (regex at `:361`), and requires that set, minus its local
  `excluded` set (`:375-382`), to EQUAL `EXPECTED_KEYS` (`:29-38`), which holds `/tours`
  and `/tours/closed` but no `/tours/past`. The suite is in gate 2: root `npm test` runs
  every workspace (`package.json:39`), the e2e workspace's `test` is `vitest run`
  (`e2e/package.json:9`), and its include covers `performance/**/*.test.ts`
  (`e2e/vitest.config.ts:8`). The describe (`routes.test.ts:208`) is not skipped.
- Failure scenario: after Task 7, `npm test` goes red in the e2e workspace on
  "mechanically matches App route elements and proves generated placeholders are
  empty": the received list carries an extra `/tours/past`. No plan step runs that
  suite before gate 2, so it surfaces only at the final gates.
- Correction (planner picks one and records it in the handback; add the file(s) to
  spec section 7):
  - (a) scope-safe: add `/tours/past` to the `excluded` set at `routes.test.ts:375-382`
    and extend the comment at `:371-374` with the reason (a new list view not yet
    profiled), then file a `docs/issues/` entry to give it a profiler surface.
  - (b) full: add a `/tours/past` row to `ROUTES` in `e2e/performance/routes.ts`
    modeled on the `/tours/closed` row (`:589`) with its own terminal (the
    "Past tours list" list, the empty-state text, the alert) and GET contract, add it
    to `EXPECTED_KEYS` and `EXPECTED_WARM` (`routes.test.ts:29-38`, `:71` onward), bump
    the 31 count (`:286-289`), and extend the ledgers (`routes.ts:686-687`, `:740-741`;
    a conditional GET also needs a `warmRequirementClassifications` entry, which
    re-pins `routes.test.ts:433-435`). This changes Cameron's `perf:pages` contract.
  - Either way, add a run of that one file (from `e2e/`, `npx vitest run
    performance/routes.test.ts`) to Task 7 Step 5.
  - Incidental: the line-cited ledgers `routes.ts:686-687`, `:716`, `:740-741` cite
    `ToursPage.tsx` / `useTours.ts` ranges that Tasks 6-7 shift. Their test is
    format-only (`routes.test.ts:420`), so nothing fails; refresh only if (b) is chosen.

## R-2 [SHOULD-FIX] Task 7 bulk test: the held-promise variable fails `npm run typecheck`

- Where: plan line 1876 (declaration) and line 1899 (call) in Task 7 Step 1, the test
  "bulk: select all -> Mark toured (N) re-reads then PATCHes each id sequentially ...".
- Tree: the dashboard typecheck includes test files (`dashboard/tsconfig.json:12`,
  script at `dashboard/package.json:10`) under `strict` (`tsconfig.base.json:3`).
- Failure scenario: the declaration initializes the variable to `null` with a
  function-or-null type; TypeScript narrows it to `null` at that initializer, and the
  only assignment happens inside the `patchTour` mock's closure, which does not widen the
  outer flow type. At the call the non-null assertion yields `never`, so tsc reports
  TS2349 ("This expression is not callable. Type 'never' has no call signatures.");
  an optional call fails the same way. Task 7 Step 6 (`npm run typecheck`) goes red.
- Correction: declare it WITHOUT an initializer and with `undefined` in its type (no
  initializer means no narrowing), the repo's held-promise idiom:
  `dashboard/src/routes/conversation/useMarkThreadRead.test.tsx:61` (called at `:84`),
  also `ConversationDetail.test.tsx:861` and `ContactDetail.test.tsx:2155`. The call
  site can stay as written.

## R-3 [NOTE] `React.MutableRefObject` is deprecated in the installed React types

- Where: plan line 2360 (`PastToursViewProps.bulkBusyRef`).
- Tree: `@types/react` 19.2.17 marks `MutableRefObject` "@deprecated Use `RefObject`
  instead" (`node_modules/@types/react/index.d.ts:1667-1672`); `RefObject` is mutable
  (`:154-159`) and `useRef(false)` returns `RefObject<boolean>` (`:1737`). It compiles,
  and no rule in `eslint.config.mjs` reads deprecations (no type-aware preset).
- Correction: type the prop `React.RefObject<boolean>` (repo convention
  `dashboard/src/routes/contact/useAutoGrowTextarea.ts:26`; `MutableRefObject` appears
  nowhere in `dashboard/src`).

## R-4 [NOTE] "The same ordering the Closed tab has today" is not true

- Where: plan lines 2583-2586 (Task 7 Step 4.5), which the slice report is told to repeat.
- Tree: the Closed fetch runs at PAGE level, in parallel with the lookups:
  `useClosedTours(closed)` is called unconditionally by the page
  (`dashboard/src/routes/tours/ToursPage.tsx:193-194`), so on `/tours/closed` its effect
  fires on mount beside `useContacts` / `useListings`. The Past fetch lives in a child
  that mounts only after `!loading`, so it waits for the four list lookups - a serial
  step the Closed tab does not have.
- Correction: none to code (the child-owned hook is deliberate); word the slice report
  and handback accurately: Past adds one request round trip after the lookups land.

## R-5 [NOTE] A mid-batch tab round trip leaves enabled-but-inert controls and a stale list

- Where: plan lines 2357-2360 and 2433-2475 (Task 7 Step 4.4) against spec 4.5 ("While
  a batch runs, EVERY mark control is disabled").
- Behavior: the render-time `bulkBusy` is CHILD state and resets to false when the Past
  view remounts; the in-flight guard is the page-owned ref. Past -> Active -> Past while
  a batch runs yields a fresh view whose checkboxes and buttons are enabled, but whose
  clicks `markToured` drops silently (the ref is still true). The old batch's
  `reloadPast()` reaches the unmounted hook, so the new view keeps the list it fetched on
  mount, possibly from before the old PATCHes landed. Safety holds: the ref blocks a
  second batch and the per-tour re-read blocks a wrong PATCH.
- Correction (optional): keep the busy FLAG as page state beside the ref (the page
  survives the tab switch), pass both down, set it only inside `markToured` (an event
  handler, so `react-hooks/set-state-in-effect` does not apply), and disable the controls
  on it. Otherwise accept and name the edge in the handback.

## R-6 [NOTE] Exact time-string assertions depend on the host ICU

- Where: plan line 1837 (`getByText` of the row's date-time string) and lines 1941-1942
  (`toHaveTextContent` of the `<label>: <result>` lines).
- Tree: Testing Library normalizes whitespace in the NODE text only, never in a string
  matcher (`node_modules/@testing-library/dom/dist/matches.js:36,42,52`); jest-dom's
  `toHaveTextContent` does the same. On an ICU 72+ host the en-US time format carries
  U+202F before AM/PM, which the node-side `\s+` rewrite turns into a space while the
  expected string keeps it, so these assertions fail there. This runner's ICU emits a
  plain space (`dashboard/src/routes/inbox/inboxTime.test.ts:82-83`), so they pass
  here. The accessible-name assertions are unaffected (no normalization on either side).
- Correction: none needed for tonight's gates. For portability, follow the repo
  convention (`dashboard/src/routes/inbox/inboxTime.ts:7-13`) and map U+202F / U+00A0 to
  a plain space in the page's new `whenLabel`; the Task 9 e2e labels inherit the same
  property.

## R-7 [NOTE] The Past tests' isolation leans on this Vitest version's `restoreAllMocks`

- Where: plan line 1761 (`beforeEach` clears `reloadPast` with `mockClear`) and lines
  1929-1931 (the "dropped rows" test installs a `reloadPast` implementation).
- Tree: Vitest 3.2.6 `restoreAllMocks` calls `mockRestore` on every mock
  (`node_modules/vitest/dist/chunks/vi.bdSIJ99Y.js:3942-3945`), which clears the
  implementation (`node_modules/@vitest/spy/dist/index.js:111-121`), so the file's
  `afterEach` (`ToursPage.test.tsx:240-242`) resets it today. From Vitest 4 on,
  `restoreAllMocks` leaves `vi.fn()` mocks alone; the leaked implementation would empty
  the list after every later batch and break the four later batch tests.
- Correction: reset it with `mockReset` in that `beforeEach` (same meaning today,
  version-proof).

## R-8 [NOTE] Small drift, no behavior impact

- Spec 2.2 anchors: `VIEW_TABS` is `ToursPage.tsx:171-176` (spec: 179-182); `TourRow` is
  `:116-160` (spec: 122-158); the client status filter is `useTours.ts:69` (spec: 70);
  `useClosedTours` is `:106-141` (spec: 111-146). The plan's own Task 6-8 anchors hold.
- Plan line 1674 says 15 new tests; the Task 6 block defines 16 (3 + 2 + 6 + 5).
- Comments the plan leaves stale: `ToursPage.tsx:1-2` ("two URL-backed VIEWS ... Active |
  Closed tabs"), `ToursPage.module.css:1` ("two-section layout") and `:35-36` ("Active /
  Closed view tabs").
- ASCII: all eight Part-2 dashboard files already hold non-ASCII (useTours.ts 7,
  useTours.test.ts 5, ToursPage.tsx 8, ToursPage.module.css 3, ToursPage.test.tsx 11,
  TourDetail.tsx 1, TourDetail.test.tsx 5, App.tsx 14), so only the added-lines check
  (plan lines 134-137) is valid for any of them; Tasks 6 and 8 have no ASCII step - run
  the added-lines check for their files too. Plan line 136's example "ToursPage.tsx
  line 3" is ASCII; its non-ASCII sits at lines 1, 5, 6, 9, 12, 24, 74, 183.

## Checked and holding (no action)

- Task 6: `getTours(params, signal?)` accepts `{ from, to }`
  (`dashboard/src/api/endpoints.ts:2595-2617`); `useTours.test.ts` imports `renderHook,
  waitFor` only (`:11`), mocks the barrel as a bare object (`:19-22`), imports
  `toursDateRange` before the mock (`:13`) and the hooks after it (`:24`), so adding `act`
  and the spread-`importActual` mock is right (the bare mock would throw on the new
  `TOUR_STATUS_LABELS` read in `pastState`'s fallback). `TOUR_STATUS_LABELS.canceled` is
  "Canceled" (`types.ts:873`). The async IIFE that sets state only after an await is clean
  under `set-state-in-effect`: the effect scanner has no function-expression case
  (`eslint-plugin-react-hooks.development.js:46429-46544`) and async IIFEs are never
  inlined (`:43057-43061`). `exhaustive-deps` is warn-level in this preset (`:55415-55418`)
  and allows the unreferenced `epoch` trigger in an effect. The pre-existing
  `useTours.ts:116` error is already named in the plan (lines 3122-3124).
- Task 7: every referenced class exists in `ToursPage.module.css`; the only container is
  `.page` (`:4-11`, unnamed), the page root (`ToursPage.tsx:248`), so `.pastRow` is inside
  it; all fifteen tokens are defined in `dashboard/src/ui/tokens.css` (lines 9-78). The
  fixtures give "Alice Smith", "Bob Jones", `123 Peachtree St, Atlanta, GA, 30303` and
  `456 Oak Ave, Decatur, GA, 30030` (`ToursPage.test.tsx:94-132`, `format.ts:102-112`).
  `Button` takes `size`/`variant="secondary"`/`type`/`disabled`/`aria-label`
  (`Button.tsx:9-32`), `Spinner` takes `center` (`Spinner.tsx:6-12`). Lint by rule
  source: the callback ref with a block body returns void (React 19 `RefCallback`,
  `index.d.ts:176-181`) and trips no rule; `bulkBusyRef` is treated as a ref by name
  (`:44150`, default on at `:31646`) and a ref-reading closure passed as a JSX prop is
  not an error (JSX operands are checked only for a direct ref value, `:44917-44920`,
  `:45340-45343`); render calls nothing impure (the purity list is `Date.now`,
  `performance.now`, `Math.random`). `usePastTours` is never called on Active or Closed,
  so the perf GET contracts for `/tours` and `/tours/closed` are unchanged.
- Task 8: line 26 import, the `modal` union (`:237-239`), the keyed mount of
  `TourDetailLoaded` (`:129-139`), the back link (`:595-597`, "Back to tours") and the
  CTAs (`:547-558`) are exact. The test file's router mock re-exports `actual` and stubs
  only `useNavigate` (`TourDetail.test.tsx:78-82`); react-router-dom 7.18.0 re-exports
  react-router, whose `useSearchParams` calls its own `useNavigate`
  (`chunk-4ZMWKKQ3.mjs:10850-10860`), so the strip navigates for real in tests.
  `NavigateOptions.state` and `LinkProps.state` exist
  (`index-react-server-client-3ykjivgQ.d.ts:171-177,2211,2304,3049`) and
  `createLocation(..., state = null)` (`chunk-4ZMWKKQ3.mjs:234`) confirms the state must
  be carried. The dialog is named "Record outcome" (`TourModals.tsx:311`,
  `Modal.tsx:170-184`); the Modal renders inline with no `aria-hidden`/`inert` on
  siblings, so `waitLoaded()` and the back-link query work while it is open at mount,
  and its "Cancel" is the only one on the page. The state initializer is pure and the
  strip effect is clean (`setSearchParams` is an unknown hook's return, not a `useState`
  setter; the four deps are complete).
- Importer checklist: `ToursPage` is imported only by `App.tsx:47` (routes `:239-240`) and
  `ToursPage.test.tsx:65` (routes `:208-209`); the `closed` prop is used only at
  `App.tsx:240` and `ToursPage.test.tsx:209`, both rewritten by the plan. `useTours.js`
  exports are imported by `ToursPage.tsx:40`, `useTours.test.ts:13,24` and
  `ToursPage.test.tsx:17,37`, all covered. `App.test.tsx` and `AppFrame.test.tsx` render
  `App` but no tours route. The one unlisted consumer is R-1.
- Status writers: every dashboard tour-status PATCH is in `TourDetail.tsx` - Mark toured
  (`:319`, then opens the outcome dialog), Mark no-show (`:325`), Book / Reschedule
  (`:465`, `:468`), Mark already toured (`:482-487`, then the outcome dialog), the exit
  gate (`:496-500`, closes on not-a-fit, else converts), Cancel (`:522`, then the
  close-group ask). `RemindersPanel` writes reminders, not status. The Past runner sends
  the same body as `:319`, adds a re-read guard none of these have, and by spec 4.4 opens
  no dialog - consistent.
- `location.state`: the only reader is `ImageViewerProvider`
  (`dashboard/src/ui/imageViewer/ImageViewerProvider.tsx:79,115,163`), whose helpers
  spread every other key through (`history.ts:85-128`), so `state.back` survives an image
  opened on the tour page. No other back-pointer convention exists: every detail page
  hard-codes its back link (`ConversationDetail.tsx:398`, `GroupTextView.tsx:319`,
  `PlacementDetail.tsx:527`, `TourDetail.tsx:595`). Other tour-link sites, none with
  state or a date in the label (note only): `ToursPage.tsx:141-143`, `TenantFile.tsx:308`,
  `LandlordFile.tsx:213`, `ListingDetail.tsx:1077`, `PlacementDetail.tsx:662`,
  `Card.tsx:206`, `Today.tsx:45,80`.
