# Presentation + self-heal map - findings (design-phase research, 2026-09-24, main @31bccd98)

Produced by a code-explorer child (opus). The full A-E reference map lives in
the planner's context; this file keeps the FINDINGS (what a designer would get
wrong) plus the load-bearing facts the design rests on. Verify before relying.

## Load-bearing facts
- A `failed` slot is permanent: broadcast (broadcastSlotMayTransition,
  twilio.ts:3544-3548) and relay (forward-only machine, messagesRepo.ts:133-142)
  both refuse any later callback over it. No self-heal.
- Broadcast callback -> slot match is conversationId + tsMsgId
  (twilio.ts:3591-3593); the slot stores no SID. If sendMessage throws, the
  fan-out never gets tsMsgId, so even a non-terminal slot can never be healed.
- Relay callback -> slot needs the relaysid# pointer, written only after a
  successful send AND a successful slot write (relayFanOut.ts:1450-1467). No
  pointer = no path to the slot.
- deliveryReason (dashboard deliveryStatus.ts:952-977): app-invented codes map
  (:913-935) renders prose; Twilio code map (:777-784); UNMAPPED renders
  "Delivery failed (error <code>)" (:976).
- Broadcast rows: presentRecipientStatus (broadcastFormat.ts:94-110); failed
  rows sort first and link "open conversation to retry"
  (BroadcastResults.tsx:63-67, 77). No staleness / not-confirmed state for
  broadcasts at all.
- deriveBroadcastStats (broadcastsRepo.ts:216-265) buckets by STATUS with no
  default arm - a new status value silently drops out of every chip.
- Relay leg rows: presentLegDelivery (deliveryStatus.ts:668-770); only
  `contact_opted_out` changes label/tone/failure by CODE today (:689-700).
- Relay rollup chip (presentRelayDelivery :435-604) renders only for OUTBOUND
  (team-sent) relay messages; member-authored relay sources (direction inbound)
  get per-recipient rows on click + an sr-only summary (Timeline.tsx:931,
  1090-1093, 1143-1154).
- Existing "not confirmed" copy ("Sent - not confirmed", "Queued - not
  confirmed", chip "N not confirmed") is red-but-not-a-failure BY DESIGN so no
  Retry is offered that could double-send (deliveryStatus.ts:73-77, 541-545,
  706-711). It is derived from staleness clocks only; no code triggers it.

## Findings / surprises
1. Unmapped app codes print as fake carrier errors: `no_contact` renders
   "Delivery failed (error no_contact)" today. Any new code must go in the
   app-code map.
2. Broadcast 30003 retries never heal the broadcast slot: retrySend calls
   sendMessage WITHOUT broadcastId (retrySend.ts:200-207), so the badge keeps
   promising "will retry" (StatChips.test.tsx:127-131) while the 1:1 bubble may
   read Delivered.
3. An ambiguous broadcast send can never be matched to its slot (needs tsMsgId
   sendMessage never returned).
4. Broadcast status decided once in finalize, never revisited; all-skipped reads
   green "Sent"; every refusal shows only as "Skipped".
5. A new STATUS value (vs a new code) breaks the broadcast UI quietly (badge
   "Sending...", slot in no chip).
6. Member-authored relay messages have no summary chip.
7. Relay legs never dispatched never go stale; deliveryStatus.ts:221-223 claims
   "the server's own staleness alarm covers it" - no such alarm exists for relay
   (groupSendStaleness only watches native group texts; due rows written only by
   groupSend.ts).
8. The broadcast catch wraps MORE than the send (slot write, bumpStats, token
   acquire, broadcastFanOut.ts:430-446): a terminal write added to that catch
   could clobber a correct `sent` slot (setRecipient is a blind overwrite).
   Versioned applyRecipientSendResult allows sent -> failed. Throws also sit
   OUTSIDE the per-recipient try: broadcastFanOut.ts:366, 410-411; relay
   suppression read, token acquire, presign, aggregation writes
   (relayFanOut.ts:1324, 1360-1382).
9. A real Twilio 429 reads as code 20429 (twilio-node RestException sets code =
   Twilio code, status = HTTP; errorCodeOf reads code first), which is NOT in
   {'429','30022'} - so real rate limiting takes the unknown-error throw today.
   Fan-out tests fake 429 as {code: 429} (broadcastFanOut.test.ts:179).
   Planner verified 2026-09-24 against Twilio docs: 20429 = HTTP 429, "requests
   that receive 429 responses aren't processed and are safe to retry". 30007 and
   30022 are CARRIER log-type codes delivered asynchronously, not REST errors.
10. The adapter's kill-switch error (messaging.ts:383-388, thrown :666-674) is a
    plain Error subclass, NOT a SendRefusedError - in relay it hits the
    unknown-error arm today; the relay `refused` arm looks unreachable from
    adapter errors.
11. Terminal failures written by the jobs never flag the placement for attention;
    only webhook-observed failures do (twilio.ts:3102-3133).
12. The relay retry ladder already reports a stranded retry honestly as "Queued -
    not confirmed"; writing a terminal code there replaces that with the
    original's "Undelivered/Failed" plus the new copy (relayRetryJoin.ts:405-415).
13. The composer's "already sent this property" flag counts failed/stranded
    recipients of any sent/sending broadcast (broadcastsRepo.ts:524-550).
