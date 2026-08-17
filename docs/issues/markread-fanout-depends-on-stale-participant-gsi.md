---
id: markread-fanout-depends-on-stale-participant-gsi
title: The two mark-read fan-outs skip threads a stale participant GSI reports as read
type: bug
severity: med
status: open
area: app/inbox
created: 2026-08-16
refs: app/src/routes/inbox.ts, app/src/lib/contactThreads.ts, app/src/repos/conversationsRepo.ts
---

**Problem.** Filed from the plan-blind adversarial review of
`feat/inbox-unread-index` (finding 2, tail). PRE-EXISTING code shape, newly
consequential.

Both mark-read fan-outs filter the thread list before resetting:

```js
await Promise.all(
  all
    .filter((c) => unreadOf(c) > 0)
    .map(async (c) => { ...resetUnread... }),
);
```

- `POST /api/inbox/unknown/:phone/read` filters `findByParticipantPhone` output.
- `POST /api/inbox/:contactId/read` filters `conversationsForContact` output.

Both lists resolve through `byParticipantPhone` / `byParticipantEmail`, which are
eventually consistent and lag INDEPENDENTLY of `byUnread`. An inbound at t=0
increments the counter and stamps `unread_flag`; an operator marking read at
t=0.3s reads a participant image that still says `unread_count: 0`, the filter
drops that thread, and `resetUnread` never runs. The mark-read silently no-ops.

What makes this newly consequential: the nav badge and the fan-out now read
DIFFERENT GSIs and can disagree. Before the sparse index, a badge computed from
the same participant/open-partition reads would have agreed with the fan-out's
view. Now the badge counts the row through `byUnread` while the fan-out declines
to clear it, so the operator clicks "Mark read", the optimistic decrement
expires, and the badge comes back up. The consequence is milder than the
soft-delete case (the operator can retry, and the row stays reachable), which is
why the fix wave changed only the delete handler.

The same filter was removed from the contact soft-delete handler
(`app/src/routes/contacts.ts`) in this branch's fix wave, with the reasoning and
the stale-image regression test recorded there; that fan-out had no retry path,
so a miss was permanent.

**Suggested fix.** Drop both `.filter((c) => unreadOf(c) > 0)` calls and reset
every thread the lookup returns - `resetUnread` is idempotent and already
conditional on `attribute_exists(conversationId)`.

CAUTION, and the reason this is not a copy of the delete-handler change: each
reset in these two handlers also emits `conversation.updated`. Removing the
filter would emit one event per already-read thread of the contact, which fans
out to every connected dashboard's debounced refetch. Either emit only when the
reset actually changed something (compare the returned attributes) or keep the
filter as a pure EMIT gate while resetting unconditionally.
