# S4 report - contacts routes and importer protection

Date: 2026-10-08. Lane: approved Caseworkers feature mission, S4 only.
Worktree: W:/tmp/caseworkers. Branch: feat/caseworkers.
Started clean at b6f6f304 after S3. This report is committed with each task.
No S5 changes, new dependencies, seeds, scripts or infrastructure changes.

## Task 4.1 - refuse server-owned contact keys

Added one refusal helper used by both contact body parsers for
caseworker_review, caseworker_conversion and type_source. Null is refused too.
Step 0 passed: S1/S2 primitives, both S3 service exports and all required
makeWebhookHarness api dependencies are present; the harness is unchanged.

RED, app workdir: npx vitest run test/contactsCrud.test.ts exited 1:
seven failed, 29 passed. POST returned 201 and PATCH returned 200, including
the null case labelled PIN in the draft; that case is real RED evidence.
GREEN, app workdir:
npx vitest run test/contactsCrud.test.ts test/contactTriage.test.ts test/contactsEmailCrud.test.ts
exited 0: three files, 88 tests passed. Root npm run typecheck exited 0.

## Evidence

All app tests use W:/tmp/caseworkers/app; root checks use W:/tmp/caseworkers.
Exact command/cwd metadata, verbatim logs and exit files are ignored under
.superpowers/sdd/S4/, named 4.1-red, 4.1-green and 4.1-typecheck.
run.mjs preserves real exits and has a 600-second hard owned-child timeout.
Aggregate npm test, smoke, e2e and live QA remain the parent's later gates.

## Task 4.2 - organization PATCH

Task 4.1 commit: 4aec86ce. Step 0 passed again.
PATCH parses organization, D5-checks against both kinds with a consistent read,
and maps empty string to REMOVE. POST still ignores the field.
RED: npx vitest run test/contactOrgNames.test.ts exited 1, six failed and 11
passed. Organization-only bodies returned 400; the mixed off-list write returned
200; the numeric case returned the old no-updatable-fields error. POST pin passed.
GREEN: npx vitest run test/contactOrgNames.test.ts test/contactTriage.test.ts test/contactIntakeFields.test.ts test/trimStrings.test.ts
exited 0, four files and 63 tests. Root npm run typecheck exited 0.
Logs: 4.2-red, 4.2-green, 4.2-typecheck. No contract deviation.

## Task 4.3 - merged-kind guard and manual type source

Task 4.2 commit: a17a387a. Step 0 passed again.
PATCH refuses creating a caseworker from the merged type/role with 409
caseworker_use_conversion. Type and role edits read consistently. Overrides
from tenant, landlord or partner to a different type get type_source: manual;
unknown triage does not. Generic thread behavior and shared helpers are unchanged.
The consistent-read test checks the first read of both requests separately,
strengthening the draft's single combined observation without changing scope.

RED: npx vitest run test/contactTriage.test.ts exited 1: eight failed, 43 passed.
Four guarded writes returned 200; consistentRead and three manual stamps were
absent. GREEN:
npx vitest run test/contactTriage.test.ts test/aiRunVerdicts.test.ts test/contactsCrud.test.ts test/contactStaffNotes.test.ts test/contactOrgNames.test.ts test/landlordContactFields.test.ts test/contactIntakeFields.test.ts test/suggestions.test.ts test/contactEmailReaders.test.ts test/contactPhones.test.ts test/contactsEmailCrud.test.ts test/trimStrings.test.ts
exited 0: 12 files, 273 tests. Root npm run typecheck exited 0.
All pre-existing cases stayed unchanged, including the resolved-thread pin.
Logs: 4.3-red, 4.3-green, 4.3-typecheck. No contract deviation.

## Task 4.4 - caseworker-review routes and wiring

Task 4.3 commit: 0192ee86. Step 0 passed again; no local units variable existed.
Added the literal Possible route ahead of contact-ID routes, preview and strict
make/dismiss routes. They use the router's existing repo/service/bus instances,
and api.ts now forwards units. The harness api block remains unchanged.
The session userId supplies the actor, and service errors retain status/extras.
No new role restriction or service-to-route import cycle was introduced.

RED: npx vitest run test/caseworkerReviewApi.test.ts exited 1: 16 failed, one
vocabulary pin passed. Missing handlers returned 404. Nine extra boundary pins
cover authentication on all four operations, forged actor, null organization
keys, explicit organization removal and deleted subject refusal.
GREEN: npx vitest run test/caseworkerReviewApi.test.ts test/contactTriage.test.ts test/contactsCrud.test.ts test/contactOrgNames.test.ts
exited 0: four files, 130 tests (26 route cases). Root npm run typecheck exited 0.
Root npx eslint app/src/routes/caseworkerReview.ts app/src/routes/contacts.ts app/src/routes/api.ts app/test/caseworkerReviewApi.test.ts
exited 0, no errors. Logs: 4.4-red, 4.4-green, 4.4-typecheck, 4.4-lint.
No contract deviation; the route layer does not duplicate S3 logic.

## Task 4.5 - importer preserves manually typed contacts

