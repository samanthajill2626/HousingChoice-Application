D5 checked plan v4 section 9 (S5.1-S5.7, plan lines 14353-18866) against the live tree in W:\tmp\today-checklist (source = main @970a29b9): every quoted anchor, names and signatures, per-commit dashboard typecheck, RED/GREEN predictions, importers of everything S5 renames or removes, react-hooks lint, the mocking pattern, mutationCatalog impact, and spec r8 plus rulings PR31-PR36, PR63-PR69, PR102, PR103. Result: 3 MINOR, no BLOCKER, no MAJOR.

## D5-1 - MINOR - S5.6 Step 2 RED list gets two cases wrong

- Plan location: Task S5.6, Step 2 (plan ~17996-18017); the cases are at plan ~17634-17639 and ~17935-17948.
- What the plan says: "every All-caught-up case" is RED on the old page ("no such sections, copy or buttons"), and "The unchanged cases stay green". The fate table marks "a failed section load says so in the section ..." as CHANGED (fixture `identify`), but Step 2 does not list it as RED.
- What the tree holds:
  - The old page shows "All caught up" for an empty ready queue (`dashboard/src/routes/today/Today.tsx:289-294`) and never renders an "At a glance" heading. So the new case "no At a glance section when both of its parts are empty" is GREEN before Step 3, not RED.
  - The old `GROUP_META` (`Today.tsx:38-44`) has no `identify` entry. So in "a failed section load says so in the section ...", the identify row is never rendered and `getByRole('link', { name: /James Porter/ })` throws. That case is RED before Step 3.
  - Every other prediction holds: on the old page each new-heading, AI-line, layout, 5-row and fallback case fails, and the unchanged pins pass.
- Correction (paste into S5.6 Step 2): "Exceptions: 'no At a glance section when both of its parts are empty' is GREEN on the old page. It pins the new rule and is not a RED, and the step still has many real REDs. 'a failed section load says so in the section and leaves the rest of Today alone' is RED on the old page, because the old GROUP_META does not render its identify fixture. It goes GREEN after Step 3."

## D5-2 - MINOR - S5.7 Step 4 expects lint exit 0, but useTours.ts already has one error

- Plan location: Task S5.7, Step 4 (plan ~18766-18780).
- What the plan says: "Expected: exit 0 (`docs/issues/lint-backlog-repo-wide.md` names none of these files)."
- What the tree holds:
  - `dashboard/src/routes/tours/useTours.ts:128` (`useClosedTours`) calls `setState({ status: 'loading', closed: [] })` directly in an effect body. That is `react-hooks/set-state-in-effect`: plugin 7.1.1 flags any synchronous setState in the effect callback's own blocks (`node_modules/eslint-plugin-react-hooks/cjs/eslint-plugin-react-hooks.development.js:46327-46540`).
  - Earlier gate runs recorded it as pre-existing at that exact line: `docs/superpowers/reviews/2026-10-01-tour-auto-close/code-review/spec-conformance-r1.md:94` and `docs/superpowers/reviews/2026-09-30-today-past-tours/gate-runs.md:17`.
  - `useTours.ts` was last changed on 2026-10-02 (04e88501), before the 2026-10-07 lint cleanup that paused the react-hooks errors.
  - The backlog issue lists no files by name, so its silence is not evidence.
  - The S5.2 and S5.3 edits are all below line 128, so the error stays at :128.
- Correction (paste into S5.7 Step 4): "Expected: exactly ONE error, pre-existing: `dashboard/src/routes/tours/useTours.ts:128 react-hooks/set-state-in-effect` (useClosedTours, not touched by S5, present at main @970a29b9). Confirm it by baseline, name it in the S5 report and leave it. Any other error is S5's." The same note applies to the S8 gate 5 run, which lints this file because the branch touches it.

## D5-3 - MINOR - S5.7 Step 1 expected grep hits miss one comment

- Plan location: Task S5.7, Step 1 (plan ~18735-18747).
- What the plan says: the only expected hit in `buildToday.test.ts` is "the inversion comment" (the S5.4 1d block).
- What the tree will hold after S5.4: the S5.4 step 1f replacement adds the comment "// Was a tenant_1to1 Unreplied row; Unreplied is gone (spec 2026-10-23 4)," (plan ~15911) to "still surfaces the unknown 1:1 thread beside it". It also matches the case-insensitive `unreplied` grep.
- Correction (paste into the buildToday.test.ts bullet of S5.7 Step 1): "...and the S5.4 1f comment in 'still surfaces the unknown 1:1 thread beside it' ('Was a tenant_1to1 Unreplied row; ...'). It records the removal and is not a defect."

