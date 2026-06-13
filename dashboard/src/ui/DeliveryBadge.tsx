// DeliveryBadge — the §7.1 delivery-state badge for an outbound message.
// Shows queued/sent/delivered/undelivered/failed; for failures it appends the
// human-readable reason from the error code (and exposes it as a title). Inbound
// messages have no meaningful delivery state, so callers only render this for
// outbound messages.
import { Badge } from './Badge.js';
import { deliveryReason, presentDeliveryStatus } from './deliveryStatus.js';
import type { DeliveryStatus } from '../api/types.js';

export interface DeliveryBadgeProps {
  status: DeliveryStatus;
  /** Twilio error code (failures only) — drives the human-readable reason. */
  errorCode?: string;
  /** Show the failure reason inline (default true); when false it's title-only. */
  showReason?: boolean;
}

export function DeliveryBadge({
  status,
  errorCode,
  showReason = true,
}: DeliveryBadgeProps): React.JSX.Element {
  const { label, tone, isFailure } = presentDeliveryStatus(status);
  const reason = isFailure ? deliveryReason(errorCode) : undefined;
  const text = isFailure && showReason && reason ? `${label} · ${reason}` : label;
  return (
    <Badge tone={tone} dot {...(reason !== undefined && { title: reason })}>
      {text}
    </Badge>
  );
}
