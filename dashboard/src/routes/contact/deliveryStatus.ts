// Delivery-state presentation for OUTBOUND message bubbles — pure functions,
// unit-tested directly. Ported from the legacy dashboard's ui/deliveryStatus.ts so
// the new comms pane shows the same Queued/Sent/Delivered/Undelivered/Failed states.
//
// Two rules carried over:
//   - "sent ≠ delivered": `sent` is a non-error waypoint, NEVER shown as a failure.
//   - Inbound messages have no meaningful delivery state — callers render this for
//     OUTBOUND only. A row with no stored status (seed/legacy) shows NO chip
//     (returns null) rather than a misleading "Sending…".
import type { DeliveryStatus } from '../../api/index.js';

export type DeliveryTone = 'neutral' | 'info' | 'success' | 'danger';

export interface DeliveryPresentation {
  /** Short badge label ("Sent", "Delivered", "Failed", …). */
  label: string;
  tone: DeliveryTone;
  /** undelivered/failed — the caller surfaces a Retry action. */
  isFailure: boolean;
  /**
   * Human-readable failure reason(s), ALWAYS carrying the raw Twilio error code
   * so an operator can debug (e.g. "Number not registered for A2P 10DLC (error
   * 30034)"). Present only on a failure that carried a code; absent otherwise.
   * For a relay rollup, distinct per-leg reasons are joined with "; ".
   */
  reason?: string;
}

const STATUS_PRESENTATION: Record<DeliveryStatus, DeliveryPresentation> = {
  // `queued_pending` (connect-when-ready hold, T7) = composed on a `connecting`
  // relay group and held: no number to send from yet, so it goes to nobody until
  // the group connects and it flushes. A neutral, non-failure "Queued" cue that
  // says WHEN it will send - it is a deliberate hold, not a stall.
  queued_pending: {
    label: 'Queued - will send when connected',
    tone: 'neutral',
    isFailure: false,
  },
  // `queued` = accepted by us / handed to the carrier but not yet carrier-sent —
  // i.e. the "sending from the app" waypoint. Shown as "Sending…" so the optimistic
  // bubble reads as in-progress before it advances to Sent → Delivered.
  queued: { label: 'Sending…', tone: 'neutral', isFailure: false },
  sent: { label: 'Sent', tone: 'info', isFailure: false },
  delivered: { label: 'Delivered', tone: 'success', isFailure: false },
  undelivered: { label: 'Undelivered', tone: 'danger', isFailure: true },
  failed: { label: 'Failed', tone: 'danger', isFailure: true },
};

/**
 * How long an outbound message may sit at `sent` before the chip stops implying
 * it landed. Twilio returns a terminal receipt within seconds to a couple of
 * minutes when it returns one at all; 15 minutes is well past that.
 */
export const STALE_SENT_AFTER_MS = 15 * 60 * 1000;

/**
 * `sent` that never advanced. An over-budget MMS is discarded by the carrier
 * with NO receipt and NO error code (docs/issues/
 * outbound-mms-stalls-at-sent-with-no-receipt.md), so the row sits at `sent`
 * forever and the old chip read "Sent" - indistinguishable from a message that
 * actually arrived. That is exactly how the 2026-08-19 drop went unnoticed.
 *
 * Deliberately NOT `isFailure`: no receipt is not proof of failure, the message
 * may well have landed, and marking it failed would offer a Retry that could
 * double-send. It reads as danger so it draws the eye, and says plainly that we
 * do not know. No `reason` either - the label already says it, and the bubble
 * renders a reason INLINE, where a sentence of guidance would swamp the chip.
 */
const STALE_SENT_PRESENTATION: DeliveryPresentation = {
  label: 'Sent - not confirmed',
  tone: 'danger',
  isFailure: false,
};

