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
 * Map a delivery status to its label/tone/failure-flag, or `null` when there is no
 * status to show (undefined — seed/legacy rows; or an unrecognized value). Returning
 * null keeps the bubble clean instead of inventing a false "Sending…"/failure cue.
 */
export function presentDeliveryStatus(
  status: DeliveryStatus | undefined,
): DeliveryPresentation | null {
  if (status === undefined) return null;
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
  const fanned = slots.filter(
    (s) => !(s.status === 'failed' && s.errorCode === 'contact_opted_out'),
  );
  if (fanned.length === 0) return null;
  const delivered = fanned.filter((s) => s.status === 'delivered').length;
  const failed = fanned.filter(
    (s) => s.status === 'failed' || s.status === 'undelivered',
  ).length;
  const total = fanned.length;
  if (failed > 0) {
    // Surface the failed legs' error code(s) so the chip is debuggable (the 30034
    // group-text bug read as a bare "0/2 - 2 failed" with no code). Distinct
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
 * Twilio error code → a human reason that ALWAYS surfaces the raw code number
 * (mapped or not), so an operator never has to leave the thread to learn WHY a
 * send failed. Absent code ⇒ undefined (caller shows just the "Failed" label).
 */
export function deliveryReason(errorCode: string | undefined): string | undefined {
  if (errorCode === undefined || errorCode.length === 0) return undefined;
  const mapped = ERROR_CODE_REASONS[errorCode];
  return mapped !== undefined
    ? `${mapped} (error ${errorCode})`
    : `Delivery failed (error ${errorCode})`;
}
