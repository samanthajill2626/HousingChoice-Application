---
id: relay-30003-retry-lineage
title: Relay 30003 needs retry lineage and one effective dashboard status
type: bug
severity: med
status: open
area: app/messaging-relay
created: 2026-08-28
refs: app/src/routes/webhooks/twilio.ts:2348, app/src/routes/webhooks/twilio.ts:2433, app/src/routes/webhooks/twilio.ts:2553, app/src/jobs/retrySend.ts:27, app/src/repos/messagesRepo.ts:118, dashboard/src/routes/contact/deliveryStatus.ts:543, dashboard/src/routes/contact/Timeline.tsx:1670
---

**Problem.** A group relay recipient that returns Twilio error 30003 reaches a
contradictory terminal state. Twilio has marked that physical Message SID
`undelivered`, but the dashboard says `Phone unreachable - will retry`. No relay
retry is actually scheduled.

The relay SID-pointer branch in `/webhooks/twilio/status` updates the member's
`delivery_recipients` slot and returns before the generic 30003
`messaging.retrySend` branch. The slot becomes `undelivered`; the forward-only
delivery state machine then prevents that same slot from advancing to
`delivered`. There is no later relay attempt whose delivery callback could make
the dashboard truthful.

Twilio also does not promise to retry an `undelivered` Message SID. Its 30003
guidance tells the customer to create another send through the REST API. The
retry promise in our UI therefore describes neither Twilio behavior nor current
HousingChoice relay behavior.

A naive reuse of the 1:1 retry path is not enough. That path creates a new
provider Message SID and a new persisted message row. A relay message is stored
once with one delivery slot per recipient. Retrying a failed member as an
unrelated message would lose the logical relationship and could show multiple
dashboard sends with conflicting delivery statuses.

**Desired behavior.** Preserve one logical relay message and one visible
delivery row per recipient while allowing multiple physical provider attempts
under that row.

- A 30003 callback schedules a bounded HousingChoice retry for only the failed
  recipient. It must not resend to the sender or any recipient whose leg did not
  fail.
- The dashboard shows the recipient as retrying while a new attempt is pending.
- If a later attempt is delivered, the same recipient row becomes `Delivered on
  retry` (or an equivalently clear delivered state). The Timeline continues to
  show one logical message bubble, not one bubble per provider attempt.
- If the retry cap is exhausted, the row becomes terminally `Undelivered` and no
  longer promises another retry.
- Every physical attempt remains durable and auditable by provider SID, status,
  error code, and timestamps, but attempt detail is subordinate to the one
  effective recipient status in the normal dashboard view.
- A delivered attempt wins permanently. A late or redelivered callback from an
  older failed attempt cannot regress the effective recipient status.

**Suggested fix.** Add relay-specific retry lineage keyed by the logical source
message and member key, with a durable attempt counter and one provider SID per
attempt. The retry job should carry identifiers only and re-read the durable
source. It must preserve the exact original outbound representation, including
the sender prefix and attachments; attachments must be freshly presigned for
each provider send.

Before each retry, re-run the applicable relay send gates: the group is still
open, the intended member/phone relationship is still valid, and the recipient
is not suppressed or opted out. A refusal ends the retry chain without sending
and produces truthful operator-facing copy. Do not silently redirect an old
failed leg to a newly changed phone number.

Claim and advance the durable attempt before enqueueing so a queue failure can
still reach a terminal state. Duplicate Twilio callbacks, duplicate queue
deliveries, concurrent callbacks, and out-of-order callbacks must be
idempotent. A new provider SID must point back to the same logical source
message, member, and attempt rather than becoming an unrelated Timeline row.

Derive the displayed recipient status from that lineage and emit the existing
message refresh event after each effective transition. Keep the shared 30003
copy context-aware: only say `will retry` or `retrying` when a retry was actually
claimed; otherwise say `Phone unreachable` and expose the final error code.

**Acceptance criteria.**

1. A forward relay-recipient 30003 callback claims and enqueues exactly one
   retry for that recipient when all send gates pass.
2. A duplicate callback or duplicate job delivery sends no duplicate text.
3. The retry count is durable, bounded, and reaches a terminal state even when
   enqueueing fails. The selected backoff/cap either matches the current 1:1
   60/120/240-second policy or documents why relay differs.
4. Other relay members receive no duplicate send.
5. Each new provider SID is recorded as another attempt under the same logical
   recipient delivery. A delivered retry updates the effective status and a
   late older failure cannot regress it.
6. The dashboard renders one message bubble and one row for that recipient,
   showing retrying, delivered-on-retry, or terminal-undelivered truthfully. It
   never renders the physical attempts as conflicting duplicate sends.
7. SMS and MMS retries preserve the originally sent content; MMS retries use
   fresh presigned URLs.
8. Closing the group, removing/suppressing the member, changing the destination,
   or opting out before the retry cannot produce an unauthorized send.
9. Focused backend tests cover callback, enqueue, cap, idempotency, gate refusal,
   and out-of-order delivery. Dashboard tests cover the effective status and
   single-bubble presentation. A focused hermetic Playwright flow proves one
   failed relay leg can retry to delivered without duplicating the message.

This issue does not add a general Twilio status-polling or missed-callback
reconciliation system. Retry-attempt callbacks update the effective state; a
cross-channel reconciliation sweep would be separate work.

This issue is scoped to relay fan-out legs. Native Twilio group-text receipts
and the existing 1:1 retry/collapse behavior must not change merely because the
dashboard presenter is shared; any extension to those paths requires separate
evidence and explicit scope.

**Related.** The durable counter and enqueue-failure requirements overlap
[retry-counter-in-envelope-makes-caps-unreachable](./retry-counter-in-envelope-makes-caps-unreachable.md).
The timing policy must remain consistent with
[quiet-hours-ungated-automated-paths](./quiet-hours-ungated-automated-paths.md).

Twilio references:

- [30003: Unreachable destination handset](https://www.twilio.com/docs/api/errors/30003)
- [Outbound Message Status in Status Callbacks](https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks)
