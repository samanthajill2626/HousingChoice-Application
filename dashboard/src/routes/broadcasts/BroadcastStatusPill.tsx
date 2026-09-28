// BroadcastStatusPill - the draft/sending/sent/failed lifecycle pill (list rows
// + the Results header). Text-first (status by label, colour is reinforcement
// only). Tokens via the shared DeliveryBadge module's tone classes would conflate
// delivery + lifecycle, so this carries its own small style. With `stats`, a
// finished share's label derives from its recipients (share-sent-outcome D4,
// presentShareLabel): Sent / Sending / Not confirmed / Not sent - an
// all-skipped one reads a neutral "Not sent" (share-skip-fix D6).
import type { BroadcastStats, BroadcastStatus } from '../../api/index.js';
import { presentShareLabel } from './broadcastFormat.js';
import styles from './BroadcastStatusPill.module.css';

const TONE_CLASS: Record<string, string> = {
  neutral: styles.neutral ?? '',
  progress: styles.progress ?? '',
  positive: styles.positive ?? '',
  danger: styles.danger ?? '',
};

/** The lifecycle pill. With `stats`, a finished share reads Sent / Sending /
 *  Not confirmed / Not sent from its recipients (share-sent-outcome D4; an
 *  all-skipped one is share-skip-fix D6's neutral "Not sent"); a draft or a
 *  share still sending, or no stats, reads the plain status label. */
export function BroadcastStatusPill({
  status,
  stats,
}: {
  status: BroadcastStatus;
  stats?: BroadcastStats;
}): React.JSX.Element {
  const { label, tone } = presentShareLabel(status, stats);
  return <span className={`${styles.pill} ${TONE_CLASS[tone]}`}>{label}</span>;
}
