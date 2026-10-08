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

## Task 5.5 - settling and revalidating organization rewrites

Task 5.4 commit: 2874276c. Organization Use accepts either kind; Add requires
explicit kind, rejected elsewhere. Existing field guards refuse Move/Split.
Run again and lapsed claim use both kinds for organization, and the first
non-organization field for rename/merge. From-text union protection remains.
RED: app npx vitest run test/orgRewriteService.test.ts test/organizationsApi.test.ts
exited 1: four failed / 58 passed. Agency Use was refused, lapsed claim was
refused, Run again returned target-gone; the route accepted invalid county
kind with 202. Later assertions in those cases were not reached. Widened
rename from-text union pin passed already, as planned.
GREEN: app npx vitest run test/orgRewriteService.test.ts test/organizationsApi.test.ts test/orgRewriteJob.test.ts
exited 0, three files / 80 tests (5.5-green). Root npm run typecheck exited 0
(5.5-typecheck). No contract deviation or lock behavior change.

## Task 5.6 - check across both lists

Task 5.5 commit: 0a93168c. check accepts the typed kind/kinds union; the route
requires exactly one form and validates nonempty, distinct, valid kinds.
Spelling target semantics and the existing single-kind requests are unchanged.
RED: app npx vitest run test/orgNamesService.test.ts test/organizationsApi.test.ts
exited 1: two failed / 63 passed. The service returned otherKind instead of
match and the route returned 400 for kinds. GREEN: the same command exited 0,
two files / 65 tests (5.6-green). Root npm run typecheck exited 0
(5.6-typecheck); afterward only a redundant adjacent comment was removed.
No contract deviation.

## Task 5.7 - dev fixture and e2e contracts

Task 5.6 commit: 7a68c883. The existing hermetic dev fixture accepts raw
organization on contacts. Its generic writer, deployment gates and logging
are unchanged. E2E field type and dev-seam README/selectors rows widened in
the same task; no seeds changed.
RED: app npx vitest run test/devOrgFixture.test.ts exited 1: two failed /
13 passed, organization returned 400 and the refusal-message pin differed.
GREEN: same command exited 0, 15 passed (5.7-green). Root npm run typecheck
exited 0, all five workspaces (5.7-typecheck). No contract deviation.
The complete S5 added-line ASCII and git diff --check pass; the cleanup
script diff is exactly three comment lines. No real DynamoDB fault in logs.

## S5 final verification and handoff

| Task | Commit |
|---|---|
| 5.1 | dbc63916 |
| 5.2 | e89d38d1 |
| 5.3 | a31eeff4 |
| 5.4 | 2874276c |
| 5.5 | 0a93168c |
| 5.6 | 7a68c883 |
| 5.7 | 9db84012 |

Each task carries its report entry. The final root npm run typecheck
(5.7-typecheck) exited 0 across all five workspaces and covers all final
source/tests. No implementation change followed it.

Final regression from W:/tmp/caseworkers/app:
npx vitest run test/orgRecordWriters.integration.test.ts test/orgRecords.test.ts test/orgRewriteService.test.ts test/orgRewriteJob.test.ts test/organizationsApi.test.ts test/orgNamesService.test.ts test/devOrgFixture.test.ts test/cleanOrgNames.test.ts test/contactOrgNames.test.ts
Exit 0: nine files, 241 tests passed, zero skipped (exit-regression).
Per-file counts in command order: 30, 24, 33, 18, 30, 35, 15, 39, 17.
Both DynamoDB-backed families ran against their isolated test fixtures.

Final lint from W:/tmp/caseworkers:
npx eslint app/src/repos/contactsRepo.ts app/src/repos/orgListRepo.ts app/src/services/orgRecords.ts app/src/services/orgRewrite.ts app/src/services/orgNames.ts app/src/routes/organizations.ts app/src/routes/dev.ts app/scripts/clean-org-names.ts app/test/helpers/twilioWebhookHarness.ts app/test/orgRecordWriters.integration.test.ts app/test/orgRecords.test.ts app/test/orgRewriteService.test.ts app/test/orgRewriteJob.test.ts app/test/organizationsApi.test.ts app/test/orgNamesService.test.ts app/test/devOrgFixture.test.ts e2e/fixtures/orgFixture.ts e2e/tests/dashboard-next/org-lists.spec.ts
Exit 0, all 18 touched TypeScript paths, no errors (exit-lint). No baseline
attribution needed. Full-slice git diff --check and added-line ASCII checks
pass; existing source glyphs/encoding are preserved. No real DynamoDB fault
line or hard timeout occurred. All owned commands finished.

Bare git status and resolved MERGE_HEAD were checked before every commit;
MERGE_HEAD was absent. Explicit paths only, GPT-6 Astra co-author trailer on
every commit. This final report-only closeout is committed immediately.
No main sync, deployment, environment, infrastructure, dependencies, seed,
cleanup, browser, live-port or aggregate-suite operations were performed.
E2E pins moved with their wire changes; S10 owns their execution and live QA.
S6/S7 and later work remain the parent's responsibility.

## Downstream contracts

- OrgRecordField now includes organization in app and e2e fixture types.
  Contact writer accepts organization expect:string|null and next:string|null;
  empty next refuses, null removes, classification revision is untouched.
- recordFieldsForKind appends organization LAST for either kind. Rewrite counts
  include organization. Clear removes it, and Move/Split cannot target it.
- OrgUsageCounts: tenants, otherContacts, properties, organization, deleted,
  inUse:{active,deleted}, kindLocked:{active,deleted}. Legacy deleted counts
  column hits only. UI Delete and deleted display must use distinct inUse;
  kind-change refusal/dialog uses kindLocked. Never sum display columns.
- Off-list organization rows and holder reads include every contact type and
  deleted records. Resolution accepts both kinds. The server record allowlist
  lives in routes/organizations.ts (O1 reference for S7.5a).
- Resolve Add on organization REQUIRES explicit kind; kind on any other action
  or field returns 400. Use accepts either kind, Clear removes, Move/Split
  refuse. Run again and lapsed claim revalidate organization against both
  kinds; rename/merge target kind comes from the first non-organization field.
- POST /api/organizations/check requires exactly one of kind or kinds; kinds
  is a nonempty, duplicate-free subset of housing_authority and agency.
  spellingFor works with either form. Service check exposes the typed union.
- Dev org fixture accepts organization; its e2e field type and documented
  seam rows are updated. S5 owns the usage pin and all these e2e changes.

No production plan/spec deviation, unexpected importer, cycle or unresolved
finding remains. Only RED evidence precision and the logged atomic edit-script
failure differ from the draft. Existing tests changed only at planned pins.
