// BroadcastResults — the live results view for one broadcast (route
// /broadcasts/:broadcastId). A header (audience summary + status pill + created
// date + the creator), the StatChips rollup, and the per-recipient rows with a
// DeliveryBadge. Live via onBroadcastUpdated (the hook overlays status+stats and
// refetches for per-recipient detail); a manual Refresh button too.
//
// Each recipient row links to the tenant's contact/comms page (/contacts/:id);
// a phone-only recipient (no contactId) renders WITHOUT a link (graceful). A
// FAILED row carries the error class AND an explicit "↗ open conversation to
// retry" affordance — disposition is conversation-only (the tenant's 1:1 thread
// has the existing Retry); Results adds no inline retry/dismiss of its own.
import { Link, useParams } from 'react-router-dom';
import { Spinner } from '../../ui/index.js';
import { formatPhone } from '../contact/format.js';
import type { BroadcastRecipientView } from '../../api/index.js';
import { BroadcastStatusPill } from './BroadcastStatusPill.js';
import { DeliveryBadge } from './DeliveryBadge.js';
import { StatChips } from './StatChips.js';
import {
  audienceSummary,
  formatBroadcastDate,
  toRecipientViews,
} from './broadcastFormat.js';
import { useBroadcastResults } from './useBroadcastResults.js';
import styles from './BroadcastResults.module.css';

/** A recipient's display name: the formatted phone for a phone-only row, else a
 *  neutral "Tenant" (names aren't on the results map — never leak a raw id /
 *  `phone#…` key into the UI). */
function recipientLabel(row: BroadcastRecipientView): string {
  if (row.phone !== undefined) {
    const formatted = formatPhone(row.phone);
    return formatted.length > 0 ? formatted : 'Tenant';
  }
  return 'Tenant';
}

/** One recipient row. A contactId row is a link to the tenant's comms; a failed
 *  row appends the "↗ open conversation to retry" affordance (same link target —
 *  the contact page hosts the in-thread Retry). A phone-only row renders link-less. */
function RecipientRow({ row }: { row: BroadcastRecipientView }): React.JSX.Element {
  const failed = row.status === 'failed';
  const inner = (
    <>
      <span className={styles.recipientName}>{recipientLabel(row)}</span>
      <DeliveryBadge status={row.status} {...(row.errorCode !== undefined && { errorCode: row.errorCode })} />
      {failed && row.contactId !== undefined ? (
        // NOT aria-hidden: the hint contributes to the link's accessible name so
        // a role+name lookup for "open conversation to retry" resolves the link.
        <span className={styles.retryHint}>↗ open conversation to retry</span>
      ) : null}
    </>
  );

  if (row.contactId !== undefined) {
    return (
      <li className={`${styles.recipient} ${failed ? styles.recipientFailed : ''}`.trim()}>
        {/* No aria-label override on a failed row — the inner text (incl. the
            "↗ open conversation to retry" hint) IS the accessible name, so the
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
  const { status, results, notFound, refresh, retry, refreshing } = useBroadcastResults(
    broadcastId ?? '',
  );

  if (status === 'loading') return <Spinner center />;

  if (status === 'error') {
    return (
      <div className={styles.error} role="alert">
        {notFound ? (
          <>
            <p>This broadcast doesn&apos;t exist (it may have been deleted).</p>
            <Link to="/broadcasts" className={styles.backLink}>
              Back to broadcasts
            </Link>
          </>
        ) : (
          <>
            <p>We couldn&apos;t load this broadcast.</p>
            <button type="button" className={styles.retry} onClick={retry}>
              Retry
            </button>
          </>
        )}
      </div>
    );
  }

  if (results === null) return <Spinner center />;

  const recipients = toRecipientViews(results.recipients);

  return (
    <div className={styles.page}>
      <Link to="/broadcasts" className={styles.backLink}>
        ← Broadcasts
      </Link>

      <header className={styles.header}>
        <div className={styles.headTop}>
          <h1 className={styles.title}>{audienceSummary(results.audience_filter)}</h1>
          <BroadcastStatusPill status={results.status} />
        </div>
        <p className={styles.meta}>Started {formatBroadcastDate(results.created_at)}</p>
        {results.last_error !== undefined ? (
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

      <StatChips stats={results.stats} />

      <h2 id="recipients-heading" className={styles.recipientsHeading}>
        Recipients
      </h2>
      {recipients.length === 0 ? (
        <p className={styles.emptyBody}>No recipients recorded yet.</p>
      ) : (
        // Named by the heading (aria-labelledby) — no duplicate aria-label.
        <ul className={styles.recipients} aria-labelledby="recipients-heading">
          {recipients.map((row) => (
            <RecipientRow key={row.contactKey} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
