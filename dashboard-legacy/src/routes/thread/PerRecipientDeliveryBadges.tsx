// PerRecipientDeliveryBadges — the relay fan-out's per-member delivery chips
// (M1.7). A relayed message is delivered to each OTHER member independently, so
// instead of one DeliveryBadge we render a compact chip per recipient, each
// labelled with the member (resolved against the roster — honest identity) and
// its own delivery state. Reuses DeliveryBadge so the §7.1 status presentation
// (sent ≠ delivered, failure reasons) is identical to the 1:1 path.
//
// In dev there are no real Twilio callbacks (console driver), so chips mostly
// rest at Queued/Sent — that's expected (see the milestone note).
import { DeliveryBadge } from '../../ui';
import { memberLabelForKey } from './relay';
import type { ConversationParticipant, RelayRecipientDelivery } from '../../api';
import styles from './PerRecipientDeliveryBadges.module.css';

export interface PerRecipientDeliveryBadgesProps {
  /** The message's delivery_recipients map (member key → per-recipient state). */
  recipients: Record<string, RelayRecipientDelivery>;
  /** The live roster, for resolving each member key to a display label. */
  roster: ConversationParticipant[];
}

export function PerRecipientDeliveryBadges({
  recipients,
  roster,
}: PerRecipientDeliveryBadgesProps): React.JSX.Element | null {
  const entries = Object.entries(recipients);
  if (entries.length === 0) return null;

  return (
    <ul className={styles.list} aria-label="Per-recipient delivery">
      {entries.map(([key, delivery]) => (
        <li key={key} className={styles.item}>
          <span className={styles.who} title={memberLabelForKey(roster, key)}>
            {memberLabelForKey(roster, key)}
          </span>
          <DeliveryBadge
            status={delivery.status}
            {...(delivery.errorCode !== undefined && { errorCode: delivery.errorCode })}
          />
        </li>
      ))}
    </ul>
  );
}
