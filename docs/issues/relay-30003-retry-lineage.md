---
id: relay-30003-retry-lineage
title: Relay 30003 needs retry lineage and one effective dashboard status
type: bug
severity: med
status: resolved
area: app/messaging-relay
created: 2026-08-28
updated: 2026-09-02
resolved: 2026-09-02
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

**Resolution (2026-09-02, feat/relay-30003-retry-lineage).** Spec
`docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md`
(revision 6, approved 2026-09-02 after four adversarial review rounds); plan
`docs/superpowers/plans/2026-09-02-relay-30003-retry-lineage.md`; mission
records under `docs/superpowers/reviews/2026-09-02-relay-30003-retry-lineage/`.

**The architecture, in two sentences.** A retry is a NEW source message row
addressed to the failed member alone - never a promotion of the failed leg - and
the create of that row's `sid#` pointer, under the deterministic synthetic SID
`relayretry-<digest>-<attempt>` (`app/src/lib/relayRetryClaim.ts`), IS the
atomic claim, so the failed slot is never rewritten and no exception to
`ALLOWED_PRIOR` is created. Nothing stores an effective status: the dashboard
derives a per-member `retryState` at THREAD level by joining the original's
recipient entries forward to those rows
(`dashboard/src/routes/contact/relayRetryJoin.ts`), which is what lets a
delivered rung win over an `undelivered` slot the forward-only status machine
forbids overwriting.

**The nine acceptance criteria, and what proves each.**

1. **Met.** Task 12 (`71181d79`) claims inside the relay branch of
   `POST /webhooks/twilio/status`: a consistent source re-read, a positive
   fan-out/team fence, a slot-state gate, the append, then the enqueue. The
   decision yields exactly one of eleven `RelayRetryClaimOutcome` values.
   `app/test/relayRetryClaim.webhook.test.ts` (27 tests), starting with "claims
   exactly one retry for a forward 30003 on a relay leg".
2. **Met, by two independent guards, tested separately.** A duplicate or
   concurrent CALLBACK loses the pointer create and stops - Task 12's "claims
   nothing twice for a duplicate callback, and says so on the line"
   (`already_claimed`). A duplicate JOB DELIVERY is stopped by
   `putJobExecutionMarker` - Task 11's "sends nothing on a redelivered job (the
   execution marker)" in `app/test/relayRetryLeg.test.ts`. The second guard is
   unit-proven only: the hermetic lane's in-process queue runs a job once and
   cannot redeliver, so a green e2e is not evidence for it.
