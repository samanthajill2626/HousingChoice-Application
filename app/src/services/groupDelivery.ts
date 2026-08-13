// Group delivery: the SUPPRESSED slot, and the aggregate `delivery_status`.
//
// Two facts from live QA round 2 shape everything in this module.
//
// (1) TWILIO SKIPS A SUPPRESSED PARTICIPANT. Verified against the Messages API:
//     after a member opted out, a group send produced NO message record for that
//     leg at all. The Conversations layer does not create the leg, does not
//     attempt delivery, does not emit a 21610 - and therefore WILL NEVER SEND A
//     DELIVERY RECEIPT FOR THAT PARTICIPANT. A slot seeded `queued` for such a
//     member is stuck forever, which made the per-send staleness sweep raise a
//     FALSE "group delivery receipts silent - check Conversations service
//     webhook config" ERROR on every send to that group (L3). After spec 16.2
//     that alarm is the ONLY detector of a dead receipts webhook, so false-firing
//     it trains the operator to ignore the one alarm that matters.
//
//     THE FIX IS LABELLING, NOT EXCLUDING. Spec 4.4's "sends do NOT exclude
//     suppressed members app-side" stands: we still post to the WHOLE
//     conversation and Twilio still decides. Dropping a participant would be a
//     roster change, and a roster change is a NEW thread identity by
//     construction (spec 4.1) - it would fork every other member's handset
//     thread. All we do is record, at send time, what we already know.
//
// (2) THE AGGREGATE WAS NEVER DERIVED. `delivery_status` stayed `queued` on a
//     group send even with every slot `delivered` - neither the send path nor the
//     receipts path ever wrote it, though spec 4.3 requires it (L4).
//
// PII (doc 9): statuses and codes only - no phones, no bodies.
import type { DeliveryStatus, RelayRecipientDelivery } from '../repos/messagesRepo.js';

/**
 * What a leg Twilio never sent records instead of a raw provider code.
 *
 * `contact_opted_out` is the value the rest of the app ALREADY reads: the
 * timeline's "N members opted out" note counts it, and the delivery rollup
 * EXCLUDES those legs from `delivered N/M` rather than painting the chip red.
 * The relay fan-out writes this same synthetic code for the same reason, so one
 * code means "we know this leg was never really sent" on every product.
 *
 * It lives HERE rather than in groupReceipts so the send path can seed it
 * without importing the receipts service (which imports this module).
 */
export const SUPPRESSED_ERROR_CODE = 'contact_opted_out';

/** True when a slot is one we KNOW was never sent (see SUPPRESSED_ERROR_CODE). */
export function isSuppressedSlot(slot: Pick<RelayRecipientDelivery, 'errorCode'>): boolean {
  return slot.errorCode === SUPPRESSED_ERROR_CODE;
}

/**
 * The slot a KNOWN-SUPPRESSED member is seeded with at send time.
 *
 * `undelivered` is deliberate on both counts: it is the status the receipts path
 * writes for a real 21610, so a known-suppressed leg and an observed-suppressed
 * leg are indistinguishable downstream; and it is TERMINAL, so the staleness
 * sweep has nothing to wait for. Paired with the synthetic code, every existing
 * reader (rollup chip, opted-out note, this module's own derivation) already
 * handles it - nothing new renders.
 */
export function suppressedSlot(): RelayRecipientDelivery {
  return { status: 'undelivered', errorCode: SUPPRESSED_ERROR_CODE };
}

/** Statuses a delivery leg never moves out of. Same set the staleness alarm uses. */
const TERMINAL: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  'delivered',
  'failed',
  'undelivered',
]);

export interface GroupDeliveryRollup {
  status: DeliveryStatus;
  errorCode?: string;
}

/**
 * The aggregate `delivery_status` for a group send, derived from its per-member
 * slots (spec 4.3).
 *
 * THE RULES, and why each one:
 *   - SUPPRESSED LEGS ARE EXCLUDED, exactly as the dashboard rollup chip
 *     excludes them. Counting a leg Twilio never sent would make the aggregate
 *     unreachable: one opted-out member and the message could never finalize.
 *   - every remaining leg terminal -> `delivered` when they all arrived, else the
 *     worst outcome present (`failed` outranks `undelivered`). "All terminal with
 *     one suppressed" is therefore neither `queued` nor `failed`.
 *   - every remaining leg at least `sent` -> `sent` (it left Twilio, nothing has
 *     confirmed arrival).
 *   - anything still `queued` -> `queued`, i.e. NO CHANGE. The caller skips the
 *     write in that case rather than re-asserting the seeded value against a
 *     forward-only guard that would refuse it and log a spurious "would regress".
 *   - EVERY leg suppressed -> `undelivered` + the synthetic code: nothing was
 *     sent to anybody, and no receipt will ever arrive to say so.
 *
 * MONOTONIC BY CONSTRUCTION, which is what makes it safe against the
 * forward-only writer: slots only ever move forward, so the derived value only
 * ever moves forward too.
 */
export function deriveGroupDeliveryStatus(
  slots: readonly RelayRecipientDelivery[],
): GroupDeliveryRollup {
  // No map at all is no information - never a claim that the send failed.
  if (slots.length === 0) return { status: 'queued' };
  const fanned = slots.filter((s) => !isSuppressedSlot(s));
  if (fanned.length === 0) return { status: 'undelivered', errorCode: SUPPRESSED_ERROR_CODE };

  if (fanned.every((s) => TERMINAL.has(s.status))) {
    const failed = fanned.filter((s) => s.status === 'failed');
    const undelivered = fanned.filter((s) => s.status === 'undelivered');
    const worst = failed[0] ?? undelivered[0];
    if (worst === undefined) return { status: 'delivered' };
    return {
      status: worst.status,
      ...(worst.errorCode !== undefined && { errorCode: worst.errorCode }),
    };
  }
  if (fanned.every((s) => s.status === 'sent' || TERMINAL.has(s.status))) {
    return { status: 'sent' };
  }
  return { status: 'queued' };
}
