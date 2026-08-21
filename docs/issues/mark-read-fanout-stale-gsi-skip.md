---
id: mark-read-fanout-stale-gsi-skip
title: The mark-read fan-outs skip genuinely-unread threads on a stale GSI image
type: bug
severity: high
status: open
area: app/inbox
created: 2026-08-17
updated: 2026-08-21
refs: app/src/routes/inbox.ts:1704, app/src/routes/inbox.ts:1737, app/src/routes/contacts.ts:1952, app/src/lib/contactThreads.ts, app/src/repos/conversationsRepo.ts
---

<!--
  MERGED 2026-08-21. `markread-fanout-depends-on-stale-participant-gsi` (med,
  filed 2026-08-16 from the plan-blind adversarial review of
  feat/inbox-unread-index, finding 2 tail) described the same two fan-outs, the
  same filter, and the same fix. Its file was deleted and its distinct content -
  the two route paths, the byParticipantEmail leg, the operator-visible symptom,
  and the emit-gate alternative - folded in below. Do not re-file it.
-->

**Problem.** Both mark-READ fan-outs filter their candidate list on the count
they just read:

```ts
all.filter((c) => unreadOf(c) > 0).map((c) => conversations.resetUnread(c.conversationId))
```

The two call sites:

- `POST /api/inbox/unknown/:phone/read` filters `findByParticipantPhone` output.
- `POST /api/inbox/:contactId/read` filters `conversationsForContact` output
  (`app/src/lib/contactThreads.ts`).

Both lists resolve through the EVENTUALLY CONSISTENT `byParticipantPhone` /
`byParticipantEmail` GSIs, which lag INDEPENDENTLY of `byUnread`. A stale ZERO
for a thread that is genuinely unread therefore skips that thread entirely: no
`resetUnread`, no `conversation.updated`, and the row stays in the sparse
`byUnread` index.

The window is not incidental. The inbound webhook writes `incrementUnread` to the
BASE table and pushes `message.persisted`; `useMarkContactRead` subscribes to that
event payload-blind and POSTs the fan-out milliseconds later - i.e. inside GSI
replication lag by design, not by accident.

**Two distinct consequences, and the second is why this is `high`.**

1. *Operator-visible, self-healing.* The nav badge and the fan-out now read
   DIFFERENT indexes and can disagree. The badge counts the row through
   `byUnread` while the fan-out declines to clear it, so the operator clicks
   "Mark read", the optimistic decrement expires, and the badge comes back up.
   Annoying, but retryable. (Before the sparse index this could not happen: a
   badge computed from the same participant/open-partition reads would have
   agreed with the fan-out's view.)
2. *Permanent.* It does NOT heal for the LAST message of a thread: nothing fires
   again, so the thread becomes a permanent `byUnread` resident that costs a
   resurfacing probe on every badge request - i.e. it feeds
   [`unread-badge-request-round-trip-cost`](./unread-badge-request-round-trip-cost.md).

This class has already been ruled on in this repo. `app/src/routes/contacts.ts`
removed the identical filter over the identical GSI, citing a prior adversarial
finding: a stale image reporting 0 for a thread that IS unread made the reset skip
that thread forever, and the filter was only an optimization. That fan-out runs
once per contact soft-delete and had no retry path, so a miss was permanent; the
fix was applied there, with a stale-image regression test, and the two inbox
fan-outs were deliberately left alone by that fix wave.

Found by the plan-blind adversarial reviewer during the `inbox-mark-unread`
mission (round 2), which hardened the mark-UNREAD write against the mirror-image
race (stale POSITIVE) but deliberately did not touch the mark-READ path: this is
pre-existing behavior, and the human authorized exactly two hardening items on
that mission.

**Suggested fix.** Do NOT copy `contacts.ts` verbatim - that fan-out runs once per
contact delete, while these two run whenever a contact page is open and any
org-wide message lands, so simply dropping the filter multiplies `resetUnread`
writes and `conversation.updated` SSE volume (one event per already-read thread of
the contact, fanned out to every connected dashboard's debounced refetch).

The shape this repo has already established for exactly this problem is a
conditional write: add `resetUnreadIfUnread` to `conversationsRepo` with
`ConditionExpression: attribute_exists(unread_flag)`, call it unfiltered from both
fan-outs, catch `ConditionalCheckFailedException` as "already read - nothing to
do", and emit `conversation.updated` only when a write actually happened. That
keeps the event volume the filter was protecting while making the WRITE, not a
lagging read, the authority - the same correction `setUnread` made on the
mark-unread side (`app/src/lib/markUnread.ts`).

The cheaper variant, if the conditional write is not wanted: reset every thread
the lookup returns (`resetUnread` is idempotent and already conditional on
`attribute_exists(conversationId)`) and keep the existing filter as a pure EMIT
gate. That fixes correctness but spends the extra writes; the conditional write
spends neither.

A regression test is cheap: the `stalePositiveOnFirstRead` seam in
`app/test/inboxApi.test.ts` already stages a stale image; point it at the read
routes with a stale ZERO and assert on `world.unreadResets`.
