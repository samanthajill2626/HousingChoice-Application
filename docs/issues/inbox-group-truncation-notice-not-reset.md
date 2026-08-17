---
id: inbox-group-truncation-notice-not-reset
title: The inbox group-truncation notice survives a failed refetch and sits above the error banner
type: bug
severity: low
status: open
area: dashboard/inbox
created: 2026-08-16
refs: dashboard/src/routes/inbox/Inbox.tsx, dashboard/src/routes/inbox/useInbox.ts
---

**Problem.** Filed from the conformance re-review of `feat/inbox-unread-index`
(N4). PRE-EXISTING; adjacent to this branch only because the inbox error banner
is now easier to reach on the Unread tab (an empty truncated unread page renders
it - spec 4.5 step 3).

`Inbox.tsx` renders the group-truncation notice on `inbox.groupsTruncated`
ALONE. It has no `status` gate, and `groupsTruncated` is reset in exactly one
place - the filter-change effect in `useInbox.ts`. It is NOT reset in
`fetchFirstPage`'s error path, and NOT by `retry()` (which only sets
`status: 'loading'` and re-enters `fetchFirstPage`). `truncated` and `base` DO
get reset on the 404/pending path and on a filter change; `groupsTruncated` was
left out of the error path.

Failure scenario: the operator is on a filter whose first page reported
`groupsTruncated: true`, so the notice renders. A background refetch (an SSE
reconcile, or `retry()`) fails. `status` becomes `'error'`, the row block stops
rendering (it requires `status === 'ready'`), and the page now shows

```
Showing the latest N group texts.  See all group texts
We couldn't load your inbox.  [Retry]
```

- a claim about a list that is no longer on screen, with a working link, sitting
directly above the statement that the list could not be loaded. Retrying does
not clear it; only switching filters does. Low severity: nothing is lost and the
link still goes somewhere real.

Note this is a DIFFERENT half of the same notice from the one already handled:
the count reaching zero through optimistic mark-read is covered in `Inbox.tsx`
(adversarial 30 - the notice drops the count and keeps the link). That fix
addressed a stale COUNT while the list rendered; this is a stale NOTICE while the
list does not.

**Suggested fix.** Either gate the notice on `inbox.status === 'ready'` next to
the row block it describes, or clear `groupsTruncated` alongside the other page
state in `fetchFirstPage`'s error path and in `retry()`. The status gate is the
smaller change and matches what the notice actually means (a statement about the
page currently rendered). A regression test wants a `useInbox` + `Inbox`
composed render: a first page with `groupsTruncated: true`, then a failing
refetch, asserting the notice is gone while the error banner is up.