Task 4.4 commit: a94de995. Step 0 passed again. Fixture confirmed Vera Cole.
The importer skips type, status, housingAuthority and agency when its existing
read sees type_source: manual. It also omits an empty DynamoDB names map.
The accepted read/write race and lack of an importer revision bump remain.
Other import-owned fields keep their existing behavior.

RED: npx vitest run test/importApply.integration.test.ts exited 1: one failed,
33 passed, zero skipped. The new case's first post-import assertion observed
type tenant and status needs_review instead of partner/active; its later
organization assertions were not reached on that failing run.
GREEN: npx vitest run test/importApply.integration.test.ts test/importOrgNames.test.ts
exited 0: two files, 43 tests, zero skipped. This executes the real DynamoDB
empty-names-map path and proves authority/agency remain absent as requested.
Root npm run typecheck exited 0. All previous importer cases passed unchanged.
Logs: 4.5-red, 4.5-green, 4.5-typecheck. No contract deviation.

## S4 final verification and handoff

| Task | Commit |
|---|---|
| 4.1 | 4aec86ce |
| 4.2 | a17a387a |
| 4.3 | 0192ee86 |
| 4.4 | a94de995 |
| 4.5 | f954569f |

Each task committed its evidence after focused RED/GREEN and root typecheck.
The final 4.5-typecheck covers all final source/tests and all five workspaces;
no source changed after it, so no redundant typecheck was run for this report.

Final command from W:/tmp/caseworkers/app:
npx vitest run test/caseworkerConversion.test.ts test/possibleCaseworkers.test.ts test/contactClassification.test.ts test/caseworkerReviewApi.test.ts test/contactTriage.test.ts test/contactsCrud.test.ts test/contactOrgNames.test.ts test/aiRunVerdicts.test.ts test/unitsRepo.integration.test.ts test/importApply.integration.test.ts
Exit 0: ten files, 350 tests passed, zero skipped (exit-regression).
Per-file counts: conversion 78, possible 9, classification 14, review API 26,
triage 51, CRUD 36, organization names 17, AI verdicts 74, units repo 11,
import apply 34. Both integration suites executed against DynamoDB Local.

Final command from W:/tmp/caseworkers:
npx eslint app/src/routes/contacts.ts app/src/routes/api.ts app/src/routes/caseworkerReview.ts app/src/lib/import/apply.ts app/test/contactsCrud.test.ts app/test/contactOrgNames.test.ts app/test/contactTriage.test.ts app/test/caseworkerReviewApi.test.ts app/test/importApply.integration.test.ts
Exit 0: all nine owned TypeScript files, no errors (exit-lint). No baseline
attribution needed. Whole-slice git diff --check and added-line/new-file ASCII
checks pass. Existing source encoding and untouched glyphs are preserved.

All commands completed; no owned command is running. No hard timeout fired.
Every S4 log was scanned: no real DynamoDB control-plane fault. Shared DynamoDB
was never restarted, stopped or removed. No aggregate test, smoke, e2e, browser,
live app port, environment, deployment, infrastructure, main-sync or cleanup
operation was performed. Parent owns remaining slices and mission completion.

Bare git status and the resolved MERGE_HEAD path were checked before every
commit; MERGE_HEAD was absent. Explicit owned paths were staged and every commit
has Co-Authored-By: GPT-6 Astra <noreply@openai.com>. This report closeout is the
only post-implementation edit and is committed immediately; status is checked
again afterward.

## Downstream contracts and deviations

The new registerCaseworkerRoutes(router, deps) receives contacts, conversion,
and logger. It is mounted before contact-ID reads. Endpoints are authenticated
by the existing API router, with no role restriction:
- GET /api/contacts/possible-caseworkers returns { rows }.
- GET /api/contacts/:contactId/caseworker-review/preview returns CaseworkerPreview.
- POST /api/contacts/:contactId/caseworker-review accepts only action make with
  optional string organization, or action dismiss alone; it returns { contact }.
  Extra keys and null/non-string organization return 400 invalid_body.
  Service errors retain { error: code, ...extras } and the service status.

ContactsRouterDeps adds unitsRepo and optional caseworkerConversion test seam.
api.ts forwards its units repo; makeWebhookHarness was already correctly wired.
Conversion uses the same contacts/conversations/placements/tours/extraction/
aiRuns/audit/activity/vocabulary/events/orgNames instances as the contacts router.
Actor remains the authenticated userId, not a client-supplied value.

Both POST/PATCH refuse all three server-owned keys. PATCH organization accepts
both kinds, empty removes, POST ignores it. PATCH type/role uses merged-kind
refusal and consistent reads, stamping manual only on overrides of a previously
typed tenant/landlord/partner. Generic thread semantics remain unchanged.
Importer preserves the four guarded fields and still has the accepted
read/write race. S3 conversion and shared-helper contracts are unchanged.

No production plan/spec discrepancy, unexpected importer, cycle, or unresolved
finding remains. Only evidence precision (4.1 null RED, 4.5 first-failure scope)
and stronger targeted boundary assertions differ from the drafted tests.
S5 and later work remain unimplemented by this slice. No fakes, seeds, org-list
usage/rewrite types, dependency manifests, tracker, or unrelated source changed.
