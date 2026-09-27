# Plan review R1 - reviewer A (adversarial)

Plan: `docs/superpowers/plans/2026-09-26-staff-notes-past-tours.md` (v4)
Spec: `docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md` (DRAFT 4)
Base read: worktree `W:\tmp\staff-notes-past-tours` @ a0fa0160 (main 0dafe3c1 + docs)
Method: every claim below was checked against the repo file:line named, or against
the installed package source under `W:\AI Projects\Housing Choice\HC Application\node_modules`.
Three claims were proven by running tools read-only: ESLint on plan snippets fed
through `--stdin --stdin-filename dashboard/src/...` (the repo config, so the
dashboard rule set applies), and `tsc --strict --noUncheckedIndexedAccess` on
plan snippets copied to a scratch directory. No suite was run and the repo was
not modified.

Question asked: if a builder with no context runs this plan literally, do they
produce the spec? Not without deviating. Four HIGH findings each stop a TDD step
or a completion gate from going green as written.

---

## F1 [HIGH] usePastTours test asserts `to <= now`, which contradicts the implementation; three plan comments also say "to now"

What is wrong. Task 6 Step 1, test "once enabled, fetches ONE range query with the
Past window" (plan lines 1401-1402), asserts
`new Date(params['to']).getTime() <= Date.now()`. The plan's own implementation
(lines 1496-1499) sets `to` to the start of tomorrow minus 1 ms, which is later
than `Date.now()` at any moment today. So the assertion can never pass, and
Step 4 ("Expected: all green") cannot be met.

The plan also contradicts itself about which side is right:
- The code (1496-1499), the Global Constraints (56-57), the `pastToursDateRange`
  docstring (1490-1495) and the neighboring test (1286-1291) all say end of today.
- The failing assertion, the useTours.ts header comment the builder is told to
  paste (1460: "[start of the local day 90 days ago, now]"), the Task 6 commit
  message (1611: "90-day window to now") and the ToursPage header text (2500:
  "(to now)") all say `now`.

The same header comment (1463-1464) also says a toured tour with an outcome is
dropped, and leaves out the "Needs placement" exception.

What it implies. The builder hits a red test with four plan artifacts pointing
each way. A builder who fixes the code to match the test and comments ships the
window the spec rejects (spec 4.2; section 9 Q7 and Q9): a tour marked toured or
no-show before its time today would drop off Past. Fix: delete the upper-bound
assertion, or assert `to === new Date(y, m, d + 1).getTime() - 1`. Then correct
the three comments.

## F2 [HIGH] useTours.test.ts mocks the api barrel without `actual`, so the new `TOUR_STATUS_LABELS` import throws in the pastState fallback test

What is wrong. Task 6 Step 3 changes the useTours.ts import to
`import { getTours, TOUR_STATUS_LABELS, type Tour, type TourStatus }` (plan
1455-1456). `pastState` reads `TOUR_STATUS_LABELS[tour.status]` on its fallback
path (1536).

The existing test file mocks the barrel with a bare factory that returns only
`getTours` (`dashboard/src/routes/tours/useTours.test.ts:19-22`). It does not
spread `importActual`. Vitest 3.2.6 wraps a factory mock in a Proxy that throws
on any missing export:
`[vitest] No "TOUR_STATUS_LABELS" export is defined on the ... mock`
(`node_modules/vitest/dist/chunks/execute.B7h3T_Hc.js:330`).

The plan considered only the type import: "a type-only import survives the
module mock" (1264-1265). It never addresses the new value import.

What it implies. The test "anything else -> the status label (never blank)"
(1363-1365) goes red and stays red under the plan's instructions. Fix: convert
that mock to the `importActual` spread form (as ToursPage.test.tsx:55-63 already
does), or add `TOUR_STATUS_LABELS` to the factory.

## F3 [HIGH] Three new effects trip `react-hooks/set-state-in-effect`, an ERROR in dashboard source, so gate 5 fails

