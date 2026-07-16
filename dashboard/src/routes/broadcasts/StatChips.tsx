// StatChips — the broadcast delivery rollup as a row of labeled count chips
// (Recipients / Delivered / Sent / Sending / Failed / Skipped). One job: present
// BroadcastStats as accessible text (label + count), colour as reinforcement
// only. "Recipients" is the resolved audience (stats.audience); the remaining
// buckets are disjoint and sum to it (Sending + Sent + Delivered + Failed +
// Skipped == Recipients), so the row visibly balances. "Skipped" folds both
// skip reasons (opted out + no consent) into one neutral count.
//
// "Sending" is the stats.queued bucket: legs in flight — dispatched but not
// yet carrier-confirmed (no carrierSentAt), plus deferred transient retries.
// "Sent" counts only carrier-confirmed legs, so this row can never claim
// "Sent" while the recipient rows / the messages' own 1:1 bubbles still read
// "Sending…".
import type { BroadcastStats } from '../../api/index.js';
import styles from './StatChips.module.css';

interface Chip {
  label: string;
  value: number;
  tone?: 'success' | 'danger';
}

export function StatChips({ stats }: { stats: BroadcastStats }): React.JSX.Element {
  const chips: Chip[] = [
    { label: 'Recipients', value: stats.audience },
    { label: 'Delivered', value: stats.delivered, tone: 'success' },
    { label: 'Sent', value: stats.sent },
    { label: 'Sending', value: stats.queued },
    { label: 'Failed', value: stats.failed, tone: 'danger' },
    { label: 'Skipped', value: stats.skipped_opted_out + stats.skipped_no_consent },
  ];
  return (
    <dl className={styles.chips} aria-label="Delivery stats">
      {chips.map((chip) => (
        <div
          key={chip.label}
          className={`${styles.chip} ${chip.tone === 'success' ? styles.success : ''} ${
            chip.tone === 'danger' && chip.value > 0 ? styles.danger : ''
          }`.trim()}
        >
          <dt className={styles.chipLabel}>{chip.label}</dt>
          <dd className={styles.chipValue}>{chip.value}</dd>
        </div>
      ))}
    </dl>
  );
}
