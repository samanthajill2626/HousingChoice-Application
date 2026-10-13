# Completion gates - feat/join-housing-authority

All commands run BARE from W:/tmp/join-housing-authority (Git Bash), output redirected to a
file and read after the run; never piped. Logs and exit markers (gitignored) under
`.superpowers/sdd/gates/`. Main sync (Task 6.1): `git rev-list --count HEAD..main` = 0 at
every gate run (main @5c0d3f6a, already merged at 469241f7 before the build), so no sync
merge was needed; "main already contained" recorded.

## FINAL - @15c1676f (code tip e05dab52; 15c1676f adds a records file only)

| # | Command | Exit | Duration | Counts |
|---|---|---|---|---|
| 1 | `npm run typecheck` | 0 | 47s | all workspaces |
| 2 | `npm test` (no AWS_* exported) | 0 | 123s | app 440 files / 9266 passed + 1 skipped (pre-existing staticSmoke diagnostic: no built dashboard); dashboard 239 / 4434; e2e workspace 22 / 503; fake-twilio 34 / 275; fake-twilio-web 13 / 111. No `[dynamoAdmin]` line. |
| 3 | `npm run smoke` | 0 | 9s | `smoke-dist: OK - 1655 import specifier(s) across 287 emitted file(s) resolve under plain Node.` |
| 4 | `E2E_TRACE=1 timeout 2700 npm run e2e` | 0 | 1476s | `340 passed (24.6m)`; includes public-pages.spec.ts:430 (the new /join test, ok 174) and tenant-onboarding.spec.ts:178 (self-serve, ok 327); landlord-onboarding.spec.ts:190 ok 302 |
| 5 | `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` | 0 | 5s | 24 files, 0 errors, 0 warnings (json count); `scripts/e2e-session.mjs` is in the list but the config lints `.ts`/`.tsx` only, so that file is NOT linted (known hole) |

E2E_TRACE=1 on gate 4: the open issue `e2e-blank-document-after-contact-navigation` names a
retained trace as its next discriminator; the run is otherwise the plain `npm run e2e`.

## Earlier runs (both runs reported, per AGENTS.md)

- run1 @67cd745c (end of build): typecheck 0 (33s); npm test 0 (98s; app 440 / 9264 + 1
  skipped, dashboard 239 / 4433, e2e 22 / 503, ft 34 / 275, ftw 13 / 111); smoke 0; lint 0
  (24 files); e2e EXIT 1 - 339 passed, 1 failed (21.9m): landlord-onboarding.spec.ts:190 at
  steps.ts:627, an entirely white document (third sighting of the open issue
  `e2e-blank-document-after-contact-navigation`; the file passed alone right after, 7/7,
  47.0s, `E2E_TRACE=1`). Adjudication: code-review/R1-adjudications.md.
- run2 @348bf3c7 (after fix wave 1): typecheck 0, smoke 0, lint 0; npm test EXIT 1 - app
  439 / 440 files, 1 failed: tourRemindersApi.test.ts "orders by (sentAt ?? dueAt) DESC with
  reminderId as the tie-break" with the `[ 'rem-e-d', 'rem-e-b', ... ]` signature = the open
  issue `tour-reminders-earlier-tie-break-test-ms-race` (two clock reads straddling a
  millisecond; the branch does not touch tours). The file passed alone twice (69/69,
  69/69); third sighting appended to the issue (d7cbbab3).
- run3 @d7cbbab3: npm test 0 (101s; app 440 / 9265 + 1 skipped); e2e (`E2E_TRACE=1`) 0 -
  340 passed (24.4m).
