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
  '21610': 'Recipient has opted out (STOP)',
};

export function deliveryReason(errorCode: string | undefined): string | undefined {
  if (errorCode === undefined || errorCode.length === 0) return undefined;
  return ERROR_CODE_REASONS[errorCode] ?? `Delivery failed (error ${errorCode})`;
}
