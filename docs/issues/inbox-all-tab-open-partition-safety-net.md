---
id: inbox-all-tab-open-partition-safety-net
title: The filter=all inbox pager walks the open partition with no scan budget, no cursor-on-stop, and no truncated flag
type: debt
severity: med
status: open
area: app
created: 2026-09-02
refs: app/src/routes/inbox.ts, app/src/lib/unreadFeed.ts, dashboard/src/routes/inbox/useInbox.ts, dashboard/src/routes/inbox/Inbox.tsx, docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md
---

**Problem.** Spun out of
[`inbox-filter-tabs-full-walk`](inbox-filter-tabs-full-walk.md) on 2026-09-02
when that issue was re-stamped resolved; this is the one remainder it still
tracked as OWED. The `filter=all` pager (`app/src/routes/inbox.ts`, the
`pager:` loop over `conversations.listByLastActivity({ status: 'open' })`)
fills a page by walking the open partition in chunks and breaks only when the
page fills or the stream is exhausted. It applies no raw-scan budget, mints no
cursor when it stops early (it cannot stop early), and never sets the wire
`truncated` flag. Its sibling reads are all bounded: `groups` pages its own
partition through a tagged cursor, `unread` reads the sparse `byUnread` index
under `UNREAD_WALK_LIMIT` and reports `truncated`, and `unknown` reads the
contacts triage partition under `UNKNOWN_QUEUE_SCAN_BUDGET` with the index's
own cursor.

In practice the All tab is cheap: its page fills from the head of the
newest-first partition, so it walks about one page of conversations per
render. The safety net is about the shape, not the bill - an unbounded read
should not exist even when it is cheap, because it has no forward path if it
ever does get slow enough to time out (a partition thick with rows a filter
rejects, or a `passesFilter` that starts rejecting most rows).

**Why it was not built with the unknown-tab work (human ruling 2026-08-25).**
Spec section 5 of
[`2026-08-25-inbox-unknown-tab-walk-design.md`](../superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md)
ships its own named gate unsolved: a budget-stopped ZERO-ROW `filter=all` page
carrying `truncated` lights the dashboard's non-filter-gated failure banner
(`Inbox.tsx`, the `truncated` check) on an org where nothing failed, and the
spec says that must be solved FIRST. The unknown branch sidestepped it by
never setting `truncated` and letting the CURSOR be the continuation signal;
the `all` pager's empty-page invariant makes that answer unavailable to it as
written (trap 1 below).

**Two traps found in plan review, carried verbatim from the parent issue for
whoever picks it up:**

1. The empty-page invariant NULLS the cursor, so "Load more" cannot be the
   affordance in exactly the state that needs one.
2. Replacing the pager loop's tail orphans the `moreChunks` binding
   (`app/src/routes/inbox.ts:1799` post-flip; its ONLY reader is the loop's
   tail at `:1840`), which is a gate-5 `no-unused-vars` error unless the
   binding is deleted along with the tail.

The line numbers in trap 2 are as recorded on 2026-08-25 and have moved since
(`const moreChunks = chunk.lastEvaluatedKey !== undefined` and its `if
(!moreChunks)` reader sit near the end of the `pager:` loop today); the shape
of the trap has not.

**Suggested fix.** Give the `all` pager the same three-part contract the
`unread` branch already has: a raw-scan budget, a cursor minted at the exact
position the walk stopped (the pager already mints an exact mid-chunk boundary
on the page-full exit, so the mechanism exists), and an honest signal to the
client. Decide the empty-page-with-more question BEFORE touching the loop:
either the dashboard learns that an empty page carrying a cursor is a "nothing
here yet, more to read" state for `all` as it already does for `unknown`
(`emptyMoreCopy()`), or `truncated` becomes filter-aware on the client. Either
answer changes the wire contract for a state that does not occur today, so it
wants a spec paragraph, not a drive-by.

**Reachability today.** Not a live cost: the All tab fills from the head of
the partition. This is a forward guard against an unbounded read surviving in
the one feed that still has one.
