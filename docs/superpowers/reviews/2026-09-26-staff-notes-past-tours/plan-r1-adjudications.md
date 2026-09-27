# Plan review round 1 - adjudications

Plan: `docs/superpowers/plans/2026-09-26-staff-notes-past-tours.md` v4
@a0fa0160 -> v5 (this round). Spec DRAFT 4 (two precision edits folded in:
4.3 row order, 7 issue count).
Reviewers: A (`plan-r1-reviewer-a.md`, 15 findings) and B
(`plan-r1-reviewer-b.md`, 14 findings), independent, same brief, opus; both
ran ESLint / tsc probes on plan snippets from a scratchpad.
Planner: Fable, overnight unattended run.

Verification: the planner re-read `eslint.config.mjs:40-70` (the
`recommended-latest` preset is applied to non-test dashboard files and
`set-state-in-effect` is explicitly turned OFF only for test files, which
proves it is ON elsewhere), the ToursPage test fixtures (c1 Alice Smith, u1
"123 Peachtree St ... 30303"), the contact page's segmented "View" toggle
(`ContactDetail.tsx:944-962`, buttons "Comms" / "Profile"), the e2e timing
comment (`playwright.config.ts:105-109`) and TourDetail.test's module-level
`beforeEach` (line 222).

Counts: 29 findings -> 29 ACCEPT (all folded into plan v5), 0 REJECT,
0 DEFER. Duplicates: A1=B2, A2=B3, A3=B1, A5=B9, A6=B6, A7=B5, A8=B4,
A10=B7, A11=B13, A12=B8, A13=B11, A14=B10, A15=B14+B12.

## Design-shaping accepts (how the plan changed)

| # | finding | ruling |
|---|---|---|
| B1 / A3 [BLOCKING] | three new effects set state synchronously; `react-hooks/set-state-in-effect` is an error in dashboard source; gate 5 fails | ACCEPT. Hook: no synchronous write - status stays `idle` until the first result (the page already treats idle as loading) and the `'loading'` value is gone; every write is in the async callback. Page: the per-view reset EFFECT is deleted and App.tsx keys each tours route element by view so a tab switch REMOUNTS the page (tests wire the same keys). Tour page: the dialog is opened in the `useState` INITIALIZER from the URL (the loaded component mounts per tourId after the tour loads), and the effect only navigates (the strip), which is not a state setter. Plan header names the rule. |
| A4 [HIGH] | the textarea nested inside its `<label>` makes the label's accessible text include the prefilled value, so `getByLabel('Staff notes', { exact: true })` misses a prefilled box | ACCEPT. Label and textarea are siblings associated by `htmlFor` / `id` (`useId`). |
| A9 / B14 | `timeout 1500` is below the suite's documented loaded runtime; no orphan recovery | ACCEPT. 2700s, with the orphan recipe (e2e:stop, prove the lane's ports free, isolate the failing file) written into Task 10. |
| A14 / B10 | in-flight guard reads render-time state | ACCEPT. A `bulkBusyRef` guards re-entry; the remount-on-tab-switch case is documented (setters land on the unmounted instance; sent PATCHes stand). |

## Test-correctness accepts

| # | ruling |
|---|---|
| A1 / B2 | the `to <= now` assertion replaced by exact end-of-today and from-90-days assertions; every "to now" text corrected. |
| A2 / B3 | `useTours.test.ts`'s api mock now spreads `importActual` so the barrel's label constants exist. |
| A7 / B5 | every `pastRows` literal carries `reloadFailed`. |
| A8 / B4 | the dropped-rows test rewritten: the reload swap happens synchronously inside `reloadPast` so React's batched render sees it; both a dropped FAILURE (alert) and a dropped SUCCESS (status) are asserted from the snapshot; labels use the real fixtures (u1 = "123 Peachtree St, Atlanta, GA, 30303"); a second test proves the tab-switch remount clears selection and results. |
| A12 / B8 | added: `pastState` precedence (no outcome beats convertible); "Needs placement" row has no action; dropped-success line. |
| A6 / B6 | intro copy in the code now carries "or a placement"; the test asserts the whole sentence. |
| A10 / B7 | the Past e2e clicks the back arrow on the page reached THROUGH the `?outcome=1` strip, then separately on the plain row-link path. |
| A11 / B13 | the "none in Active" check waits for both Active regions first; the no-send count is re-read after a 2 s settle. |
| A5 / B9 | the staff-notes e2e presses the "View" group's "Profile" button before the 360px step (the profile pane is display:none at that width until pressed). |
| A13 / B11 | Task 1's red state says four, not five. |
| A15a | Task 8's new tests are a top-level describe; the module-level `beforeEach` (line 222) applies. |
| A15b / B14 | commit trailers name `<AUTHORING-MODEL>`; `git status` is its own command; the MERGE_HEAD check precedes every commit. |
| A15c / B12 | spec 4.3 row order clarified (identity left, date-time + chip right); the plan follows it. |
| A15d | spec 7 says six issue files; the plan header says the glossary entry and the six issues are already committed. |

## Round 2

Round 1 changed how three tasks are built (the lint-driven redesign of the
hook, the page reset and the tour page), so a round 2 runs on the v5 delta
with reviewer A continued (it ran the ESLint and tsc probes and can re-run
them against the redesigned snippets); reviewer B's report is handed to it.
