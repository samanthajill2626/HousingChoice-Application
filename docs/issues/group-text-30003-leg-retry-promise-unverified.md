---
id: group-text-30003-leg-retry-promise-unverified
title: A native group-text 30003 LEG promises a retry that no code path schedules
type: bug
severity: low
status: open
area: dashboard/messaging
created: 2026-09-01
refs: app/src/routes/webhooks/twilio.ts:2408, app/src/routes/webhooks/twilio.ts:2567, app/src/services/groupReceipts.ts:336, app/src/services/groupReceipts.ts:422, dashboard/src/routes/contact/deliveryStatus.ts:597, dashboard/src/routes/contact/Timeline.delivery.test.tsx:517
---

**Problem.** The "will retry" tail on a 30003 is true at the MESSAGE level and
false at the LEG level, and native group text is currently exempted from the
relay fix on the strength of the message-level fact alone. M5 traced both
levels; the evidence is recorded here so the follow-on mission starts from the
trace rather than from a one-level rationale.

Both of the following hold, at different levels:

1. MESSAGE level - the retry is real. The 30003 arm of the `/webhooks/twilio`
   status route resolves `messages.getByProviderSid(MessageSid)`
   (`app/src/routes/webhooks/twilio.ts:2408`) and enqueues `retrySend`
   (`:2567`) with no `group_text` guard. A message-level group-text 30003
   therefore DOES reach the retry enqueue, exactly as a 1:1 does. This is the
   fact M5's spec recorded (R4-6) and the fact D20's group-text exemption rests
   on.
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
separately, because its code can be leg-derived (above). Confirm before
building: whether a group-text leg can ever be retried by any path (grep found
none), and whether the rollup should keep copying a leg code onto the message
row at all.

**Related.**
[relay-30003-classified-transient-retrying](./relay-30003-classified-transient-retrying.md)
is the server-side half of the same contradiction (the log taxonomy still
classifies 30003 as transient-retrying).
[relay-30003-retry-lineage](./relay-30003-retry-lineage.md) is the relay-side
mission whose scope guard this evidence satisfies.
