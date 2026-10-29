// RankingsSection - the admin Rankings tab (WP1 B2a spec D18; charter 11):
// "Rank this anchor", the weekly cost totals, and the run log (list |
// detail). Admin only: the tab is adminOnly and the route sits inside
// AdminRoute (App.tsx); the run log's API is requireRole('admin'). Every
// choice lives in the URL so a reload reads the same page again:
//   rank   the panel's anchor, `<kind>:<id>`    older  `1` = include older tenants
//   from / to  the date range                   anchor the run list's anchor filter
//   run    the opened run
import { useSearchParams } from 'react-router-dom';
import type { RankingRunListRow, RankingRunListRowLive } from '../../../api/index.js';
import { RankAnchorPanel } from './RankAnchorPanel.js';
import { RankingCostTotals, costRangeNote } from './RankingCostTotals.js';
import { RankingRunDetail } from './RankingRunDetail.js';
import { RankingRunList } from './RankingRunList.js';
import { anchorParam, parseAnchorParam } from './rankingFormat.js';
import { useRankingCost, useRankingRun, useRankingRunList } from './useRankingRuns.js';
import styles from './RankingsSection.module.css';

type Param = 'rank' | 'older' | 'from' | 'to' | 'anchor' | 'run';

function isLive(row: RankingRunListRow): row is RankingRunListRowLive {
  return !row.expired;
}

export function RankingsSection(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const rankAnchor = parseAnchorParam(searchParams.get('rank'));
  const includeOlder = searchParams.get('older') === '1';
  const filterAnchor = parseAnchorParam(searchParams.get('anchor'));
  const from = searchParams.get('from') ?? undefined;
  const to = searchParams.get('to') ?? undefined;
  const runId = searchParams.get('run') ?? undefined;

  const list = useRankingRunList({ from, to, anchor: filterAnchor });
  const detail = useRankingRun(runId);
  const cost = useRankingCost({ from, to });

  const setParams = (changes: Partial<Record<Param, string | undefined>>): void => {
    const next = new URLSearchParams(searchParams);
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined || value === '') next.delete(name);
      else next.set(name, value);
    }
    setSearchParams(next);
  };

  const filterLabel =
    filterAnchor === undefined
      ? undefined
      : list.rows.filter(isLive).find((row) => row.anchorKind === filterAnchor.kind && row.anchorId === filterAnchor.id)
          ?.anchorDisplay ?? filterAnchor.id;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h2 className={styles.heading}>Rankings</h2>
        <p className={styles.lede}>Rank a property or a tenant, then check every model call, its cost and its pairs.</p>
      </header>
      <RankAnchorPanel
        anchor={rankAnchor}
        includeOlder={includeOlder}
        onAnchorChange={(next) => setParams({ rank: next === undefined ? undefined : anchorParam(next) })}
        onIncludeOlderChange={(next) => setParams({ older: next ? '1' : undefined })}
        onShowRuns={(next) => setParams({ anchor: anchorParam(next), run: undefined })}
      />
      <RankingCostTotals
        cost={cost.cost}
        status={cost.status}
        rangeNote={costRangeNote(from, to)}
        onRetry={cost.retry}
      />
      <div className={styles.runs}>
        <RankingRunList
          rows={list.rows}
          status={list.status}
          hasMore={list.hasMore}
          loadingMore={list.loadingMore}
          loadMoreFailed={list.loadMoreFailed}
          incomplete={list.incomplete}
          from={from ?? ''}
          to={to ?? ''}
          anchorFilter={filterLabel === undefined ? undefined : { label: filterLabel }}
          onFromChange={(value) => setParams({ from: value })}
          onToChange={(value) => setParams({ to: value })}
          onClearAnchor={() => setParams({ anchor: undefined })}
          onOpen={(id) => setParams({ run: id })}
          onLoadMore={list.loadMore}
          onRetry={list.retry}
          onRefresh={() => {
            list.retry();
            cost.retry();
          }}
        />
        <RankingRunDetail
          detail={detail.detail}
          status={detail.status}
          onRetry={detail.retry}
          // Spec D11: a re-scored pair opens the run that holds its current match.
          onOpenRun={(id) => setParams({ run: id })}
        />
      </div>
    </div>
  );
}
