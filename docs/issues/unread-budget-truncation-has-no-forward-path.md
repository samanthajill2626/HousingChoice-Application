---
id: unread-budget-truncation-has-no-forward-path
title: A truncated unread badge renders nothing (half fixed - the page now pages)
type: bug
severity: med
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
blank nav item.

**SEVERITY RESTORED to `med` 2026-08-16** (review fix wave 2, adversarial r2
finding 2). Fix wave 1 dropped it to `low` while simultaneously making the state
FAR cheaper to reach - the deleted-probe bound stopped the whole walk after 26
probes, so 27 hidden deleted threads (not ~2000 invisible residents) produced a
zero badge AND a page of zero rows with a null cursor. The direction was wrong,
so the severity is back.

**The corrected mechanism (fix wave 2).** The probe bound now counts only WASTED
probes and stops the PROBING, never the WALK: past the bound a deleted-contact
thread is treated as hidden without a read, and live contacts, unknowns, groups
and relay threads behind the wall are still counted and still emitted. So the
27-hidden world answers 5 (its true visible count) and the page returns those 5
rows.

**A DRAINED STREAM IS A NATURAL END (fix wave 3, adversarial r3 finding 2).**
Wave 2 additionally made those skipped threads force `truncated` even when the
walk then drained its supply, and wave 2's own note called what remained "the
genuinely-zero case". That understated it: an org whose index holds nothing but
hidden residue and is otherwise CAUGHT UP got a zero badge marked as a floor and
an empty page marked truncated, which is the client's inbox FAILURE state
(`serverRowCount === 0 && truncated`) - permanently, over a deterministic prefix
whose Retry reproduces it. That is the steady state of any org past ~26 hidden
residents, and residue accrues by design. The rule now: skipped-but-unprobed
threads do NOT make a drained walk an early end. The assumption past the bound is
"hidden", which is exactly what an empty page means, and a hidden row is one no
reader would have shown. `truncated` is back to naming an EARLY end only - the
raw-scan budget, the depth cap, or a lag-drop the request could not deliver.

WHAT THIS ISSUE STILL TRACKS, therefore, is the ORIGINAL silent zero: a badge
that answers 0 because its WALK STOPPED EARLY (the budget case reproduced below)
renders as no badge at all, indistinguishable from caught up. The server-side
`unread_badge_truncated_zero` WARN - which now also carries the skipped depth -
is the only place that state is observable; the UI affordance is the fix. The
residue cleanup (delete-time reset + backfill rule 3) remains the prevention for
the wall itself, and the deleted-probe tripwire (wasted + skipped) is what
reports it.

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
