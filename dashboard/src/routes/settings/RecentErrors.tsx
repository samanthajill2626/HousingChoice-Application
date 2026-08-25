// RecentErrors - recent error events (doc section 6). A labeled window selector
// (1h / 24h / 7d, default 24h) plus a manual Refresh button drive a CloudWatch
// Logs read. Each row renders its timestamp, level, source (app / worker / host
// / unknown), the job or event name, the error type and code, the short message
// and the failing error's own message, and correlationId - with any truncation
// marked in TEXT. Two per-row controls go deeper: "Show all" expands the
// COMPLETE log record behind that row (GetLogRecord, via /errors/detail), and
// "Trace" pivots to the surrounding lines sharing the row's requestId,
// pollRunId or correlationId (via /trace).
//
// PII (HUMAN DECISION 2026-08-24): this panel is ADMIN-ONLY, enforced
// SERVER-side, and what it renders MAY include contact PII - phone numbers,
// names, message text - and host operational data. That is deliberate: everyone
// who can reach it already has access to the underlying logs. CREDENTIALS are
// the exclusion, dropped server-side by the detail route's `err` allowlist.
//
// On the local/hermetic stack (no AWS) the server returns { available: false }
// and the panel shows the degraded notice "Available in deployed
// environments." - with NO rows, so neither row control exists there. An empty
// result is a friendly "no recent errors" state.
//
// A11y: a real heading, a <label>ed <select> for the window, an accessibly-named
// refresh button, aria-expanded on the detail toggle, role="alert" only on a
// true load error.
import { useState } from 'react';
import { useErrorDetail, useSystemErrors, type ErrorWindow } from './useSystemStatus.js';
import { ErrorTrace } from './ErrorTrace.js';
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

/**
 * Which id drives the trace link. requestId and pollRunId are the CROSS-HOP
 * ids - they reach back to the request or the poll tick that enqueued the work -
 * so they win over correlationId, which for a job line is just that one job run.
 *
 * OOM rows are non-JSON, so all three are null there. That is not an edge case:
 * those rows are synthesized by the service and are exactly the ones an operator
 * clicks. With no id, render NO control - never `?correlationId=null`.
 */
function tracePivot(
  ev: SystemErrorEvent,
): { kind: 'requestId' | 'pollRunId' | 'correlationId'; id: string } | null {
  if (ev.requestId != null && ev.requestId.length > 0) return { kind: 'requestId', id: ev.requestId };
  if (ev.pollRunId != null && ev.pollRunId.length > 0) return { kind: 'pollRunId', id: ev.pollRunId };
  if (ev.correlationId != null && ev.correlationId.length > 0) {
    return { kind: 'correlationId', id: ev.correlationId };
  }
  return null;
}

/** The four-value source union -> what an operator calls that process. */
const SOURCE_LABEL: Record<SystemErrorEvent['source'], string> = {
  app: 'app',
  worker: 'worker',
  system: 'host',
  unknown: 'unknown',
};

/**
 * The expanded row: the complete log record behind one event, fetched on demand.
 *
 * DEGRADED reads differently depending on WHY. On the local/hermetic stack there
 * is no CloudWatch at all, which is the panel's standing "Available in deployed
 * environments." story; any other reason (a pointer outside this environment's
 * log groups, an expired record) is a real miss and must not claim the operator
 * merely needs a deployed env.
 *
 * `err.stack` is pulled OUT of the key/value list into its own bounded, scrolling
 * container - inline it would push every other field off the screen. The two
 * server-side truncation flags are surfaced here because nothing else renders
 * them; a flag no view shows is dead weight.
 */
