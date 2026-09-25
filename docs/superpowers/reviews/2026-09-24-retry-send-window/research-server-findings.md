# Research findings - server retry paths (relay ladder and one-to-one chain)

Read-only research, 2026-09-24, by an opus research subagent for the planner
session, at `main` @`685f2ede`. Punctuation normalized to ASCII; content as
reported. Findings cite code by file:line and quote none of it.

## 1. What "sent at" means per path

- `buildTsMsgId` = `<providerTs>#<providerSid>` (`app/src/repos/messagesRepo.ts:200-202`),
  split back at `:208-213`. Every row also stores `created_at` = our clock at
  append (`:2218`, `:2240`).
- One-to-one: `providerTs` is Twilio's `dateCreated` (whole seconds, Twilio's
  clock), falling back to our clock (`app/src/adapters/messaging.ts:745`; the
  console driver uses ours at `:1173`). The prefix is a valid send time.
- Relay root: `providerTs` is OUR clock when the row is saved - inbound receipt
  (`twilio.ts:853`), team compose (`app/src/routes/api.ts:1802`), or a
  connecting-group compose held as `queued_pending` until the group opens
  (`api.ts:1710`; `app/src/services/relayQueuedMessages.ts:86-98`). The leg's real
  send time is the member slot's `sentAt` = Twilio `dateCreated`
  (`app/src/jobs/relayFanOut.ts:1457`); retry rows use the claim time
  (`twilio.ts:2770`). The root prefix parses but is the WRONG clock for relay.

## 2. Relay claim (`twilio.ts:2678-2907`)

- Order: code check `:2685-86` -> consistent read `:2695-2701` -> sender fence
  `:2709-13` -> `To` `:2720-23` -> slot state `:2744-52` -> attempt and
  `cap_exhausted` `:2757-59` -> root `:2760-63` -> append (the claim) `:2781-2835`
  -> enqueue `:2842-91` -> SSE `:2900-05`.
- Backoff is computed only in `enqueueRelayRetryLeg`: `Date.now()` +
  `resolveRelayRetryBackoff` (`app/src/jobs/relayRetryLeg.ts:214-234`), 60/120/240 s
  (`app/src/lib/relayRetryClaim.ts:16-18`).
- Severity: failure marker `:3045-91`; `isTerminalRelayLegFailure` (`:433-445`) logs
  a 30003 at ERROR unless the outcome is `claimed`, `already_claimed`,
  `fenced_announcement` or `slot_settled`.
- Outcome union: `relayRetryClaim.ts:47-90`, pinned by `relayRetryClaim.test.ts:51-88`
  ("thirteen").
- A window decline fits between `:2763` and `:2781`: returning there leaves exactly
  what `cap_exhausted` leaves - the slot terminal with 30003 from the callback's own
  write (`:2947-53`), no retry row, no enqueue, no claim SSE, ERROR. The origin is
  available on rung 1 as `slot.sentAt`; rungs 2+ read the previous rung's row, so
  the origin must be carried forward like `relay_retry_origin_direction`
  (`:2824-25`).

## 3. Relay job (`app/src/jobs/relayRetryLeg.ts`)

- Order: execution marker `:350-59` -> consistent read of the retry row `:364-67`
  -> lineage check, throws on a missing field (`:268-292`) -> transport `:381-90`
  -> gates: group open `:491-509`, pool number (throws) `:510-15`, roster
  `:517-31`, number digest `:538-46`, opt-out `:548-55` -> send `:575-98`.
- `refuseGate` (`:449-67`) is the pre-send refusal: marks a versioned slot
  `excluded`, writes failed plus the code, emits SSE on the root. `closeTerminally`
  (`:471-80`) is the post-send close and leaves aggregation state alone.
- Close codes `:91-97`; dashboard copy `dashboard/src/routes/contact/deliveryStatus.ts:913-935`,
  pinned by `deliveryStatus.test.ts:1648-68`; an unmapped code renders "Delivery
  failed (error X)" (`:974-76`).
- The transient re-enqueue (`:643-46`) re-runs the whole handler, so a gate-time
  check covers every pass.
- Recommendation: the window check as the LAST gate before `sendOneRelayLeg`,
  closing with `refuseGate(<new code>)`; also check at `:643-46` and close instead
  of re-enqueueing. Caveat: `sendOneRelayLeg` waits on an unbounded
  `tokenBucket.acquire(1)` after every job gate (`relayFanOut.ts:1360`).

## 4. One-to-one 30003 arm (`twilio.ts:3350-69`)

- `message` is read at `:3151`, before `updateDeliveryStatus` (`:3251`); it has
  `retry_attempt`, `retry_of`, `tsMsgId`, `provider_ts`, `created_at`,
  `broadcast_id`, and no conversation type.
- `enqueueSendRetry` takes `{providerSid, conversationId, attempt}` and returns
  void; `runAt` is computed inside (`app/src/jobs/retrySend.ts:44-50`, `:73-77`).
- The WARN `delivery_failed` marker (`:3279-89`; `isTerminalDeliveryFailure`
  `:351-55`; the code set `:342`) fires on every callback before the arm.
  Exhausted retries add an ERROR at `:3358-61`.
- No conversation read in scope; `flagPlacementAttention` reads one internally
  (`:555`) without returning it; the 30005/30006 and 21610 arms do their own reads
  (`:3421`, `:3476`).

## 5. `retrySend` (`retrySend.ts:103-239`)

