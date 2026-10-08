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

## Task 8.3 - conversion dialog

Task 8.2 commit: 2321cf7a. Added CaseworkerDialog with preview/refusal links,
exact count/error/repair copy, typed organization settlement, carry-preserving
omission, clears and both-list new-name dialog. Added isCaseworkerContact
only to the leaf caseworkerRole module, preserving its import boundary.
RED: dashboard npx vitest run src/routes/contact/CaseworkerDialog.test.tsx,
exit 1: module import missing, no cases collected (genuine missing-module RED).
GREEN: dashboard npx vitest run src/routes/contact/CaseworkerDialog.test.tsx
src/routes/contact/caseworkerRoleMirror.test.ts, exit 0, initially 74 tests;
added an explicit untouched carried-value PIN, final 75 tests (23 + 52).
Scoped root npx eslint on CaseworkerDialog.tsx, CaseworkerDialog.test.tsx
and caseworkerRole.ts exited 0. Root bare npm run typecheck exited 0 across
all five workspaces. No contract deviation; picker indentation follows the
plan's note. No command remains active for this task.

## Task 8.4 - create form

Task 8.3 commit: 3f4530e1. New contacts can select Caseworker and send exactly
partner + Caseworker through existing creation. No Organization control added.
RED: dashboard npx vitest run src/routes/contact/ContactCreateForm.test.tsx,
exit 1: 1 failed / 15 passed, missing Caseworker button. GREEN: same command,
exit 0, 16 tests. Root npm run typecheck exit 0 across all five workspaces
(8.4-typecheck). No contract deviation; existing custom roles still pass.

## Task 8.5 - edit form organization and conversion gate

Task 8.4 commit: 37d6913e. Extended S7 orgSetters to a complete field-keyed
Record with organization, typed settlement and exact dirty comparison. Both
kinds land in organization, the existing single NewOrgDialog handles adds,
and 422s stay under their originating field. Stored contact gates the preset;
409 caseworker_use_conversion points to More actions > Make caseworker.
RED: dashboard npx vitest run src/routes/contact/ContactEditForm.test.tsx,
exit 1, 9 failed / 63 passed: no offered preset, no organization control and
old generic 409 copy. Later wire checks in cases stopped by the missing
control were not reached. GREEN: same command exit 0, 72 tests. Root bare
npm run typecheck exited 0 across five workspaces (8.5-typecheck).
Existing act warnings remain; no failure excused. ASCII/diff checks pass.
No contract deviation; redundant optional setter call removed once the map
became complete, and its stale two-field comments updated.

## Task 8.6 - Unknown card

Task 8.5 commit: cfdecbcd. Mark as Caseworker is fourth after Partner, opens
its dedicated callback, and shares the in-flight disable gate. Existing
triage PATCH callbacks retain their exact canonical kinds.
RED: dashboard npx vitest run src/routes/contact/UnknownFile.test.tsx,
exit 1, 4 failed / 7 passed: four-action order, missing button and old lede.
GREEN: same command exit 0, 11 tests. Root bare npm run typecheck exit 0,
all five workspaces (8.6-typecheck). No contract deviation.

## Task 8.7 - contact actions menu

Task 8.6 commit: ff1cd85a. Added the optional onMakeCaseworker menu handler;
its presence alone controls the item. Clicking it closes the menu and reports
to the host. RED: dashboard npx vitest run
src/routes/contact/ContactActionsMenu.test.tsx, exit 1: 1 failed / 18 passed,
missing Make caseworker menuitem. GREEN: same command exit 0, 19 tests.
Root bare npm run typecheck exit 0, five workspaces (8.7-typecheck).
No contract deviation; host eligibility remains Task 8.8.

## Task 8.8 - contact detail integration

Task 8.7 commit: 8ceedd7f. Added conversion entry points and organization-only
partner header facts. Preview remains dialog-open-only; Possible and org list
reads are absent at mount. Returned contact updates in place and refetches the
suggestions, timeline and file. RED: dashboard npx vitest run
src/routes/contact/ContactDetail.test.tsx, exit 1: 9 failed / 107 passed.
A draft assertion queried the second render before load; it now awaits its
Unknown action before inspecting the header. Initial GREEN: 116 tests.

Adjudication C4 (parent approved): the planned callback could close B's dialog
when A's pending conversion resolves after navigation, despite useContact
rejecting the stale data update. An added deferred-response regression failed
at the missing B dialog (8.8-navigation-red2, -t late.conversion, 1 failed /
116 skipped). The earlier quoted selector selected zero tests and is excluded
from evidence. Dialog state now carries the existing contact review generation;
old success callbacks return before closing or refetching. The regression also
asserts no stale suggestions/timeline/file reads. Final GREEN: same full
ContactDetail command, exit 0, 117 tests (8.8-green2). Root bare npm run
typecheck exited 0 across five workspaces; scoped eslint on ContactDetail.tsx
and its test exited 0. Existing act warnings remain; no failure excused.
No command remains active. Browser proof remains parent-owned.

## Task 8.9 - partner file

Task 8.8 commit: c064760e. Partner Details now show Role and Organization.
StaffNotesCard sits above Preferences & notes and receives setContact from
ContactDetail through the optional onContactUpdated prop. The S9 seam after
Preferences & notes and before Group threads is preserved. The issue retains
the open landlord half; the existing browser flow scopes its now-ambiguous
Partner assertion to Details.
RED: dashboard npx vitest run src/routes/contact/files.test.tsx, exit 1,
4 failed / 37 passed. GREEN: dashboard npx vitest run
src/routes/contact/files.test.tsx src/routes/contact/ContactDetail.test.tsx
src/routes/contact/TenantFile.test.tsx, exit 0, 161 tests across three files.
Root bare npm run typecheck exited 0 across five workspaces. Root npx eslint
e2e/tests/flows/conversation-fact-extraction.spec.ts exited 0. npm run issues
exited 0 (ignored index regenerated). Added-line ASCII/diff checks pass.
No contract deviation; browser execution remains parent-owned.