What is wrong. The root ESLint config applies the eslint-plugin-react-hooks
7.1.1 `recommended-latest` rules to `dashboard/**/*.{ts,tsx}`
(`eslint.config.mjs`, the `dashboard/**` block). It turns the rule off only for
`*.test.*` files. `set-state-in-effect` is in that preset at severity error.
Running ESLint on the plan's snippets under a dashboard path gives three errors:

1. `usePastTours`: `setState((s) => ...)` in the effect body (plan 1568).
2. `ToursPage`: the per-view reset effect `setSelectedIds / setResults /
   setSnapshot` (plan 2284-2288).
3. `TourDetailLoaded`: `setModal('outcome')` in the deep-link effect (plan 2682).
   The `setSearchParams` call is not flagged.

Baseline check: at base, only the pre-existing `useTours.ts:116`
(`useClosedTours`) reports this rule. So all three are new lines and fail gate 5
by the AGENTS.md baseline-comparison rule. The plan's only lint note is about
`exhaustive-deps` (2689-2691).

What it implies. The branch cannot pass gate 5 as written, and the fix changes
structure:
- TourDetailLoaded mounts after the tour loads and is keyed by `tourId`
  (TourDetail.tsx:129-131). So `modal` can take a lazy `useState` initializer
  from the query string, and the effect can keep only the strip.
- The reset can go away if App.tsx gives each view's element a distinct `key`.
- usePastTours needs a restructure or a justified disable.

Name this in the plan so the builder does not improvise under gate pressure.

## F4 [HIGH] The textarea sits inside its `<label>`, so the e2e's `getByLabel('Staff notes', { exact: true })` misses whenever the box holds text

What is wrong. StaffNotesCard wraps the textarea inside the label:
`<label><span srOnly>Staff notes</span><textarea value={draft} .../></label>`
(plan 882-892). Two library behaviors combine:

1. React 19.2.7 writes a controlled textarea's value into `defaultValue` on mount
   and on every update when no `defaultValue` prop is given
   (`react-dom-client.development.js`, `initTextarea` / `updateTextarea`).
   `defaultValue` is the textarea's child text node.
2. Playwright 1.61's label engine takes the label's text from
   `elementText(label)`. That function concatenates EVERY descendant text node,
   the textarea's included, and `exact: true` compares
   `normalized === 'Staff notes'` (`playwright-core/lib/coreBundle.js`,
   `getElementLabels` / `elementText` / `createTextMatcher`).

So with the box prefilled, the label reads "Staff notes<stored text>" and the
exact locator matches nothing.

Testing Library does NOT show this. `getLabelContent` skips textarea children
(`@testing-library/dom/dist/label-helpers.js:10-16`). The StaffNotesCard unit
tests go green while the e2e goes red.

Failing e2e lines:
- 1201: `expect(staffCard.getByLabel('Staff notes', { exact: true })).toBeVisible()`
  after "Edit staff notes" on a saved box.
- 1210: the cleanup `.fill('')`.

The first `+ Add` pass works only because the box starts empty. This also breaks
the property spec 3.6 states: "`getByLabel('Staff notes', { exact: true })`
resolves it".

What it implies. The tenant-staff-notes spec cannot pass, and so neither can
gate 4. Fix: a sibling `<label htmlFor={id}>` with `useId` (label text is then
the span only), or give the textarea `aria-labelledby` pointing at the hidden
span.

## F5 [MEDIUM] The 360px step clicks inside a pane that is `display: none` at that width

What is wrong. The contact page's profile pane defaults to hidden on narrow
widths:
- `pane` starts as `'comms'` (`ContactDetail.tsx:181`).
- The profile column gets `paneHidden` unless `pane === 'profile'`
  (`ContactDetail.tsx:984`).
- `.paneHidden { display: none }` under `@media (max-width: 860px)`
  (`ui/twoPaneShell.module.css:128,168-169`).

