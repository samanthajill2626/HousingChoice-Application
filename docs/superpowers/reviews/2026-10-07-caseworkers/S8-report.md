# S8 report - dashboard caseworkers

Date: 2026-10-08. Authorized Caseworkers feature mission, S8 only.
Worktree W:/tmp/caseworkers, feat/caseworkers, clean start e32fb777.
Binding dispatch, spec revision 15, plan sections 0-3 and S8, assembly/review
rulings, repository workflow and S7 handoff govern this slice. Parent owns
aggregate checkpoints and S10 browser proof. No aggregate/browser run here.
Raw commands, cwd, logs and exits are in .superpowers/sdd/S8/; the runner
owns a 600-second per-command timeout and awaits child completion.

## Task 8.1 - dashboard API and catalog

Mirrored conversion/preview/Possible types and Contact fields, added the four
endpoint functions, and moved both POST catalog entries and 118-to-120 pin
with their implementation. API types additions are type-only.
RED from dashboard: npx vitest run src/api/endpoints.test.ts, exit 1,
2 failed / 48 passed: missing listPossibleCaseworkers and makeCaseworker.
RED from e2e: npx vitest run performance/mutationCatalog.test.ts, exit 1,
1 failed / 3 passed: discovered 118 mutations instead of 120. The later
fingerprint comparison was not reached in RED.
GREEN: the same commands exit 0: 50 endpoint tests, 4 catalog tests.
Root npm run typecheck exited 0 across all five workspaces (8.1-typecheck).
No contract deviation. git diff --check passed.

## Task 8.2 - KindPicker Caseworker preset

Task 8.1 commit: bdd128a4. Added the host-gated Caseworker segment with the
exact preset role, filtered mentions from Other suggestions, and made its
placeholder ASCII. Typed custom roles and all existing five-segment hosts
remain supported. No CSS redesign.
RED: dashboard npx vitest run src/routes/contact/KindPicker.test.tsx,
exit 1, 5 failed / 11 passed: missing Caseworker segment, offered mentions,
and the old placeholder. GREEN: same command exit 0, 16 tests. Root bare
npm run typecheck exit 0, all five workspaces (8.2-typecheck).
No contract deviation. Task 8.1 and 8.2 added-line ASCII and diff checks pass.