function ErrorDetail({ state }: { state: ReturnType<typeof useErrorDetail> }): React.JSX.Element | null {
  const { status, result } = state;
  if (status === 'loading')
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  if (status === 'error') return <p role="alert">Couldn&apos;t load details for this row.</p>;
  if (result === null) return null;
  if (!result.available) {
    return (
      <p className={styles.degraded}>
        {result.reason === 'unavailable_local'
          ? 'Available in deployed environments.'
          : 'Could not load the full record.'}
      </p>
    );
  }

  const record = result.record;
  const stack = record.fields['err.stack'];
  // Sorted so the same record always reads the same way twice.
  const fields = Object.entries(record.fields)
    .filter(([key]) => key !== 'err.stack')
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className={styles.detailBlock}>
      <dl className={styles.detailFields}>
        {fields.map(([key, value]) => (
          <div key={key} className={styles.detailField}>
            <dt className={styles.detailKey}>{key}</dt>
            <dd className={styles.detailValue}>{value}</dd>
          </div>
        ))}
      </dl>
      {stack !== undefined ? <pre className={styles.detailStack}>{stack}</pre> : null}
      {record.rawText !== undefined ? <pre className={styles.detailRaw}>{record.rawText}</pre> : null}
      {record.rawTextTruncated === true ? (
        <p className={styles.truncated}>Raw text was cut off (limit reached).</p>
      ) : null}
      {record.responseTruncated ? (
        <p className={styles.truncated}>Some fields were cut off (response limit reached).</p>
      ) : null}
      <p className={styles.errorCorrelation}>log group: {record.logGroup}</p>
    </div>
  );
}

function ErrorRow({ event }: { event: SystemErrorEvent }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [tracing, setTracing] = useState(false);
  const detail = useErrorDetail();
  const isWarn = event.level < 50;
  const code = event.errorCode;
  const pivot = tracePivot(event);
  const chip = event.jobName ?? event.event;
  return (
    <li className={styles.errorRow}>
      <div className={styles.errorMeta}>
        <span className={styles.errorWhen}>{formatWhen(event.timestamp)}</span>
        <span className={`${styles.errorLevel} ${isWarn ? (styles.errorLevelWarn ?? '') : ''}`}>
          {levelLabel(event.level)}
        </span>
        <span className={styles.errorChip}>{SOURCE_LABEL[event.source]}</span>
        {chip != null && chip.length > 0 ? <span className={styles.errorChip}>{chip}</span> : null}
        {event.errType != null ? <span className={styles.errorChip}>{event.errType}</span> : null}
        {code !== null && code !== undefined && code.length > 0 ? (
          <span className={styles.errorCode}>error {code}</span>
        ) : null}
      </div>
      <p className={styles.errorMessage}>
        {event.message}
        {event.messageTruncated ? <span className={styles.truncated}> (truncated)</span> : null}
      </p>
      {/*
        errMessage is non-null ONLY when it differs from `message`, and that is
        the COMMON case for a job failure: `message` is
        "job failed: relay.warmNumber" while errMessage is the vendor text that
        actually says what went wrong. Rendering it here is the point of the
        feature, and it is also the only place errMessageTruncated is surfaced.
      */}
      {event.errMessage != null ? (
        <p className={styles.errorDetail}>
          {event.errMessage}
          {event.errMessageTruncated ? <span className={styles.truncated}> (truncated)</span> : null}
        </p>
      ) : null}
      {event.correlationId !== null ? (
        <span className={styles.errorCorrelation}>id: {event.correlationId}</span>
      ) : null}
      <div className={styles.errorActions}>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          aria-expanded={open}
          onClick={() => {
            // Fetch on OPEN only - closing is not a read, and re-opening a row
            // whose record is already in hand still refetches deliberately.
            if (!open) detail.load(event.ref);
            setOpen(!open);
          }}
        >
          {open ? 'Hide details' : 'Show all'}
        </Button>
        {pivot !== null ? (
          <Button variant="secondary" size="sm" type="button" onClick={() => setTracing(!tracing)}>
            {tracing ? 'Hide trace' : 'Trace'}
          </Button>
        ) : null}
      </div>
      {open ? <ErrorDetail state={detail} /> : null}
      {tracing && pivot !== null ? (
        <ErrorTrace kind={pivot.kind} id={pivot.id} at={event.timestamp} />
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
            // ref (the log-event pointer) is unique per event and stable across
            // queries, so expander state and fetched detail survive a refresh.
            <ErrorRow key={ev.ref} event={ev} />
          ))}
        </ul>
      )}
    </div>
  );
}
