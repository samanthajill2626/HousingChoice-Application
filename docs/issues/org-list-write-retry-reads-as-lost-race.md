---
id: org-list-write-retry-reads-as-lost-race
title: A conditional org write that landed but answered a retryable error is read back as a lost race - a started rewrite refuses itself for 15 minutes
type: bug
severity: low
status: open
area: app/repos
created: 2026-10-07
refs: app/src/repos/orgListRepo.ts:216-219, app/src/services/orgRewrite.ts:351-357, app/src/services/orgRewrite.ts:547-567, app/src/services/orgRewrite.ts:577-588, app/src/services/orgNames.ts:264, app/src/services/orgNames.ts:378, app/src/repos/contactsRepo.ts:1732, app/src/repos/unitsRepo.ts:994, app/src/repos/poolNumbersRepo.ts:564-580
---

**Problem.** The AWS SDK retries a DynamoDB 500, a timeout or a connection reset on its
own. When the first attempt of a CONDITIONAL write was already applied, the retry fails
its own condition and surfaces `ConditionalCheckFailedException` - the shape of a lost
race. Two places then misread their own write:

- The org list's `mutate()` (`app/src/repos/orgListRepo.ts:216-219`) re-reads and re-runs
  the change against its own write. `start()` (rename, merge, every "Not on the list"
  action; `app/src/services/orgRewrite.ts:351-357`) and `runAgain()` (`:547-567`) then
  find their own fresh lock and answer 409 `org_rewrite_running`: the job is never
  enqueued, the admin reads "Another update is still running", Settings shows the rewrite
  running for 15 minutes and refuses every other rewrite until the lock goes stale, then
  offers Run again (which works). A rename's or merge's list change is already applied
  while its records wait. `acquireForCleanup()` (`:577-588`) prints REFUSED for its own
  lock and blocks Settings for 15 minutes; `add()` answers 409 `org_name_taken` for the
  entry it just added (`app/src/services/orgNames.ts:264`); `remove()` answers 404
  `org_not_found` for its own delete (`:378`). `claim()`, `heartbeat()` and `finish()`
  are idempotent here.
- The record writers `rewriteOrgFields` and `rewriteAcceptedAuthorities`
  (`app/src/repos/contactsRepo.ts:1732`, `app/src/repos/unitsRepo.ts:994`) answer
  `skipped` for a write that landed. The org.rewrite pass then counts it skipped and
  appends no `org_name_rewrite` event; the cleanup counts it in `skippedOnCondition` and
  appends no `org_name_cleanup` event. That is a permanent audit gap - the re-run the
  RUNBOOK asks for finds the record already clean - under a log line saying nothing was
  written.

Rare (DynamoDB answering 5xx after applying a write), self-healing (15 minutes, then Run
again), and no record data is lost. It follows from the SDK's retry semantics; fix wave 2
did not introduce it. Code review R3-BE-2
(`docs/superpowers/reviews/2026-10-06-clean-org-names/code-review/R3-BE.md`; the list half
reproduced over a fake document client, the record-writer half traced), ruled to file
rather than fix (`R3-adjudications.md` there). Filed during the clean-org-names build
(`feat/clean-org-names`).

**Suggested fix.** The list, in one place: in `mutate()`, on a lost condition, re-read;
when the stored item deep-equals the item this attempt wrote (version + 1 included -
every mutate write is a whole-item Put), the write landed - return its result instead of
re-running the change. The record writers: `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'`
(the `app/src/repos/poolNumbersRepo.ts:564-580` precedent), answering `written` when the
returned item already holds `next` on the written fields.
