---
id: unread-index-integration-coverage-requires-local-dynamo
title: A green npm test does not prove byUnread index semantics - that suite self-skips without DynamoDB Local
type: debt
severity: med
status: open
area: app/test-infra
created: 2026-08-16
refs: app/test/unreadIndexRepo.integration.test.ts:42, app/test/helpers/unreadIndexFake.ts, app/src/lib/unreadFeed.ts:19
---

**Problem.** The only suite that exercises the sparse `byUnread` GSI against real
DynamoDB semantics, `app/test/unreadIndexRepo.integration.test.ts`, self-skips
when nothing answers at `DYNAMODB_ENDPOINT` (`describe.skipIf(!reachable)`).
Everything else on the unread path runs against
`app/test/helpers/unreadIndexFake.ts`, an in-memory model.

So `npm test` can be green on a machine with no Docker while proving nothing
about:

- `LastEvaluatedKey` behavior at the Query `Limit` (the fake modelled this
  wrongly until the 2026-08-16 review fix wave - it returned a key only when
  items remained, so every `queryUnreadPage` call-count assertion was calibrated
  one round trip short of production);
- tie ordering across rows sharing one `last_activity_at`;
- `ExclusiveStartKey` validation (an empty key attribute is a
  `ValidationException`, reasoned from the service contract rather than run -
  see the A4 fix in the same wave);
- sparse-index membership, i.e. that a row leaves the index when
  `unread_flag` is REMOVEd.

The exposure is structural, not hypothetical: `app/src/lib/unreadFeed.ts` states
as a design rule that "the unit tests assert on the NUMBER of queryUnreadPage
CALLS", which makes those assertions only as good as the fake's fidelity to the
service.

**Suggested fix.** Options, in increasing cost:

1. Make the skip LOUD - print a prominent line naming the coverage that was not
   run, so a green suite cannot be silently mistaken for a proven index.
2. Fail rather than skip when an env var (e.g. `REQUIRE_DYNAMO_TESTS=1`) is set,
   and set it in whatever runs the completion gates.
3. Have the gate itself boot DynamoDB Local (`npm run db:start`) so the
   integration lane always runs.

Deliberately NOT done in `feat/inbox-unread-index`: the reviewer's remedy
suggested amending `AGENTS.md`'s gates section, which is shared project law and
out of scope for a feature branch's fix wave. Filed here for the human to rule
on.

Related: [`dynamodb-local-cross-worktree-test-contention`](./dynamodb-local-cross-worktree-test-contention.md),
[`db-update-gsis-integration-flake-under-load`](./db-update-gsis-integration-flake-under-load.md).