3. **Met, and the policy MATCHES 1:1 rather than differing.** The attempt lives
   on the retry ROW (`relay_retry_attempt`, Task 1 `814f2997`), one durable row
   per rung, so no slot write can lose it; the cap is
   `MAX_RELAY_RETRY_ATTEMPTS = 3`. A failed enqueue still reaches a terminal
   state - Task 12 closes the leg `enqueue_failed` from the webhook ("closes the
   retry leg enqueue_failed when the enqueue throws", plus its versioned twin).
   `relayRetryBackoffMs` is 60/120/240 s, mirroring `app/src/jobs/retrySend.ts`,
   asserted by "matches the 1:1 ladder policy" in
   `app/test/relayRetryClaim.test.ts`.
4. **Met.** Task 12's "never sends to any other member, on any rung" and Task 11
   (`64773ab3`) "sends to the failed member ONLY - never to the rest of the
   roster". Confirmed in a browser by Task 14 (`a97884f5`) counting the fake's
   outbound threads: the retried member has exactly 2 legs
   (`undelivered` with `errorCode 30003`, then `delivered`), the reachable
   member exactly 1, and no third leg exists.
5. **Met.** Each rung is its own row carrying its own provider SID, and the
   carrier's real `SM...` for that leg is mapped onto the rung's single-entry
   slot by a `relaysid#` pointer - two pointer families, no collision - so every
   physical attempt stays durable and auditable by SID, status, error code and
   timestamps (Task 1, `app/test/messagesRepoRetryLineage.integration.test.ts`).
   A delivered attempt wins permanently at the join (Task 6, `6332843b`):
   `relayRetryJoin.test.ts` covers "is delivered-on-retry once any rung
   delivered", "keeps delivered-on-retry when an older rung reports failure
   afterwards" and "keeps delivered-on-retry when a later rung is still queued".
6. **Met in substance; the "one bubble" wording was SUPERSEDED, not satisfied
   literally.** Tasks 7, 8 and 9 (`5d2feb14`, `e4e8b533`, `bbe58487`, with
   `51b12e13` and `845cfa54`) render `retrying`, `delivered-on-retry`,
   `terminal` and `unconfirmed` from ONE derived value at every position that
   exists - the rollup chip, its accessible-name recital, the inbound
   `inboundRecipientName` recital and the per-recipient row - so the three
   cannot disagree (`dashboard/src/routes/contact/deliveryStatus.test.ts`,
   `Timeline.delivery.test.tsx`, `Timeline.ticker.test.tsx`,
   `Timeline.test.tsx`; all three hosts re-proved by Task 10 (`65bed580`) in
   `TourConversation.test.tsx` and `PlacementConversation.test.tsx`). The
   physical attempts are never shown as conflicting duplicate sends: Task 7's
   filter hides every retry row that earns no bubble. But the founder approved a
   display contract (spec Sec 5) in which a DELIVERED retry of an OUTBOUND
   original renders a SECOND bubble reading `delivered 1/1 on retry` - that
   permission is what made the new-row architecture available at all. Every
   other retry row - failed, still queued, or any retry of an inbound original -
   renders none.
7. **Met.** Task 1 splits the body: the ROW keeps the raw body and
   `relay_retry_leg_body` keeps the exact composed leg copy, which every rung
   sends verbatim - Task 11's "sends exactly one leg, the stored leg copy
   verbatim, after a sender rename". MMS attachments are re-presigned per
   attempt through the extracted `sendOneRelayLeg` (Task 3, `b2b35e81`), proved
   by Task 11's "re-presigns attachments on every attempt". A retry row writes
   NO media-pointer rows, so the gallery index does not grow per attempt while
   the durable s3Keys still ride the row (Task 1, "writes no media-pointer rows
   for a retry row").
8. **Met.** Task 11 re-runs four gates before any send, each writing its own
   close code: `retry_group_closed`, `retry_member_removed`,
   `retry_number_changed` and `retry_opted_out`. The changed-number gate
   compares the stored `relay_retry_dest_digest` against a digest of the
   member's CURRENT number, so an old message can never be silently redirected.
   The `it.each(gateCases)` battery in `app/test/relayRetryLeg.test.ts` asserts
   zero sends, the slot closed with that code, nothing further scheduled on
   either ladder, and exactly one terminal ERROR carrying
   `retryClaim: 'gate_refused'`.
9. **Met.** Backend: `app/test/relayRetryClaim.test.ts`,
   `app/test/messagesRepoRetryLineage.integration.test.ts`,
   `app/test/conversationsRepoActivityBump.integration.test.ts`,
   `app/test/relayRetryLeg.test.ts` (37), `app/test/relayRetryClaim.webhook.test.ts`
   (27), `app/test/twilioStatusWebhook.test.ts` (40 -> 47) and
   `app/test/registerHandlers.test.ts`. Dashboard:
   `dashboard/src/routes/contact/relayRetryJoin.test.ts`,
   `deliveryStatus.test.ts`, `Timeline.test.tsx`, `Timeline.delivery.test.tsx`,
   `Timeline.ticker.test.tsx`,
   `dashboard/src/routes/conversation/useRelayThread.test.tsx`, plus the two host
   suites. Browser: `e2e/tests/dashboard-next/relay-30003-retry.spec.ts` (Task
   14, the rename and rewrite of this issue's pinning spec) proves one failed
   relay leg retries to delivered without duplicating - chip, accessible name,
   row and send counts.

**Residuals, recorded not fixed (spec Sec 9).** A crash between the claim and
the enqueue strands a retry: the row exists, nothing sends, and the leg settles
to `unconfirmed` rather than a permanent `retrying`, but no ERROR is emitted
because nobody observes it - closing that needs the reconciliation sweep this
issue puts out of scope. That window now has its own OPEN issue, with the
interleaving, the `dueRow` fix and the duplicate-send trap written out:
[`relay-retry-stranded-claim-window`](./relay-retry-stranded-claim-window.md).
The relay member-key collapse is worked AROUND, not
fixed; see
[`relay-member-key-collapses-two-phones-one-contact`](./relay-member-key-collapses-two-phones-one-contact.md),
which stays OPEN and records the two retry-path guards. And every attempt
appends a real row while almost none of them render, so hidden rows dilute
thread paging - bounded at three hidden rows per failed leg. Two neighbours stay
OPEN by the founder's 2026-09-02 ruling:
[`relay-inbound-source-has-no-delivery-rollup`](./relay-inbound-source-has-no-delivery-rollup.md)
(an inbound source still shows no visible chip, though its rows and recital now
carry the retry states) and
[`quiet-hours-ungated-automated-paths`](./quiet-hours-ungated-automated-paths.md),
whose item 3 now names the relay ladder under its existing recommendation.
[`relay-30003-classified-transient-retrying`](./relay-30003-classified-transient-retrying.md),
the server-side half of the same contradiction, is closed with this one.

## Design knowledge from M5 (2026-09-01)

This issue was DEFERRED out of bundle M5
(`feat/retry-counter-durable`) as its own mission: three of M5's design review
rounds failed to converge this lineage state machine while the counter anchor
converged after one. Those rounds still bought facts, and they are written down
here so the follow-on mission does not re-buy them. Sources: spec
`docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md` (Sec 2.1 and
Sec 8 obligation 5) and its `design-review/adjudications.md`.

**1. The forward-only status machine forbids a delivered retry from superseding
an undelivered leg.** `ALLOWED_PRIOR` in `app/src/repos/messagesRepo.ts:121-130`
lists, for each new status, the statuses it may overwrite -
`delivered: ['queued','sent']`. `undelivered` is NOT in that list, deliberately,
so a late callback cannot regress or "un-fail" a leg. A retry that delivers must
therefore land through an EXPLICIT, scoped transition of its own; it cannot just
call the existing writer and expect the promotion to take. Acceptance criterion
5 ("a delivered retry updates the effective status") is exactly this line of
code, and it is the reason the effective status has to be DERIVED from lineage
rather than stored by overwriting the slot.

**2. Gating the retry claim on the slot transition caps the ladder at ONE retry,
invisibly.** The tempting design is "claim a retry only when the callback
actually transitioned the slot to undelivered". After the first retry the slot
is already `undelivered`, so the second callback transitions nothing, so no
second retry is ever claimed - a ladder that silently stops at rung 1 while
every test that only checks "one retry happened" stays green. **The gate belongs
on the ATTEMPT RECORD**, not on the slot's transition: claim against the durable
per-member attempt counter, and let the slot write be whatever the status
machine allows.

**3. The relay ANNOUNCEMENT path writes the same SID pointers, so a
pointer-keyed retry reaches fenced `jobs/tourReminders.ts`.**
`app/src/services/relayAnnouncements.ts` (see `:289` and `:312`) writes a
recipient slot plus a `relaysid` pointer exactly as the fan-out does, so the
same `/webhooks/twilio/status` relay branch finalizes both.
`sendRelayAnnouncement` is imported by `jobs/relayFanOut.ts:56`,
`routes/relayGroups.ts:35` AND **`jobs/tourReminders.ts:61`**. A retry keyed on
the SID pointer therefore has blast radius into the tour-reminder ladder, which
is a separate mission's file. Scope the retry to fan-out legs explicitly, or
budget for that fence.

**4. A two-level lineage map WILL hit the parent-path seeding problem M5's
scalar avoided.** M5 chose a top-level scalar (`fanout_attempt`), so it never
had to create a parent map before writing a child. A lineage keyed by member -
attempts per member under one source message - is a nested map, and DynamoDB
REJECTS a `SET parent.#child` whose parent attribute is absent. The in-repo
answer is `app/src/repos/conversationsRepo.ts:2189-2214`: attempt the child
write under `attribute_exists(<parent>)`, catch `ConditionalCheckFailedException`,
and seed the whole map with this one entry under a condition that still guards
the ITEM's existence so an unknown id cannot create a row. Copy that shape; do
not invent a third one, and do not "solve" it by creating the map at message
creation time (that is a creation-site edit in the hottest write path, which is
what M5's D3 declined).

**5. The relay chip copy M5 set must be revisited when a retry becomes real.**
`RELAY_ERROR_CODE_REASONS` in
`dashboard/src/routes/contact/deliveryStatus.ts` maps relay 30003 to
`Phone unreachable` - the carrier code is kept, the "will retry" promise is
dropped - and it feeds THREE positions that must change together (the rollup
chip, the accessible-name recital, the per-recipient row; the message-level chip
is deliberately excluded). That copy is true only while no relay retry exists.
The moment one does, the copy has to become context-aware - "retrying" only when
a retry was actually CLAIMED, not merely when the code is 30003 - and all three
positions move in the same change. The e2e that pins today's behavior is
`e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts`; it will fail,
correctly, and is the checklist for what the new copy must satisfy. Related:
[`relay-30003-classified-transient-retrying`](./relay-30003-classified-transient-retrying.md),
the server-side half of the same contradiction.

### The durable substrate M5 leaves behind - and why NOT to share it

M5 shipped `MessageItem.fanout_attempt`, a top-level scalar, and
`MessagesRepo.claimFanoutPass(conversationId, tsMsgId, cap)` - an atomic
conditional `ADD` that returns `claimed` / `capped` / `missing`
(`app/src/repos/fanoutClaim.ts`). It is keyed on the SOURCE MESSAGE, it survives
a wholesale recipient-slot write, and it is claimed before the work it
authorises, which is precisely the pattern this issue's "claim and advance the
durable attempt before enqueueing" asks for. **Reuse the PATTERN; do not reuse
the COUNTER** (spec Sec 2.1): `fanout_attempt` belongs to the CONTINUATION
ladder, and a continuation sharing a budget with a retry would silently consume
it. A retry ladder needs its own durable record, per member.
