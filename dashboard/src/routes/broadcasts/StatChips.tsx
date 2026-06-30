// StatChips — the broadcast delivery rollup as a row of labeled count chips
// (Recipients / Delivered / Sent / Queued / Failed). One job: present
// BroadcastStats as accessible text (label + count), colour as reinforcement
// only. "Recipients" is the resolved audience (stats.audience).
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
    { label: 'Queued', value: stats.queued },
    { label: 'Failed', value: stats.failed, tone: 'danger' },
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
