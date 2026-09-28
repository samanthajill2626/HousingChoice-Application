// useBroadcastsList — owns the broadcasts list for the active status filter: the
// first page (GET /api/broadcasts), cursor "Load more", and a live patch of a
// row's status/stats on a broadcast.updated SSE. Abort-guarded fetch with a
// generation ref so a stale page never clobbers a newer one.
//
// share-sent-outcome D4: the patch MERGES an event whose stats omit
// `retry_pending` by keeping the row's last count (only the rollup that just
// scheduled a retry emits one). A FINISHED share (the event's stored status
// `sent` or `failed`) whose kept count is positive then refetches THAT share's
// stats once (GET results?view=stats, 400 ms debounced per row), so a chain
// that ends in a failure receipt - which shrinks nothing in `failed` - turns
// the row from Sending to Not sent. A share still `sending` never refetches: it
// keeps its stored label and needs no count.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getBroadcastStats,
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
  /** Drop a row locally (after a successful delete) — no refetch, cursor kept. */
  removeRow: (broadcastId: string) => void;
}

const PAGE_LIMIT = 50;

/** share-sent-outcome D4: the per-row debounce of a finished share's stats
 *  refetch - coalesces a burst of receipts into one GET. */
const STATS_REFETCH_DEBOUNCE_MS = 400;

export function useBroadcastsList(filter: BroadcastsFilter): BroadcastsListState {
  const [status, setStatus] = useState<BroadcastsListStatus>('loading');
  const [rows, setRows] = useState<BroadcastSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);
  /** The latest rows, for the SSE handler (reads them without re-subscribing). */
  const rowsRef = useRef<BroadcastSummary[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  /** share-sent-outcome D4: one pending stats refetch per row - its debounce
   *  timer and its in-flight request (a newer schedule supersedes both). */
  const statsRefetchRef = useRef(
    new Map<string, { timer?: ReturnType<typeof setTimeout>; controller?: AbortController }>(),
  );

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
    setLoadingMore(false); // a stale in-flight loadMore now bails (gen-guarded)
    void fetchFirstPage();
    return () => abortRef.current?.abort();
  }, [fetchFirstPage]);

  const retry = useCallback(() => {
    setStatus('loading');
    void fetchFirstPage();
  }, [fetchFirstPage]);

  const removeRow = useCallback((broadcastId: string) => {
    setRows((prev) => prev.filter((r) => r.broadcastId !== broadcastId));
  }, []);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    // Capture the generation at start — a ?status= filter change mid-flight bumps
    // genRef (via fetchFirstPage's effect), so we bail rather than append the OLD
    // filter's page onto the NEW list and clobber the cursor.
    const gen = genRef.current;
    setLoadingMore(true);
    listBroadcasts({
      ...(statusParam !== undefined && { status: statusParam }),
      limit: PAGE_LIMIT,
      cursor,
    })
      .then((page) => {
        if (gen !== genRef.current) return; // filter changed mid-load — discard
        setRows((prev) => [...prev, ...page.broadcasts]);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        /* keep the cursor so the user can retry "Load more" */
      })
      .finally(() => {
        if (gen !== genRef.current) return; // a newer load owns loadingMore now
        setLoadingMore(false);
      });
  }, [statusParam, cursor, loadingMore]);

  // --- share-sent-outcome D4: one debounced stats refetch per row. The result
  // replaces the row's status + stats; a row no longer on the page is ignored,
  // and a failed read keeps the row as it is (the next event or load corrects it).
  const scheduleStatsRefetch = useCallback((broadcastId: string) => {
    const pending = statsRefetchRef.current;
    const prior = pending.get(broadcastId);
    if (prior?.timer !== undefined) clearTimeout(prior.timer);
    prior?.controller?.abort();
    const entry: { timer?: ReturnType<typeof setTimeout>; controller?: AbortController } = {};
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      const controller = new AbortController();
      entry.controller = controller;
      getBroadcastStats(broadcastId, controller.signal)
        .then((view) => {
          if (controller.signal.aborted) return;
          setRows((prev) =>
            prev.map((r) =>
              r.broadcastId === broadcastId ? { ...r, status: view.status, stats: view.stats } : r,
            ),
          );
        })
        .catch(() => {
          /* keep the row as it is - the next event or page load corrects it */
        })
        .finally(() => {
          if (pending.get(broadcastId) === entry) pending.delete(broadcastId);
        });
    }, STATS_REFETCH_DEBOUNCE_MS);
    pending.set(broadcastId, entry);
  }, []);

  useEffect(() => {
    const pending = statsRefetchRef.current;
    return () => {
      for (const entry of pending.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.controller?.abort();
      }
      pending.clear();
    };
  }, []);

  // --- SSE: a broadcast changed → patch the matching row's status+stats in
  // place (the list summary carries exactly those two live fields). A row not on
  // the current page is ignored (it'll be correct on the next fetch / Load more).
  // share-sent-outcome D4: an omitted retry_pending keeps the row's last count;
  // a finished share with a positive kept count refetches its stats.
  const onBroadcastUpdated = useCallback(
    (e: { broadcastId: string; status: BroadcastStatus; stats: BroadcastSummary['stats'] }) => {
      setRows((prev) =>
        prev.map((r) => {
          if (r.broadcastId !== e.broadcastId) return r;
          const kept =
            e.stats.retry_pending === undefined && r.stats.retry_pending !== undefined
              ? { retry_pending: r.stats.retry_pending }
              : {};
          return { ...r, status: e.status, stats: { ...e.stats, ...kept } };
        }),
      );
      const row = rowsRef.current.find((r) => r.broadcastId === e.broadcastId);
      if (
        row !== undefined &&
        e.stats.retry_pending === undefined &&
        (row.stats.retry_pending ?? 0) > 0 &&
        (e.status === 'sent' || e.status === 'failed')
      ) {
        scheduleStatsRefetch(e.broadcastId);
      }
    },
    [scheduleStatsRefetch],
  );
  useEventStream({ onBroadcastUpdated });

  return { status, rows, hasMore: cursor !== null, loadingMore, loadMore, retry, removeRow };
}
