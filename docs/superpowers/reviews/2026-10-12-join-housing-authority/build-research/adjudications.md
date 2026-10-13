# Build research (Phase 1) - adjudications

Orchestrator: build-orchestrator (Opus 5.5), 2026-10-12.
Tree: feat/join-housing-authority @34e79ec7 (main @5c0d3f6a merged at 469241f7; main
has not moved since, so 0 behind).

Five parallel read-only readers checked the plan against the live tree: S1S2 (app
server, Tasks 1.1-2.4), S3 (dashboard, 3.1-3.6), S4 (backfill + RUNBOOK, 4.1-4.6),
S5S6 (e2e, docs, completion, 5.1-6.3) and INV (plan-independent invariant sweep).
Their evidence is gitignored reference under `.superpowers/sdd/build-research/`.

Result: 0 BLOCKER, 0 MAJOR, 8 MINOR. Every Edit anchor was found exactly once
(S1S2 replayed all 36 server edits in order on scratch copies; S3 replayed the
dashboard slice and ran its tests in a scratch copy: 8 files / 74 tests green,
every RED/GREEN count reproduced, eslint and tsc clean at each stage). S1S2 wrote
no findings file (clean slice).

The plan text is NOT edited (it is the reviewed artifact); each correction below is
carried into the implementer briefs and, where it is the orchestrator's own step,
applied by the orchestrator.

| Id | Sev | Disposition |
|---|---|---|
| S3-F1 | MINOR | ACCEPT. Brief note for Task 3.4: "gives up after 10 seconds" goes RED on "Unable to find a label ... Housing authority" (the select is queried before the mock is read), not a TypeError. Count 12 failed / 6 passed unchanged. |
| S3-F2 | MINOR | ACCEPT. Citation only (`public-pages.spec.ts:380`, not `:352`). No action. |
| S4-F1 | MINOR | ACCEPT. Brief note for S4: every run of the new test file needs DynamoDB Local from Task 4.1 on (globalSetup throws without it); the shared container is up (`docker ps`: hc-dynamodb-local); never start/stop/restart it; never use ALLOW_SKIP_DYNAMO_TESTS for S4 - a skipped run is never GREEN. |
| S4-F2 | MINOR | ACCEPT. Task 4.6's RUNBOOK "Cost:" line uses the corrected wording: "then per candidate not named in `--skip` one audit-history Query per 100 events plus one that comes back empty". |
| S5S6-F1 | MINOR | ACCEPT. Every MERGE_HEAD check (implementer commits and the Task 6.1 sync) uses `test -e "$(git rev-parse --git-path MERGE_HEAD)"` - the plan's `.git/worktrees/...` path is relative to the worktree, where `.git` is a file, so it never exists. |
| S5S6-F2 | MINOR | ACCEPT. All `git -C` paths use forward slashes (`W:/tmp/join-housing-authority`); the backslash form fails in Git Bash. |
| S5S6-F3 | MINOR | ACCEPT, plus an orchestrator rule: `npm run e2e:stop` DROPS the lane's tables and removes an unchanged `lane.json`. So (a) the 6.3a rehearsal rows are gone at Step 9.4, and (b) on a gate-4 abort the orchestrator reads `launcherPid` from `lane.json` BEFORE running `e2e:stop`, then tree-kills it if still alive. |
| INV-F1 | MINOR | ACCEPT as a handback consequence for Cameron (the APPROVED spec is not edited): the unfiltered Contacts > Tenants list is ordered by status (byTypeStatus GSI range key), so a new /join lead now appears among Onboarding tenants (after On hold) instead of in the Needs review block near the top. No code change. |

INV sweep confirmations worth keeping (from INV-reference): the D10 audit event list
is complete against every live writer of a contact's `housingAuthority`;
`app/src/routes/public.ts:268` is the only creator of `capture_source: 'housing_fair'`;
no code path rewrites a whole contact from a projected shape, so the
`housing_fair_signup_v2` marker cannot be dropped; the public list read, the sign-up
check and the backfill only ever `peek()` the org-list item; the only status reader
whose behavior changes for a /join lead is the extraction's Onboarding->Searching
suggestion, already listed in spec section 4.
