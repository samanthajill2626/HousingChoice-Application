// ErrorTrace - the correlation trace behind ONE error row (design S5/S6). Given
// the pivot id the row chose (requestId > pollRunId > correlationId) and the
// row's own timestamp, it loads the merged, ascending timeline the server built
// from two bracketing queries and renders it as an ordered list: when, which log
// group the line came from, and the line's message.
//
// The anchor - the very failure the operator clicked - is found by REF (the
// log-event pointer, exact) and marked by the TEXT "this failure" as well as by
// styling, because this panel never conveys status by colour alone. The
// timestamp only bounds the query. The per-side truncation notices are HERE; they have
// no other surface. DEGRADED (no AWS on this stack) and EMPTY (queried fine,
// nothing correlated) must read differently: an empty trace that looks like a
// blank panel is the failure mode this view exists to avoid.
import { useEffect } from 'react';
import { useErrorTrace } from './useSystemStatus.js';
import { Spinner } from '../../ui/index.js';
import type { SystemTraceLine } from '../../api/index.js';
import styles from './SystemStatusSection.module.css';

interface ErrorTraceProps {
  kind: 'correlationId' | 'requestId' | 'pollRunId';
  id: string;
  /** The anchor row's timestamp - bounds the QUERY (it no longer marks the line). */
  at: string;
  /**
   * The anchor row's `ref` - which line IS the failure. Compared exactly,
   * because a millisecond timestamp is not unique: an app line and a worker
   * line under one requestId is the normal interleaved case this view exists to
   * show, and marking both "this failure" would be a lie about which one is.
   */
  anchorRef: string;
}

export function ErrorTrace({ kind, id, at, anchorRef }: ErrorTraceProps): React.JSX.Element {
  const { status, result, load } = useErrorTrace();
  useEffect(() => {
    load(kind, id, at);
  }, [load, kind, id, at]);

  if (status === 'loading')
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  if (status === 'error') return <p role="alert">Couldn&apos;t load the trace.</p>;
  if (result === null) return <p className={styles.empty}>No trace loaded.</p>;
  // DEGRADED and EMPTY must read differently. An empty trace that looks like a
  // blank panel is the failure mode this view exists to avoid.
  if (!result.available) return <p className={styles.degraded}>Available in deployed environments.</p>;
  if (result.lines.length === 0) return <p className={styles.empty}>No lines found around this event.</p>;

  return (
    <div>
      {result.truncatedBefore ? (
        <p className={styles.truncated}>Earlier lines were cut off (limit reached).</p>
      ) : null}
      <ol className={styles.traceList}>
        {result.lines.map((l: SystemTraceLine) => (
          <li key={l.ref} className={l.ref === anchorRef ? styles.traceAnchor : styles.traceLine}>
            <span className={styles.errorWhen}>{l.timestamp}</span>
            <span className={styles.errorChip}>{l.source}</span>
            <span>{l.message}</span>
            {l.ref === anchorRef ? <span className={styles.errorChip}>this failure</span> : null}
          </li>
        ))}
      </ol>
      {result.truncatedAfter ? (
        <p className={styles.truncated}>Later lines were cut off (limit reached).</p>
      ) : null}
    </div>
  );
}
