---
id: mark-read-fanout-stale-gsi-skip
title: The mark-read fan-outs skip genuinely-unread threads on a stale GSI image
type: bug
severity: high
status: open
area: app
created: 2026-08-17
refs: app/src/routes/inbox.ts:1704, app/src/routes/inbox.ts:1737, app/src/routes/contacts.ts:1952
---

**Problem.** Both mark-READ fan-outs filter their candidate list on the count
they just read:

```ts
all.filter((c) => unreadOf(c) > 0).map((c) => conversations.resetUnread(c.conversationId))
```

`all` comes from `findByParticipantPhone` / `conversationsForContact`, a Query on
the EVENTUALLY CONSISTENT `byParticipantPhone` GSI. A stale ZERO for a thread that
is genuinely unread therefore skips that thread entirely: no `resetUnread`, no
`conversation.updated`, and the row stays in the sparse `byUnread` index.

The window is not incidental. The inbound webhook writes `incrementUnread` to the
BASE table and pushes `message.persisted`; `useMarkContactRead` subscribes to that
event payload-blind and POSTs the fan-out milliseconds later - i.e. inside GSI
replication lag by design, not by accident. It usually self-heals on a later
trigger, but it does NOT heal for the LAST message of a thread: nothing fires
again, so the thread becomes a permanent `byUnread` resident that costs a
resurfacing probe on every badge request.

This class has already been ruled on in this repo. `app/src/routes/contacts.ts`
removed the identical filter over the identical GSI, citing a prior adversarial
finding: a stale image reporting 0 for a thread that IS unread made the reset skip
that thread forever, and the filter was only an optimization. The fix was applied
there and left in place here.

Found by the plan-blind adversarial reviewer during the `inbox-mark-unread`
mission (round 2), which hardened the mark-UNREAD write against the mirror-image
race (stale POSITIVE) but deliberately did not touch the mark-READ path: this is
pre-existing behavior, and the human authorized exactly two hardening items on
that mission.

**Suggested fix.** Do NOT copy `contacts.ts` verbatim - that fan-out runs once per
contact delete, while this one runs whenever a contact page is open and any
org-wide message lands, so simply dropping the filter multiplies `resetUnread`
writes and `conversation.updated` SSE volume.

The shape this repo has already established for exactly this problem is a
conditional write: add `resetUnreadIfUnread` to `conversationsRepo` with
`ConditionExpression: attribute_exists(unread_flag)`, call it unfiltered from both
fan-outs, catch `ConditionalCheckFailedException` as "already read - nothing to
do", and emit `conversation.updated` only when a write actually happened. That
keeps the event volume the filter was protecting while making the WRITE, not a
lagging read, the authority - the same correction `setUnread` made on the
mark-unread side (`app/src/lib/markUnread.ts`).

A regression test is cheap: the `stalePositiveOnFirstRead` seam in
`app/test/inboxApi.test.ts` already stages a stale image; point it at the read
routes with a stale ZERO and assert on `world.unreadResets`.
