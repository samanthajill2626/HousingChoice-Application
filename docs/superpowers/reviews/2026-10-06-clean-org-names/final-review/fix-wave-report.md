# Final-review fix wave report - MEDIUM-1, LOW-1, FE L6

- Implementer: fix-wave implementer (Claude Opus 5.5), 2026-10-07. Worktree
  `W:/tmp/clean-org-names`, branch `feat/clean-org-names`.
- Range: after 8c187fea (final review records) through c45845bb - 3 commits, one per
  fix, 10 files. Each fix test-first (FIX 3 has no test, per dispatch): RED on the
  unfixed code for the reason the finding names, then GREEN.
- Commit checks each time: bare `git status`, no MERGE_HEAD, explicit paths only
  (`git commit -- <paths>`), ASCII message with the `Co-Authored-By: Claude Opus 5.5`
  trailer; 0 non-ASCII bytes on added lines (`git diff -U0` checked per commit).
- NOT mine, left untouched and unstaged: `docs/issues/org-rewrite-single-message-pass.md`
  and the design spec (modified), `docs/issues/org-names-backend-review-lows.md` and
  `docs/issues/org-picker-settings-review-lows.md` (untracked) - another writer's
  in-flight work that appeared during the wave. The spec edit already describes FIX 2
  in D4.
- No `npm test`, e2e, Playwright, smoke or server run (per dispatch). DynamoDB Local was
  already up, so the cleanup run tests ran (not self-skipped).

## Per fix

| fix | commit | files | RED | GREEN |
|---|---|---|---|---|
| 1 MEDIUM-1 | 7f528c25 | `app/scripts/clean-org-names.ts`, `app/test/cleanOrgNames.test.ts`, `RUNBOOK.md` | new case "apply refuses an environment with no stored org list": `expected 'completed' to be an instance of CleanupRefusedError` - the old apply took the lock, which created the item, and ran. 1 failed / 38 passed | `cleanOrgNames.test.ts` 39/39 |
| 2 LOW-1 | a043ef87 | `app/src/lib/orgNames.ts`, `app/src/services/orgNames.ts`, `dashboard/src/routes/orgs/orgCopy.ts`, `app/test/orgNames.test.ts`, `app/test/orgNamesService.test.ts`, `dashboard/src/routes/orgs/orgCopy.test.ts` | app: normalizer kept U+2019 (`'st jude<U+2019>s'` vs `'st jude s'`) and the zero-width space; `checkNewName` returned null for the curly twin of a listed name (expected `org_name_taken`); `hasOrgControlChar` false for the format characters; `checkNewOrgName`/`checkOrgSpelling` null for a soft hyphen / zero-width space. 5 failed / 66 passed. dashboard: the same two normalizer failures, 2 failed / 35 passed | app `orgNames` + `orgNamesService` 71/71; dashboard `orgCopy` 37/37 |
| 3 FE L6 | c45845bb | `dashboard/src/routes/settings/OrgListSection.module.css` | no test (CSS containment; the planner's e2e gate covers it) | - |

### FIX 1 notes

- The apply now calls `deps.orgList.peek()` before the lock; null throws
  `CleanupRefusedError` with the dispatched text (prefixed `clean-org-names: `, as the
  lock refusal is), which the CLI already prints and maps to exit 1. The new case pins
  that the ONLY command sent is the peek's `GetCommand` (no lock, no Scan, no write),
  that the item is still absent (so no `lastRewrite`), and that every table is unchanged.
- `seedWorld` in the test now defaults to an environment on the new code: the item is
  created by the repo's create-only `get()` (the deployed app's first read). The dry run
  and the refusal pass `orgList: null`. Every other apply case proves the apply still
  runs when the item exists (the main apply case is retitled "on a stored list").
- RUNBOOK: step 4 opens Settings first (dispatched text, plus the refusal line to look
  for); a rollback note under step 4. Also, beyond the two dispatched edits, the
  section's exit-codes line now names this refusal beside the lock's, so it stays
  complete.
- Lanes - CONFIRMED: `app/src/lib/seed/lean.ts:526-537` puts `seedOrgListRow()`
  (`lib/seed/orgList.ts`, the starting list with fixed ids) in `SEED.settings`;
  `seedAll` (`lib/seed/index.ts:116-157`) starts BOTH profiles from that lean map and
  Puts every row unconditionally (the full profile only appends cast/matrix rows, and
  matrix's settings carry no org-list row); `/__dev/reseed` (`lib/devReset.ts:106-113`)
  clears, then runs `seedAll`. So after any reseed the lane holds the item and
  `--env local --lane <L> --apply` passes the new check.

### FIX 2 notes

- Both normalizers are byte-identical (diffed). Format characters are stripped first,
  then the folds, then the old steps. The new test cases are identical in both suites.
- No dashboard mirror of the control-character rule exists: "Is this really new?" asks
  the server's `POST /api/organizations/check`, which goes through `checkNewOrgName`
  (`services/orgNames.ts:263` at HEAD), as do add, rename and the spelling edits.
- TRAP hit and avoided: the Edit/Write tools (and Bash parameters) decode a typed
  backslash-u escape into the literal character. The escapes were written as ASCII
  placeholders and converted by a small node script that builds the backslash from its
  char code; every touched file verified 0 non-ASCII bytes.
- No org data, seed, fixture or org test holds any of these characters literally or as
  an escape (scanned), so no existing case changes behavior.
- Observation, not acted on: the dashboard copy for `org_name_invalid`
  (`orgCopy.ts:274`, `:422` at HEAD) and the spelling reason (`:463`) still say "line
  breaks or other control characters". A name refused for an invisible character reads as that
  sentence, which the user cannot see the cause of. A wording change ("...or invisible
  characters") is the planner's call.

## Final checks (after the last commit)

- `npm run typecheck` at the worktree root (app, dashboard, e2e, fake-twilio,
  fake-twilio-web): exit 0.
- `npx eslint` on the 8 `.ts` files the wave touched: exit 0, no output - 0 errors, so
  nothing new versus base. (The CSS and RUNBOOK are outside the lint config.)
- Touched suites at HEAD: app `cleanOrgNames` + `orgNames` + `orgNamesService` 3 files /
  110 tests, exit 0; dashboard `orgCopy` 1 file / 37 tests, exit 0.
