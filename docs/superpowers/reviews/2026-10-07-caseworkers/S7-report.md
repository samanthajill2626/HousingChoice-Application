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

## Task 7.3 - new organization dialog and kind choice

Task 7.2 commit: 55d05df9. Added reusable OrgKindChoice with neither radio
selected; organization-mode checks both lists and requires a kind before
adding. Compound guidance (including a refused add) says Pick one of them.
The exact selector documentation row moved with this task as authorized.
RED: dashboard npx vitest run src/routes/orgs/OrgKindChoice.test.tsx src/routes/orgs/NewOrgDialog.test.tsx
exited 1: missing OrgKindChoice module, four failed / 16 passed collected
cases. Observed missing intro, missing Kind groups and missing ambiguity copy;
later add/refusal assertions were not reached. An implementation script's
ambiguous plan-block selector stopped after creating OrgKindChoice and CSS;
7.3-green still had four failures / 410 passes. Corrected the selector without
duplicating either file. Final GREEN: dashboard npx vitest run src/routes/orgs src/routes/settings
exited 0, 28 files / 414 tests, zero skipped (7.3-green-final). Only intro
indentation changed afterward. No contract deviation or new dependency.
Root npm run typecheck exited 0, all five workspaces (7.3-typecheck).

## Task 7.4 - distinct usage totals in Settings

Task 7.3 commit: b98b6858. Required merged-layout handback sections 1, 5,
8 read. All usageTotal callers verified: list descriptions, entry panel,
Delete and Change kind. They now read inUse or kindLocked respectively;
deleted display reads distinct inUse.deleted. Organization-only holders
block Delete and keep their value through Change kind. No layout changed.
RED: dashboard npx vitest run src/routes/orgs/orgCopy.test.ts src/routes/settings/OrgListSection.test.tsx
exited 1, 5 failed / 94 passed: missing blockingUses, duplicate deleted count,
DeKalb Not used, Step Up 1 record instead of 3, old Change kind sentence.
The Step Up case stopped at its description; later Delete/Change checks were
not reached. One edit-script block lookup was ambiguous for the entry panel;
corrected before running GREEN. No source contract or anchor drift.
GREEN: dashboard npx vitest run src/routes/orgs src/routes/settings exited 0,
28 files / 419 tests, zero skipped (7.4-green). Existing usage pins remain.
Root npm run typecheck exited 0, all five workspaces (7.4-typecheck).
Only two newly inserted blank lines had trailing spaces; removed. Added-line
ASCII passes, and no usageTotal or per-column deleted reader remains.

## Task 7.5 - inline settlement across both kinds

Task 7.4 commit: 9873a238. Organization Use searches both lists; Remember
checks the chosen entry's kind. Add requires a kind and sends it only for
organization rows. Compound failures use organization guidance. Kind remains
inside the existing gated fieldset; synchronous SettleGate, late-answer
navigation/focus guards and role controls are unchanged. kindForField removed.
RED: dashboard npx vitest run src/routes/settings/NotOnListSection.test.tsx
exited 1, six failed / 32 passed (7.5-red): compound lacked agency Use,
agency Remember check absent, agency search absent, Add named Housing
authorities, and the final two cases stopped at the missing Kind group.
The refused-add copy was not reached in RED; it passes in GREEN.
GREEN: dashboard npx vitest run src/routes/settings src/routes/orgs exited 0,
28 files / 425 tests, zero skipped (7.5-green). Existing single-kind and
settle-gate/late-answer regressions pass. Root npm run typecheck exited 0,
all five workspaces (7.5-typecheck). ASCII and git diff --check pass.
No contract deviation, extra segment or page-level width cap.

## Task 7.5a - organization values are URL-addressable

Task 7.5 commit: 509f079b. Added organization to the client's RECORD_FIELDS
allowlist. O1 applied: the new comment correctly names the server allowlist
in app/src/routes/organizations.ts (widened by S5.4).
RED: dashboard npx vitest run src/routes/settings/orgSelection.test.ts src/routes/settings/OrgListSection.test.tsx
exited 1, two failed / 68 passed: literal URL selection was null, and the
clicked value's panel never appeared. The row label and href pins passed;
the round-trip URL and aria-current assertions were not reached in RED.
GREEN: dashboard npx vitest run src/routes/settings exited 0, 23 files /
327 tests, zero skipped (7.5a-green). Invalid field=nope still rejects.
Root npm run typecheck exited 0, all five workspaces (7.5a-typecheck).
No contract deviation beyond the already accepted O1 comment correction.

## Task 7.6 - field-keyed contact form seam

Task 7.5a commit: cff303af. Added OrgFormField, orgPickField,
newOrgDialogKind and isOrgFormField. ContactEditForm now keys adding/errors
and applyOrg by field; orgSetters still has only the two tenant arms.
Actual partner Organization controls, state and patch logic remain S8.
RED: dashboard npx vitest run src/routes/orgs/orgCopy.test.ts exited 1,
one failed / 43 passed: orgPickField missing. The later helper assertions
were not reached in RED. GREEN: dashboard npx vitest run src/routes/orgs/orgCopy.test.ts src/routes/contact/ContactEditForm.test.tsx
exited 0, two files / 107 tests, zero skipped (7.6-green); all existing
other-field, 422 and server-confirmed chip pins passed. Existing React act
warnings remain in ContactEditForm tests. Root npm run typecheck exited 0,
all five workspaces (7.6-typecheck). No contract deviation or new cycle.
Final changed-TypeScript lint includes both task paths: npx eslint over all
20 S7 TS/TSX paths exited 0 with no warnings/errors (exit-lint), so no
baseline attribution is needed and no narrower duplicate lint run is added.
