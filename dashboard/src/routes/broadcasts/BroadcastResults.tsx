// BroadcastResults — the live results view for one broadcast (route
// /broadcasts/:broadcastId). A header (audience summary + status pill + created
// date + the creator), the StatChips rollup, and the per-recipient rows with a
// DeliveryBadge. Live via onBroadcastUpdated (the hook overlays status+stats and
// refetches for per-recipient detail); a manual Refresh button too.
//
// Each recipient row links to the tenant's contact/comms page (/contacts/:id);
// a phone-only recipient (no contactId) renders WITHOUT a link (graceful). A
// FAILED row carries the error class AND, when the conversation would offer
// Retry, an explicit "open conversation to retry" affordance - disposition is
// conversation-only (the tenant's 1:1 thread has the existing Retry); Results
// adds no inline retry/dismiss of its own.
//
// share-sent-outcome D3/D4: a failed 30003 row carries its newest attempt's
// promise facts, judged against a SERVER-clock snapshot re-taken on a 60 s
// visibility-gated ticker (the conversation page's precedent, Timeline.tsx).
// ONLY on a tick the page also recounts retry_pending from its own rows, so
// the pill and the chips move with the row when a promise lapses with no event.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Spinner } from '../../ui/index.js';
import { formatPhone } from '../contact/format.js';
import type { BroadcastRecipientView } from '../../api/index.js';
import { serverNowMs } from '../../api/serverClock.js';
import { BroadcastStatusPill } from './BroadcastStatusPill.js';
import { DeliveryBadge } from './DeliveryBadge.js';
import { StatChips } from './StatChips.js';
import {
  audienceSummary,
  formatBroadcastDate,
  presentShareLabel,
  sendReachLabel,
  toRecipientViews,
} from './broadcastFormat.js';
import { useBroadcastResults } from './useBroadcastResults.js';
import { SEND_UNCONFIRMED_CODE } from '../contact/deliveryStatus.js';
import { isRetryPromiseLive, RETRY_OUTCOME_UNCONFIRMED } from '../contact/retryPromise.js';
import styles from './BroadcastResults.module.css';

/** The ticker's period: it re-judges every promise on screen (and recounts
 *  retry_pending) once a minute. It fetches NOTHING - the cost is one render. */
const RESULTS_TICK_MS = 60 * 1000;

/** share-sent-outcome D4 (deviation 14): the rows the ticker counts as pending
 *  a retry - the ones the route marked pending whose promise is still live, or
 *  that carry no due instant (their row read failed: pending on the safe side). */
function pendingRetryCount(rows: readonly BroadcastRecipientView[], nowMs: number): number {
  return rows.filter(
    (r) => r.retryPending === true && (r.retryDueAt === undefined || isRetryPromiseLive(r.retryDueAt, nowMs)),
  ).length;
}

/** A recipient row's identity block: the tenant NAME (primary) + formatted phone
 *  (secondary), mirroring the composer's review rows. When no name resolved the
 *  formatted phone is the primary label (no duplicate secondary line); with
 *  neither a name nor a phone (a deleted contact) the neutral "Tenant" fallback
 *  stands in - never leak a raw id / `phone#...` key into the UI. */
function recipientIdentity(row: BroadcastRecipientView): { primary: string; secondary?: string } {
  const formattedPhone = row.phone !== undefined ? formatPhone(row.phone) : '';
  if (row.name !== undefined && row.name.length > 0) {
    return formattedPhone.length > 0
      ? { primary: row.name, secondary: formattedPhone }
      : { primary: row.name };
  }
  if (formattedPhone.length > 0) return { primary: formattedPhone };
  return { primary: 'Tenant' };
}

/** One recipient row. A contactId row is a link to the tenant's comms; a failed
 *  row the conversation would offer Retry on appends the "open conversation to
 *  retry" affordance (same link target - the contact page hosts the in-thread
 *  Retry). A phone-only row renders link-less. `serverNow` is the page's
 *  SERVER-clock snapshot every promise on the row is judged against. */
