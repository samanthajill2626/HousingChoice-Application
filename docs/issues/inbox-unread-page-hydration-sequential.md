---
id: inbox-unread-page-hydration-sequential
title: The Unread and Unknown inbox pages hydrate one row at a time; at limit=100 that is up to 100 sequential reads per refresh
type: debt
severity: low
status: open
area: app/inbox
created: 2026-09-25
refs: app/src/routes/inbox.ts
---

**Problem.** `feat/inbox-rows-timestamps` raised the dashboard's page size
to 100 and prefetched the `filter=all` pager's per-row reads through
promise-memoized caches (spec section 5.10). The `filter=unread` and
`filter=unknown` branches were left sequential: each row still awaits its
latest-message read (and, on Unread, its contact hydration) in turn. Unread
is a triage set that is usually far short of 100 rows, and `?limit=` tunes
it, so this was accepted.

**Suggested fix.** If a measured Unread page is slow for Sam, apply the same
prefetch pass to the unread candidates: the caches are already shared
closures, so only the window and the `stop` flag are new.
