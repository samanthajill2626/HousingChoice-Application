// BroadcastStatusPill — the draft/sending/sent/failed lifecycle pill (list rows
// + the Results header). Text-first (status by label, colour is reinforcement
// only). Tokens via the shared DeliveryBadge module's tone classes would conflate
// delivery + lifecycle, so this carries its own small style.
import type { BroadcastStatus } from '../../api/index.js';
import { BROADCAST_STATUS_LABELS, BROADCAST_STATUS_TONE } from './broadcastFormat.js';
import styles from './BroadcastStatusPill.module.css';

const TONE_CLASS: Record<string, string> = {
  neutral: styles.neutral ?? '',
  progress: styles.progress ?? '',
  positive: styles.positive ?? '',
  danger: styles.danger ?? '',
};

export function BroadcastStatusPill({ status }: { status: BroadcastStatus }): React.JSX.Element {
  const tone = BROADCAST_STATUS_TONE[status];
  return (
    <span className={`${styles.pill} ${TONE_CLASS[tone]}`}>{BROADCAST_STATUS_LABELS[status]}</span>
  );
}