function RecipientRow({
  row,
  serverNow,
}: {
  row: BroadcastRecipientView;
  serverNow: number;
}): React.JSX.Element {
  const failed = row.status === 'failed';
  // share-sent-outcome D3: the hint appears only when the conversation would
  // offer Retry for this recipient - the newest attempt has a MESSAGE ROW (a
  // synchronous rejection, a fence, a cap or an enqueue failure has nothing to
  // retry), it failed with NO live promise (a scheduled retry reads "will
  // retry" instead), and it is neither Not confirmed (SOR D22: the text may
  // have gone out, and a resend is the double text send-outcome-reconcile
  // exists to prevent) nor a retry chain that ended unresolved. The row keeps
  // its failed styling and sort, and stays a link to the contact.
  const showRetryHint =
    failed &&
    row.errorCode !== SEND_UNCONFIRMED_CODE &&
    row.retryOutcome !== RETRY_OUTCOME_UNCONFIRMED &&
    row.contactId !== undefined &&
    (row.tsMsgId !== undefined || row.latestAttempt !== undefined) &&
    !isRetryPromiseLive(row.retryDueAt, serverNow);
  const { primary, secondary } = recipientIdentity(row);
  const inner = (
    <>
      <span className={styles.recipientIdentity}>
        <span className={styles.recipientName}>{primary}</span>
        {secondary !== undefined ? (
          <span className={styles.recipientPhone}>{secondary}</span>
        ) : null}
      </span>
      <DeliveryBadge
        status={row.status}
        {...(row.carrierSentAt !== undefined && { carrierSentAt: row.carrierSentAt })}
        {...(row.errorCode !== undefined && { errorCode: row.errorCode })}
        {...(row.retryDueAt !== undefined && { retryDueAt: row.retryDueAt })}
        {...(row.retryOutcome !== undefined && { retryOutcome: row.retryOutcome })}
        serverNowMs={serverNow}
      />
      {showRetryHint ? (
        // NOT aria-hidden: the hint contributes to the link's accessible name so
        // a role+name lookup for "open conversation to retry" resolves the link.
        <span className={styles.retryHint}>open conversation to retry</span>
      ) : null}
    </>
  );

  if (row.contactId !== undefined) {
    return (
      <li className={`${styles.recipient} ${failed ? styles.recipientFailed : ''}`.trim()}>
        {/* No aria-label override on a failed row - the inner text (incl. the
            "open conversation to retry" hint) IS the accessible name, so the
            single canonical name is name-resolvable. */}
        <Link to={`/contacts/${encodeURIComponent(row.contactId)}`} className={styles.recipientLink}>
          {inner}
        </Link>
      </li>
    );
  }
  // Phone-only recipient: no contact page to link to → render the row flat.
  return (
    <li className={`${styles.recipient} ${styles.recipientFlat} ${failed ? styles.recipientFailed : ''}`.trim()}>
      {inner}
    </li>
  );
}

export function BroadcastResults(): React.JSX.Element {
  const { broadcastId } = useParams<{ broadcastId: string }>();
  const { status, results, notFound, refresh, retry, refreshing, liveStats, recountRetryPending } =
    useBroadcastResults(broadcastId ?? '');

  const recipients = useMemo(
    () => (results === null ? [] : toRecipientViews(results.recipients)),
    [results],
  );
  // share-sent-outcome D3/D4: the SERVER-clock snapshot every promise on the
  // page is judged against, re-taken on each tick (never the browser clock:
  // the server wrote the stamp, and the thread's Retry guard reads its clock).
  const [serverNow, setServerNow] = useState(() => serverNowMs());
  // The interval reads the LATEST rows without re-arming on every refetch.
  const rowsRef = useRef(recipients);
  useEffect(() => {
    rowsRef.current = recipients;
  }, [recipients]);
  useEffect(() => {
    const tick = (): void => {
      const now = serverNowMs();
      setServerNow(now);
      // ONLY here (never on an SSE overlay): the recount the pill and the
      // chips read until the next payload replaces it (useBroadcastResults).
      recountRetryPending(pendingRetryCount(rowsRef.current, now));
    };
    // VISIBILITY-GATED, as the conversation page's ticker is: re-judging a
    // hidden tab only updates pixels nobody is looking at. The focus listener
    // makes coming back to the tab immediate. It fetches NOTHING.
    const onFocus = (): void => {
      tick();
    };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') tick();
    }, RESULTS_TICK_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [recountRetryPending]);

  if (status === 'loading') return <Spinner center />;

  if (status === 'error') {
    return (
      <div className={styles.error} role="alert">
        {notFound ? (
          <>
            <p>This send doesn&apos;t exist (it may have been deleted).</p>
            <Link to="/broadcasts" className={styles.backLink}>
              Back to Matching
            </Link>
          </>
        ) : (
          <>
            <p>We couldn&apos;t load this send.</p>
            <button type="button" className={styles.retry} onClick={retry}>
              Retry
            </button>
          </>
        )}
      </div>
    );
  }

  if (results === null || liveStats === null) return <Spinner center />;

  const reachLabel =
    results.audience_mode === 'seeds_only'
      ? sendReachLabel(results.stats.audience)
      : audienceSummary(results.audience_filter);
  // share-sent-outcome D4: the stored last_error explains a share that reached
  // nobody for its own reason - it shows under "Not sent" only.
  const showLastError =
    results.last_error !== undefined && presentShareLabel(results.status, liveStats).label === 'Not sent';

  return (
    <div className={styles.page}>
      <Link to="/broadcasts" className={styles.backLink}>
        ← Matching
      </Link>

      <header className={styles.header}>
        <div className={styles.headTop}>
          <h1 className={styles.title}>{reachLabel}</h1>
          <BroadcastStatusPill status={results.status} stats={liveStats} />
        </div>
        <p className={styles.meta}>Started {formatBroadcastDate(results.created_at)}</p>
        {showLastError ? (
          <p className={styles.lastError} role="alert">
            {results.last_error}
          </p>
        ) : null}
        <button
          type="button"
          className={styles.refresh}
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <StatChips stats={liveStats} />

      <h2 id="recipients-heading" className={styles.recipientsHeading}>
        Recipients
      </h2>
      {recipients.length === 0 ? (
        <p className={styles.emptyBody}>No recipients recorded yet.</p>
      ) : (
        // Named by the heading (aria-labelledby) — no duplicate aria-label.
        <ul className={styles.recipients} aria-labelledby="recipients-heading">
          {recipients.map((row) => (
            <RecipientRow key={row.contactKey} row={row} serverNow={serverNow} />
          ))}
        </ul>
      )}
    </div>
  );
}
