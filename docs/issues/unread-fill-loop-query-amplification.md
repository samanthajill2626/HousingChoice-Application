---
id: unread-fill-loop-query-amplification
title: The unread fill loop re-queries the index per collect, reading ~3x the items a default page needs and up to ~90x at limit=1
type: bug
severity: med
status: open
area: app/inbox
created: 2026-08-16
refs: app/src/lib/unreadFeed.ts:349, app/src/routes/inbox.ts:1245
---

**Re-adjudicated 2026-08-25 against main @88ac7b36.** The defect reproduces
unmodified, but two of its framing claims were false and two of its three
remedies are now DISPROVEN: this amplification does NOT touch the nav badge, and
remedy 3 is the only sound shape. Severity stays med.

**SCOPED INTO A MISSION 2026-08-21, RE-SLICED 2026-08-25.** This issue,
[`unread-budget-truncation-has-no-forward-path`](unread-budget-truncation-has-no-forward-path.md),
[`inbox-truncated-flag-two-meanings`](inbox-truncated-flag-two-meanings.md) and
[`unread-load-more-empty-on-exact-multiple`](unread-load-more-empty-on-exact-multiple.md)
are now ONE slice: all four land on the same few lines of
`app/src/lib/unreadFeed.ts` and share one flag contract (`capped` /
`scanExhausted` / `truncated` / `consumedAll`), so fixing them apart means three
more passes over the same code.

**IT IS NOT A BADGE FIX - the earlier framing here was wrong and is corrected
in place.** This issue used to open by calling itself one of "the two
amplifications inside the same badge request", and
[`unread-badge-request-round-trip-cost`](unread-badge-request-round-trip-cost.md)
sequences it first on that premise. The premise is false. `countUnreadRows`
(`app/src/routes/inbox.ts:1674`) makes exactly ONE `collectUnreadRows` call - no
fill loop, no `startAfter` - and its `maxRows` is `BADGE_COUNT_CAP` (100), which
ALREADY EQUALS `UNREAD_QUERY_PAGE_SIZE` (100), so the badge's internal page is
already exactly its appetite and there is nothing here to bound. This defect
lives on `GET /api/inbox?filter=unread` (`aggregateInbox`) ONLY. Expect NO badge
round-trip change from this work, and measure the badge against the per-item
contact lookup alone.

**Problem.** Filed from the spec-conformance review of
`feat/inbox-unread-index` (findings 2 and 5, both measured against the real
`aggregateInbox`).

Each iteration of the `filter=unread` fill-or-exhaust loop
(`app/src/routes/inbox.ts:1245`) constructs a NEW `collectUnreadRows`, hence a
NEW layer-1 iterator, hence a NEW `queryUnreadPage` starting from
`scanPosition`. The iterator's internal page size is
`Math.min(UNREAD_QUERY_PAGE_SIZE, opts.budget - state.scanned)`
(`app/src/lib/unreadFeed.ts:349`, the `limit:` passed to `queryUnreadPage`) and
does NOT consider `maxRows`, so a collect that will consume ONE item still
fetches up to 100. The request budget counts only CONSUMED items
(`remainingBudget = budget - scanned`) - a consumer that breaks the `for await`
leaves the generator suspended at its `yield`, so the rest of the already-FETCHED
page never reaches `state.scanned += 1` - and the loop's own termination argument
("capped consumed at least one raw item") is satisfied by consuming exactly one.
Nothing bounds the ITERATION COUNT.

Measured with a throwaway probe, at limits the route accepts (`parseLimit`
clamps to 1..100):

```
limit=1  -> rows=0  queries=601  itemsRead=55050  (budget reports "scanned=600")
limit=30 -> rows=0  queries=21   itemsRead=1880
```

Both figures reproduce the code exactly (sum over i=1..600 of min(100, 601-i) =
55050; 17*100 + 90 + 60 + 30 = 1880), re-derived 2026-08-25 - the mechanism has
not moved.

**READ THE TWO LIMITS AS TWO DIFFERENT CLAIMS.** `limit=1` is reachable by any
authed caller but is NOT a shape the app issues: the dashboard always sends 30
(`dashboard/src/routes/inbox/useInbox.ts:94`, `PAGE_LIMIT = 30`). So the ROUTINE
cost is the second line - roughly 3x the items and 3.5x the round trips of the
ideal 6 Queries for 600 items. The `limit=1` line is the CEILING an authed
operator can reach by hand: with `UNREAD_WALK_LIMIT = 2000`, roughly 2000 serial
round trips and ~180k item reads on one request against a shared table, while
spec section 9 claims "cost scales with scanned index items". That ceiling is why
this stays med rather than low; the 3x routine cost is why it is not high.
`app/test/inboxFeed.test.ts:1783` ("SCAN SENTINEL") already exercises the
600-collect shape - the filed probe verbatim - and asserts only the WARN, never
the query count, so the path is real, reachable, and GREEN today.

SAME ROOT CAUSE, second symptom (conformance finding 5): the scanned-items
tripwire `warnUnreadScanned(log, startingBudget - remainingBudget)`
(`app/src/routes/inbox.ts:1351`) reports CONSUMED items, so the sentinel that
exists to catch index accrual can under-report the real index read by ~90x. The
original wording here - that it "stays quiet through precisely the pathology" -
was too strong and is corrected: in the 600-item probe consumed is 600, which is
past `UNREAD_WALK_WARN` (500), so the WARN DOES fire, and the SCAN SENTINEL test
asserts exactly that. The true statement is narrower: any walk consuming fewer
than 500 items is silent no matter how much it read. A 300-item index at
`limit=1` issues ~300 Queries and reads ~29,850 items with zero WARNs. The
request-level accumulation itself is implemented correctly; the budget it
accumulates is what under-counts.

