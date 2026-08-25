---
id: unread-load-more-empty-on-exact-multiple
title: An unread feed sized an exact multiple of `limit` shows a Load more that returns nothing
type: bug
severity: low
status: open
area: app/inbox
created: 2026-08-16
refs: app/src/lib/unreadFeed.ts, app/src/routes/inbox.ts, dashboard/src/routes/inbox/useInbox.ts, dashboard/src/routes/inbox/Inbox.tsx
---

**Problem.** Filed from the fix-wave re-reviews of `feat/inbox-unread-index`
(conformance N2 and adversarial NEW-4 - the same mechanism, seen from the cursor
side and the `truncated` side). Both probe-verified against the real
`aggregateInbox`. PRE-EXISTING: the fix wave did not touch `capped`. Filed as
"cosmetic", which is no longer true of symptom 2 - see the re-adjudication
paragraph below.

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
   nothing and the button then disappears. It costs one wasted request and one
   wasted Query; no row is lost.

   SYMPTOM 1 IS NOT AN UNREAD DEFECT - it is inbox-wide LEK paging (verified
   2026-08-25). DynamoDB returns a LastEvaluatedKey whenever the request's Limit
   was REACHED, not when rows remain, so the `all` filter does exactly the same
   thing on its own pager: `chunkSize = min(FETCH_BATCH, max(limit, 25))` is 30
   at the shipped page size, exactly 30 open conversations produce a chunk of 30
   WITH a key, the page-full arm takes `boundaryKey = chunk.lastEvaluatedKey`,
   mints a cursor, and the next page comes back empty with `nextCursor: null`.
   Whatever is decided here, the same trailing empty page stays reachable on
   `all` unless that pager is changed too. Only symptom 2 is unique to the
   unread branch.

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

   THE CAPTION ABOVE IS THE ORIGINAL PROBE'S AND ITS PAGE ARITHMETIC ONLY CLOSES
   AT limit 45 (45+45+11 = 101, 45+45+30 = 120), so read "p3" as that probe's,
   not as limit 30's. Re-traced at limit 30 on 2026-08-25 the boundary is one
   page later and the mechanism is identical: 120 unread contacts, p4's collect
   caps on item 120 (the buffer's last item, `more === false`), `consumedAll`
   stays false, `seen.size` is 120 > `SEEN_SET_MAX` (100), so the depth-cap arm
   returns rows=30, cursor=null, truncated=true having delivered 120 of 120.

   Symptom 2 needs BOTH conditions - the seen-set past 100 AND the supply ending
   exactly on a page fill - so at the shipped page size it is n = 120 alone.
   n = 150 also trips the depth cap at p4, but 30 rows really are unreachable
   behind it, so there the flag is TRUE.

NOT harmless, and the original "renders no affordance because rows are present"
claim WENT STALE ONE DAY AFTER FILING. No rows are lost in either symptom and the
empty-rows-implies-null-cursor invariant still holds (`app/src/routes/inbox.ts`
forces the cursor null on an empty page) - that much is unchanged. But the
consumer this issue predicted ("any future consumer that renders an affordance on
`truncated` with rows will lie") SHIPPED on 2026-08-17 in `aa12a9dd`
("feat(inbox): say when the Unread list is capped"). `dashboard/src/routes/inbox/
Inbox.tsx` gates a notice on `filter === 'unread' && truncated &&
serverRowCount > 0` - precisely the state symptom 2 fabricates - and renders
"Showing the most recent unread. There are older unread threads not shown here."
over a feed that delivered every row it had. `hasMore` is deliberately NOT in
that gate, so nothing else suppresses it. A false sentence to the operator is a
WORSE outcome than the silence this issue originally described: it invites a hunt
for older unread threads that do not exist. Severity stays `low` because
symptom 2 needs the narrow n = 120 shape above, but it is no longer cosmetic and
must not be triaged as such. Related:
[`unread-budget-truncation-has-no-forward-path`](./unread-budget-truncation-has-no-forward-path.md)
(the other early-end signal) and
[`seen-set-max-equals-max-inbox-limit`](./seen-set-max-equals-max-inbox-limit.md)
(the depth cap itself).

**The first suggested fix, DISPROVEN 2026-08-25.** It read: "Have
`collectUnreadRows` report `scanExhausted` INDEPENDENTLY of `capped` (or have the
route consult `state.scanExhausted` directly)". It does not close this, and an
implementer who follows it ships a NO-OP WITH A GREEN SUITE.

`scanExhausted` is not being shadowed while true - it is already FALSE at the cap
break. `iterateUnreadConversations` sets it only AFTER its page's item loop, and
`break` out of a `for await ... of` calls the generator's `return()`, which
unwinds from the suspended `yield` (there is no `try`/`finally` in that
function), so the line never runs on a capped collect. The generator's own
comment says as much. So `consumedAll: state.scanExhausted` returns exactly
today's answer for exactly the reported case, and every existing assertion stays
green. The parenthetical is not available either: `state` is a local of
`collectUnreadRows` and reaches the route only through `CollectResult`.

The one mechanical way to make it non-no-op - dropping `!capped` from
`truncated` - is WORSE: every ordinary capped collect would then report
`truncated`. Page 1 of `unreadWorld(40)` at limit 30 flips (a test asserts
`undefined`), and `countUnreadRows` returns the collector's `truncated` verbatim
to the nav badge, so a badge that merely hit `BADGE_COUNT_CAP` would claim its
count is a floor for the wrong reason - collapsing the `capped` vs `truncated`
distinction the wire keeps on purpose.

**Suggested fix (rewritten 2026-08-25).** Three COORDINATED edits. Any one or two
of them alone is a no-op on the reported case.

1. `iterateUnreadConversations` sets `state.scanExhausted = true` BEFORE yielding
   the final item of a final page - when `!more` and the loop is at
   `page.items.length - 1` - instead of only after the loop. At that point the
   stream IS over whatever the consumer does next, and the flag costs no extra
   read: it is the half of the lookahead the LastEvaluatedKey already paid for.
2. `collectUnreadRows` then derives `consumedAll: state.scanExhausted` alone
   (drop `!capped`), which is now truthful - the flag can only be set at the
   final item, and a consumer that caps there has consumed every yielded item.
   `truncated` KEEPS its `!capped` guard; that is what avoids the badge
   regression above.
3. `app/src/routes/inbox.ts` records `consumedAll` BEFORE the page-full break in
   the fill-or-exhaust loop (`if (collected.consumedAll) consumedAll = true;`
   ahead of `if (unreadRows.length >= limit) break;`). Today page-full is checked
   first, so the route never observes the corrected flag on the very page this
   issue is about.

RESIDUE, stated plainly so it is not rediscovered as a defect: this removes the
common instances (n = 30 / 60 / 90 / 120 at the shipped page size), not the
class. A supply ending on a 100-item query-page boundary still cannot be
detected without an extra Query - the service returns a LastEvaluatedKey because
the Limit was REACHED, so a walk that caps on item 100 of a 100-item buffer has
`more === true` and cannot know the stream ended without spending another Query
and another slice of the raw-scan budget. An org with exactly 100 unread rows at
limit 25 keeps its empty trailing page.

Regression tests (the original two, which were right): `unreadWorld(120)` at
`limit: 30` asserting `truncated === undefined` with 120/120 delivered, plus
`unreadWorld(60)` at `limit: 30` asserting page 2 mints no cursor. Nothing in
`app/test/unreadFeed.test.ts` or `app/test/inboxFeed.test.ts` currently pins
either shape, and no existing assertion there breaks under the three edits: the
40 / 101 / 130 / 300-item cases all cap mid-buffer or end naturally, where edit 1
cannot reach them.

**Re-adjudicated 2026-08-25 against main @88ac7b36.** The defect still
reproduces, both symptoms, traced end to end from `collectUnreadRows` to the
rendered "Load more"; what changed is that the first suggested fix is disproven
(no-op), symptom 1 is now recorded as inbox-wide LEK paging rather than an unread
defect, and symptom 2 is no longer harmless because the `truncated`-with-rows
notice shipped on 2026-08-17. This issue is now ONE SLICE with
[`unread-fill-loop-query-amplification`](./unread-fill-loop-query-amplification.md),
[`unread-budget-truncation-has-no-forward-path`](./unread-budget-truncation-has-no-forward-path.md)
and [`inbox-truncated-flag-two-meanings`](./inbox-truncated-flag-two-meanings.md),
sharing one coherent flag contract (`capped` / `scanExhausted` / `truncated` /
`consumedAll`) in `app/src/lib/unreadFeed.ts`.