/**
 * THE single clock comparison in this module: has `atMs` been quiet for at least
 * STALE_SENT_AFTER_MS as of `nowMs`? Inclusive at exactly the threshold.
 *
 * One shared COMPARISON, never one shared PREDICATE. `presentDeliveryStatus`
 * keeps its own `sent`-only gate over this, and `isStaleLeg` encodes the
 * per-leg eligibility table over the same comparison, so the two rules can
 * differ in WHICH legs they consider without ever diverging on the threshold.
 *
 * `atMs` is `number | undefined` because a caller's clock is genuinely optional
 * and may be `Date.parse` of a malformed string. Both a missing clock and a
 * non-finite one answer false: no clock is no evidence of quiet.
 */
export function isQuietSince(atMs: number | undefined, nowMs: number): boolean {
  if (atMs === undefined || !Number.isFinite(atMs)) return false;
  return nowMs - atMs >= STALE_SENT_AFTER_MS;
}

/**
 * Map a delivery status to its label/tone/failure-flag, or `null` when there is no
 * status to show (undefined — seed/legacy rows; or an unrecognized value). Returning
 * null keeps the bubble clean instead of inventing a false "Sending…"/failure cue.
 *
 * `sentAtMs` (the message's timestamp) is optional: pass it and a `sent` row that
 * has gone quiet for STALE_SENT_AFTER_MS presents as unconfirmed instead of
 * "Sent". Omit it and behavior is exactly as before. `nowMs` is injectable for
 * tests.
 *
 * CONVENTION DIVERGENCE, deliberate - do NOT harmonise these two:
 * this function opts out of staleness by WITHHOLDING THE TIMESTAMP (`sentAtMs`).
 * Its `nowMs` is a DEFAULTED parameter, so passing `undefined` RE-ARMS the real
 * clock rather than disabling anything. The newer `isStaleLeg` /
 * `canEverGoStale` / `presentRelayDelivery` / `presentLegDelivery` opt out the
 * opposite way - by WITHHOLDING THE CLOCK (`nowMs: number | undefined`, where
 * undefined means staleness is off entirely). Changing this signature would move
 * the 1:1 rule, which three out-of-module callers depend on.
 */
export function presentDeliveryStatus(
  status: DeliveryStatus | undefined,
  sentAtMs?: number,
  nowMs: number = Date.now(),
): DeliveryPresentation | null {
  if (status === undefined) return null;
  if (status === 'sent' && isQuietSince(sentAtMs, nowMs)) {
    return STALE_SENT_PRESENTATION;
  }
  return STATUS_PRESENTATION[status] ?? null;
}

/** The slice of a relay `delivery_recipients` slot the rollup presenter reads. */
export interface RelayDeliverySlot {
  status: DeliveryStatus;
  errorCode?: string;
}

/**
 * Present a relay SOURCE message's per-recipient rollup as one chip. The rules:
 *   - in flight → neutral "delivered N/M" that counts up as DLRs land;
 *   - every leg delivered → the SAME green "Delivered" cue as a 1:1 bubble
 *     ("Delivered N/N") so a finalized group send is legible at a glance;
 *   - any hard-failed leg (failed/undelivered) → danger, with the failure count.
 * Opted-out members are EXCLUDED from the count: they were never sent to (the
 * bubble's opt-out note explains them), and counting them would make N/M
 * unreachable — the chip could never finalize. All-opted-out (or no slots) ⇒
 * null: nothing was fanned out, so there is nothing to summarize.
 */
