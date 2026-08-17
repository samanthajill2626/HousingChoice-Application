---
id: unread-budget-truncation-has-no-forward-path
title: A budget-truncated unread feed mints no cursor and the nav badge renders nothing
type: bug
severity: med
status: open
area: app/inbox
created: 2026-08-16
refs: app/src/routes/inbox.ts, app/src/lib/unreadFeed.ts, dashboard/src/app/UnreadContext.tsx, dashboard/src/app/NavContents.tsx
---

**Problem.** Filed from the plan-blind adversarial review of
`feat/inbox-unread-index` (finding 1, CONFIRMED - reproduced against the real
`aggregateInbox` / `countUnreadRows` through the `unreadWalkLimit` seam). Two
halves, one cause: when the request's raw-scan budget (`UNREAD_WALK_LIMIT`,
2000) expires before the unread page fills, the feed reports the early end and
then throws away everything needed to get past it.

1. NO FORWARD PATH. The cursor block sets `truncated = true` and leaves
   `unreadCursor = null` even though `scanPosition` IS known at that moment. The
   position is deliberately discarded, so Retry re-runs the same deterministic
   prefix with a fresh budget and produces the identical answer. Every row
   behind the truncation point is unreachable through the API until the index
   itself is cleaned.
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

**Suggested fix.** Mint the cursor from the known `scanPosition` when the stop
was the BUDGET (truncation is about this request's budget, not the end of the
feed), which makes Retry / Load more actually advance; keep `truncated` as the
signal that the page ended early. For the badge, either surface `truncated` in
`UnreadContext` (an indeterminate marker rather than nothing) or, at minimum,
log a WARN on a truncated count of zero so the silent state is observable. Note
the depth-cap arm is a different case - it genuinely cannot mint a cursor the
server would accept, which is
[`seen-set-max-equals-max-inbox-limit`](./seen-set-max-equals-max-inbox-limit.md).