At `NARROW_360` the Staff notes card is not rendered visibly, so
`staffCard.getByRole('button', { name: 'Edit staff notes', exact: true }).click()`
(plan 1200) waits out the test timeout. The plan knows it might ("If the card is
not visible at 360px, click the pane switcher", 1219-1223) but ships the code
without the click.

The switcher is deterministic: `role="group"` `aria-label="View"`, button
"Profile" (`ContactDetail.tsx:946-961`).

What it implies. The literal spec fails. Put the click in the code:
`page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Profile' }).click()`.
That also removes a guess. F4 must be fixed as well for this step to pass.

## F6 [MEDIUM] The Past intro copy in Task 7 drops "or a placement"; no test would catch it

What is wrong.
- Spec 4.1 (lines 336-338) and the plan's Global Constraints (69-71): "Last 90
  days: tours that were never marked toured, toured tours still waiting on an
  outcome or a placement, and no-shows."
- The code the builder pastes, `PAGE_INTRO.past` (plan 2126): "... toured tours
  still waiting on an outcome, and no-shows."

The unit test checks only `/^Last 90 days:/` (1732), and so does the e2e (2812).

What it implies. The wrong staff-facing copy ships green. The dropped clause
names a row state this feature adds ("Needs placement"). Fix the literal, and
assert the full string in the unit test.

## F7 [MEDIUM] ToursPage.test assigns `pastRows` without `reloadFailed` (TS2741), which fails dashboard typecheck

What is wrong. `pastRows` is typed `Omit<PastToursState, 'reload'>` (plan 1632),
which requires `reloadFailed`. Two assignments omit it:
`pastRows = { status: 'ready', past: [...] }` at 1835 (inside
`reloadPast.mockImplementation`) and at 1865.

`tsc --strict` on the same shape reports:
`TS2741: Property 'reloadFailed' is missing`.

The dashboard typecheck includes test files (`dashboard/tsconfig.json`:
`"include": ["src", ...]`). So Task 7 Step 6's `npm run typecheck` and gate 1
fail. Vitest does not type-check, so Step 5 would look green.

What it implies. A gate failure the plan's own TDD loop cannot surface. Add
`reloadFailed: false` at both sites.

## F8 [MEDIUM] The required "above-toolbar block" test is not reliably delivered

What is wrong. Spec section 5 requires a ToursPage test that renders the
above-toolbar block "for a result whose row the reload dropped". The plan's two
candidates both miss:

1. The first test is titled "a failed id the reload dropped is reported above
   the toolbar, and the selection follows the listed rows" (1826-1847). It never
   asserts the block. It switches views and asserts the reset.
2. The second test, "results kept on the same view" (1849-1870), swaps
   `pastRows` AFTER `await waitFor(reloadPast called)`. The mocked hook is not
   reactive. The re-render that `markToured` triggers (`setResults` /
   `setBulkBusy`, 2371-2378) lands before the swap, with the old rows. Nothing
   renders again after the swap.

   The rendered alert is then the per-row one on p4, "Could not mark toured:
   Changed since the list loaded", which does not contain the label. So the
   `waitFor` times out.

   Its `P4_LABEL` is also wrong. NOT_MARKED_2 is tenant c2 at unit u1 (plan 1720),
   and the file's fixtures make that
   "Bob Jones at 123 Peachtree St, Atlanta, GA, 30303"
   (`ToursPage.test.tsx:95-134`; `format.ts:102-111`). The plan writes
   "88 Sycamore St, Decatur, GA", and its replacement instruction (1695-1697)
   covers only the Alice Smith / "12 Peach St" placeholder.

The plan hedges with a `useSyncExternalStore` fallback (1943-1950) that the
builder has to design. The stray `render(<div />)` lines (1857-1858) are also
dead code.

What it implies. The one test that proves "no result is ever silent" (spec 4.5)
fails or gets rewritten ad hoc. Fix the plan text:
- make the mock reactive from the start;
- set `reloadPast`'s implementation to swap rows before the runner re-renders;
- correct `P4_LABEL`;
- rename or merge the mislabeled test.

## F9 [MEDIUM] `timeout 1500 npm run e2e` is shorter than the suite's documented runtime under load; a kill orphans the stack with no recovery step

What is wrong. Task 10 caps gate 4 at 25 minutes (plan 2934). The e2e config
records that under pressure the suite runs at "1.93-1.96x its 17.9m idle
baseline" (`e2e/playwright.config.ts:105-109`). That is about 35 minutes, and it
"meets 2x routinely on a shared box". The plan itself predicts another mission's
e2e running tonight (2939-2941).

What it implies. A healthy run is likely to be killed mid-suite. Two AGENTS.md
rules then apply:
- Killing a suite orphans its stack.
- `reuseExistingServer` adopts an orphaned same-commit stack.

The plan gives no instruction for this case: tree-kill, `e2e:stop`, prove the
lane ports are free, re-run. Raise the cap well above 2x baseline, or state the
recovery procedure.

## F10 [MEDIUM] The Past e2e never proves that the back pointer survives the `?outcome=1` strip

What is wrong. Spec section 5 (lines 666-669): "...no `?outcome` in the URL;
Cancel; the back arrow returns to `/tours/past` (the state survived the strip)."

The plan's e2e (2852-2868) goes Cancel, `page.reload()`, then
`page.goto('/tours/past')`, then the PLAIN row link, then the back arrow. That
path never passes through the strip. The strip-preserves-state behavior (the
react-router `createLocation` null-state trap, spec 4.6) is proven only in a
MemoryRouter unit test.

What it implies. The one browser-history proof the spec asked for is missing.
Fix: click "Back to tours" right after Cancel, or after the reload
(`history.state` survives a reload), and assert `/tours/past`, before the
separate row-link check.

## F11 [LOW] Two e2e assertions cannot catch the regression they exist for

1. The "no send" proof (plan 2836-2844) reads the fake's outbound count right
   after the row shows "Marked toured". A send enqueued by the PATCH would go
   out asynchronously via the worker (all job traffic goes through
   `jobs.enqueue()`, AGENTS.md), after the assertion. Take the second count at
   the END of the test, several steps later.
2. "Active never shows them" (2799-2804) asserts
   `a[href="/tours/<id>"]` has count 0 right after the h1 is visible. The h1
   renders before the list loads (`ToursPage.tsx:250` versus the spinner gate at
   276-284), so the count-0 check passes before any row exists. The Active
   window starts at today anyway (`useTours.ts:37-43`). Wait for the Upcoming
   region, or drop the check.

## F12 [LOW] No test pins the spec's "outcome-first precedence" for pastState

Spec section 5 (line 608) requires "pastState for the four cases plus the
fallback and the outcome-first precedence". Spec 4.3 describes that case as a
toured row with no outcome that is somehow `convertible` reading "Needs outcome".
The plan's pastState block (1349-1366) has the four cases and the fallback, but
no precedence case. The implementation orders the checks correctly (1533-1534),
but a reorder would ship green.

## F13 [LOW] Task 1 Step 2's expected red state is wrong

The plan says "the five PATCH tests fail" (372-376). The fifth test, "a
notes-only PATCH does not stamp or touch staff_notes" (251-261), passes on base:
a `notes` PATCH already works and never touches `staff_notes`. It is a
regression pin, like the POST and AI tests. The count mismatch (4 red, not 5) may
send a builder hunting for a missing failure.

## F14 [LOW] The runner's in-flight guard reads render-scoped state

`markToured` returns early on `if (bulkBusy) return;` (2344), where `bulkBusy` is
React state captured by the closure. Two calls in the same render frame both see
`false` before the re-render disables the controls. Spec 4.5 (477-479) says the
runner "ignores a call while one is in flight". A `useRef` flag makes that exact.
Disabled controls cover the UI path in practice, hence LOW.

## F15 [LOW] Plan text that does not match the repo or the spec

- Task 8 Step 1 says to place the new describe "INSIDE the file's outer describe
  so it inherits the loaded-page beforeEach" (2540-2544).
  `TourDetail.test.tsx` has no outer describe. Its `beforeEach` is file-level
  (line 222) and every describe is top-level. Appending at file level is
  correct. The "replicate verbatim" alternative would double the setup.
- Every commit trailer is hard-coded "Claude Fable 5.1" (463, 506, and so on).
  AGENTS.md wants the trailer to name the authoring model, and the Claude
  overlay routes children to `opus`.
- Spec 4.3's prose order ("date and time, the tenant, the property, and the
  state", 401-403) conflicts with its own structure block (identity, then meta;
  421-429). The plan follows the block (2199-2206). This is a spec ambiguity; say
  so in the plan so a reviewer does not flag the build.
