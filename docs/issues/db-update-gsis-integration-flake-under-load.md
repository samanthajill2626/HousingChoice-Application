---
id: db-update-gsis-integration-flake-under-load
title: KNOWN FLAKE - db:update-gsis integration tests fail with DynamoDB Local InternalFailure on UpdateTable under a loaded shared container
type: bug
severity: low
status: open
area: app/test-infra
created: 2026-08-16
refs: app/test/unreadIndexRepo.integration.test.ts:561, app/src/lib/dynamoAdmin.ts:153
---

**Problem.** In a full `npm test` run, two tests in
`app/test/unreadIndexRepo.integration.test.ts` can fail:

- `db:update-gsis against DynamoDB Local (throwaway prefix) > adds the missing
  GSI in place, ACTIVE, without dropping the table`
- `db:update-gsis against DynamoDB Local (throwaway prefix) > a SECOND run
  reports nothing to do (idempotent)`

both with:

```
InternalFailure: The request processing has failed because of an unknown error,
exception or failure.
```

raised from the `UpdateTableCommand` in `app/src/lib/dynamoAdmin.ts`. Running
that file ALONE immediately afterwards is green (17/17), so it is a flake of the
shared DynamoDB Local container under concurrent load, not a defect in the code
under test: the same suite's byUnread round-trip, tie-boundary resume and
backfill cases pass in the same run. Observed on `feat/inbox-unread-index`
@f1a2a9b6 during the review gate, alongside `performanceSeed.integration.test.ts`
hammering the same container with multi-minute seeds.

**Suggested fix.** Probably already fixed structurally on main by
`93ca271b fix(test-infra): reclaim DynamoDB Local tables instead of leaking a
database per run` - table accumulation is the load source that makes an in-place
`UpdateTable` time out inside the container. Re-check after that lands here;
if it recurs, either serialize the schema-mutating lane against the rest of the
integration suites or retry `UpdateTable` on `InternalFailure`.

**Handling rule until then.** Treat it like the other known flakes named in
`AGENTS.md`: re-run the single file once before blaming the change under test,
and report BOTH runs.

Related: [`dynamodb-local-cross-worktree-test-contention`](./dynamodb-local-cross-worktree-test-contention.md),
[`unread-index-integration-coverage-requires-local-dynamo`](./unread-index-integration-coverage-requires-local-dynamo.md).
