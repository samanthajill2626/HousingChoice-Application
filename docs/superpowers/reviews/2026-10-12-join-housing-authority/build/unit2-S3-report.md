# Build unit 2 (S3, dashboard /join) - implementer report

- Implementer: Claude Opus 5.5, 2026-10-12.
- Branch feat/join-housing-authority, worktree W:/tmp/join-housing-authority.
- Start: 249340f5 (clean tree). End: 30248100 (clean tree). Six commits, one per task.
- Scope held: exactly the 12 files the plan's S3 "Files this slice touches" list names
  (`git diff --stat 249340f5 HEAD`: 12 files changed, 1479 insertions, 34 deletions;
  no other path). `git diff --stat 249340f5 HEAD --
  dashboard/src/routes/public/FlyerPage.tsx dashboard/src/routes/public/IntakeForm.test.tsx
  dashboard/src/api/client.ts` is EMPTY: none of the three NOT-touched files changed.
  FlyerPage.test.tsx has 0 removed lines (one test added, nothing else).
- No eslint-disable added. The only eslint-disable under dashboard/src/routes/public is
  the pre-existing one at FlyerPage.tsx:149 (react-hooks/exhaustive-deps, not mine).

## Per task

| Task | Commit | RED seen (reason) | GREEN |
|---|---|---|---|
| 3.1 publicApi | daf0d211 | 5 failed / 2 passed of 7: "sends housingAuthority" on the toEqual (body lacks housingAuthority); the three getHousingAuthorities cases "TypeError: getHousingAuthorities is not a function"; the constant "expected undefined to be 'housing_authority_not_listed'". "omits" and (PIN) passed. As planned. | publicApi.test.ts 7/7; folder 4 files / 32 tests; mutationCatalog 4/4 |
| 3.2 IntakeForm props | 5914d349 | 4 failed / 3 passed of 7: extraField "Unable to find a label with the text of: Extra field"; submitBlocked on toBeDisabled; errorMessage alert "Received: Sorry, we couldn't send that. Please try again."; autoFocusFirstName on toHaveFocus. Both PINs and autoFocusFirstName={false} passed. FlyerPage.test.tsx 16/16 with the new PIN already green on today's code. As planned. | IntakeForm.props.test.tsx 7/7; folder 5 files / 40 tests |
| 3.3 HousingAuthoritySelect | 411b100d | file failed to load: 'Failed to resolve import "./HousingAuthoritySelect.js"'; no tests ran. As planned. | HousingAuthoritySelect.test.tsx 10/10; folder 6 files / 50 tests |
| 3.4 list read | 2b5cbe92 | 12 failed / 6 passed of 18. Six "HousingFairIntake (/join)" cases passed. The 12 select cases failed: 9 on "Unable to find a label with the text of: Housing authority" (the 10 s case among them, per S3-F1); "aborts the list read on unmount" on "Cannot read properties of undefined (reading '0')"; StrictMode on "expected spy to be called 2 times, but got 0 times". See note R1 for the remaining two. | HousingFairIntake.test.tsx 18/18; folder 6 files / 63 tests |
| 3.5 recovery + 429 | d5ad3ea0 | 4 failed / 1 passed of 5: all four (three not-listed, the 429) on the alert text, "Received: Sorry, we couldn't send that. Please try again."; the (PIN) passed. As planned. | HousingFairIntake.recovery.test.tsx 5/5; folder 7 files / 68 tests |
| 3.6 Sign up another person | 30248100 | 5 failed / 1 passed of 6: every button case on 'Unable to find ... role "button" and name "Sign up another person"'; the (PIN) first-visit focus case passed. As planned. | HousingFairIntake.another.test.tsx 6/6 |

R1 (RED reason detail, Task 3.4): the plan says "most" of the 12 fail on the missing
label. Two fail earlier, still because the list is never read: "reads the list once on
mount" on `toHaveBeenCalledTimes(1)` (0 calls, asserted before the label query), and
"sends the default Atlanta Housing Authority when left alone" on the `toMatchObject`
(that case never queries the select; the body lacks housingAuthority). Count 12/6 exact.

## End-of-unit verification (all bare, output redirected, never piped)