- Spec 3.8 (glossary) and section 8 (six issues) have no task. Both were already
  delivered by the branch's design commits: GLOSSARY.md lines 141-156, and
  `docs/issues/*.md` for all six slugs exist. The plan should say so, so the
  handback's per-spec-item table has something to cite. Spec section 7 says
  "five files under docs/issues/" while section 8 lists six.

---

## Verified, no finding (for downstream reviewers)

- App test names are real:
  - `createFakeWorld`, `makeWebhookHarness`, `ORIGIN_SECRET`
    (`twilioWebhookHarness.ts:202,414,4275`);
  - `world.contacts` array and `world.auditEvents` with `event_type` / `entityKey` /
    `payload` (213-234, 2233-2247);
  - `TEST_SESSION_COOKIE`, `createLogCapture`, `createLogger({ destination, level })`
    (used the same way in `contactsCrud.test.ts` and `extractionApply.test.ts`).
- The fake contact `update` stores `''` for non-index keys (2050-2071).
- `ApplyDeps` has exactly the four `extraction` picks (`apply.ts:36-39`).
- `autoPrefix` is UTC (`apply.ts:154-158`).
- A `pets` write on an empty tenant lands directly (`extractionApply.test.ts:169-172`).
- `toProfile` names its fields (`jobs/extraction.ts:131-159`).
- The PATCH anchors exist: `notes` block `contacts.ts:568-573`; consent stamp
  1503; audit `fields` 1800.
