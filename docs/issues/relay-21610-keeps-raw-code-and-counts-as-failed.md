---
id: relay-21610-keeps-raw-code-and-counts-as-failed
title: A relay leg's observed 21610 keeps the raw provider code, so an opted-out relay member counts as a hard failure
type: bug
severity: med
status: open
area: app/relay
created: 2026-08-24
refs: app/src/routes/webhooks/twilio.ts:2386, app/src/services/groupReceipts.ts:419, app/src/services/groupDelivery.ts:42, app/src/jobs/relayFanOut.ts:458, dashboard/src/routes/contact/deliveryStatus.ts:376 (presentRelayDelivery's `fanned` filter), dashboard/src/routes/contact/Timeline.tsx:830 (optedOutCount)
---

**Problem.** The two multi-party products disagree about what a 21610 (Twilio
refusing a send to an opted-out handset) records in a `delivery_recipients` slot,
and only one of the two forms is treated as "never really sent".

- **Group text (native carrier group).** `groupReceipts.ts` translates the
  observed 21610 into the synthetic code before writing the slot:
  `effectiveErrorCode = SUPPRESSED_ERROR_CODE` (`groupReceipts.ts:419`), where
  `SUPPRESSED_ERROR_CODE === 'contact_opted_out'` (`groupDelivery.ts:42`).
- **Relay group.** The relay-recipient status callback passes Twilio's raw
  `ErrorCode` straight through to the slot -
  `messages.updateRecipientDeliveryStatus(..., mapped, ErrorCode)`
  (`app/src/routes/webhooks/twilio.ts:2381-2387`, the `ErrorCode` argument on
  `:2386`) - so the slot keeps the literal `'21610'`.

Every downstream reader keys on the CODE ALONE, and on the translated form only:

- the delivery rollup excludes opted-out legs from the `delivered N/M`
  denominator with `slots.filter((s) => s.errorCode !== 'contact_opted_out')`
  (`presentRelayDelivery`'s `fanned` filter,
  `dashboard/src/routes/contact/deliveryStatus.ts:376`), and
- the bubble's "N members opted out" note counts the same code
  (`optedOutCount`, `dashboard/src/routes/contact/Timeline.tsx:830-832`).

So a relay member observed opted out THIS way is painted as a hard failure - it
turns the rollup chip danger and shows in the failed count - while the identical
group-text member is quietly excluded and explained by the note. Real,
pre-existing, and not touched by `feat/per-recipient-delivery`; the new
per-recipient rows inherit the same mislabel per row.

Note this is only the OBSERVED-suppression path. When the relay fan-out already
knows a member is suppressed it writes the synthetic code itself
(`app/src/jobs/relayFanOut.ts:456-459`), which is correct. The gap is exactly the
member we did not know about until Twilio told us.

**Suggested fix.** Translate at the relay receipts seam the same way the group
seam does: in `handleRelayRecipientStatus`
(`app/src/routes/webhooks/twilio.ts:2374`), substitute `SUPPRESSED_ERROR_CODE`
for a `21610` `ErrorCode` before calling `updateRecipientDeliveryStatus`, so a
known-suppressed relay leg and an observed-suppressed relay leg are
indistinguishable downstream - which is exactly the property
`app/src/services/groupDelivery.ts:49-58` already documents as intended for the
group path. Decide alongside it whether the observed relay 21610 should also do
the number-scoped suppression bookkeeping that
`groupReceipts.ts:280-316` (`recordSuppression`) does, and whether existing
stored `'21610'` slots need a backfill or are acceptable as history.

Related but distinct:
[`relay-member-suppression-diverges-from-number-seam`](./relay-member-suppression-diverges-from-number-seam.md)
is about WHICH suppression seam the relay path READS; this one is about the code
value it WRITES. Do not merge them.