- `cd dashboard && npx vitest run src/routes/public`: exit 0, 8 files / 74 tests:
  publicApi.test.ts 7, HousingAuthoritySelect.test.tsx 10, FlyerPage.test.tsx 16,
  IntakeForm.props.test.tsx 7, IntakeForm.test.tsx 5, HousingFairIntake.recovery.test.tsx 5,
  HousingFairIntake.another.test.tsx 6, HousingFairIntake.test.tsx 18. No React act or
  other warning lines in the log.
- `cd dashboard && npx vitest run src/App.test.tsx`: exit 0, 1 file / 10 tests.
- `cd e2e && npx vitest run performance/mutationCatalog.test.ts`: exit 0, 1 file / 4 tests
  (the count pin `toHaveLength(120)` at e2e/performance/mutationCatalog.test.ts:380 holds).
  Run after 3.1 and again at the end. The POST line in publicApi.ts is unchanged; the new
  GET is `request<...>('/public/housing-authorities', { signal })` (publicApi.ts:122).
- `npm run typecheck` from the worktree root: exit 0 (every workspace). The dashboard
  `npm run typecheck` was also exit 0 after every task.
- `npx eslint` on all 11 touched/created .ts/.tsx files (the Task 3.6 Step 4.5 list):
  exit 0, no output. Also exit 0 per task on that task's files. No baseline comparison
  needed. react-hooks v7 (incl. set-state-in-effect) raised nothing.
- ASCII: every new or rewritten file prints 0 with the `tr` count (HousingFairIntake.tsx,
  its three test files, HousingAuthoritySelect.tsx + test, IntakeForm.props.test.tsx,
  publicApi.test.ts, FlyerPage.test.tsx). Added lines in IntakeForm.tsx,
  IntakeForm.module.css and publicApi.ts count 0. The pre-existing non-ASCII lines in
  those three files are untouched. The thank-you em dash is the JSX entity `&mdash;`
  (HousingFairIntake.tsx:160); the PIN in HousingFairIntake.test.tsx and
  HousingFairIntake.another.test.tsx checks the rendered U+2014.
- Every commit: a separate bare `git status` first (only the task's files), MERGE_HEAD
  check via `git rev-parse --git-path MERGE_HEAD` printed "no merge in progress", explicit
  `git add` paths, ASCII message with the Co-Authored-By trailer.

## Divergences from the plan text

None in code or tests: every file is the plan's text verbatim. Process-only differences:
- MERGE_HEAD check used the rules-file form (`git rev-parse --git-path MERGE_HEAD`) instead
  of the plan's `.git/worktrees/...` path (adjudication S5S6-F1).
- Commands used the `cd "<abs path>" && ...` Git Bash form from the rules file in place of
  the plan's `cd ...; ...` form.

## "Matches the plan but..." remarks

- M1 (verified, no action): `.help` uses `var(--c-text-muted)`; the token exists at
  dashboard/src/ui/tokens.css:15. `styles.cta` for the new button exists at
  FlyerPage.module.css:69.
- M2 (design note, AR-7 already covers it): after a not-listed refusal the alert stays up
  while the user picks a new authority (it clears only on a text edit or the next send).
  With send blocked on "Choose one", the person sees the alert plus a disabled button until
  they choose - intended, but it is the one place a stale-looking message can sit next to an
  enabled send button (after picking). Worth a glance in S6 live self-QA.
- M3 (observation): option `key={o.value}` relies on the server's D1 uniqueness; a
  duplicate name would draw a React key warning, not a functional fault. D1 + the unit 1
  `housingAuthorityNames` de-duplication make that unreachable.
- M4 (for S5, already in the plan's notes): under StrictMode every /join load issues the GET
  twice (first aborted), so a lane affords about 30 /join loads a minute under the 60/min
  limit. "Sign up another person" after a good load issues no GET (pinned by the StrictMode
  case in HousingFairIntake.another.test.tsx).
- M5 (observation): the 10 s timeout path sets state from the timer callback after
  `controller.abort()`; the request's own rejection then returns early on the aborted
  signal, so the failed state is set exactly once. A timed-out read is NOT retried on its
  own; only "Sign up another person" re-reads (D9). That matches the spec.

## Next step

Unit 2 (S3) is complete and committed at 30248100. Next per AR-8: S4 (Tasks 4.1-4.6,
backfill script + RUNBOOK). This report is left uncommitted for the orchestrator.
