// DeliveryBadge — a small pill for a broadcast recipient's delivery state. One
// job: render the recipient status (queued → sent → delivered | failed | skipped)
// as a text-first badge whose colour comes from the shared comms delivery model
// (deliveryStatus.ts), plus an optional failure reason from the Twilio error code.
// Status is conveyed by TEXT, not colour alone (a11y).
import type { BroadcastRecipient } from '../../api/index.js';
import { deliveryReason, type DeliveryTone } from '../contact/deliveryStatus.js';
import { presentRecipientStatus } from './broadcastFormat.js';
import styles from './DeliveryBadge.module.css';

/** delivery tone → the badge tone class. */
const TONE_CLASS: Record<DeliveryTone, string> = {
  neutral: styles.neutral ?? '',
  info: styles.info ?? '',
  success: styles.success ?? '',
  danger: styles.danger ?? '',
};

export interface DeliveryBadgeProps {
  status: BroadcastRecipient['status'];
  /** The Twilio error class on a failure → a human reason (rendered as a title +
   *  appended text). Absent → just the status label. */
  errorCode?: string;
}

export function DeliveryBadge({ status, errorCode }: DeliveryBadgeProps): React.JSX.Element {
  const pres = presentRecipientStatus(status);
  const reason = pres.isFailure ? deliveryReason(errorCode) : undefined;
  return (
    <span className={`${styles.badge} ${TONE_CLASS[pres.tone]}`} {...(reason && { title: reason })}>
      {pres.label}
      {reason !== undefined ? <span className={styles.reason}> — {reason}</span> : null}
    </span>
  );
}
