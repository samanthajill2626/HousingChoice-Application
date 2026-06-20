---
id: contact-vocab-roles-reserved-keyword
title: contactVocabularyRepo.add put the DynamoDB reserved keyword `roles` bare in the UpdateExpression — every custom-kind vocabulary write 400'd
type: bug
severity: med
status: resolved
area: app
created: 2026-06-19
resolved: 2026-06-19
refs: app/src/repos/contactVocabularyRepo.ts, app/test/contactVocabularyRepo.test.ts
---

**Problem.** `createContactVocabularyRepo().add()` built its `ADD` UpdateExpression with
bare attribute names (`ADD roles :roles, …`). `roles` is a **DynamoDB reserved keyword**,
so DynamoDB rejected the write with `ValidationException: Attribute name is a reserved
keyword; reserved keyword: roles`. The write-path (`POST/PATCH /api/contacts`) calls
`add()` **best-effort** (catch-and-log, never fails the response), so the failure was
silent: contacts were created fine, but the **auto-suggest vocabulary (custom roles,
relationship roles, field labels) never persisted** — every custom-kind add 400'd.

Discovered via the e2e harness logs (`vocabulary add failed (best-effort)`) while verifying
the status-model merge; the bug predates both merge branches (the repo file was unchanged
on each), i.e. it was a pre-existing failure on `main`, not a merge regression. It had no
unit/integration test, so nothing caught it (a unit test with a fake doc client doesn't
enforce reserved-keyword validation; there was no DynamoDB-Local integration test for it).

**Resolution (2026-06-19).** Aliased every attribute name via `ExpressionAttributeNames`
(`ADD #roles :roles, #rr :rr, #fl :fl` with `{'#roles':'roles', …}`) in
`app/src/repos/contactVocabularyRepo.ts`. Added `app/test/contactVocabularyRepo.test.ts`
asserting the expression uses `#`-aliases (so a regression to bare names fails the test).
Verified against real DynamoDB: the full Playwright e2e is 21/21 with **zero**
`reserved keyword: roles` / `vocabulary add failed` log lines.
