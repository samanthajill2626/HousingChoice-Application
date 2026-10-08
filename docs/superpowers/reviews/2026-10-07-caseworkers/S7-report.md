# S7 report - dashboard organization controls

Date: 2026-10-08. Authorized Caseworkers feature mission, S7 only.
Worktree W:/tmp/caseworkers, branch feat/caseworkers; clean start f800cd77.
Dependency proof: S5 organization wire, distinct usage totals, resolve kind
and both-list check contracts are present. Binding spec revision 15, plan
sections 0-3, rulings and live-tree references read. Browser verification
belongs to S10/final QA; no aggregate suite is run here. Raw command/cwd,
exit markers and logs are ignored in .superpowers/sdd/S7/; run.mjs owns a
600-second timeout and awaits every child.

## Task 7.1 - wire and vocabulary

Added organization record/refusal fields, usage totals, resolve kind and the
exclusive kind/kinds check type. Added both-list vocabulary and organization
usage copy. Distinct deleted display deliberately waits for 7.4 as planned.
RED: dashboard npx vitest run src/routes/orgs/orgCopy.test.ts src/api/endpoints.test.ts
exited 1: 3 failed / 86 passed. Observed missing ORGANIZATION_KINDS, wrong
refusal noun, and absent organization usage column; later assertions in the
first two cases were not reached. An edit script's incorrect addOrg anchor
stopped before adding the endpoint PIN; corrected at the existing check-body
anchor before GREEN. No production contract or plan discrepancy.
GREEN: dashboard npx vitest run src/routes/orgs src/routes/settings src/api/endpoints.test.ts
exited 0: 28 files / 455 tests, zero skipped (7.1-green). Existing Settings
React act warnings remain. Root npm run typecheck exited 0 across all five
workspaces (7.1-typecheck). git diff --check passes.

## Task 7.2 - both-list picker add option

Task 7.1 commit: 20b5f771. Both-kind matching already worked; the add noun
now says organization. RED: dashboard npx vitest run src/routes/orgs/OrgPicker.test.tsx
exited 1, one failed / 27 passed: the add option used housing authority.
GREEN: same command exited 0, 28 tests (7.2-green); root npm run typecheck
exited 0, all five workspaces (7.2-typecheck). No contract deviation.
