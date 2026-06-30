// BroadcastsList — the /broadcasts nav surface. A status-filtered, paginated
// list of broadcasts: each row shows the status pill, the audience summary, the
// delivered/total rollup, and the created date. A draft row opens the composer's
// review/send step (the draft already has an id → preview it); a sending/sent/
// failed row opens its live Results view. A "New broadcast" button starts a fresh
// composer. Accessibility-first (real headings, a labeled filter, link rows).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Spinner } from '../../ui/index.js';
import type { BroadcastSummary } from '../../api/index.js';
import { BroadcastStatusPill } from './BroadcastStatusPill.js';
import { audienceSummary, formatBroadcastDate } from './broadcastFormat.js';
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

export function BroadcastsList(): React.JSX.Element {
  const [filter, setFilter] = useState<BroadcastsFilter>('all');
  const navigate = useNavigate();
  const list = useBroadcastsList(filter);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Broadcasts</h1>
          <p className={styles.sub}>Share a property with a curated set of tenants.</p>
        </div>
        <button
          type="button"
          className={styles.newBtn}
          onClick={() => navigate('/broadcasts/new')}
        >
          New broadcast
        </button>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Broadcast status filter">
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
          <p>We couldn&apos;t load your broadcasts.</p>
          <button type="button" className={styles.retry} onClick={() => list.retry()}>
            Retry
          </button>
        </div>
      ) : null}

      {list.status === 'ready' && list.rows.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No broadcasts yet</p>
          <p className={styles.emptyBody}>
            Start one from a property&apos;s “Broadcast to tenants”, or with “New broadcast”.
          </p>
        </div>
      ) : null}

      {list.status === 'ready' && list.rows.length > 0 ? (
        <>
          <ul className={styles.rows} aria-label="Broadcasts">
            {list.rows.map((row) => (
              <li key={row.broadcastId} className={styles.rowItem}>
                <Link to={rowHref(row)} className={styles.row}>
                  <BroadcastStatusPill status={row.status} />
                  <span className={styles.audience}>{audienceSummary(row.audience_filter)}</span>
                  <span className={styles.delivered}>
                    {row.stats.delivered}/{row.stats.audience} delivered
                  </span>
                  <span className={styles.date}>{formatBroadcastDate(row.created_at)}</span>
                </Link>
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
    </div>
  );
}
