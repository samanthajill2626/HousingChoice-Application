---
id: dynamo-local-control-plane-fault-shape-unverified
title: Two things about DynamoDB Local's control-plane faults are unverified, and one of them makes the retry's timing arithmetic wrong by ~3x
type: bug
severity: med
status: open
area: app/test-infra
created: 2026-09-02
refs: app/src/lib/dynamoAdmin.ts, app/scripts/db-update-gsis.ts, app/test/dynamoAdminRetry.test.ts
---

**Split out of
[`npm-test-dynamodb-local-contention`](./npm-test-dynamodb-local-contention.md)
when that issue closed on 2026-09-02**, so that "open" keeps meaning
"someone should do something" and the anchor did not stay open as a parking
space for two questions.

Both were raised by adversarial review of the `feat/npm-test-soundness`
control-plane retry and could not be settled: neither reviewer nor planner
can provoke these faults on demand, and the anchor's own history records
four probe shapes that failed to summon one.

## 1. Does the container answer these faults with an HTTP 5xx?

`app/src/lib/dynamoAdmin.ts` retries `InternalFailure` and
`InternalServerError` by NAME. Whether the AWS SDK had already retried them
underneath is unknown, and it matters:

- the SDK classifies HTTP **500 / 502 / 503 / 504** as TRANSIENT and retries
  up to **3 attempts** by default (`@smithy/core`,
  `TRANSIENT_ERROR_STATUS_CODES`, `DEFAULT_MAX_ATTEMPTS`);
- `InternalServerError` carries no `$retryable` trait anywhere in
  `@aws-sdk/client-dynamodb`, so classification hangs entirely on
  `$metadata.httpStatusCode`;
- **no recorded sighting of either fault ever captured `$metadata`.**

**If the status IS 5xx**, attempts nest: our 4 attempts each contain up to 4
SDK attempts, and the 20s deadline comment at `dynamoAdmin.ts` - which
readers are explicitly told to size hook budgets from - understates the real
cost by roughly 3x. The comment currently says the nesting is open rather
than asserting either answer, which is correct but not a resolution.

**How to settle it, free:** the next time a `[dynamoAdmin]` line appears in
real suite output, capture `err.$metadata.httpStatusCode` and
`err.$metadata.attempts` from that run. `attempts > 1` proves the nesting
directly. This is only capturable while a sighting is in hand, which is why
the anchor's mechanical reopen trigger says to do it first.

## 2. Is the retried-DELETING path reachable at all?

`deleteTableIfExists` tolerates a `ResourceInUseException` that followed a
RETRY (the delete landed; the table is `DELETING`) and then waits via
`pollUntilTableGone`. That whole path assumes the container's `DeleteTable`
is ASYNCHRONOUS - that a re-send during deletion draws a conflict.

**If DynamoDB Local deletes synchronously, the re-send draws
`ResourceNotFoundException` instead, `deleteTableIfExists` returns at its
existing not-found branch, and `pollUntilTableGone` never executes in
production** - making it dead code kept alive only by its acceptance cases
(23, 24, 26, 28).

**How to settle it, cheaply and without provoking a fault:** create a
throwaway table against the local container, `DeleteTable` it, and
immediately `DescribeTable`. If the response says `DELETING`, the path is
reachable. If it throws not-found, it is not. Roughly thirty seconds of
work; nobody has spent them.

**If it turns out unreachable**, the honest options are to delete the branch
and its cases, or to keep them and say in the code that they guard a shape
the current container version does not produce - but not to leave it
implying a hazard that cannot occur.

## Why neither blocks anything

The retry is correct either way: it is gated to localhost, bounded in
attempts and wall clock, and fails closed. These are questions about whether
the DOCUMENTED COST is right (1) and whether a branch is live (2) - both
worth knowing, neither worth provoking a container fault to answer.
