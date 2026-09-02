---
id: group-text-30003-leg-retry-promise-unverified
title: A native group-text 30003 promises a retry that never sends, at BOTH the leg and message levels
type: bug
severity: low
status: open
area: dashboard/messaging
created: 2026-09-01
updated: 2026-09-01
refs: app/src/services/sendMessage.ts:293, app/src/routes/webhooks/twilio.ts:2408, app/src/routes/webhooks/twilio.ts:2567, app/src/services/groupReceipts.ts:336, app/src/services/groupReceipts.ts:422, dashboard/src/routes/contact/deliveryStatus.ts:597, dashboard/src/routes/contact/Timeline.delivery.test.tsx:517
---

**Problem.** The "will retry" tail on a native group-text 30003 is FALSE, at
both the leg and the message level, by two different mechanisms. Native group
text is nonetheless exempted from M5's relay fix - originally because the
message level looked genuine, and now (2026-09-01) as a deliberate scope call
after that turned out to be wrong too. See the update immediately below, then
the two-level trace.

**UPDATE 2026-09-01, planner handback review: level 1 below is WRONG, and with
it the last support for D20's exemption. NEITHER level retries.**

The message-level retry is ENQUEUED but **cannot send**. `retrySend`'s handler
calls `sendMessage`, and `sendMessage` throws `GroupTextSendNotSupportedError`
for any `conversation.type === 'group_text'`
(`app/src/services/sendMessage.ts:293`, class at `:177`). The handler catches
`SendRefusedError` - which that error extends - logs "send refused, retry chain
stopped", and returns. No native group text has ever been re-sent after a 30003.

So the trace is not "true at the message level, false at the leg level". It is
false at BOTH, by two different mechanisms: the leg level never schedules a
retry, and the message level schedules one that is refused on execution. The
severity below is left at `low` because nothing REGRESSED - `main` makes the
same false promise - but the rationale for treating group text differently from
relay is gone.

The original two-level trace, kept because the leg-level half is still correct
and still needed:

1. MESSAGE level - **the retry is enqueued and then refused** (see the update
   above; this bullet originally read "the retry is real"). The 30003 arm of the
   `/webhooks/twilio` status route resolves
   `messages.getByProviderSid(MessageSid)`
   (`app/src/routes/webhooks/twilio.ts:2408`) and enqueues `retrySend`
   (`:2567`) with no `group_text` guard - so it DOES reach the enqueue, exactly
   as a 1:1 does. That is where the trace originally stopped, and stopping there
   is what made the exemption look justified.
2. LEG level - the retry does not exist. Per-recipient group-text delivery codes
   are not written by that route at all. They are written by the Conversations
   receipts side, `applyReceipt` ->
   `messages.updateRecipientDeliveryStatus(..., { context: 'group' })`
   (`app/src/services/groupReceipts.ts:422`), which enqueues NO retry. So the
   per-recipient row's "will retry" describes a retry that path never schedules.

The two levels are not independent: `rollUpAggregate`
(`app/src/services/groupReceipts.ts:336`) derives the message row's status from
the legs and copies the WORST leg's error code onto the message row via
`messages.updateDeliveryStatus` (`:353`). A `group_text` message row can
therefore carry `error_code: '30003'` that originated in a leg nothing retried,
which is the case the message-level chip cannot distinguish from a real
message-level 30003.

Concrete shape: a native group text to two members, one handset off. The
Conversations receipt for that leg arrives `undelivered / 30003`, the slot is
written, no retry is scheduled, and the rollup then stamps `30003` on the
message row. The thread reads "Phone unreachable - will retry" on the leg,
and staff read that as "leave it alone, it is still going" - the exact misread
M5's D19 was written to stop for relay.

**Scope note - why this is filed and not fixed.** Changing group-text copy was
out of scope on `feat/retry-counter-durable` twice over: the M5 spec (Sec 2)
fences native group-text receipt behavior, and
[relay-30003-retry-lineage](./relay-30003-retry-lineage.md) carries its own
scope guard requiring that any extension to native group-text receipts or the
1:1 retry/collapse behavior have "separate evidence and explicit scope". This
issue IS that separate evidence.

`dashboard/src/routes/contact/Timeline.delivery.test.tsx:517` ("keeps the retry
promise on the SAME leg in a native GROUP TEXT") pins today's behavior
deliberately - it is the record of the current decision, not an oversight. Any
fix inverts that test rather than deleting it.

**Suggested fix.** Verify first whether the axis is right. The override M5
shipped is scoped "relay vs group text"; the trace above suggests the true axis
is "a LEG code vs a MESSAGE code" - no per-recipient slot in this codebase is
followed by a retry, and every message-level 1:1 30003 is. Two candidate shapes:

- pass the same leg-scoped flag for both multi-party leg positions and rename
  the option from `relay` to `leg`; or
- add `'30003'` to a leg-scoped reason map consulted whenever the source of the
  code is `row.slot.errorCode`.

Either way the message-level chip needs the `group_text` aggregate case handled
separately, because its code can be leg-derived (above).

**One open question remains** - whether the rollup should keep copying a leg
code onto the message row at all. The other one is now ANSWERED: no group-text
leg is ever retried, and no group-text MESSAGE is either, since the enqueued
retry is refused at `sendMessage.ts:293`.

Note the axis question is now simpler than it looks: for `group_text` BOTH
levels want the honest copy, so a leg-vs-message distinction is not needed to
fix this issue - only to avoid changing 1:1, where the retry is genuine.

**Related.**
[relay-30003-classified-transient-retrying](./relay-30003-classified-transient-retrying.md)
is the server-side half of the same contradiction (the log taxonomy still
classifies 30003 as transient-retrying).
[relay-30003-retry-lineage](./relay-30003-retry-lineage.md) is the relay-side
mission whose scope guard this evidence satisfies.
