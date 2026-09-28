// DeliveryBadge - a small pill for a broadcast recipient's delivery state. One
// job: render the recipient status (queued -> sent -> delivered | failed | skipped)
// as a text-first badge whose color comes from the shared comms delivery model
// (deliveryStatus.ts), plus the reason a skipped or failed recipient was not
// reached (shareRecipientReason, spec D7). Status is conveyed by TEXT, not color
// alone (a11y).
import type { BroadcastRecipient } from '../../api/index.js';
import type { DeliveryTone } from '../contact/deliveryStatus.js';
import { presentRecipientStatus, shareRecipientReason } from './broadcastFormat.js';
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
  /** Carrier-confirmed instant; a status-'sent' slot WITHOUT it renders
   *  "Sending…" (dispatched, awaiting the carrier — same as the 1:1 bubble). */
  carrierSentAt?: string;
  /** The slot's reason code: a carrier or app-owned code on a failure, the
   *  refusal / fence code on a skip. Rendered as a title + appended text through
   *  shareRecipientReason. Absent on a failed row -> "Delivery failed"; absent on
   *  a skipped row (recorded before 2026-09-25) -> "Opted out or number
   *  unreachable". Queued / sent / delivered rows show no reason. It also picks
   *  the LABEL for `send_unconfirmed`: "Not confirmed" (SOR D22). */
  errorCode?: string;
  /** share-sent-outcome D3: the newest attempt's retry promise as its message
   *  row holds it (the results route passes it through). */
  retryDueAt?: string;
  /** share-sent-outcome D3: 'unconfirmed' when that attempt's chain ended unresolved. */
  retryOutcome?: string;
  /** share-sent-outcome D3: the page's SERVER-clock snapshot the promise is
   *  judged against (re-taken on the page's 60 s ticker). Without it the badge
   *  judges no promise and reads the plain failure. */
  serverNowMs?: number;
}

export function DeliveryBadge({
  status,
  carrierSentAt,
  errorCode,
  retryDueAt,
  retryOutcome,
  serverNowMs,
}: DeliveryBadgeProps): React.JSX.Element {
  const pres = presentRecipientStatus(status, carrierSentAt, errorCode);
  // share-skip-fix D7: every skipped and failed row carries its reason;
  // share-sent-outcome D3: a failed 30003 row's reason reads its promise.
  const reason = shareRecipientReason(
    status,
    errorCode,
    serverNowMs !== undefined ? { retryDueAt, retryOutcome, serverNowMs } : undefined,
  );
  return (
    <span className={`${styles.badge} ${TONE_CLASS[pres.tone]}`} {...(reason && { title: reason })}>
      {pres.label}
      {reason !== undefined ? <span className={styles.reason}> — {reason}</span> : null}
    </span>
  );
}
