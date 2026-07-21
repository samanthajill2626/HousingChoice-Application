// RecentErrors — recent error events (doc §6). A labeled window selector (1h /
// 24h / 7d, default 24h) + a manual ↻ button drive a CloudWatch Logs read; each
// event renders its timestamp, level, short message, and correlationId — the
// PII-SAFE projection ONLY (never bodies/numbers/names/emails). On the local/
// hermetic stack (no AWS) the server returns { available: false } → the degraded
// notice "Available in deployed environments." An empty result is a friendly
// "no recent errors" state.
//
// A11y: a real heading, a <label>ed <select> for the window, an accessibly-named
// refresh button, role="alert" only on a true load error.
import { useSystemErrors, type ErrorWindow } from './useSystemStatus.js';
import { Button, Spinner } from '../../ui/index.js';
import type { SystemErrorEvent } from '../../api/index.js';
import styles from './SystemStatusSection.module.css';

const WINDOW_OPTIONS: { value: ErrorWindow; label: string }[] = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
];

/** Format an ISO timestamp for display. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/** pino numeric level → a short human label (40 warn, 50 error, 60 fatal). */
function levelLabel(level: number): string {
  if (level >= 60) return 'fatal';
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  return String(level);
}

function ErrorRow({ event }: { event: SystemErrorEvent }): React.JSX.Element {
  const isWarn = event.level < 50;
  const code = event.errorCode;
  return (
    <li className={styles.errorRow}>
      <div className={styles.errorMeta}>
        <span className={styles.errorWhen}>{formatWhen(event.timestamp)}</span>
        <span className={`${styles.errorLevel} ${isWarn ? (styles.errorLevelWarn ?? '') : ''}`}>
          {levelLabel(event.level)}
        </span>
        {code !== null && code !== undefined && code.length > 0 ? (
          <span className={styles.errorCode}>error {code}</span>
        ) : null}
      </div>
      <p className={styles.errorMessage}>{event.message}</p>
      {event.correlationId !== null ? (
        <span className={styles.errorCorrelation}>id: {event.correlationId}</span>
      ) : null}
    </li>
  );
}

export function RecentErrors(): React.JSX.Element {
  const { status, result, refreshing, window, setWindow, includeWarnings, setIncludeWarnings, refresh } =
    useSystemErrors();

  const available = result?.available === true;
  const events = result?.events ?? [];

  return (
    <div className={styles.block} aria-labelledby="system-errors-heading">
      <div className={styles.blockHead}>
        <h3 id="system-errors-heading" className={styles.blockHeading}>
          Recent errors
        </h3>
        <div className={styles.errorControls}>
          <label className={styles.windowLabel} htmlFor="system-errors-window">
            Window
          </label>
          <select
            id="system-errors-window"
            className={styles.windowSelect}
            value={window}
            onChange={(e) => setWindow(e.target.value as ErrorWindow)}
          >
            {WINDOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <label className={styles.warnToggle} htmlFor="system-errors-warnings">
            <input
              id="system-errors-warnings"
              type="checkbox"
              checked={includeWarnings}
              onChange={(e) => setIncludeWarnings(e.target.checked)}
            />
            Include warnings
          </label>
          <Button
            variant="secondary"
            size="sm"
            onClick={refresh}
            disabled={refreshing || status === 'loading'}
            aria-label="Refresh recent errors"
          >
            {refreshing ? 'Refreshing…' : '↻ Refresh'}
          </Button>
        </div>
      </div>

      {status === 'loading' ? (
        <div className={styles.center}>
          <Spinner />
        </div>
      ) : status === 'error' ? (
        <div role="alert" className={styles.errorBlock}>
          <p className={styles.errorText}>Couldn't load recent errors.</p>
          <Button variant="secondary" size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : !available ? (
        <p className={styles.degraded}>Available in deployed environments.</p>
      ) : events.length === 0 ? (
        <p className={styles.empty}>No recent errors in this window.</p>
      ) : (
        <ul className={styles.errorList}>
          {events.map((ev) => (
            <ErrorRow key={`${ev.timestamp}-${ev.correlationId ?? ''}-${ev.message}`} event={ev} />
          ))}
        </ul>
      )}
    </div>
  );
}
