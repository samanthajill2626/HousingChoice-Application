---
id: seen-set-max-equals-max-inbox-limit
title: MAX_INBOX_LIMIT <= SEEN_SET_MAX is a load-bearing invariant with zero margin, undocumented and untested
type: debt
severity: low
status: open
area: app/inbox
created: 2026-08-16
updated: 2026-09-25
refs: app/src/routes/inbox.ts:223, app/src/routes/inbox.ts:272, app/src/routes/inbox.ts:1715, app/test/inboxFeed.test.ts
---

Re-adjudicated 2026-08-25 against main @88ac7b36. The originally filed symptom
was disproved and the body below was rewritten in place: the defect is real but
runs in the OPPOSITE direction from the way it was first written, so the old
text is gone rather than left standing above a correction. Line citations were
refreshed on 2026-09-25 against `feat/inbox-rows-timestamps`; the findings did
not change.

**The filed symptom does not reproduce, and never did.** The original body said
that a client requesting `?filter=unread&limit=100` gets page 1 and that page 2
is impossible. That is false. The depth cap at `app/src/routes/inbox.ts:1715` is
a STRICT comparison, `seen.size > SEEN_SET_MAX`, and it has been strict since the
feature's first commit `3bdc1801` - `git log -S "seen.size >= SEEN_SET_MAX" --
app/src/routes/inbox.ts` returns NOTHING, and `git show
3bdc1801:app/src/routes/inbox.ts` already carries the `>` form. A 100-row page one
produces a seen-set of exactly 100, which is not `> 100`, so the minter emits the
cursor and the decoder accepts it (`inbox.ts:562` uses the same strict bound,
`payload.s.length > SEEN_SET_MAX`). Page 2 is served normally.

**The reachability runs the other way.** The seen-set is seeded from the cursor
(`inbox.ts:1393`), grows only on an EMITTED contact row (`inbox.ts:1612`), and the
fill loop plus the lagged-drop retry are both bounded at the page size
(`inbox.ts:1578`, `inbox.ts:1654`), so `seen.size <= resume.s.length + limit`.
Reachable depth is therefore `SEEN_SET_MAX + limit`: `limit=100` reaches 200
contacts, `limit=30` reaches 120, `limit=25` reaches 125. **The maximum limit the
route advertises buys the DEEPEST feed, not the shallowest.** The 120 figure is
the one already pinned by a passing test, `app/test/inboxFeed.test.ts:1489`
("130 unread contacts at limit 30 ... expect 120").

**The real finding is the invariant, and its direction.** `MAX_INBOX_LIMIT`
(`inbox.ts:223`) must stay `<=` `SEEN_SET_MAX` (`inbox.ts:272`). That is what makes
page one pageable at all: if `MAX_INBOX_LIMIT` were raised to 101, a client asking
`?filter=unread&limit=101` would emit 101 rows, `seen.size` would be 101, the cap
would fire, and page one would come back `truncated: true` with `nextCursor: null`
- exactly the failure the old body described, CREATED by moving the constant the
old body implied was harmless. Today the two sit on that boundary with ZERO
margin, the coupling is named in neither constant's comment, and nothing pins it:
`MAX_INBOX_LIMIT` is imported by no test, and every `aggregateInbox` limit in
`app/test/inboxFeed.test.ts` is 1, 2, 3, 4, 25, or 30 - nothing above 30
exercises the boundary.

Nothing ships broken, but the margin is now live: since
`feat/inbox-rows-timestamps` (2026-09-25) the dashboard requests `limit=100`
(`dashboard/src/routes/inbox/useInbox.ts:60`, `DEFAULT_PAGE_LIMIT`), which is
exactly `SEEN_SET_MAX`. The strict `>` comparison keeps page two reachable
(a 100-row page one seeds a 100-id seen-set, not `> 100`), and the two
depth-cap ordering tests in `app/test/inboxFeed.test.ts` still cover the cap:
"DEPTH CAP: past SEEN_SET_MAX ids on a page that EXHAUSTED the supply is a
natural end, NOT truncated" (`:1469`) and "DEPTH CAP: past SEEN_SET_MAX ids
with supply REMAINING withholds rows and says truncated" (`:1489`). The
pinning boundary test proposed below is now worth landing. This stays
`debt`, and stays `low`.

Related, tracked separately, no sequencing claimed here:
[`unread-load-more-empty-on-exact-multiple`](./unread-load-more-empty-on-exact-multiple.md).

**Suggested fix.** Two cheap pieces, and nothing in production changes.

1. A comment at BOTH constants (`inbox.ts:223` and `inbox.ts:272`) naming the
   invariant WITH its direction: `MAX_INBOX_LIMIT` must remain `<= SEEN_SET_MAX`,
   because a page-one seen-set larger than the cap leaves the server unable to
   mint a cursor it would itself accept, ending unread paging after one page.
2. One boundary test. `SEEN_SET_MAX` is module-private, so assert it through the
   route: page a >200-contact unread world at `limit: MAX_INBOX_LIMIT` and require
   page one to return a non-null cursor. That is the pin that stops a future edit
   breaking this silently.

The two remedies originally suggested here are WORSE and should not be revived:

- **Raising `SEEN_SET_MAX` above `MAX_INBOX_LIMIT` fixes nothing** - it is already
  `>=`. It only buys depth, and the budget for that is nearly spent: the doc block
  at `inbox.ts:257-271` sizes 100 ids at ~6.3KB base64url against CloudFront's
  8,192-byte URL limit, leaving roughly 28 further ids of headroom before the
  transport, not Node, is the failure mode - and an oversized cursor works locally
  and fails only in a deployed environment. It would also break
  `app/test/inboxFeed.test.ts:1489`, whose 130-contact world would stop truncating
  and need resizing.
- **Clamping `filter=unread` below the depth cap makes the feed strictly
  shallower** - `limit=99` reaches 199 where `limit=100` reaches 200 - and its
  stated goal ("at least one more page is always reachable") is already met at
  every legal limit. It would also push a filter-specific special case into
  `parseLimit` (`inbox.ts:2711-2716`), which is shared by all four filters.
