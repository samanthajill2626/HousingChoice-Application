# Code review R2 - adjudications

Orchestrator adjudication of `code-review-r2-rereview.md` (the fresh re-review
after fix wave 1). The reviewer's verdict - not yet merge-ready, narrow gap,
nothing structural - is accepted in full. Every finding decided below; the
FIX items form wave 2.

## Wave 2 (eight items + one comment correction)

- **W1 (2.1, 3.1) narrow F1.** The R1 argument covered exactly two shapes and
  the fix whitelisted the whole outcome. Split the outcome: `slot_settled`
  (WARN) when the slot EXISTS and either reads `delivered` or is terminal on a
  code other than 30003 - the leg's end state was already logged at its own
  severity; `slot_ineligible` (ERROR) for an ABSENT slot or a non-terminal
  slot after a failure callback - an internal anomaly of the
  `source_unreadable` class, on a leg that did end terminally on 30003 with no
  ladder. `RelayRetryClaimOutcome` gains `slot_settled` (thirteen values; the
  exhaustive union test moves with it). Tests: absent slot -> ERROR +
  `slot_ineligible`; refused write still `sent` -> ERROR; `delivered` -> WARN
  + `slot_settled`; 30007 -> WARN + `slot_settled`.
- **W2 (2.3, 2.5, 2.6) F2 keeps Twilio's redelivery.** Catch, log, let the
  tail run (failure marker, SSE, escalation), then RETHROW the captured error
  after the tail so the callback 5xxs and Twilio redelivers; D8's state gate
  re-claims on the redelivery (the slot still reads terminal/30003, no row was
  created) and `flagPlacementAttention` cannot double-fire (gated on
  `transitioned`, false on the redelivery). Fold the diagnostic line into the
  failure marker (attach `err`; one ERROR line, one `event`) - 2.5. If the
  enqueue-failure close itself throws, the outcome stays `enqueue_failed` (a
  row exists) and the close's error is logged on that line - 2.6. Test: a
  rejected `append` -> the marker carries `claim_failed` + `err`, the SSE and
  exactly one escalation fire, the handler REJECTS; a replayed callback then
  claims (recovery).
- **W3 (2.4) F5 keeps its guard.** The env override is honored ONLY in the
  in-process topology: `resolveRelayRetryBackoff` ignores
  `E2E_RELAY_RETRY_BACKOFF_MS` whenever `JOBS_QUEUE_URL` is set (production's
  app process). Comments made structural again (`scripts/e2e-session.mjs`,
  `relayRetryLeg.ts`). Test: override set + `JOBS_QUEUE_URL` set -> 60/120/240
  on the free enqueue and the handler; override set + unset -> the override.
- **W4 (2.2, 3.2, 1.6) F7 on the live shape.** The reviewer proved every
  relay source appended today is versioned, so the re-stamp is inert where it
  matters. Take the adversarial review's other proposal: `sendOneRelayLeg`
  gains an optional `suppressionChecked?: boolean` (docblock: the caller ran
  `isMemberSuppressed` in its own gate moments before; skip the duplicate read
  so the two cannot disagree; the fan-out never passes it, so its behaviour is
  byte-identical - the four relay suites stay at 186). The retry job passes
  `true`. The re-stamp and the unconditional `closeCode` on the `suppressed`
  branch go (the branch stays as a defensive log without `closeCode`). Test:
  `isMemberSuppressed` mocked false-then-true with the REAL `sendOneRelayLeg`
  -> the leg sends and the slot never reads `contact_opted_out`, on a
  versioned row. Fix the stale `deliveryStatus.ts:408` citation to `:449`.
- **W5 (3.5, 1.1 in part) Q2 becomes a FIX.** Amends build ruling B1: the
  quiet-rung overlay keeps the ORIGINAL's `errorCode` (it overlays status,
  sentAt, sid, actualTransport, transportAggregationState only), and the
  `unconfirmed` presentation carries `reason: deliveryReason(errorCode, opts)`
  on the row and the recital AND on the chip's `retrying || notConfirmed`
  branch (the same reason list the failed branch builds), so a leg whose retry
  went quiet still names the carrier failure at every position. No label
  changes; D19's table stands. Tests at the join, the presenter and
  Timeline.delivery: `Queued - not confirmed - Phone unreachable (error
  30003)` on the row and recital; the chip's `reason` names 30003.
- **W6 (1.3)** `presentLegDelivery` takes the caller's `DeliveryReasonOptions`
  (an optional last parameter, defaulting to `{ relay: true }`) instead of
  baking them in; Timeline's two call sites pass their `{ media, relay }`.
- **W7 (2.9)** pin F9: one test that the harness fake's `listMediaPointers`
  skips a row carrying `relay_retry_of`.
- **W8 (1.5)** the ticker's retry clause is roster-gated like the projection:
  `retryIndex` is built only for `rosterKind === 'relay'` (an empty map
  otherwise), so the two halves of D18 share one gate.
- **W9c (1.2, comment only)** the comment at `twilio.ts` claiming "the
  DeliveryFailures count metric is unaffected" is corrected: each rung's
  callback emits its own `delivery_failed` event, so relay now counts the way
  the 1:1 ladder already does (up to four per message per dead handset). The
  metric itself is not changed on this branch (Q4).

## Open questions - amended for the human

- **Q4 (A13 + 1.2 + 3.7)** now has both halves: one `cap_exhausted` ERROR per
  message per dead handset (three consecutive buckets to page), AND up to four
  `delivery_failed` events per message against `hc-<env>-delivery-failures`,
  which fires on a single period. The relay ladder now counts like the 1:1
  ladder does. Decide the threshold, or whether rung failures should carry a
  distinct event.
- **Q3 (A5 + 1.4 + 3.6)** the digest AND its salt (`relay_retry_of`) reach
  the browser in one JSON object (rows are returned as-is). The pre-image is
  recoverable from data the client already holds, by authenticated staff who
  can already see the roster. Decide whether "no phone in a sort key" is meant
  literally; `createHmac` with a shared secret is the change.
- **Q1 (3.4)** stays open but is a log-hygiene question, not a paging one: a
  gate refusal is a burst inside one bucket, and an opted-out member is
  refused at the fan-out afterwards, so the shape does not recur.
- **1.1 (the stranded state)** is partly closed by W5 (the carrier code is on
  screen at every position) and W1 (an absent slot alarms again); the missing
  alarm for a claim that was durable but never enqueued remains inside the
  filed issue `relay-retry-stranded-claim-window` - nobody observes that
  state without the sweep. Stated plainly in the handback.

## Recorded, no change

- **2.7** F4 fires per rung and per transient pass (config-gated on a bucket
  every real environment sets).
- **2.8** F3's group-text case is a fence that passes with the feature
  reverted; intention 14's group-text half stays proven by construction.
- **2.10** F1's inverted assertion is the intended behaviour change.
- **F6** is configuration with no pinning test; the spec's comment is its
  guard.
- **F11 rider (3.3)** upheld: the mechanism is filed; W1/W5 restore the
  signals that are inside the delivered feature.

## Process note

Wave 2 is a fix to the fix wave, scoped to R2's section 2 plus the three
section-1 items with a bounded change (1.3, 1.5, Q2). A scoped fresh
re-review of wave 2's diff follows; the build-time ruling B1 is amended by W5
and the amendment is recorded here rather than by rewriting the ledger.
