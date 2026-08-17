---
id: unread-budget-truncation-has-no-forward-path
title: A budget-truncated unread badge renders nothing (half fixed - the page now pages)
type: bug
severity: low
status: open
area: app/inbox
created: 2026-08-16
updated: 2026-08-16
refs: app/src/routes/inbox.ts, app/src/lib/unreadFeed.ts, dashboard/src/app/UnreadContext.tsx, dashboard/src/app/NavContents.tsx
---

**HALF RESOLVED 2026-08-16** (review fix wave 1, conformance C1; spec 4.5 step 2
amended). Half 1 below - the missing forward path - is FIXED: a truncated page
that HAS rows now mints its cursor from the `scanPosition` it already paid for,
so Load more advances past the truncation point. An EMPTY truncated page still
returns null, which is the invariant the client's empty-state gating rests on.

Half 2 - the silent-zero badge - REMAINS OPEN and is what this issue now tracks.
Rendering an indeterminate badge is out of v1's scope, so the interim measure is
server-side only: `countUnreadRows` logs a rate-limited WARN
(`unread_badge_truncated_zero`) when it answers 0 with the walk stopped early,
which makes the state observable but still leaves the OPERATOR looking at a
blank nav item. Note the walk can now also stop early on the deleted-probe bound
(`UNREAD_DELETED_PROBE_LIMIT`), not only on the raw-scan budget, which makes
this state cheaper to reach than the 2000-resident estimate below.

**Problem.** Filed from the plan-blind adversarial review of
`feat/inbox-unread-index` (finding 1, CONFIRMED - reproduced against the real
`aggregateInbox` / `countUnreadRows` through the `unreadWalkLimit` seam). Two
halves, one cause: when the request's raw-scan budget (`UNREAD_WALK_LIMIT`,
2000) expires before the unread page fills, the feed reports the early end and
then throws away everything needed to get past it.

1. NO FORWARD PATH - FIXED, see the note above. The cursor block set
   `truncated = true` and left
   `unreadCursor = null` even though `scanPosition` WAS known at that moment.
   The position was deliberately discarded, so Retry re-ran the same
   deterministic prefix with a fresh budget and produced the identical answer.
   Every row behind the truncation point was unreachable through the API until
   the index itself was cleaned.
2. SILENT-ZERO BADGE. `countUnreadRows` returns
   `{unreadCount: 0, capped: false, truncated: true}`, but `UnreadContext` reads
   only `unreadCount` and `capped` - the word `truncated` appears in that file
   exactly once, in a comment - and `NavContents` renders a badge only when
   `unread > 0`. The operator sees NO badge: visually identical to "all caught
   up", while unread work exists. (`InboxUnreadCount.truncated` is a wire field
   with a documented client contract that no client implements - adversarial 7,
   the same mechanism seen from the contract side.)

Reproduction (verbatim from the reviewer):

```
world: 10 index rows flagged unread with status 'closed'  (invisible residents)
       + 1 genuinely unread OPEN thread, OLDER, so it sits behind them
budget: unreadWalkLimit = 5

GET /api/inbox/unread-count -> {"unreadCount":0,"capped":false,"truncated":true}
   -> nav badge renders NOTHING

GET /api/inbox?filter=unread
   page 0: rows=(none) cursor=null truncated=true
   -> Inbox.tsx renders the inbox failure state + Retry, forever;
      the real unread row is unreachable through the API.
```

At the production budget this needs roughly 2000 invisible residents ahead of
the first visible row, so it is not an everyday state. The accrual paths that
get there are [`inbound-reflags-closed-relay-group`](./inbound-reflags-closed-relay-group.md)
and the mark-read half of
[`markread-fanout-depends-on-stale-participant-gsi`](./markread-fanout-depends-on-stale-participant-gsi.md);
the delete-side accrual was closed in the fix wave.

NOT IN SCOPE HERE: that Retry is ineffective on a truncated page was a KNOWN,
accepted design decision (review round 4 - spec 4.5 step 3 says in as many words
that "the point of this state is not lying, not guaranteed recovery"). This
issue is about the missing forward path and the silent-zero badge, not about
re-litigating that ruling.

**Suggested fix.** The cursor half is done as described (mint from the known
`scanPosition`, keep `truncated` as the early-end signal). WHAT IS LEFT: surface
`truncated` in `UnreadContext` and give `NavContents` an indeterminate marker,
so a truncated zero stops looking exactly like "all caught up". Note
the depth-cap arm is a different case - it genuinely cannot mint a cursor the
server would accept, which is
[`seen-set-max-equals-max-inbox-limit`](./seen-set-max-equals-max-inbox-limit.md).
