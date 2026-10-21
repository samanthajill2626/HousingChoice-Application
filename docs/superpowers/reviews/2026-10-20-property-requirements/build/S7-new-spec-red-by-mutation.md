# S7 - property-requirements.spec.ts: RED by mutation

Unit U13 (slice S7), plan Task 7.4 Steps 4-7. The spec is
`e2e/tests/dashboard-next/property-requirements.spec.ts` (513 lines, the plan
text byte for byte, plan lines 25487-25999). Every run below used the same
command, from the worktree root, one npm hop into the e2e workspace:
`timeout 1200 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/property-requirements.spec.ts`,
output to `.superpowers/sdd/s7/7.4-<run>.log` (gitignored), exit code
appended. Each run cold-booted its own stack: the lane check (no listener on
lane 10's ports 10001 / 10011 / 10021 / 10031) was clean before every run and
after every run, so `reuseExistingServer` never adopted a stack across a
mutation. The app and worker run from source under tsx and Vite serves the
dashboard source, so a cold boot after an edit runs the mutant.

The two tests: test 1 = "landlord requirements: the New form pre-fills them,
the property page tags exceptions and stale copies, Apply writes only the
checked properties" (spec line 195); test 2 = "Matching: a two-size property
pre-fills two voucher chips, and a 6-bedroom tenant matches 4+" (spec line
454).

## First (unmutated)

- Started 2026-10-21 01:08:55, commit `e1bf8582`; the tree held only the new
  spec (untracked).
- Expected GREEN: S1-S6 shipped the behavior, so this is not the RED.
- Verbatim summary line: `  2 passed (15.0s)`; `exit=0`.
- Evidence that test 1 really reached the write: the app log in the same file
  records one `POST .../requirements/apply` answered 200 and four
  `POST /api/units` (A, B, C and test 2's two-size property).

## R1 - two server-side mutants, one cold run

- Started 2026-10-21 01:10:12, commit `e1bf8582`; the tree held the new spec
  plus the two mutants only.
- M1 (O1 coupling, D8): in `app/src/lib/requirements.ts`, `planUnitApply`,
  the per-field write at `:470` became `if (next !== null) patch[field.key] = next;`,
  so a blank key of a changing item is never REMOVEd.
- M2 (4+ = 4 or more, D12): in `app/src/lib/blastAudienceRules.ts`,
  `voucherSizeMatches`, the line `:241`
  (`if (tenantSize >= VOUCHER_CHIP_MAX) return sizes.includes(VOUCHER_CHIP_MAX);`)
  was deleted, so matching is exact again.
- Unit liveness (`cd app && ALLOW_SKIP_DYNAMO_TESTS=1 npx vitest run test/requirementsApply.test.ts test/blastAudienceRules.test.ts`,
  log `7.4-r1-unit-liveness.log`): `Tests  9 failed | 92 passed (101)` - 6
  failures in `test/requirementsApply.test.ts` (including `a blank landlord
  item ("Clears") REMOVEs the item on the unit`) and 3 in
  `test/blastAudienceRules.test.ts` (`sizes [4], tenant voucher size 5 -> true`,
  `... 12 -> true`, `sizes [2,4], tenant voucher size 6 -> true`): both mutants
  are on tested paths.
- Verbatim summary line: `  2 failed`; `exit=1`.
- Test 1, first error: `Error: expect(locator).toHaveCount(expected) failed`
  on `getByText('Cats OK')` (Expected: 0, Received: 1), at spec line 384
  (`property-requirements.spec.ts:384:43`). The failure snapshot shows the
  flyer's Pets row reading `No pets (Cats OK)` - the details were not
  cleared, exactly what O1 forbids. Nothing earlier failed: B and C were still
  written.
- Test 2, first error: `Error: expect(locator).toBeChecked() failed` /
  `Error: element(s) not found` on the 6-bedroom tenant's checkbox in
  `Candidate recipients`, at spec line 509
  (`property-requirements.spec.ts:509:77`). The snapshot lists only the
  3-bedroom tenant.
- Both first-failing lines are the ones the plan predicts.
- Revert (Edit tool, not `git checkout`), then
  `git diff --exit-code -- app/src/lib/requirements.ts app/src/lib/blastAudienceRules.ts`
  -> `R1 revert exit=0`. Lane check clean afterwards.

## R2 - the Apply row's starting state, one cold run

- Started 2026-10-21 01:12:03, commit `e1bf8582`; the tree held the new spec
  plus the one mutant only (R1's reverts proven first).
- M3 (D8 starting state): in `dashboard/src/routes/contact/applyRequirementsModel.ts`,
  `rowIsChecked`, the last line `:90` (`return row.own.length === 0;`) became
  `return true;`, so a row with an own value among its changes starts CHECKED.
- Unit liveness (`cd dashboard && npx vitest run src/routes/contact/applyRequirementsModel.test.ts`,
  log `7.4-r2-unit-liveness.log`): `Tests  1 failed | 18 passed (19)`, the
  failing case `rowIsChecked > starts checked without own values, unchecked
  with one, never when Already matches`.
- Verbatim summary lines: `  1 failed` and `  1 passed (29.7s)`; `exit=1`.
- Test 1, first error: `Error: expect(locator).not.toBeChecked() failed` on
  row A's checkbox in `Which properties` (Received: checked), at spec line 344
  (`property-requirements.spec.ts:344:56`) - the line the plan predicts. Test
  2 passed, as predicted (M3 is dashboard-only and Apply-only).
- Revert (Edit tool), then
  `git diff --exit-code -- dashboard/src/routes/contact/applyRequirementsModel.ts`
  -> `R2 revert exit=0`. Lane check clean afterwards.

## Green (after the reverts)

- Revert proof over every mutated file in one command:
  `git diff --exit-code -- app/src/lib/requirements.ts app/src/lib/blastAudienceRules.ts dashboard/src/routes/contact/applyRequirementsModel.ts`
  -> `revert exit=0`; `git status --porcelain` showed only
  `?? e2e/tests/dashboard-next/property-requirements.spec.ts`.
- Started 2026-10-21 01:12:59, commit `e1bf8582`, log `7.4-green.log`.
- Verbatim summary line: `  2 passed (14.8s)`; `exit=0`.

## Mutant summary

| Mutant | File:line | Unit liveness | e2e | Result |
|---|---|---|---|---|
| M1 blank keys never REMOVEd | `app/src/lib/requirements.ts:470` | 6 failed in `requirementsApply.test.ts` | R1 test 1 at spec :384 (`No pets (Cats OK)`) | KILLED |
| M2 exact voucher matching | `app/src/lib/blastAudienceRules.ts:241` | 3 failed in `blastAudienceRules.test.ts` | R1 test 2 at spec :509 (6-bedroom tenant absent) | KILLED |
| M3 own-value row starts checked | `dashboard/src/routes/contact/applyRequirementsModel.ts:90` | 1 failed in `applyRequirementsModel.test.ts` | R2 test 1 at spec :344 (row A checked) | KILLED |

The Playwright failure artifacts of R1 and R2 are preserved (gitignored) in
`.superpowers/sdd/s7/r1-test-results/` and `.superpowers/sdd/s7/r2-test-results/`.
