# S5 report - organization across the org-list server

Date: 2026-10-08. Lane: approved Caseworkers feature mission, S5 only.
Worktree W:/tmp/caseworkers, branch feat/caseworkers; clean start 789c6e34.
Per-task focused RED/GREEN and root typecheck precede each commit. Parent owns
aggregate checkpoints, e2e, live QA and final gates. No shared container changes.
Raw command metadata, verbatim output and real exits live under ignored
.superpowers/sdd/S5/. run.mjs uses a 600-second owned-child hard timeout.

## Task 5.1 - real and fake organization rewrite parity

Widened the conditional writer's expect/next contract with organization,
including absent guards, SET, null REMOVE, empty-string refusal and no other
writes. The real repo and FakeWorld changed together.
RED: app npx vitest run test/orgRecordWriters.integration.test.ts exited 1,
4 failed / 26 passed, both real and fake halves. Empty organization threw
nothing-to-write rather than the organization error; guards reached the same
missing write path. An initial edit script rejected a nonunique anchor before
writing files; 5.1-green therefore repeated RED and 5.1-typecheck exited 2 on
the unchanged missing organization signature. These logs are preserved.
GREEN after the corrected exact anchor: same Vitest command exited 0, 30 tests
passed, zero skipped (5.1-green-final). Root npm run typecheck exited 0
(5.1-typecheck-final), all five workspaces. No contract deviation.

## Task 5.2 - organization rewrite passes

Task 5.1 commit: dbc63916. OrgRecordField, pass counts, contact plan and audit
support organization. Rename/merge of either kind append organization last.
Move/Split remain refused by passField; cleanup script change is comment-only.
RED: app npx vitest run test/orgRecords.test.ts test/orgRewriteService.test.ts test/orgRewriteJob.test.ts test/organizationsApi.test.ts
exited 1: 28 failed / 66 passed, precisely missing organization counts,
organization writes counted skipped, and missing final rename/merge field.
GREEN: same command exited 0, four files / 94 tests (5.2-green).
Regression: app npx vitest run test/orgRecordWriters.integration.test.ts test/cleanOrgNames.test.ts
exited 0, two files / 69 tests, zero skips; the latter exercises only its
isolated test fixtures (5.2-regression). Root npm run typecheck exited 0
(5.2-typecheck). No contract deviation, no job implementation change needed.

## Task 5.3 - distinct usage totals and refusal modes

Task 5.2 commit: e89d38d1. Added the organization display column, preserved
legacy per-column deleted, and computed distinct inUse/kindLocked totals.
Delete reads inUse; kind change reads kindLocked, excluding organization-only
holders. E2E usage wire and existing usage pin changed in this task; their
execution remains S10 as planned.
RED: app npx vitest run test/orgRecords.test.ts test/organizationsApi.test.ts
exited 1: four failed / 45 passed, all at missing usage fields/totals. The
route case stops there before Delete, so the draft's predicted 204 was not
observed in this RED run. GREEN: app npx vitest run test/orgRecords.test.ts test/organizationsApi.test.ts test/orgRewriteJob.test.ts
exited 0, three files / 67 tests (5.3-green). Root npm run typecheck exited 0
(5.3-typecheck). Existing refusal pins remain unchanged. No contract deviation.

## Task 5.4 - off-list organization values and holders

Task 5.3 commit: a31eeff4. Off-list contact scan includes organization and
resolves over both kinds. The routes/organizations.ts RECORD_FIELDS allowlist
now accepts organization (O1: this is S7.5a's server comment reference).
RED: app npx vitest run test/orgRecords.test.ts test/organizationsApi.test.ts
exited 1: two failed / 50 passed, both missing organization rows. The route
case stops before its records request; no 400 observation is claimed. Generic
holders already passed, as predicted. GREEN: same command exited 0, two files
/ 52 tests (5.4-green). Root npm run typecheck exited 0 (5.4-typecheck).
No contract deviation. Existing off-list/holder tests remain unchanged.
