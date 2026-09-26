---
id: inbox-incomplete-head-read-keeps-stale-rows
title: An incomplete inbox head read keeps rows read elsewhere at their stale count and leaves a restored list unarmed until a complete read lands
type: improvement
severity: low
status: open
area: dashboard/inbox
created: 2026-09-26
refs: dashboard/src/routes/inbox/inboxListMerge.ts:123, app/src/routes/inbox.ts:1749, docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md
---

**Problem.** Spec 5.6 branch I: a head read that stopped early (a budget
exit, or a page flagged `truncated`) merges its rows in and REMOVES NOTHING,
so the list never loses a row on a read that could not see the whole page.
Two residues follow from that rule, both by design and both accepted at the
2026-09-25 spec gate:

- a row another operator (or another tab) marked read keeps its stale unread
  count until the next COMPLETE head read replaces the list; on the Unread
  tab the row therefore stays listed;
- a list restored from the store (a back-button return) mounts unarmed, and
  an incomplete reconcile keeps it unarmed, so auto-load stays off until a
  complete head read; the Load more button remains the fallback.

The Unread head read goes incomplete more often than the budget exit alone
suggests: `app/src/routes/inbox.ts` sets `truncated` whenever a full page
carries a lag-dropped row it could not re-deliver (`unresolvedDrops > 0`),
which on a busy inbox with more than a page of unread rows is typically the
read right after an inbound.

**Suggested fix.** Only if it is seen: let a truncated-but-full Unread page
replace rows that the page DID cover (rows whose `lastActivityAt` is newer
than the page's oldest row), keeping only the rows behind the page's
boundary. That is the provenance rule the deferred design in
`inbox-loaded-pages-survive-refresh` already specifies for All and Groups.
