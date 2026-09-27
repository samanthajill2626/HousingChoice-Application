---
id: status-callback-passive-match-for-pending-reconcile
title: A status callback for a SID we do not yet hold is dropped at ERROR even when a send reconcile is pending for it - no passive match, and the webhook's failure side effects never run
type: improvement
severity: med
status: open
area: app/messaging
created: 2026-09-25
refs: app/src/routes/webhooks/twilio.ts:3151, app/src/routes/webhooks/twilio.ts:3171, app/src/routes/webhooks/twilio.ts:3223, app/src/routes/webhooks/twilio.ts:3279, app/src/routes/webhooks/twilio.ts:3338, app/src/routes/webhooks/twilio.ts:3364, app/src/routes/webhooks/twilio.ts:3470, docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md
---

**Problem.** The status webhook resolves every delivery callback by SID: the
message row, then the relay `relaysid#` pointer, then the system-send marker
(`app/src/routes/webhooks/twilio.ts:3151-3157`). If none resolves, it waits
once and retries the lookups (`:3171-3174`), and if still nothing, it logs
"status callback for unknown provider SID after retry - delivery outcome
dropped" at ERROR and acks 200 (`:3212-3227`).

`feat/send-outcome-reconcile` (SOR) makes this path busier by design. When a
send's outcome is ambiguous (a timeout after Twilio may have accepted), the
message exists at Twilio but we do not hold its SID until the reconcile job
finds and adopts it, 5 seconds to 4 minutes later (SOR D13, D13a). Twilio's
callbacks for that message arrive in the meantime and are dropped:

- **Alarm noise.** Up to three ERROR lines per orphan until adoption; a burst
  of ambiguous sends (a Twilio blip) can turn that into an
  `hc-<env>-error-logs` page for messages that are being handled correctly.
- **Side effects that never run.** The webhook's failure handling runs only
  for a callback that resolves to a known message: the `delivery_failed`
  marker the delivery-failure metric counts (`:3279-3290`), and on a
  transition the placement attention flag (`:3338`), the 30003 automatic retry
  (`:3364`) and the 21610 suppression bookkeeping (`:3470`). A dropped receipt
  runs none of them. SOR's adoption records the terminal status honestly and WARNs naming
  the code (SOR D15), but does not replay those side effects.

SOR fences `routes/webhooks/twilio.ts` entirely and names this as the follow-up
that closes both (design Sec 2, "Out - hard fences").

**Suggested fix.** Found along the way (the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9 and Sec 2); a webhook follow-up to build after SOR lands, on its attempt
record. On an unknown SID, before the ERROR, look for a pending reconcile the
callback could belong to (the callback carries `To` and `From`; the attempt
record holds the recipient digest and sender) and either resolve the reconcile
on the spot (a passive match: the same claim-then-adopt SOR D11 uses, so it
cannot adopt a message twice) or, at minimum, downgrade the log to WARN while a
matching reconcile is open. Then decide which webhook side effects an adoption
of a terminal failure must replay, so a message that failed 30003 while its SID
was unknown still gets its retry.

**Related.**
[send-time-21610-skips-suppression-bookkeeping](./send-time-21610-skips-suppression-bookkeeping.md),
[accepted-send-lost-when-append-fails](./accepted-send-lost-when-append-fails.md)
(the same ERROR fires for an append that failed after Twilio accepted),
[verification-sms-receipts-trip-error-alarm](./verification-sms-receipts-trip-error-alarm.md).
