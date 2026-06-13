// Delivery-state presentation logic (doc §7.1) — PURE functions, unit-tested
// directly (no rendering). DeliveryBadge.tsx renders these.
//
// Two caveats encoded here, both from §7.1:
//   - "sent ≠ delivered": `sent` is a distinct, non-error resting state (carrier
//     delivery receipts are best-effort); it is NOT shown as a failure.
//   - A failure shows a HUMAN-READABLE reason derived from the Twilio error code.
import type { BadgeTone } from './Badge.js';
import type { DeliveryStatus } from '../api/types.js';

export interface DeliveryPresentation {
  /** The short label shown in the badge ("Queued", "Sent", "Failed", …). */
  label: string;
  tone: BadgeTone;
  /** True for undelivered/failed — the caller may surface a retry/call action. */
  isFailure: boolean;
}

const STATUS_PRESENTATION: Record<DeliveryStatus, DeliveryPresentation> = {
  queued: { label: 'Queued', tone: 'neutral', isFailure: false },
  // "sent ≠ delivered" — a non-error waypoint, NOT a failure.
  sent: { label: 'Sent', tone: 'info', isFailure: false },
  delivered: { label: 'Delivered', tone: 'success', isFailure: false },
  undelivered: { label: 'Undelivered', tone: 'danger', isFailure: true },
  failed: { label: 'Failed', tone: 'danger', isFailure: true },
};

/** Map a delivery status to its label/tone/failure-flag. */
export function presentDeliveryStatus(status: DeliveryStatus): DeliveryPresentation {
  return STATUS_PRESENTATION[status];
}

/**
 * Twilio error code → human-readable reason (doc §7.1 error classes). The map
 * covers the codes §7.1 calls out; anything else falls through to a generic
 * line that still surfaces the raw code for support.
 */
const ERROR_CODE_REASONS: Record<string, string> = {
  '30003': 'Phone unreachable — will retry',
  '30005': 'Number is invalid',
  '30006': 'That number is a landline',
  '30007': 'Carrier filtered the message',
  '21610': 'Recipient has opted out (STOP)',
};

/**
 * A human-readable failure reason for an error code. Returns undefined when no
 * code is present (the caller shows just the status label then).
 */
export function deliveryReason(errorCode: string | undefined): string | undefined {
  if (errorCode === undefined || errorCode.length === 0) return undefined;
  return ERROR_CODE_REASONS[errorCode] ?? `Delivery failed (error ${errorCode})`;
}
