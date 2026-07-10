// BroadcastsList — the /broadcasts nav surface. A status-filtered, paginated
// list of broadcasts: each row shows the status pill, the audience summary, the
// delivered/total rollup, and the created date. A draft row opens the composer's
// review/send step (the draft already has an id → preview it) and carries a
// Delete action (confirm modal → DELETE — the list is the only reliable place to
// kill a draft, since the composer can't rehydrate one yet); a sending/sent/
// failed row opens its live Results view. A "New broadcast" button starts a fresh
// composer. Accessibility-first (real headings, a labeled filter, link rows).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Spinner } from '../../ui/index.js';
import { ApiError, deleteBroadcast, type BroadcastSummary } from '../../api/index.js';
import { Modal } from '../contact/Modal.js';
import { BroadcastStatusPill } from './BroadcastStatusPill.js';
import { audienceSummary, formatBroadcastDate, sendReachLabel } from './broadcastFormat.js';
import { useBroadcastsList, type BroadcastsFilter } from './useBroadcastsList.js';
import styles from './BroadcastsList.module.css';

/** The filter tabs (All + each lifecycle status). */
const FILTERS: ReadonlyArray<{ filter: BroadcastsFilter; label: string }> = [
  { filter: 'all', label: 'All' },
  { filter: 'draft', label: 'Drafts' },
  { filter: 'sending', label: 'Sending' },
  { filter: 'sent', label: 'Sent' },
  { filter: 'failed', label: 'Failed' },
];

/** A draft row routes to the composer (to finish review/send); every other
 *  status routes to the live Results view. */
function rowHref(row: BroadcastSummary): string {
  if (row.status === 'draft') return `/broadcasts/new?draftId=${encodeURIComponent(row.broadcastId)}`;
  return `/broadcasts/${encodeURIComponent(row.broadcastId)}`;
}

/** The row's audience line: a seeds-only send (no filter to summarize) shows
 *  its reach count instead of the (empty) filter summary. */
function rowAudienceLabel(row: BroadcastSummary): string {
  return row.audience_mode === 'seeds_only'
    ? sendReachLabel(row.stats.audience)
    : audienceSummary(row.audience_filter);
}

export function BroadcastsList(): React.JSX.Element {
  const [filter, setFilter] = useState<BroadcastsFilter>('all');
  const navigate = useNavigate();
  const list = useBroadcastsList(filter);

  // Draft delete — the row being confirmed (modal open while non-null).
  const [confirmDelete, setConfirmDelete] = useState<BroadcastSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function closeConfirm(): void {
    if (deleteBusy) return;
    setConfirmDelete(null);
    setDeleteError(null);
  }

  async function onConfirmDelete(): Promise<void> {
    if (confirmDelete === null || deleteBusy) return;
    const id = confirmDelete.broadcastId;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteBroadcast(id);
      list.removeRow(id);
      setConfirmDelete(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Raced a send — it's no longer a draft. Say so, and refresh the list
        // behind the modal so the row shows its real status.
        setDeleteError('This send already started, so it can no longer be deleted.');
        list.retry();
      } else if (err instanceof ApiError && err.status === 404) {
        // Already gone (deleted elsewhere) — dropping the row IS the outcome.
        list.removeRow(id);
        setConfirmDelete(null);
      } else {
        setDeleteError("Couldn't delete the draft — please try again.");
      }
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Matching</h1>
          <p className={styles.sub}>Share a property with a curated set of tenants.</p>
        </div>
        <button
          type="button"
          className={styles.newBtn}
          onClick={() => navigate('/broadcasts/new')}
        >
          Send a property
        </button>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Send status filter">
        {FILTERS.map((tab) => (
          <button
            key={tab.filter}
            type="button"
            role="tab"
            aria-selected={filter === tab.filter}
            className={`${styles.tab} ${filter === tab.filter ? styles.tabActive : ''}`}
            onClick={() => setFilter(tab.filter)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {list.status === 'loading' ? <Spinner center /> : null}

      {list.status === 'error' ? (
        <div className={styles.error} role="alert">
          <p>We couldn&apos;t load your sends.</p>
          <button type="button" className={styles.retry} onClick={() => list.retry()}>
            Retry
          </button>
        </div>
      ) : null}

      {list.status === 'ready' && list.rows.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No sends yet</p>
          <p className={styles.emptyBody}>
            Start one from a property&apos;s “Send to tenants”, from a tenant&apos;s “Properties
            sent”, or with “Send a property”.
          </p>
        </div>
      ) : null}

      {list.status === 'ready' && list.rows.length > 0 ? (
        <>
          <ul className={styles.rows} aria-label="Property sends">
            {list.rows.map((row) => (
              <li key={row.broadcastId} className={styles.rowItem}>
                <Link to={rowHref(row)} className={styles.row}>
                  <BroadcastStatusPill status={row.status} />
                  <span className={styles.audience}>{rowAudienceLabel(row)}</span>
                  {/* Meta (delivered + date) grouped so on a tight content pane it
                   *  wraps to its own line below the audience instead of squeezing
                   *  it into a narrow wrapped column (container query in CSS). */}
                  <span className={styles.meta}>
                    <span className={styles.delivered}>
                      {row.stats.delivered}/{row.stats.audience} delivered
                    </span>
                    <span className={styles.date}>{formatBroadcastDate(row.created_at)}</span>
                  </span>
                </Link>
                {row.status === 'draft' ? (
                  <button
                    type="button"
                    className={styles.deleteBtn}
                    aria-label={`Delete draft: ${rowAudienceLabel(row)}`}
                    onClick={() => {
                      setDeleteError(null);
                      setConfirmDelete(row);
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {list.hasMore ? (
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => list.loadMore()}
              disabled={list.loadingMore}
            >
              {list.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </>
      ) : null}

      {confirmDelete !== null ? (
        <Modal
          title="Delete draft?"
          onClose={closeConfirm}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={closeConfirm}
                disabled={deleteBusy}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                type="button"
                onClick={() => void onConfirmDelete()}
                disabled={deleteBusy}
              >
                {deleteBusy ? 'Deleting…' : 'Delete draft'}
              </Button>
            </>
          }
        >
          <p className={styles.confirmBody}>
            This deletes the unsent draft ({rowAudienceLabel(confirmDelete)},{' '}
            {formatBroadcastDate(confirmDelete.created_at)}). Nothing has been sent, and the
            draft&apos;s message can&apos;t be recovered.
          </p>
          {deleteError !== null ? (
            <p className={styles.confirmError} role="alert">
              {deleteError}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
