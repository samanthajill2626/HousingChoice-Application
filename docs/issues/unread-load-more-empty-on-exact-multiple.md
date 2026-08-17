---
id: unread-load-more-empty-on-exact-multiple
title: An unread feed sized an exact multiple of `limit` shows a Load more that returns nothing
type: bug
severity: low
status: open
area: app/inbox
created: 2026-08-16
refs: app/src/lib/unreadFeed.ts, app/src/routes/inbox.ts, dashboard/src/routes/inbox/useInbox.ts
---

**Problem.** Filed from the fix-wave re-reviews of `feat/inbox-unread-index`
(conformance N2 and adversarial NEW-4 - the same mechanism, seen from the cursor
side and the `truncated` side). Both probe-verified against the real
`aggregateInbox`. Cosmetic, and PRE-EXISTING: the fix wave did not touch
`capped`.

`collectUnreadRows` sets `capped` when `candidates.length >= opts.maxRows`, which
fires on the VERY ITEM that exhausts the supply. `consumedAll` is
`!capped && state.scanExhausted`, so `capped` shadows `scanExhausted`: a collect
that fills the page at the same moment the index runs out reports "page full",
never "supply exhausted". The route then takes a page-full arm on a page with
nothing behind it. Two symptoms, depending on where the page lands:

1. INSIDE the depth cap - the route mints a cursor. A feed whose size is an exact
   multiple of `limit` therefore hands back a cursor on its last FULL page:

```
60 unread contacts at limit 30
lens=[30,30,0]   page 2 mints a cursor
page 3           rows=0  cursor=null  truncated=undefined
```

   `hasMore: cursor !== null` renders "Load more" on page 2; clicking it appends
   nothing and the button then disappears.

2. PAST the depth cap - the depth-cap arm fires instead and claims a truncation
   that did not happen:

```
=== 101 unread contacts, limit 30 ===  p3: rows=11  truncated=undefined  delivered 101/101
=== 120 unread contacts, limit 30 ===  p3: rows=30  truncated=true       delivered 120/120  <- FALSE
=== 130 unread contacts, limit 30 ===  p3: rows=30  truncated=true       delivered 120/130  <- true
```

   The fix wave's two new tests use exactly 101 and 130, so they BRACKET this
   boundary and miss it. `n = limit * k` landing on the depth cap is the general
   case.

Harmless today: no rows are lost in either symptom, the empty-rows-implies-null-
cursor invariant still holds (`app/src/routes/inbox.ts` forces the cursor null on
an empty page), and symptom 2 renders no affordance because rows are present. But
it contradicts the contract the fix wave itself restated - "`truncated` names a
NON-NATURAL end ... rows were WITHHELD" - so any future consumer that renders an
affordance on `truncated` with rows will lie. Related:
[`unread-budget-truncation-has-no-forward-path`](./unread-budget-truncation-has-no-forward-path.md)
(the other early-end signal) and
[`seen-set-max-equals-max-inbox-limit`](./seen-set-max-equals-max-inbox-limit.md)
(the depth cap itself).

**Suggested fix.** Have `collectUnreadRows` report `scanExhausted` INDEPENDENTLY
of `capped` (or have the route consult `state.scanExhausted` directly), so a
page that filled AND exhausted the supply takes the natural-end arm: no cursor,
no `truncated`. A regression test wants `unreadWorld(120)` at `limit: 30`
asserting `truncated === undefined` with 120/120 delivered, plus
`unreadWorld(60)` at `limit: 30` asserting page 2 mints no cursor.