## Verified with no finding

- Anchors: every quoted old text in S5.1-S5.6 matches the tree, allowing for [U+xxxx] notation and bullet indent:
  - `Today.module.css` `.sectionError` (232-237) and `.emptyBody` (367-371);
  - `useTours.ts` 216-218, 239-243 and 254-261;
  - `useTours.test.ts` 26-28, 30-32 and 296-302;
  - `tourTime.ts` 87-91; `tourTime.test.ts` 10-13 and 102;
  - `useTodayPastTours.test.tsx` 1-8, 53-58, 78-118 and 215-216;
  - `useToday.test.tsx` 35-45;
  - `buildToday.test.ts` 115, 130/155 (exactly 2 for `replace_all`), 138-139, 200-246, 301-310, 374 and 395-405;
  - `types.ts` 488-503, 523-529 and 2180;
  - `useToday.ts` 15-17, 21, 30-31, 41-43, 55, 73-75, 83-88, 108-110, 145-147 and 151-156;
  - `buildToday.ts` 7-15, 30-32, 38-46, 61-73, 138-151, 197-198, 280-282, 287-294, 301-318 and 331-333;
  - the 2026-08-03 pins at `Today.test.tsx` 166-169, reproduced byte-for-byte in the S5.6 rewrite.
- PR102: no S5 code or test renders or asserts a heading count, and nothing is left over from PR64. No `.count` style. The bare-label pins are kept, along with the relay case's "no count chip" comment, and the S5.6 Step 5 grep proves the em-dash pin line survived.
- PR103: no top-level `people` anywhere in S5; `people` appears only on `QuietShareProperty`.
- PR66: the server already sends `generatedAt: nowIso` (`app/src/routes/today.ts:1111`), with `now = Date.parse(nowIso)` (:332-333). S4 3d passes that same `now` to `buildQuietShares`. `useToday` drops `generatedAt` today (`useToday.ts:55`); S5.4 exposes it.
- PR32: `useToday` subscribes to placement, conversation, suggestion, tour and contact events (`useToday.ts:142-157`, 300 ms debounce). The fallback runs only on `ApiError` 404 (:59). Neither changes.
- Compile: the dashboard typechecks after every commit.
  - `'unreplied'` is read only by `Today.tsx` (GROUP_META), its test, `buildToday.ts` and `types.ts`. PR69's sequencing holds.
  - The only other reader of `TodayState` is `Today.tsx`.
  - `types.ts` stays import-free; e2e `tour-roster.spec.ts` and app `contactTimeline.test.ts` import it.
  - `isCaseworkerContact` takes `{ type?: unknown; role?: unknown }`, so `QuietSharePerson` fits.
  - The api barrel re-exports `types.ts`. Every CSS token used exists in `ui/tokens.css`.
- Importers: `TODAY_PAST_TOURS_CAP` has exactly 3 readers (`useTodayPastTours.ts`, `useTours.test.ts`, `useTours.ts`), all handled. The S5.3 grep expects one hit, and that is correct. `selectOffRangeTours` is refactored without a behavior change. `buildToday` exports are unchanged, and no other dashboard file reads the old copy except `useToday.ts:146`, which S5.4 edits.
- Lint on new code: the conditional seed in `QuietSharesSection` is not flagged (validateNoSetStateInRender reports only setState in unconditional blocks, plugin dev.js ~45367). `const Heading = 'h3' | 'h2'` is not a static-components hit. No new unused imports. Test files have the compiler rules off.
- Tests:
  - The mocking pattern matches the existing suites: `Today.test.tsx` mocks `./useToday.js` and `./useTodayPastTours.js`; `useToday.test.tsx` and `useTodayPastTours.test.tsx` mock the api barrel; `QuietShares` and `TodaySection` render directly.
  - No new fake timers and no StrictMode dependence.
  - The queries are valid for the markup: `aria-label` lists; `aria-expanded` and `aria-controls` buttons; folded and AI lists are not rendered until opened; exact-match RTL names.
  - S5.1, S5.2, S5.3, S5.4 and S5.5 RED and GREEN predictions all hold (checked case by case against the old code).
- mutationCatalog: S5 adds no dashboard POST, PUT, PATCH or DELETE call. Today still calls only `closeConversation` and `deferCloseNag` (`e2e/performance/mutationCatalog.ts:74-75`), and Quiet shares has no Interested or Not interested actions.
- Spec r8: S5 conforms to sections 2-2.5, 3, 3.1, 5.3, 5.4 rows, 6.2 and 6.3, and to PR31-PR36, PR63, PR65 and PR67.
