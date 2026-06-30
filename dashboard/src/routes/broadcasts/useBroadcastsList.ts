// useBroadcastsList — owns the broadcasts list for the active status filter: the
// first page (GET /api/broadcasts), cursor "Load more", and a refetch on a
// broadcast.updated SSE (so a row's status/stats roll forward live). Abort-guarded
// fetch with a generation ref so a stale page never clobbers a newer one.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listBroadcasts,
  useEventStream,
  type BroadcastStatus,
  type BroadcastSummary,
} from '../../api/index.js';

export type BroadcastsListStatus = 'loading' | 'ready' | 'error';

/** The status filter: a real BroadcastStatus, or 'all' (no ?status=). */
export type BroadcastsFilter = BroadcastStatus | 'all';

export interface BroadcastsListState {
  status: BroadcastsListStatus;
  rows: BroadcastSummary[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

const PAGE_LIMIT = 50;

export function useBroadcastsList(filter: BroadcastsFilter): BroadcastsListState {
  const [status, setStatus] = useState<BroadcastsListStatus>('loading');
  const [rows, setRows] = useState<BroadcastSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);

  const statusParam = filter === 'all' ? undefined : filter;

  const fetchFirstPage = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    genRef.current += 1;
    const gen = genRef.current;
    try {
      const page = await listBroadcasts(
        { ...(statusParam !== undefined && { status: statusParam }), limit: PAGE_LIMIT },
        controller.signal,
      );
      if (controller.signal.aborted || gen !== genRef.current) return;
      setRows(page.broadcasts);
      setCursor(page.nextCursor);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      setStatus('error');
    }
  }, [statusParam]);

  // Initial load + full reload on a filter change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    setRows([]);
    setCursor(null);
    void fetchFirstPage();
    return () => abortRef.current?.abort();
  }, [fetchFirstPage]);

  const retry = useCallback(() => {
    setStatus('loading');
    void fetchFirstPage();
  }, [fetchFirstPage]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    listBroadcasts({
      ...(statusParam !== undefined && { status: statusParam }),
      limit: PAGE_LIMIT,
      cursor,
    })
      .then((page) => {
        setRows((prev) => [...prev, ...page.broadcasts]);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        /* keep the cursor so the user can retry "Load more" */
      })
      .finally(() => setLoadingMore(false));
  }, [statusParam, cursor, loadingMore]);

  // --- SSE: a broadcast changed → patch the matching row's status+stats in
  // place (the list summary carries exactly those two live fields). A row not on
  // the current page is ignored (it'll be correct on the next fetch / Load more).
  const onBroadcastUpdated = useCallback(
    (e: { broadcastId: string; status: BroadcastStatus; stats: BroadcastSummary['stats'] }) => {
      setRows((prev) =>
        prev.map((r) =>
          r.broadcastId === e.broadcastId ? { ...r, status: e.status, stats: e.stats } : r,
        ),
      );
    },
    [],
  );
  useEventStream({ onBroadcastUpdated });

  return { status, rows, hasMore: cursor !== null, loadingMore, loadMore, retry };
}