- Parse payload `:52-70` -> original lookup (WARN and return if missing or not
  outbound, `:112-20`) -> execution marker `:129-46` -> `sendMessage` automated,
  original author, no `retryOf`, no `broadcastId` (`:200-207`) -> annotates
  `retryOf` and `retryAttempt` AFTER the send (`:226-29`); its own comment calls
  this racy (`:221-25`).
- A `SendRefusedError` logs WARN and ends the chain (`:209-16`) - that includes
  `group_text` (`app/src/services/sendMessage.ts:298-300`); any other error
  rethrows and the marker then suppresses the redelivery.
- The next webhook sees only the new row, so the origin must live on it: write it
  at append through the `retryOf` input path (`sendMessage.ts:240`, `:427` ->
  `messagesRepo.ts:2265`). Pre-deploy chains could walk `retry_of` via
  `getByTsMsgId` (`messagesRepo.ts:1385`).

## 6. Native group text

- The arm has no `group_text` guard, but whether it is ever reached is UNVERIFIED
  and doubtful: classic status callbacks do not fire for Conversations sends
  (`app/src/services/groupReceipts.ts:3-10`; fake `conversationsEngine.ts:15-18`);
  group rows are keyed by the `IMxx` SID with no `sid#` alias for member `SMxx`
  SIDs, so such a callback should hit the unknown-SID ERROR (`twilio.ts:3213-28`).
- The receipts path writes the slot (`groupReceipts.ts:448-58`) and enqueues
  nothing; `rollUpAggregate` copies the worst leg's code onto the message row
  (`:354-58`), which never reaches the arm.
- `docs/issues/group-text-30003-leg-retry-promise-unverified.md`: neither level
  retries; a message-row 30003 can come from a leg; the fix is dashboard copy, and
  it must INVERT `Timeline.delivery.test.tsx:517` rather than delete it. Its line
  references are stale (`twilio.ts` 2408/2567 are now 3151/3364).

## 7. Manual retry route (`api.ts:1564-1661`)

- Checks: 404 on SID or conversation mismatch (`:1571-75`); 400 not outbound
  (`:1576-79`); 409 email (`:1585-88`); 409 `not_failed` (`:1592-95`).
- `retryOf` is stamped at append (`:1651`). No check for a pending or earlier retry
  of the same message (`:1559-60`); a pending-retry refusal belongs between `:1595`
  and `:1597`. The dashboard shows Retry on any failure (`Timeline.tsx:1341-51`).

## 8. Repository and projection

- Retry fields: `MessageItem` `messagesRepo.ts:997-1016`; `NewMessage` `:732`,
  `:742-758`.
- `annotateMessage` (`:2905-53`) is the only general stamp, limited to
  `MessageAnnotations` (`:1173-77`): a due time means extending that type. It has
  no REMOVE and no status condition. The test harness has its own copy
  (`app/test/helpers/twilioWebhookHarness.ts:1338`).
- `contactTimeline` passes only listed fields (type `app/src/routes/contactTimeline.ts:157-207`,
  mapping `:420-63`): a new field is added there and in
  `dashboard/src/api/types.ts:2479`; the relay/group view
  (`dashboard/src/routes/conversation/useRelayThread.ts:69-152`) only if those
  bubbles show it.

## 9. Invariant sweep

- Creates retries: `twilio.ts:3364`, `:2781`, `:2842`; `retrySend.ts:73-77`,
  `:200-229`; `relayRetryLeg.ts:225-34`, `:575`, `:643-46`;
  `app/src/jobs/registerHandlers.ts:47`, `:60`; `scripts/e2e-session.mjs:272` (lane
  backoff 10 s). Manual: `api.ts:1651`.
- Server readers: `twilio.ts:2757`, `:2761`, `:2776`, `:2825`, `:3129`, `:3353`;
  `relayRetryLeg.ts:268-92`, `:372`; `messagesRepo.ts:2265-84`, `:2335`,
  `:2912-18`; `contactTimeline.ts:442`.
- Dashboard readers: `types.ts:2308-15`, `:2494`, `:2509-15`;
  `useRelayThread.ts:101-142`; `dashboard/src/routes/contact/relayRetryJoin.ts:135-64`,
  `:453`; `Timeline.tsx:885`, `:1077`, `:1975-84`, `:2004-19`. The copy:
  `deliveryStatus.ts:778`.
- e2e, seeds, dev seams: only `e2e/tests/dashboard-next/relay-30003-retry.spec.ts`;
  no seed or dev seam writes retry fields.

## 10. Risks to the design

- Test fixtures use fixed past times and no slot `sentAt`
  (`app/test/twilioStatusWebhook.test.ts:59`; `app/test/relayRetryClaim.webhook.test.ts:66`,
  `:174`; `app/test/relayRetryLeg.test.ts:90`): a window based on the tsMsgId
  prefix would turn them into declines. `created_at` is always "now".
- The job can refuse after the due stamp is written - manual mode
  (`sendMessage.ts:349`), opt-out, deleted contact, kill switch, breaker, a thrown
  send - so the stamp must expire or be cleared, and be written only after a
  successful enqueue.
- Broadcasts: retries drop `broadcastId`, and
  `dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31` keeps promising "will
  retry" from the broadcast slot (pinned by `StatChips.test.tsx:124-130`); a stamp
  on the message row cannot reach it.
- Double send today: a manual Retry during the backoff sends twice.
- Pre-deploy rows: a new REQUIRED lineage field would make the lineage check throw
  after the marker is set, silently dropping rungs claimed before the deploy.
- No other 30003-triggered resend exists; fan-out continuations and the
  `queued_pending` flush are delayed first sends, not retries.
