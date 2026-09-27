# Plan review R1 - reviewer B (adversarial)

Plan: `docs/superpowers/plans/2026-09-26-staff-notes-past-tours.md` (v4)
Spec: `docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md` (DRAFT 4)
Repo state read: worktree `W:\tmp\staff-notes-past-tours` at a0fa0160 (main @0dafe3c1 plus docs).
Method: every spec decision walked to a task; every plan code block checked against the
real signatures, fixtures, mocks and test setup in the repo. Four claims were checked
empirically, without touching the repo:
(a) the plan's new effects linted with the repo's own react-hooks preset
    (eslint-plugin-react-hooks 7.1.1 `recommended-latest`, loaded by absolute path from
    the main checkout's node_modules, run from a scratchpad script);
(b) a `tsc --strict --noUncheckedIndexedAccess` probe of two test-file patterns;
(c) the Vitest 3.2.6 mock and restore semantics, read from the installed source;
(d) jest-dom 6.9.1 `toHaveTextContent('')`, read from the installed source.

Verified and NOT findings (recorded so the next reader need not redo them):
- The glossary entry (spec 3.8) and all six issue files (spec 8) are already committed
  on the branch (`documentation/GLOSSARY.md:141-156`; `docs/issues/` has all six slugs).
  The plan has no task for them because none is needed.
- The Task 1 app test matches the real harness exactly: `makeWebhookHarness`,
  `createFakeWorld`, `ORIGIN_SECRET` (`app/test/helpers/twilioWebhookHarness.ts:202,414,4275`),
  `world.contacts` / `world.auditEvents` (lines 222, 232), `toProfile`
  (`app/src/jobs/extraction.ts:131`), `ApplyDeps` and the `applyExtraction` ctx
  (`app/src/services/extraction/apply.ts:34-45,160-174`), and `ExtractionResult.noteLines`
  (`app/src/adapters/extraction.ts:87`). The notes append re-reads nothing
  (`apply.ts:686-704` works on the `ctx.contact` snapshot), so the stubbed
  `getById -> undefined` is fine.
- No contact merge or whole-item PUT of an existing contact exists
  (`contactsRepo.ts` PutCommand only at 898, 971 (pointer items) and 1173/1186 (create)),
  so no mutation surface can drop or copy `staff_notes`. No LLM caller other than
  extraction reads a contact.
- `contact_updated` audit `fields` has no dashboard renderer (grep: tests and
  `contacts.ts:1800` only), so the new field name never shows raw in a timeline.
- `TenantFile` is rendered only by `ContactDetail.tsx:1058` and `files.test.tsx:80`;
  none of the existing selectors in `files.test.tsx` or `ContactDetail.test.tsx`
  collides with the new card. Across all e2e specs that open the seeded tenant, only
  `contact-detail.spec.ts:59,73` are page-wide "notes" locators; all the others are
  scoped or use non-colliding names.
- Card heading names include the aside (`Card.tsx:20-24` puts `aside` INSIDE the
  `<h3>`), so the plan's regex heading matchers (`/Staff notes/`) are right and exact
  string names would not be.
- jest-dom 6.9.1 `toHaveTextContent('')` passes ONLY on empty text
  (`@testing-library/jest-dom/dist/matchers-98b869c1.js:444-447`), so the Task 8
  "param stripped" waits are real, and the state-survives-strip unit test is sound.
- `release!()` in the Task 7 bulk test typechecks (tsc probe), despite the
  closure-assignment narrowing.

---

## 1. [BLOCKING] Three new `react-hooks/set-state-in-effect` lint errors - gate 5 cannot pass

What is wrong. Each of the plan's three new effects calls a state setter synchronously in
the effect body:
- `usePastTours` (plan Task 6 step 3, plan line ~1568): `setState((s) => ...)` before
  the async IIFE;
- the ToursPage view-reset effect (plan Task 7 step 4, line ~2284):
  `setSelectedIds(...)`, `setResults(...)`, `setSnapshot(...)`;
- the TourDetail deep-link effect (plan Task 8 step 3, line ~2682): `setModal('outcome')`.

Evidence.
- `eslint.config.mjs:50-51` applies `reactHooks.configs['recommended-latest'].rules`
  to every non-test dashboard file. In plugin 7.1.1 `set-state-in-effect` has
  `severity: ErrorSeverity.Error, preset: LintRulePreset.Recommended`
  (`eslint-plugin-react-hooks.development.js:18137-18145`), and it walks every block
  of the effect function, conditional branches included (`getSetStateCall`,
  line 46429 on).
- The repo already counts it as an error: `docs/issues/lint-backlog-repo-wide.md:37`
  (15 occurrences).
- Baseline run of that preset on the current files: `useTours.ts:116`
  (`useClosedTours`' `setState({ status: 'loading', closed: [] })`) errors with
  `react-hooks/set-state-in-effect`. `ToursPage.tsx` has no react-hooks error today,
  and `TourDetail.tsx` has only `react-hooks/purity` at line 269.
- The same run on the plan's code, copied verbatim into scratchpad probes, reports
  `react-hooks/set-state-in-effect error` for all three effects.
- The plan checked this very preset and got it wrong. Task 8 says "The full
  dependency list satisfies `react-hooks/exhaustive-deps` (the repo lints it,
  `eslint.config.mjs:47-50`)", but it never considered the compiler rules in the
  same preset. No task runs eslint before Task 10.

What it implies. AGENTS.md gate 5: an error "present now and absent there is YOURS
and is BLOCKING". A literal build reaches Task 10 with three blocking lint errors in
three touched files, after the e2e has already run. Clearing them means redesigning
three effects:
- lazy initial state for the deep-link modal (strip in the effect, open via
  `useState(() => ...)`);
- state reset keyed on `view` (for example, an inner component keyed by `view`, or
  state tagged with the view it belongs to);
- a loading flag the hook does not set synchronously in its effect.

Each redesign then needs its tests re-run. The alternative is suppression comments,
which are a review decision, not a plan default. The plan must choose the design now.

## 2. [HIGH] The `usePastTours` window test contradicts the window, and three stale "to now" texts argue for the wrong fix

What is wrong. The plan's `usePastTours` test "once enabled, fetches ONE range query
..." (plan line 1402) asserts
`expect(new Date(params['to']!).getTime()).toBeLessThanOrEqual(Date.now())`.
The implementation (plan line 1498) and spec 4.2 / Q7 / Q9 set `to` = end of today
local (start of tomorrow minus 1 ms), which is always later than `now`.

Evidence. The dashboard test clock is pinned to `2026-07-01T12:00:00Z`
(`dashboard/src/test/setup.ts:32-36`), so `Date.now()` is noon UTC and `to` is
23:59:59.999 local on that day. The assertion fails deterministically in every
timezone west of UTC+12. Three places in the plan describe the OLD window
(`[..., now]`):
- the useTours.ts header comment the builder is told to paste (plan line 1460,
  "query over [start of the local day 90 days ago, now]"; line 1463 also omits the
  Needs-placement exception);
- the ToursPage header comment (plan line 2500, "the last 90 days' tours (to now)");
- the Task 6 commit message (plan line 1611, "90-day window to now").

What it implies. Task 6 step 4 ("Expected: all green") is unreachable as written.
A builder reconciling a red test against three texts that say "to now" is steered
toward changing the implementation. That would violate spec Q9: tours marked toured
or no-show before their time today would drop off every list, the commonest
"needs outcome" moment. Even if the builder fixes the test instead, the pasted
header comments ship documenting a window the code does not have. The plan should
fix the assertion (for example, `to === new Date(y, m, d + 1).getTime() - 1` under
the pinned clock) and all three texts.

## 3. [MEDIUM] `useTours.test.ts` mocks the api barrel without `TOUR_STATUS_LABELS`; the `pastState` fallback test throws

What is wrong. The plan adds a VALUE import to `useTours.ts`:
`import { getTours, TOUR_STATUS_LABELS, ... } from '../../api/index.js'`
(plan line 1456). The existing test file mocks that barrel with a bare factory that
returns only `getTours`.

Evidence.
- `dashboard/src/routes/tours/useTours.test.ts:20-22`:
  `vi.mock('../../api/index.js', () => ({ getTours: ... }))`, with no `importActual`.
- Vitest 3.2.6 wraps a factory mock in a Proxy that THROWS on any key the factory did
  not return:
  `[vitest] No "TOUR_STATUS_LABELS" export is defined on the ... mock`
  (`vitest/dist/chunks/execute.B7h3T_Hc.js:323-330`).
- The plan noticed the mock ("a type-only import survives the module mock", plan
  line 1265) but only for `Tour`. It never converts the factory to the spread form,
  though it does exactly that for `ToursPage.test.tsx` (plan line 1641).

What it implies. The `pastState` test "anything else -> the status label (never
blank)" hits `TOUR_STATUS_LABELS[...]` and fails with the Vitest error. Task 6 step 4
is red for a reason the plan does not name. The fix is small (spread `importActual`
in the factory), but it has to be in the plan.

## 4. [MEDIUM] The only test of the above-toolbar block cannot pass as written, and its label placeholder is wrong

What is wrong. Spec 5 requires ToursPage tests to render "the above-toolbar block for
a result whose row the reload dropped". Two plan tests carry that title:
- "a failed id the reload dropped is reported above the toolbar, and the selection
  follows the listed rows" (plan line 1826). It switches views, which RESETS results
  (the Task 7 view-reset effect), and then asserts there is NO alert. It never
  observes the block.
- "a failed id the reload dropped is reported above the toolbar (results kept on the
  same view)" (plan line 1849). It swaps `pastRows` AFTER the batch has finished
  rendering and waits for a re-render that nothing triggers. The mock hook is not
  reactive, and the last state change (`setBulkBusy(false)`) happened in the same
  batch as `reloadPast()`, before the swap.

