---
id: inbox-reconcile-failure-blanks-list
title: A failed background reconcile blanks a healthy inbox list into the error state
type: decision
severity: low
status: open
area: dashboard/inbox
refs: dashboard/src/routes/inbox/useInbox.ts, dashboard/src/routes/inbox/Inbox.tsx
created: 2026-08-24
---

**The question.** `useInbox` refetches the current filter's first page on a
debounced `conversation.updated`. Nobody asked for that request. If it FAILS -
a transient 5xx, a throttle, a network blip - the hook sets `status: 'error'`,
and `Inbox.tsx` gates the whole row list on `status === 'ready'`. So a healthy
list the operator is reading is replaced by "We couldn't load your inbox." on the
strength of a background request they never issued.

The same hook makes the opposite choice one function away: `loadMore`'s `.catch`
is deliberately empty, with a comment saying the cursor is kept so the user can
retry. That is a page the operator DID ask for, and it is treated as
non-destructive. The reconcile is treated as authoritative. The two policies are
inconsistent, and the more destructive one applies to the less deliberate
request.

Found by the adversarial review of `feat/inbox-unread-read-path` (2026-08-24).
That branch fixed the adjacent half - a reconcile failing after an optimistic
mark-read committed no longer discards the commit - but deliberately did not
change what a failure MEANS, on the grounds that this is a product call and not
a defect.

**Options.**

1. Keep the list, surface the failure quietly (a stale-data marker, or nothing).
   Matches `loadMore`. Risk: the operator reads a list that has stopped
   updating and does not know it.
2. Only enter the error state when there is nothing to lose - `setStatus('error')`
   solely when no rows are rendered. Cheap, and it makes the destructive arm
   unreachable in the case that matters. Needs a ref or a functional read, since
   `base` is not in the callback's deps.
3. Leave as-is: a failed refresh is a real fact and hiding it is its own kind of
   lie.

Option 2 is the smallest honest change, but it is a judgement about what
operators should see, so it wants a human ruling rather than an engineer's
preference.

**Note the neighbouring guard already shipped.** The generation check in
`fetchFirstPage` now protects a rendered list only, not a spinner - a page
discarded while `status` is `'loading'` is installed rather than dropped,
because nothing re-issues it and the alternative was a permanently stuck tab.
That is a different question from this one and is already decided.
