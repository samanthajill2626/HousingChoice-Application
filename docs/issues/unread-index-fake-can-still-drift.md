---
id: unread-index-fake-can-still-drift
title: The byUnread in-memory fake can still drift from the real service, and call-count assertions are calibrated against it
type: debt
severity: med
status: open
area: app/test-infra
created: 2026-08-21
refs: app/test/helpers/unreadIndexFake.ts, app/src/lib/unreadFeed.ts, app/test/unreadIndexRepo.integration.test.ts
---

**Problem.** Almost everything on the unread path runs against
`app/test/helpers/unreadIndexFake.ts`, an in-memory model of the sparse
`byUnread` GSI. Nothing checks that the fake agrees with the real service.

This is not theoretical. The fake modelled `LastEvaluatedKey` **wrongly** until
the 2026-08-16 review fix wave: it returned a key only when items remained, so
every `queryUnreadPage` call-count assertion in the suite was calibrated one
round trip short of production. The bug was in the FAKE, and the tests agreed
with it.

That matters more than a normal fake would, because `app/src/lib/unreadFeed.ts`
states as a design rule that "the unit tests assert on the NUMBER of
`queryUnreadPage` CALLS" - so the entire cost model of the app's
highest-frequency request is pinned against a hand-written imitation of DynamoDB.

**What is already done, and why this is still open.**
[`unread-index-integration-coverage-requires-local-dynamo`](./unread-index-integration-coverage-requires-local-dynamo.md)
was resolved on 2026-08-21: `npm test` now FAILS rather than skipping when
DynamoDB Local is unreachable, so the real-DynamoDB suite is guaranteed to RUN.
That closed "the integration suite might silently not execute". It did NOT make
the fake faithful, and those are different problems. Filed separately so the
second one does not disappear inside a resolved issue.

**Suggested fix.** The shape that worked for two sibling issues on
`fix/test-suite-hardening`:

- `update-call-status-fake-mirrors-real...` - pin the REAL implementation with a
  small integration suite, so drift in the fake cannot hide even though the fake
  still carries the volume.
- `sw-mirror-test-pins-literals-not-behaviour` - run BOTH copies over a shared
  input table and require identical output.

The second applies almost directly here: drive the fake and the real repo
through the same sequence of `queryUnreadPage` calls (empty page, exact-multiple
page, tie on `last_activity_at`, resume from `ExclusiveStartKey`, row leaving
the sparse index when `unread_flag` is REMOVEd) and assert the same rows AND the
same pagination-key presence. Any place the fake has to differ should be an
explicit, commented exception rather than an accident.

Worth doing alongside the C1 unread-badge work, which is already going to open
these files.