Evidence.
- No mock implementation leaks in from the previous test to rescue it.
  `ToursPage.test.tsx:239-241` runs `vi.restoreAllMocks()` after each test. In
  Vitest 3.2.6 that calls `mockRestore` on every `vi.fn`, which calls `mockReset` and
  clears the implementation (`@vitest/spy/dist/index.js:111-120, 166`).
- `P4_LABEL` is hard-coded as `Bob Jones at 88 Sycamore St, Decatur, GA on ...`
  (plan line 1851). `NOT_MARKED_2` is on `u1` (plan line 1720), whose label is
  `123 Peachtree St, Atlanta, GA, 30303` (fixture `ToursPage.test.tsx:117-121` +
  `formatAddress`, `contact/format.ts:102-111`). "88 Sycamore St" is not even `u2`.
- The plan's replace instruction (plan lines 1695-1697) names only "Alice Smith" and
  "12 Peach St, Atlanta, GA". Alice Smith is already the correct c1 name, so the
  instruction leaves `P4_LABEL` wrong.
- The plan concedes the re-render problem and leaves a conditional redesign to the
  builder (plan lines 1943-1950: "if ... cannot observe the re-render, make
  usePastToursSpy reactive ...").
- The SUCCESS variant of the block (`role="status"`, "<tenant> at <property> on
  <date-time>: Marked toured") is not tested anywhere.

What it implies. Task 7 step 5 ("Expected: all green") is unreachable as written.
The spec-5 coverage of the above-toolbar block depends on a builder improvising a
reactive store. Specify the reactive mock (or `rerender`) now, fix `P4_LABEL`, rename
or drop the mis-titled first test, and add the success-line case.

## 5. [MEDIUM] `pastRows` literals miss `reloadFailed` - the typecheck gate fails on the test file

What is wrong. `pastRows` is typed `Omit<PastToursState, 'reload'>` (plan line 1632),
which requires `reloadFailed: boolean`. Two plan tests assign
`pastRows = { status: 'ready', past: [{ ...NOT_MARKED, status: 'toured' }] }`
without it (plan lines 1835 and 1865).

Evidence.
- `dashboard/tsconfig.json` includes `"src"`, so `*.test.tsx` files are
  typechecked by `npm run typecheck` (`dashboard/package.json:10`).
- A `tsc --strict` probe of the exact pattern: `error TS2741: Property
  'reloadFailed' is missing in type '{ status: "ready"; past: string[]; }' but
  required in type 'Omit<PastToursState, "reload">'`.

What it implies. Task 7 step 6 (`npm run typecheck`, "Expected: exit 0") and gate 1
fail. The fix is trivial, but the plan's code is not type-correct as written.

## 6. [MEDIUM] The Past intro copy in the code drops "or a placement"

What is wrong. Spec 4.1 fixes the intro: "Last 90 days: tours that were never marked
toured, toured tours still waiting on an outcome or a placement, and no-shows." The
plan's Global Constraints repeat it correctly (plan line 69). The code the builder
pastes does not: `PAGE_INTRO.past` = "... toured tours still waiting on an outcome,
and no-shows." (plan line 2126).

Evidence. Plan line 2126 against spec section 4.1. Nothing catches the difference:
the unit test (plan line 1732) and the e2e (plan line 2812) both match only
`/^Last 90 days:/`.

What it implies. A literal build ships the wrong staff copy. It is also the one
sentence that tells staff the "Needs placement" rows exist (spec Q3). Fix the literal,
and have one test assert the full sentence.

## 7. [MEDIUM] The e2e never proves "the back arrow returns to Past after the strip"

What is wrong. Spec 5, `tours-past.spec.ts`: "the link lands on the tour page with the
Record outcome dialog open and no ?outcome in the URL; Cancel; the back arrow returns
to /tours/past (the state survived the strip)". The plan's e2e does this instead:
Cancel, then `page.reload()`, then `page.goto('/tours/past')`, then clicks a ROW LINK
(which never goes through the strip), then the back arrow (plan lines 2856-2868). The
back arrow is never clicked on the page reached through the `?outcome=1` strip.

Evidence. Plan Task 9 step 1, lines 2852-2868; spec 5 (tours-past bullet); spec 4.6,
which names this path as the reason `state: location.state` is carried.

What it implies. Only the unit test (MemoryRouter) covers the real-router
setSearchParams-with-state path. The spec deliberately asked the hermetic e2e to
prove it against the real browser history. Click "Back to tours" right after Cancel
on the deep-linked page, before any reload or goto.

## 8. [LOW] Spec-required unit cases are missing

What is wrong. Spec 5 lists these cases; the plan has no test for them:
- `pastState` "outcome-first precedence": a toured tour with no outcome that is
  `convertible: true` must read "Needs outcome". Plan lines 1349-1366 cover only the
  four states and the fallback.
- ToursPage row actions: "none on Needs placement". No Past fixture in plan lines
  1717-1720 is a Needs-placement tour, so a row rendering "Record outcome" for any
  toured tour would pass.
- The above-toolbar success line (see finding 4).

What it implies. The implementations in the plan are correct, but the next change
to `pastState` or `PastTourRow` is unguarded. Each case is one test.

## 9. [LOW] The staff-notes e2e 360px step fails as written; the plan leaves a hedge instead of the known fix

What is wrong. The step resizes to 360px and clicks "Edit staff notes" (plan lines
1199-1200). On a narrow viewport the contact page opens on the comms pane and hides
the profile pane that holds the card.

Evidence. `ContactDetail.tsx:181` (`useState<Pane>('comms')`) and `:984` (the right
pane gets `styles.paneHidden` unless `pane === 'profile'`); the toggle is the
"Profile" button (`ContactDetail.tsx:955-961`, `aria-pressed`). The plan knows this
and hedges ("look for a button or tab named 'Profile' / 'Details'", plan lines
1219-1223).

What it implies. The literal spec step times out. Write the fix into the step: click
the "Profile" toggle after the resize.

## 10. [LOW] The runner's in-flight guard and view reset are not airtight

What is wrong.
- `markToured` guards with `if (bulkBusy) return;` (plan line 2344), which reads
  state captured by the render's closure. Spec 4.5 says "the runner also ignores a
  call while one is in flight". Only the disabled controls enforce that; a ref would
  make it true.
- A view change mid-batch runs the reset effect, and the still-running batch then
  writes `results` and the selection back (plan lines 2371-2376). Returning to Past
  shows stale results that spec 4.5 says reset on a view change.

What it implies. Both are edge cases. A ref-based busy flag, plus a view or epoch
check before writing the results, closes them.

## 11. [LOW] Task 1's stated red state is wrong

What is wrong. Plan lines 372-376 say "the five PATCH tests fail". Before the change,
the "a notes-only PATCH does not stamp or touch staff_notes" test PASSES: `notes` is
already allowlisted (`app/src/routes/contacts.ts:568-573`) and nothing writes
`staff_notes`. The first half of the client-stamp test (400
`no updatable fields supplied`) also passes.

What it implies. A builder checking red-before-green sees 4 failures, not 5, plus a
test that never goes red. It is harmless, but the plan should say which tests are
regression pins.

## 12. [LOW] The row content order is ambiguous in the spec, and the plan picks one side silently

What is wrong. Spec 4.3 says a Past row shows "in this order: the scheduled date and
time ..., the tenant, the property, and the state". The same section's structure
diagram puts identity (tenant, property) first and meta (date-time, chip) second.
The plan renders identity first (plan lines 2199-2206) with no note.

What it implies. It is a product-visible ordering choice. Record it in the slice
report, or ask; do not leave it implicit.

## 13. [LOW] The e2e "none of them is in Active" assertion is vacuous

What is wrong. After `goto('/tours')` the spec waits only for the h1 "Tours" and then
asserts `a[href="/tours/<id>"]` has count 0 (plan lines 2800-2804). The h1 renders
while the page is still loading (`ToursPage.tsx:238-239`; the spinner shows below),
so the zero-count checks can pass before any list exists.

What it implies. Wait for a loaded marker first (for example, the "Upcoming" region
or its empty-state text), then assert the absence.

## 14. [LOW] Gate and commit hygiene gaps

What is wrong.
- Gate 4 is `timeout 1500 npm run e2e` (plan line 2934), with no recovery step if the
  timeout fires. AGENTS.md: killing a suite orphans its stack, and
  `reuseExistingServer` then adopts the orphan on a commit match. After an abort you
  must prove the lane's ports are free.
- Every commit chains `git status --porcelain && git add ... && git commit`, so the
  status is printed but never read before the commit. The MERGE_HEAD check in the
  shell notes (plan line 120) appears in none of the commit commands.
- Every commit hard-codes `Co-Authored-By: Claude Fable 5.1`. `.claude/CLAUDE.md`
  routes implementation children to opus, and AGENTS.md requires the trailer to name
  the authoring model.

What it implies. These are process defects rather than product defects. Add a
timeout-recovery step (e2e:stop, check the ports), split status from commit, and
make the trailer the authoring model's.
