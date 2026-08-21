---
id: unread-fill-loop-query-amplification
title: The unread fill loop issues one index Query per collect and reads ~90x the items its budget counts
type: bug
severity: med
status: open
area: app/inbox
created: 2026-08-16
refs: app/src/lib/unreadFeed.ts, app/src/routes/inbox.ts
---

**SCOPED INTO A MISSION 2026-08-21.** This is one of the two amplifications
inside the same badge request; the other is the per-item contact lookup. They
are sequenced together at
[`unread-badge-request-round-trip-cost`](unread-badge-request-round-trip-cost.md),
which calls for fixing THIS one first: it is the cheaper change and the larger
reduction, and the contact-lookup cost should be re-measured against the fixed
loop before anything is designed for it.

**Problem.** Filed from the spec-conformance review of
`feat/inbox-unread-index` (findings 2 and 5, both measured against the real
`aggregateInbox`).

Each iteration of the `filter=unread` fill-or-exhaust loop constructs a NEW
`collectUnreadRows`, hence a NEW layer-1 iterator, hence a NEW `queryUnreadPage`
starting from `scanPosition`. The iterator's internal page size is
`Math.min(UNREAD_QUERY_PAGE_SIZE, opts.budget - state.scanned)`
(`unreadFeed.ts`, the `limit:` passed to `queryUnreadPage`) and does NOT consider
`maxRows`, so a collect that will consume ONE item still fetches up to 100. The
request budget counts only CONSUMED items (`remainingBudget = budget - scanned`),
so the accounting cannot see the over-fetch, and the loop's own termination
argument ("capped consumed at least one raw item") is satisfied by consuming
exactly one.

Measured with a throwaway probe, at limits the route accepts (`parseLimit`
clamps to 1..100):

```
limit=1  -> rows=0  queries=601  itemsRead=55050  (budget reports "scanned=600")
limit=30 -> rows=0  queries=21   itemsRead=1880
```

601 serial DynamoDB Query round trips on one authed request is the exact latency
shape this feature exists to remove (the issue it closed measured 1,230 serial
calls at ~1.8s median). With `UNREAD_WALK_LIMIT = 2000` the ceiling is roughly
2000 round trips and ~180k item reads, while spec section 9 claims "cost scales
with scanned index items". `app/test/inboxFeed.test.ts` already exercises the
600-collect shape (it asserts only the WARN, never the query count), so the path
is real and reachable today.

SAME ROOT CAUSE, second symptom (conformance finding 5): the scanned-items
tripwire `warnUnreadScanned(log, startingBudget - remainingBudget)` reports
CONSUMED items, so the sentinel that exists to catch index accrual stays quiet
through precisely the pathology that would matter - it can under-report the real
index read by ~90x. The request-level accumulation itself is implemented
correctly; the budget it accumulates is what under-counts.

**Suggested fix.** The reviewer's three remedies, cheapest first:

1. Bound the internal page by the consumer's appetite, e.g.
   `Math.min(UNREAD_QUERY_PAGE_SIZE, budget - scanned, maxRows * k)` threaded
   from layer 2.
2. Count FETCHED rather than CONSUMED items against the budget, so the ceiling
   (and the tripwire) is honest.
3. Thread ONE iterator through the whole fill loop instead of building one per
   collect.

(1) and (2) are complementary and together fix both symptoms; (3) is the
structural fix and the largest change.
