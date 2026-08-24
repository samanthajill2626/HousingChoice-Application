---
id: unread-index-fake-tie-order-is-not-the-services
title: The byUnread fake breaks last_activity_at ties by conversationId; DynamoDB does not, and a resume inside a tie returns a different row set
type: bug
severity: med
status: resolved
area: app/test-infra
created: 2026-08-23
resolved: 2026-08-23
refs: app/test/helpers/unreadIndexFake.ts, app/test/unreadIndexFakeMirror.integration.test.ts, app/src/lib/unreadFeed.ts:337
---

**Resolution (2026-08-23, `fix/test-suite-wave3`).** The reason this stayed a
bug was point 1 below: the comments were the only guard. That is fixed by
making the fake REFUSE the divergent input instead of answering it wrong:
`queryUnreadPageFromItems` now THROWS when an `exclusiveStartKey` lands inside
a `last_activity_at` tie group - the one input where the fake and the service
return different row SETS - with a message that names the two escape routes
(distinct fixture timestamps, or an explicit `allowTieResume: true` for a test
that exercises the cursor mechanism rather than service behaviour).

Verified by construction: enabling the guard immediately failed the one
existing tie-crossing test (`resumes from scanPosition...`) with the full
explanatory message, and that test now carries the documented opt-out. 34/34
green across unreadFeed + the fake-vs-real mirror suite.

Point 3's alternative (hash-scrambled tie order) was considered and rejected:
it breaks "natural order" luck but not copy-the-fake's-output calibration,
while the throw stops BOTH cold at the input that matters. Point 2 (whether
real AWS matches DynamoDB Local here) remains unverified and unimportant to
the remedy - both are "unspecified"; it becomes relevant only if a feature
ever needs defined tie ordering, which would be new work, not this issue.


**Found by the fake-vs-real mirror suite on its first run**, which is the point
of that suite: it compares rather than asserts, so it can surface a rule nobody
knew was wrong.

**Measured 2026-08-23** against DynamoDB Local. Six conversations sharing one
`last_activity_at`, queried through `queryUnreadPage`:

```
inserted conv-a,b,c,d,e,f  ->  returned f,b,c,d,e,a
inserted conv-f,e,d,c,b,a  ->  returned f,b,c,d,e,a
inserted shuffled          ->  returned f,b,c,d,e,a
same ids, a fresh table    ->  returned f,b,c,d,e,a
```

Stable across insertion order and across freshly created tables, so it is a
deterministic function of the key VALUES - the shape of a hash of the table
partition key, which is how a GSI entry is ordered when its sort key ties. It is
neither ascending nor descending by `conversationId`.

`app/test/helpers/unreadIndexFake.ts` documented the opposite, and presented it
as the service's rule:

> order is (last_activity_at DESC, conversationId DESC) - a TUPLE, because equal
> timestamps are ordinary and the trailing table key is what breaks the tie

**Why it is not merely cosmetic.** Order alone would be survivable. The row SET
is not:

```
4 rows, three sharing one timestamp, resume from the middle one (conv-b)
  real:  conv-c, conv-a, conv-d
  fake:  conv-a, conv-d          <- one row short
```

`iterateUnreadConversations` turns an Unread-page cursor into an
`ExclusiveStartKey` synthesized from a position the caller already read
(`app/src/lib/unreadFeed.ts:337`), so resuming into a tie group is a production
path, not a hypothetical the repo contract merely permits. Any paging test whose
page boundary lands inside a tie is calibrated against a row set DynamoDB will
not produce - and `unreadFeed.ts` states as a design rule that "the unit tests
assert on the NUMBER of `queryUnreadPage` CALLS", so this lands on the cost model
of the app's highest-frequency request.

**Not fixable by making the fake faithful.** The service's order is an opaque
function of the key; replicating it would mean reimplementing DynamoDB's
internal encoding, and real AWS does not document an order here either. The
honest statement is that tie order is UNSPECIFIED and nothing may depend on it.

**Done on `fix/test-hardening-wave2`:**

- The fake's header now says the tie-break is the FAKE'S choice - it needs a
  total order - and spells out the two consequences (do not assert tie order; do
  not let a page boundary land mid-tie).
- `app/test/unreadIndexFakeMirror.integration.test.ts` compares MEMBERSHIP at a
  tie, which is specified, and asserts the two orders differ, so if DynamoDB
  Local ever starts agreeing someone re-reads this instead of quietly inheriting
  a stronger guarantee than the service gives.

- The existing unread suites were audited. `unreadFeed.test.ts` pages across a
  deliberate tie (`contactSeries(300, 29)`), and its CONCLUSION holds: the fake
  and the service are each internally consistent, so a resume from a position the
  caller itself read is exact in both. Its comments claimed more than that -
  that the tie reproduced DynamoDB's behaviour - and now say what it really
  proves, which is the synthesized-full-key cursor mechanism.

**Still open, and why this stays a bug rather than debt:**

1. The divergence itself is unfixed, and a FUTURE test can still walk into it by
   asserting on which tied row falls on which side of a page boundary. The
   comments are the only thing standing in the way, which is weaker than this
   campaign's usual bar of making the rule enforceable.
2. Whether real AWS DynamoDB matches DynamoDB Local here is unverified - the
   repo forbids testing against live infrastructure without a human ask, and it
   does not matter for the remedy (both are "unspecified"), but it does matter
   before anyone writes a rule that depends on the observed order.
3. A stronger fix worth considering: make the fake's tie order deliberately
   ARBITRARY (hash the id) so a test that depends on tie order fails loudly
   instead of passing against a rule production does not honour. Not done here
   because the blast radius across existing suites is unmeasured.

Related: [`unread-index-fake-can-still-drift`](./unread-index-fake-can-still-drift.md)
