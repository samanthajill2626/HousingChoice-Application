// AlarmGrid — the CloudWatch alarm list (doc §6). Alarms come ALARM-first from
// the server; each row is name + a state badge + the last-transition time. Auto-
// refreshes every 60s WHILE THE TAB IS VISIBLE (paused when hidden) plus a manual
// ↻ button. On the local/hermetic stack (no AWS) the server returns
// { available: false } → the degraded notice "Available in deployed environments."
// (degraded, not an error).
//
// A11y: a real heading, an accessibly-named refresh button, the alarm state as
// TEXT in the badge (colour is supplementary), role="alert" only on a true
// load error.
import { useSystemAlarms } from './useSystemStatus.js';
import { Button, Spinner } from '../../ui/index.js';
import type { SystemAlarmState } from '../../api/index.js';
import styles from './SystemStatusSection.module.css';

/** alarm state → badge tone class (the state TEXT is always shown alongside). */
const STATE_CLASS: Record<SystemAlarmState, string> = {
  OK: styles.alarmOk ?? '',
  ALARM: styles.alarmFiring ?? '',
  INSUFFICIENT_DATA: styles.alarmInsufficient ?? '',
};

/** Human label for an alarm state. */
const STATE_LABEL: Record<SystemAlarmState, string> = {
  OK: 'OK',
  ALARM: 'In alarm',
  INSUFFICIENT_DATA: 'No data',
};

/** Format an ISO timestamp for display; '' (absent) → an em dash. */
function formatWhen(iso: string): string {
  if (iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export function AlarmGrid(): React.JSX.Element {
  const { status, result, refreshing, refresh } = useSystemAlarms();

  const available = result?.available === true;
  const alarms = result?.alarms ?? [];

  return (
    <div className={styles.block} aria-labelledby="system-alarms-heading">
      <div className={styles.blockHead}>
        <h3 id="system-alarms-heading" className={styles.blockHeading}>
          Alarms
        </h3>
        <Button
          variant="secondary"
          size="sm"
          onClick={refresh}
          disabled={refreshing || status === 'loading'}
          aria-label="Refresh alarms"
        >
          {refreshing ? 'Refreshing…' : '↻ Refresh'}
        </Button>
      </div>

      {status === 'loading' ? (
        <div className={styles.center}>
          <Spinner />
        </div>
      ) : status === 'error' ? (
        <div role="alert" className={styles.errorBlock}>
          <p className={styles.errorText}>Couldn't load alarms.</p>
          <Button variant="secondary" size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : !available ? (
        <p className={styles.degraded}>Available in deployed environments.</p>
      ) : alarms.length === 0 ? (
        <p className={styles.empty}>No alarms configured for this environment.</p>
      ) : (
        <ul className={styles.alarmList}>
          {alarms.map((a) => (
            <li key={a.name} className={styles.alarmRow}>
              <span className={styles.alarmName}>{a.name}</span>
              <span className={`${styles.alarmBadge} ${STATE_CLASS[a.state]}`}>
                {STATE_LABEL[a.state]}
              </span>
              <span className={styles.alarmWhen}>{formatWhen(a.stateUpdatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
