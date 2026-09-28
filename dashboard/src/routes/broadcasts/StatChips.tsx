// StatChips — the broadcast delivery rollup as a row of labeled count chips
// (Recipients / Delivered / Sent / Sending / Queued / Failed / Retrying /
// Not confirmed / Skipped). One job: present BroadcastStats as accessible text
// (label + count), colour as reinforcement only. "Recipients" is the resolved
// audience (stats.audience); the remaining buckets are disjoint and sum to it
// (Queued + Sending + Sent + Delivered + Failed + Retrying + Not confirmed +
// Skipped == Recipients), so the row visibly balances.
// "Skipped" folds all three skip buckets (opted out + no consent + other) into
// one neutral count. "Not confirmed" (SOR D22) is its own danger chip - the
// recipients the platform could not confirm - and is never a skip.
// stats.unconfirmed is optional (persisted rows predate it) -> default 0.
//
// share-sent-outcome D4: "Retrying" shows stats.retry_pending, a SUB-bucket
// of failed (the failed recipients holding a live retry promise), and
// "Failed" shows the rest: Failed + Retrying == stats.failed, so the row
// still balances. A count kept above failed (a stale payload) clamps Failed
// at 0. retry_pending is optional (absent on emits that do not carry it) ->
// default 0; the chip takes the progress tone above zero.
//
// The two in-flight buckets stay SEPARATE so a stuck send is diagnosable at a
// glance (founder ask, 2026-07-16 - proving out the Twilio infrastructure):
//   Queued  = still on OUR box (awaiting the paced fan-out / deferred retry);
//   Sending = with the CARRIER (dispatched, no carrierSentAt confirmation yet).
// "Sent" counts only carrier-confirmed legs, so this row can never claim
// "Sent" while the recipient rows / the messages' own 1:1 bubbles still read
// "Sending…". stats.sending is optional (legacy rows predate it) -> default 0.
import type { BroadcastStats } from '../../api/index.js';
import { skippedTotal } from './broadcastFormat.js';
import styles from './StatChips.module.css';

interface Chip {
  label: string;
  value: number;
  tone?: 'success' | 'danger' | 'progress';
}

export function StatChips({ stats }: { stats: BroadcastStats }): React.JSX.Element {
  const retrying = stats.retry_pending ?? 0;
  const chips: Chip[] = [
    { label: 'Recipients', value: stats.audience },
    { label: 'Delivered', value: stats.delivered, tone: 'success' },
    { label: 'Sent', value: stats.sent },
    { label: 'Sending', value: stats.sending ?? 0 },
    { label: 'Queued', value: stats.queued },
    { label: 'Failed', value: Math.max(0, stats.failed - retrying), tone: 'danger' },
    { label: 'Retrying', value: retrying, tone: 'progress' },
    { label: 'Not confirmed', value: stats.unconfirmed ?? 0, tone: 'danger' },
    { label: 'Skipped', value: skippedTotal(stats) },
  ];
  return (
    <dl className={styles.chips} aria-label="Delivery stats">
      {chips.map((chip) => (
        <div
          key={chip.label}
          className={`${styles.chip} ${chip.tone === 'success' ? styles.success : ''} ${
            chip.tone === 'danger' && chip.value > 0 ? styles.danger : ''
          } ${chip.tone === 'progress' && chip.value > 0 ? styles.progress : ''}`.trim()}
        >
          <dt className={styles.chipLabel}>{chip.label}</dt>
          <dd className={styles.chipValue}>{chip.value}</dd>
        </div>
      ))}
    </dl>
  );
}
