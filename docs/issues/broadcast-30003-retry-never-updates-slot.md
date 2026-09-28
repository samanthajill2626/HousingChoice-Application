---
id: broadcast-30003-retry-never-updates-slot
title: A broadcast recipient's automatic 30003 retry never updates the broadcast slot - retrySend drops the broadcast id, so the share row keeps its 30003 failure whatever the retry does
type: bug
severity: med
status: open
area: app/broadcasts
created: 2026-09-25
updated: 2026-09-28
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

**retry-send-adoption (2026-09-28).** The ATTRIBUTION half landed on
`feat/retry-send-adoption` (code final `1b5ddb01`, UNMERGED; anchors at
`5a03e20b`); the MATCHING half is share-skip Branch B's (spec section 0 and
R7; what B reads is spec R10). Status stays open.

- **Every retry row the branch appends carries `broadcast_id`** (copied from
  the retried row) **and `retry_root`**: the automatic retry
  (`app/src/jobs/retrySend.ts:543-544`), the reconcile's adoption
  (`app/src/jobs/sendReconcile.ts:901-902`) and the manual Retry route
  (`app/src/routes/api.ts:1768-1769`), through `sendMessage`
  (`app/src/services/sendMessage.ts:671`, `:680`) to the append
  (`app/src/repos/messagesRepo.ts:2619`). The `retrychild#` pointer family
  lists a row's retry children in one consistent Query
  (`messagesRepo.ts:2102-2114`, written at `:2785-2799`, read at
  `:3359-3386`). Nothing is written to the share slot.
- **The interim rollup cost, until B.** The webhook routes every transitioned
  receipt of a row carrying `broadcast_id` into the rollup
  (`app/src/routes/webhooks/twilio.ts:3529`), which acts on `sent` and on
  terminal statuses (`:3878`). A share-retry row never matches a slot (the
  match is the slot's own conversationId + tsMsgId, `:3887-3889`), so each
  such receipt - `sent` AND terminal, twice for a delivered text - reads the
  broadcast, waits `STATUS_UNKNOWN_SID_RETRY_DELAY_MS` (2.5 s, `:322`,
  `:3898`), reads it again and gives up at INFO (`:3904`).
- **`isBroadcastRowFor` now ignores a row with `retry_of`**
  (`app/src/jobs/broadcastFanOut.ts:1303`; plan deviation 7, a code change):
  a share-retry row is never the broadcast recipient's own row, for the
  reconcile's ownership test (`sendReconcile.ts:759-763`) or the broadcast
  adoption's dedupe read-back (`broadcastFanOut.ts:1391`).
- **The one fenced-file edit also mutes a real fault (code review round 1
  A-3, round 2 R2-7).** The give-up line moved from WARN to INFO
  (`twilio.ts:3904`, Cameron's Q2 ruling), so a GENUINE miss on a share's
  OWN row (a lost or mis-keyed slot write) no longer reaches the WARN tail or
  Recent Errors. A one-line alternative exists at the call site:
  `&& message.retry_of === undefined` on `twilio.ts:3529` skips the rollup
  (both reads and the 2.5 s wait) for every retry row and lets the give-up
  line go back to WARN. It is a different line from the one Cameron
  approved, so it is his call (the handback shows both). Either way Branch B
  should skip or route retry receipts in the rollup and restore WARN for a
  share's own row.
- **2026-09-28 (post-verdict): Cameron took the call-site alternative.** The
  rollup at `twilio.ts:3529` is skipped when the row carries `retry_of` and
  the give-up line is back at WARN (the fence relaxed for that one line only;
  `app/test/twilioStatusWebhook.test.ts` pins the skip: no broadcast read, no
  wait, no give-up line for a share-retry receipt). Branch B removes the skip
  when it routes retry receipts by `broadcast_id` + `retry_root`.
- **Two facts for B (build worklist item 27).** A retry row appended before
  this branch carries no `broadcast_id`, so a chain straddling the deploy
  loses share attribution from that row on (each retry copies the field from
  the row it retries). And a share's ROOT row can itself carry
  `retry_outcome: 'unconfirmed'` with the withdrawn promise when its
  attempt-1 retry is ruled unresolved (spec R10): spec R5's "never on
  broadcast rows" does not hold for it.
