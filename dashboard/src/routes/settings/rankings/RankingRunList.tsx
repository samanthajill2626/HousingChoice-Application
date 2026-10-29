// RankingRunList - the ranking run log (WP1 B2a spec D11, D18): one row per
// model call, newest first, cursor paged, filtered by date range and by
// anchor (the anchor filter is set from the Rank panel). An expired pointer
// reads as such, as the AI run log does.
import type { RankingRunListRow } from '../../../api/index.js';
import { Spinner } from '../../../ui/index.js';
import { directionLabel, formatCost } from './rankingFormat.js';
import styles from './RankingsSection.module.css';

export interface RankingRunListProps {
  rows: RankingRunListRow[];
  status: 'loading' | 'ready' | 'error';
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  /** A page said a run could not be read (plan PR34). */
  incomplete: boolean;
  from: string;
  to: string;
  anchorFilter: { label: string } | undefined;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onClearAnchor: () => void;
  onOpen: (runId: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onRefresh: () => void;
}

export function RankingRunList({
  rows,
  status,
  hasMore,
  loadingMore,
  loadMoreFailed,
  incomplete,
  from,
  to,
  anchorFilter,
  onFromChange,
  onToChange,
  onClearAnchor,
  onOpen,
  onLoadMore,
  onRetry,
  onRefresh,
}: RankingRunListProps): React.JSX.Element {
  return (
    <section className={styles.listPane} aria-label="Ranking run list">
      <div className={styles.listHeader}>
        <h3 className={styles.panelHeading}>Runs</h3>
        <button type="button" className={styles.linkButton} onClick={onRefresh}>
          Refresh
        </button>
      </div>
      <div className={styles.filters}>
        <label className={styles.dateLabel}>
          From
          <input className={styles.dateInput} type="date" value={from} onChange={(event) => onFromChange(event.target.value)} />
        </label>
        <label className={styles.dateLabel}>
          To
          <input className={styles.dateInput} type="date" value={to} onChange={(event) => onToChange(event.target.value)} />
        </label>
        {anchorFilter !== undefined ? (
          <p className={styles.filterChip}>
            Anchor: {anchorFilter.label}{' '}
            <button type="button" className={styles.linkButton} onClick={onClearAnchor}>
              All anchors
            </button>
          </p>
        ) : null}
      </div>
      {status === 'loading' ? <Spinner center label="Loading runs" /> : null}
      {status === 'error' ? (
        <div className={styles.error} role="alert">
          <p>We could not load the ranking runs.</p>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
      {status === 'ready' && incomplete ? <p className={styles.note}>Some runs could not be read; this list may be missing some.</p> : null}
      {status === 'ready' && rows.length === 0 ? <p className={styles.empty}>No ranking runs match these filters.</p> : null}
      {status === 'ready' && rows.length > 0 ? (
        <>
          {/* Explicit role: `list-style: none` makes WebKit drop the list
              role this aria-label (the e2e anchor) rides on. */}
          <ul className={styles.rows} role="list" aria-label="Ranking runs">
            {rows.map((row) =>
              row.expired ? (
                <li key={row.runId} className={styles.expired}>
                  Expired run {row.runId}
                </li>
              ) : (
                <li key={row.runId}>
                  <button type="button" className={styles.runRow} onClick={() => onOpen(row.runId)}>
                    <span className={styles.runTime}>{new Date(row.startedAt).toLocaleString()}</span>
                    <span>{row.anchorDisplay}</span>
                    <span>
                      {directionLabel(row.direction)}, batch {row.batchIndex + 1}
                    </span>
                    <span>{row.model}</span>
                    <span>{row.candidateCount} candidates</span>
                    <span>{formatCost(row.costUsd)}</span>
                    <span>{row.latencyMs} ms</span>
                    <span className={styles.outcome}>{row.outcome}</span>
                  </button>
                </li>
              ),
            )}
          </ul>
          {loadMoreFailed ? (
            <div className={styles.error} role="alert">
              <p>We could not load more runs.</p>
            </div>
          ) : null}
          {hasMore ? (
            <button type="button" className={styles.loadMore} disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? 'Loading...' : 'Load more'}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