- `contactsRepo.ts:134` is `park_reason`.
- No other code path Put-replaces a contact item: the import uses UpdateCommand,
  and there is no merge route. Every contact-returning route returns the whole
  item, so `setContact` never drops `staff_notes`.
- The only model call site is extraction.
- Dashboard names are real:
  - `Card` renders `<section><h3>` with the aside inside the heading
    (`Card.tsx:18-28`);
  - `CardAction` has a `label` prop; `EmptyRow`, `NotesText({ text })` and
    `responseClass.muted` exist;
  - `Button` takes `size` / `variant` / `type` / `aria-label`;
  - every CSS token the plan uses exists in `ui/tokens.css`;
  - the ToursPage CSS classes the plan reuses exist;
  - `getTour` / `patchTour` / `getTours(params, signal)` / `updateContact`
    signatures match;
  - the `Tour` type carries `outcome`, `convertible`, `convertedPlacementId`;
    `TOUR_STATUS_LABELS.canceled === 'Canceled'`;
  - `ApiError(status, code, message, body?)`.
- `ToursPage` is used only by App.tsx:239-240 and its test. `TenantFile` is
  rendered only at ContactDetail.tsx:1058. `TourDetail` is rendered only at
  App.tsx:243.
- The TourDetail test's router mock spreads `actual` and replaces only
  `useNavigate` (79-82). `useSearchParams` uses react-router's internal navigate,
  so the strip performs a real navigation in the unit test.
- react-router is 7.18.0.
- e2e names are real:
  - `listThreads(request)` with `messages[].direction` (`fakeTwilio.ts:167-209,375`);
  - `NARROW_360`, `WIDE_RESTORE`, `expectNoHorizontalOverflow` (`support/viewport.ts`);
  - `expectTodayReady`;
  - lean seed units `unit-0001` / `unit-0002` and no seeded tours.
- `POST /api/tours` has no tenant/unit dedupe and returns `{ tour }` 201.
  scheduled -> no_show is legal, and the no-show check-in is manual
  (`tours.ts:1356-1357`).
- Playwright runs `workers: 1`, `fullyParallel: false`.
- `npm run e2e -w @housingchoice/e2e -- --grep` passes the grep to Playwright,
  unlike the root form, and reuses a live session (`e2e/README.md:55`).
- The ToursPage runner, ref callback and list logic lint clean apart from F3.
- StaffNotesCard lints clean.
- The `let current; try {...} catch { continue }` pattern type-checks.