**DISPROVEN REMEDIES - do not re-propose either of these.** The reviewer filed
three remedies and recommended the first two "together"; the C1 spec froze that
pairing and put the third out of scope. Re-adjudication 2026-08-25 reversed both
calls.

**Remedy 1 - bound the internal page by `maxRows * k` - is DISPROVEN. It trades
an item-read amplification for a ROUND-TRIP amplification, in the shape this
cluster exists for.** `maxRows` counts rows EMITTED, not index items required to
find them, and the two diverge without bound on every path where layer 2 consumes
without emitting. There are three, all live on this exact code path:

- a residue wall of hidden deleted contacts (they pass `isUnreadVisible`, so
  layer 1 yields them, but `threadResurfaces` pushes no candidate);
- the seen-set, `app/src/lib/unreadFeed.ts:620` - on page 2+ the cursor carries
  up to `SEEN_SET_MAX` (100) contact ids and every item belonging to one is
  consumed silently;
- a contactless email thread, which returns without pushing.

In all three the collect walks a long run at `maxRows * k` items per round trip,
and it cannot short-circuit: `queryUnreadPage` carries NO FilterExpression
(`app/src/repos/conversationsRepo.ts:1733`), and the service returns a
LastEvaluatedKey whenever the request's Limit was REACHED - the model
`app/test/unreadFeed.test.ts:474` pins deliberately. A smaller Limit therefore
buys only more round trips. Worst case at `k = 1`: near page-fill the loop has
`maxRows = limit - unreadRows.length = 1`, so crossing a 2000-item residue wall
costs ~2000 Queries where 20 would do - a 100x regression in round trips, which
[`unread-badge-request-round-trip-cost`](unread-badge-request-round-trip-cost.md)
itself names as the actual cost driver. Any SAFE version needs a floor at
`UNREAD_QUERY_PAGE_SIZE`, which is today's behaviour exactly. There is no sound
non-trivial form of remedy 1.

**Remedy 2 - count FETCHED rather than CONSUMED against the budget - is
DISPROVEN as a budget change.** `budget` is not only a cost ceiling; it is the
input to the page's COMPLETENESS verdict (`app/src/routes/inbox.ts:1292`
`remainingBudget === 0` -> `budgetSpent` -> `truncated` at `:1392`), and zero rows
plus `truncated` is the client's inbox ERROR state (documented in place at
`app/src/routes/inbox.ts:1113-1117`). Charging redundant re-fetches to that budget
makes a page's completeness a function of its own inefficiency. Run this issue's
own 600-item probe under it: today the loop ends `consumedAll` - a CORRECT,
complete "you are caught up" - and under remedy 2 it dies at ~20 collects having
genuinely SEEN all 600 items, reporting `truncated: true` and claiming rows were
withheld that were not. It would also turn the SCAN SENTINEL test's
`scanned: 600` into ~2000. The REPORTING half of remedy 2 is still wanted (see
below); the BUDGET half is not.

**Suggested fix.** Remedy 3, which is the only sound shape, plus remedy 2's
reporting half:

1. **Thread ONE iterator through the whole fill loop** instead of building one
   per collect. It is the only remedy that reduces round trips, item reads AND
   tripwire dishonesty at once WITHOUT changing what the page answers: the
   600-item / `limit=1` probe becomes ~7 Queries and 600 items read with the same
   rows, the same `consumedAll`, and the same cursor.

   MECHANICAL CONSTRAINT, verify before estimating: layer 2 drives the generator
   with `for await ... break` (`app/src/lib/unreadFeed.ts:659-683`), and that
   `break` calls `.return()`, which CLOSES the generator permanently - the module
   comment at `:671-673` relies on that deliberately, because it is what makes
   the cap stop the scan rather than slice its output. A threaded iterator
   therefore requires explicit `.next()` pulls, or an already-created iterator
   plus a shared `UnreadWalkState` passed in. Narrowest shape: give
   `collectUnreadRows` an optional `{ iterator, state }` pair; the route creates
   it once from the cursor and hands the same pair to every collect. `startAfter`
   stays for the badge and for that first creation, and `excludeContactIds`,
   `wastedProbesBefore`, `scanPosition` and every result field keep their current
   meanings.

2. **Report FETCHED items alongside consumed** - an `itemsFetched` counter that
   the tripwire and the `'inbox feed assembled'` line carry - so the accounting
   stops under-reporting. This is remedy 2's honest half with none of its budget
   consequences, and once (1) removes the redundancy the two figures differ only
   by the tail of the last page.

**Remedy 3 was OUT OF SCOPE in the C1 spec and is now IN scope.**
`docs/superpowers/specs/2026-08-24-inbox-unread-read-path-design.md` section 3.2
says "Take remedies 1 and 2 together" and section 7 lists remedy 3 as out of
scope "unless the measurement demands it". The measurement is not needed: remedy
1 is disproven by construction and remedy 2's budget half is disproven by its
effect on `truncated`. The spec's sections 3-7 are unbuilt, so this is a
spec-gate correction rather than a rework.

Two more things this work owns:

- [`inbox-read-accounting-gaps`](inbox-read-accounting-gaps.md) explicitly defers
  its `scanned` RENAME to this fix, to avoid naming the field twice. Land it here.
- Add the query-count assertion the SCAN SENTINEL test never had. Acceptance is
  round-trip COUNT, not wall-clock; local DynamoDB timings are emulator-bound.
  `app/test/unreadIndexFakeMirror.integration.test.ts` pins the fake's Limit and
  LastEvaluatedKey semantics against the real service and must stay green, since
  it is what makes any call-count assertion mean anything.
