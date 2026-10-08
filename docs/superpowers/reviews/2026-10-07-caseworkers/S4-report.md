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