export function presentRelayDelivery(slots: RelayDeliverySlot[]): DeliveryPresentation | null {
  // Keyed on the CODE ALONE, deliberately. The relay fan-out records a
  // suppressed leg as `failed`; the group-text receipts path records what Twilio
  // actually reported for a 21610, which is `undelivered`. Requiring `failed` as
  // well meant a group text's opted-out member was counted as a hard failure -
  // the exact outcome the synthetic `contact_opted_out` code exists to prevent -
  // while the identical relay leg was excluded. `contact_opted_out` is written by
  // us, never by a carrier, so the code by itself is an unambiguous statement
  // that this leg was never really sent.
  const fanned = slots.filter((s) => s.errorCode !== 'contact_opted_out');
  if (fanned.length === 0) return null;
  const delivered = fanned.filter((s) => s.status === 'delivered').length;
  const failed = fanned.filter(
    (s) => s.status === 'failed' || s.status === 'undelivered',
  ).length;
  const total = fanned.length;
  if (failed > 0) {
    // Surface the failed legs' error code(s) so the chip is debuggable (the 30034
    // relay-group bug read as a bare "0/2 - 2 failed" with no code). Distinct
    // reasons joined; a repeated code collapses to one.
    const reasons = Array.from(
      new Set(
        fanned
          .filter((s) => s.status === 'failed' || s.status === 'undelivered')
          .map((s) => deliveryReason(s.errorCode))
          .filter((r): r is string => r !== undefined),
      ),
    );
    return {
      label: `delivered ${delivered}/${total} - ${failed} failed`,
      tone: 'danger',
      isFailure: true,
      ...(reasons.length > 0 && { reason: reasons.join('; ') }),
    };
  }
  if (delivered === total) {
    return { label: `Delivered ${total}/${total}`, tone: 'success', isFailure: false };
  }
  return { label: `delivered ${delivered}/${total}`, tone: 'neutral', isFailure: false };
}

/**
 * Twilio error code → human-readable reason (the §7.1 classes the legacy covered).
 * Used when the timeline carries `error_code` on a failure; absent code ⇒ undefined
 * (the caller shows just the "Failed" label then).
 */
const ERROR_CODE_REASONS: Record<string, string> = {
  '30003': 'Phone unreachable — will retry',
  '30005': 'Number is invalid',
  '30006': 'That number is a landline',
  '30007': 'Carrier filtered the message',
  '30034': 'Number not registered for A2P 10DLC',
  '21610': 'Recipient has opted out (STOP)',
};

/**
 * Codes THIS APP invents, which no carrier ever emits and no operator can look
 * up. They get plain operator copy and, deliberately, NO "(error <code>)" tail:
 * printing `contact_opted_out` as if it were a carrier error number is the
 * defect this map exists to fix (A16).
 *
 * `contact_opted_out` reaches the message-level chip only as the group-send
 * AGGREGATE: `deriveGroupDeliveryStatus` (app/src/services/groupDelivery.ts)
 * writes `{ status: 'undelivered', errorCode: 'contact_opted_out' }` when every
 * member is suppressed, and `presentRelayDelivery` returns null for that map, so
 * the bubble has no rollup to fall back on and this string IS what staff read.
 * The framing matches groupDelivery.ts: Twilio never creates the leg, so nothing
 * was sent - it is not a delivery failure.
 *
 * This is STAFF-FACING dashboard copy, so it lives here beside
 * ERROR_CODE_REASONS rather than in the app's message catalog (which is the
 * single source for automated MEMBER-facing copy).
 */
const INTERNAL_CODE_REASONS: Record<string, string> = {
  contact_opted_out: 'Everyone here has opted out - nothing was sent',
};

/**
 * Twilio error code → a human reason that ALWAYS surfaces the raw code number
 * (mapped or not), so an operator never has to leave the thread to learn WHY a
 * send failed. Absent code ⇒ undefined (caller shows just the "Failed" label).
 */
/** OWN-PROPERTY lookup (adversarial 30). Both maps are plain object literals, so
 *  a bare `map[code]` resolves inherited Object.prototype members - and an
 *  `error_code` is provider/wire data, never a trusted key. `INTERNAL_CODE_REASONS`
 *  is the sharp one: its early return would hand back a FUNCTION where the
 *  signature promises a string (the error map only escaped because its template
 *  wrap coerced whatever it found). */
function ownReason(map: Record<string, string>, code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : undefined;
}

export function deliveryReason(errorCode: string | undefined): string | undefined {
  if (errorCode === undefined || errorCode.length === 0) return undefined;
  const internal = ownReason(INTERNAL_CODE_REASONS, errorCode);
  if (internal !== undefined) return internal;
  const mapped = ownReason(ERROR_CODE_REASONS, errorCode);
  return mapped !== undefined
    ? `${mapped} (error ${errorCode})`
    : `Delivery failed (error ${errorCode})`;
}
