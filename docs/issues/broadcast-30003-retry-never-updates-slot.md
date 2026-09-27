---
id: broadcast-30003-retry-never-updates-slot
title: A broadcast recipient's automatic 30003 retry never updates the broadcast slot - retrySend drops the broadcast id, so the share row keeps its 30003 failure whatever the retry does
type: bug
severity: med
status: open
area: app/broadcasts
created: 2026-09-25
refs: app/src/jobs/retrySend.ts:200, app/src/services/sendMessage.ts:425, app/src/routes/webhooks/twilio.ts:3312, app/src/routes/webhooks/twilio.ts:3364, app/src/routes/webhooks/twilio.ts:3544, app/src/routes/webhooks/twilio.ts:3591, dashboard/src/routes/contact/deliveryStatus.ts:778, dashboard/src/routes/broadcasts/StatChips.test.tsx:129
---

**Problem.** A broadcast sends each recipient through `sendMessage` with
`broadcastId`, which stamps `broadcast_id` on the message row
(`app/src/services/sendMessage.ts:425`). The status webhook uses that stamp to
roll a delivery outcome into the broadcast's recipient slot
(`app/src/routes/webhooks/twilio.ts:3312`), matching the slot by the message's
`conversationId` + `tsMsgId` (`:3591-3593`).

When that message fails with 30003, the webhook rolls the failure into the slot
(`failed`, 30003) and schedules `retrySend` (`:3364`). `retrySend` re-sends
WITHOUT `broadcastId` (`app/src/jobs/retrySend.ts:200-207`), so the retry row
carries no stamp, and its receipts never reach the broadcast. The slot could
not accept them anyway: a `failed` broadcast slot is terminal and refuses every
later transition (`broadcastSlotMayTransition`, `twilio.ts:3544-3548`), and the
retry is a different `tsMsgId`.

Result: the share results row and the broadcast stats keep the original 30003
failure forever, whatever the retry does. Today the row promises "Phone
unreachable - will retry" (`dashboard/src/routes/contact/deliveryStatus.ts:778`,
pinned by `dashboard/src/routes/broadcasts/StatChips.test.tsx:129`) even after
the retry delivered - while the tenant's one-to-one bubble may read Delivered -
and it keeps promising after every retry has failed too. After
`feat/retry-send-window` the promise follows `retry_due_at` instead, so once
the retry has run the row will read a plain failure for a tenant who may have
received the text, which invites a manual re-send.

**Not claimed by `feat/share-skip-fix` Branch A.** Its spec leaves every 30003
wording and retry to `feat/retry-send-window`. Its follow-on, Branch B
(`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md`, a stub
planned after `feat/send-outcome-reconcile` and the `retrySend` adoption), lists
this issue under "Issue to close here" if still open, as part of its rule that
every attempt - the original, an automatic 30003 retry, a staff Retry - belongs
to the share that started it. Whichever of Branch B or the `retrySend` adoption
lands the fix first closes this.

**Suggested fix.** Found along the way (the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9); send-shaped - decide it with the `retrySend` adoption
([retry-send-lost-under-job-marker](./retry-send-lost-under-job-marker.md)),
after `feat/send-outcome-reconcile` lands. The retry must carry the broadcast
attribution, and the broadcast side needs a rule for how a later attempt moves
a slot that is already `failed` - which is Branch B's counted-as-sent rule, not
a relaxation of the forward-only guard.

**Related.**
[retry-send-lost-under-job-marker](./retry-send-lost-under-job-marker.md),
[no-contact-code-renders-as-carrier-error](./no-contact-code-renders-as-carrier-error.md).
Presentation finding 2 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/presentation-findings.md`.
