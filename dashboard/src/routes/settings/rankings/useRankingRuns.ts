// useRankingRuns - the Rankings page's run log reads (WP1 B2a spec D11, D12,
// D18): one cursor-paged list (newest first, filtered by date range and
// anchor), one run detail, and the weekly cost totals. Admin only on the
// server (requireRole('admin')). Each state is keyed by the request it
// answers, so a filter change reads "loading" without a reset inside an
// effect, and `retry` bumps a counter that is part of the key.
import { useCallback, useEffect, useState } from 'react';
import {
  getRankingCost,
  getRankingRun,
  listRankingRuns,
  type RankingAnchorRef,
  type RankingCostResponse,
  type RankingRunDetailResponse,
  type RankingRunListRow,
} from '../../../api/index.js';

export type RankingFetchStatus = 'loading' | 'ready' | 'error';

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export interface RankingRunListState {
  rows: RankingRunListRow[];
  status: RankingFetchStatus;
  hasMore: boolean;
  loadingMore: boolean;
  /** The last Load more failed; the rows and the cursor are still good. */
  loadMoreFailed: boolean;
  /** A page said a run could not be read (plan PR34). */
  incomplete: boolean;
  loadMore: () => void;
  retry: () => void;
}

interface ListSlice {
  key: string;
  rows: RankingRunListRow[];
  status: 'ready' | 'error';
  cursor: string | undefined;
  incomplete: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
}

export function useRankingRunList(params: { from?: string; to?: string; anchor?: RankingAnchorRef }): RankingRunListState {
  const { from, to } = params;
  const anchorKind = params.anchor?.kind;
  const anchorId = params.anchor?.id;
  const [reload, setReload] = useState(0);
  const key = [from ?? '', to ?? '', anchorKind ?? '', anchorId ?? '', String(reload)].join('|');
  const [slice, setSlice] = useState<ListSlice | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const page = await listRankingRuns({ from, to, anchorKind, anchorId }, controller.signal);
        if (controller.signal.aborted) return;
        setSlice({
          key,
          rows: page.runs,
          status: 'ready',
          cursor: page.nextCursor,
          incomplete: page.incomplete === true,
          loadingMore: false,
          loadMoreFailed: false,
        });
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return;
        setSlice({ key, rows: [], status: 'error', cursor: undefined, incomplete: false, loadingMore: false, loadMoreFailed: false });
      }
    })();
    return () => controller.abort();
  }, [anchorId, anchorKind, from, key, to]);

  const live = slice !== null && slice.key === key ? slice : null;

  const loadMore = useCallback((): void => {
    if (live === null || live.status !== 'ready' || live.cursor === undefined || live.loadingMore) return;
    const cursor = live.cursor;
    const forKey = live.key;
    setSlice((prev) => (prev !== null && prev.key === forKey ? { ...prev, loadingMore: true, loadMoreFailed: false } : prev));
    void (async () => {
      try {
        const page = await listRankingRuns({ from, to, anchorKind, anchorId, cursor });
        setSlice((prev) =>
          prev !== null && prev.key === forKey
            ? {
                ...prev,
                rows: [...prev.rows, ...page.runs],
                cursor: page.nextCursor,
                incomplete: prev.incomplete || page.incomplete === true,
                loadingMore: false,
                loadMoreFailed: false,
              }
            : prev,
        );
      } catch {
        // The cursor stays: the next page still exists, this attempt failed.
        setSlice((prev) => (prev !== null && prev.key === forKey ? { ...prev, loadingMore: false, loadMoreFailed: true } : prev));
      }
    })();
  }, [anchorId, anchorKind, from, live, to]);

  const retry = useCallback((): void => {
    setReload((n) => n + 1);
  }, []);

  return {
    rows: live?.rows ?? [],
    status: live?.status ?? 'loading',
    hasMore: live !== null && live.cursor !== undefined,
    loadingMore: live?.loadingMore ?? false,
    loadMoreFailed: live?.loadMoreFailed ?? false,
    incomplete: live?.incomplete ?? false,
    loadMore,
    retry,
  };
}

export interface RankingRunState {
  detail: RankingRunDetailResponse | undefined;
  status: 'idle' | RankingFetchStatus;
  retry: () => void;
}

interface DetailSlice {
  key: string;
  detail: RankingRunDetailResponse | undefined;
  status: 'ready' | 'error';
}

export function useRankingRun(runId: string | undefined): RankingRunState {
  const [reload, setReload] = useState(0);
  const key = runId === undefined ? undefined : `${runId}|${reload}`;
  const [slice, setSlice] = useState<DetailSlice | null>(null);

  useEffect(() => {
    if (runId === undefined || key === undefined) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const detail = await getRankingRun(runId, controller.signal);
        if (controller.signal.aborted) return;
        setSlice({ key, detail, status: 'ready' });
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return;
        setSlice({ key, detail: undefined, status: 'error' });
      }
    })();
    return () => controller.abort();
  }, [key, runId]);

  const retry = useCallback((): void => {
    setReload((n) => n + 1);
  }, []);

  if (key === undefined) return { detail: undefined, status: 'idle', retry };
  const live = slice !== null && slice.key === key ? slice : null;
  return { detail: live?.detail, status: live?.status ?? 'loading', retry };
}

export interface RankingCostState {
  cost: RankingCostResponse | undefined;
  status: RankingFetchStatus;
  retry: () => void;
}

interface CostSlice {
  key: string;
  cost: RankingCostResponse | undefined;
  status: 'ready' | 'error';
}

export function useRankingCost(params: { from?: string; to?: string }): RankingCostState {
  const { from, to } = params;
  const [reload, setReload] = useState(0);
  const key = [from ?? '', to ?? '', String(reload)].join('|');
  const [slice, setSlice] = useState<CostSlice | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const cost = await getRankingCost({ from, to }, controller.signal);
        if (controller.signal.aborted) return;
        setSlice({ key, cost, status: 'ready' });
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return;
        setSlice({ key, cost: undefined, status: 'error' });
      }
    })();
    return () => controller.abort();
  }, [from, key, to]);

  const retry = useCallback((): void => {
    setReload((n) => n + 1);
  }, []);

  const live = slice !== null && slice.key === key ? slice : null;
  return { cost: live?.cost, status: live?.status ?? 'loading', retry };
}
