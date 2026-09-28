// useBroadcastResults — owns the live Results view for one broadcast: the
// initial load (GET /api/broadcasts/:id/results), a manual Refresh, and the live
// update path. On a broadcast.updated SSE matching THIS broadcast it (1) overlays
// the event's status+stats immediately (instant feedback) AND (2) schedules a
// debounced refetch of getBroadcastResults — because the SSE payload carries the
// rollup but NOT the per-recipient detail, which only the GET returns. Abort- +
// generation-guarded so a stale fetch never clobbers a newer one / a live overlay.
//
// Polling fallback (S3): while the loaded results are still 'sending', the hook
// also polls getBroadcastResults on a ~2s interval. This is what keeps the detail
// page ticking in DEPLOYED envs, where the fan-out runs in the worker process and
// its per-recipient SSE emits never reach this app instance (only the DLR-rollup
// emits do). The interval starts on the transition INTO 'sending', stops the
// moment status goes terminal (sent/failed) or draft, and clears on unmount.
// Poll + SSE both funnel through the same abort-/generation-guarded fetchResults,
// so concurrent triggers stay safe.
//
// share-sent-outcome D4 (deviation 14): the overlay MERGES an event whose stats
// omit `retry_pending` by keeping the last known count (only the rollup that
// just scheduled a retry emits one), and the page's 60 s ticker may override
// the count with a recount from its own rows (`recountRetryPending`) so the
// pill and chips never outlive a lapsed promise. The override is cleared by a
// REFETCH (fresh rows, the route's truth) and by an overlay that CARRIES a
// count (a new pending recipient outranks the recount) - never by one whose
// count is unset, which would bring back a stale count until its refetch. And
// no recount applies between an overlay and the refetch that follows it: the
// rows are older than the stats then, so the event's count stands.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  getBroadcastResults,
  useEventStream,
  type BroadcastResults,
  type BroadcastStats,
  type BroadcastUpdatedEvent,
} from '../../api/index.js';

export type BroadcastResultsStatus = 'loading' | 'ready' | 'error';

export interface BroadcastResultsState {
  status: BroadcastResultsStatus;
  results: BroadcastResults | null;
  /** True when a not-found (deleted/never-existed) broadcast was requested. */
  notFound: boolean;
  refresh: () => void;
  retry: () => void;
  /** True while a background (SSE-triggered or manual) refetch is in flight. */
  refreshing: boolean;
  /** share-sent-outcome D4: `results.stats` with the ticker's recount (when one
   *  stands) in place of `retry_pending` - what the pill and the chips read. */
  liveStats: BroadcastStats | null;
  /** share-sent-outcome D4: the page ticker's recount of its pending rows. A
   *  no-op while the rows are older than the stats (an overlay awaiting its
   *  refetch). */
  recountRetryPending: (count: number) => void;
}

/** Debounce for SSE-triggered refetches — coalesces a burst of broadcast.updated
 *  events (each delivery callback emits one) into a single GET. */
const REFETCH_DEBOUNCE_MS = 400;

/** Poll cadence while a broadcast is still sending (the deployed-worker liveness
 *  fallback). Roughly a second locally / a couple of seconds deployed is the
 *  spec target; 2s balances liveness against results-endpoint cost. */
const POLL_INTERVAL_MS = 2000;

export function useBroadcastResults(broadcastId: string): BroadcastResultsState {
  const [status, setStatus] = useState<BroadcastResultsStatus>('loading');
  const [results, setResults] = useState<BroadcastResults | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** share-sent-outcome D4: the ticker's recount of retry_pending, standing
   *  until a refetch or a count-carrying overlay replaces it. */
  const [recount, setRecount] = useState<number | undefined>(undefined);
  /** True from an SSE overlay until the next fetch lands: the rows then are
   *  older than the stats, so the ticker must not recount from them. */
  const rowsBehindRef = useRef(false);

  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);
  /** True once a TERMINAL status (sent/failed) was observed via the SSE overlay.
   *  The gen/abort guard protects fetches against EACH OTHER, but the overlay
   *  owns no generation - so a poll that was already in flight when finalize's
   *  event landed can resolve LATER with a stale pre-finalize 'sending' snapshot
   *  and briefly regress the pill (sending -> sent -> sending -> sent). The
   *  lifecycle is forward-only (a sent/failed broadcast can never resume
   *  sending), so such a snapshot is stale BY DEFINITION and is discarded; the
   *  debounced refetch delivers the terminal rows. Reset per broadcastId. */
  const terminalSeenRef = useRef(false);

  const fetchResults = useCallback(
    async (background: boolean) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      genRef.current += 1;
      const gen = genRef.current;
      if (background) setRefreshing(true);
      try {
        const data = await getBroadcastResults(broadcastId, controller.signal);
        if (controller.signal.aborted || gen !== genRef.current) return;
        if (terminalSeenRef.current && data.status === 'sending') return;
        setResults(data);
        // Fresh rows from the route: its count is the truth again.
        setRecount(undefined);
        rowsBehindRef.current = false;
        setStatus('ready');
        setNotFound(false);
      } catch (err) {
        if (
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === 'AbortError')
        ) {
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          setStatus('error');
          return;
        }
        // A background refresh failure keeps the last-good results on screen.
        if (!background) setStatus('error');
      } finally {
        if (background) setRefreshing(false);
      }
    },
    [broadcastId],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    setResults(null);
    setNotFound(false);
    setRecount(undefined);
    terminalSeenRef.current = false;
    rowsBehindRef.current = false;
    void fetchResults(false);
    return () => abortRef.current?.abort();
  }, [fetchResults]);

  const refresh = useCallback(() => void fetchResults(true), [fetchResults]);
  const retry = useCallback(() => {
    setStatus('loading');
    void fetchResults(false);
  }, [fetchResults]);

  // --- SSE: overlay status+stats instantly, then debounce-refetch for the
  // per-recipient detail the event payload omits.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onBroadcastUpdated = useCallback(
    (e: BroadcastUpdatedEvent) => {
      if (e.broadcastId !== broadcastId) return;
      // Latch a terminal status BEFORE overlaying: any in-flight fetch that
      // still says 'sending' is now stale and must not regress the pill.
      if (e.status === 'sent' || e.status === 'failed') terminalSeenRef.current = true;
      // (1) Instant overlay of the live rollup onto whatever we have. share-
      // sent-outcome D4: an event that leaves retry_pending unset keeps the
      // last known count until the refetch below replaces it.
      setResults((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              status: e.status,
              stats: {
                ...e.stats,
                ...(e.stats.retry_pending === undefined &&
                  prev.stats.retry_pending !== undefined && { retry_pending: prev.stats.retry_pending }),
              },
            },
      );
      // The rows now lag the stats until the refetch lands; a count-carrying
      // event (the rollup's own lower bound) outranks the ticker's recount.
      rowsBehindRef.current = true;
      if (e.stats.retry_pending !== undefined) setRecount(undefined);
      // (2) Debounced refetch to pick up the per-recipient changes.
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = undefined;
        void fetchResults(true);
      }, REFETCH_DEBOUNCE_MS);
    },
    [broadcastId, fetchResults],
  );
  useEventStream({ onBroadcastUpdated });

  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    },
    [],
  );

  // --- S3: poll while sending. Keyed on the broadcast STATUS only (not the whole
  // results object), so the interval runs at a steady cadence while status stays
  // 'sending' and is torn down the instant it goes terminal / draft or on unmount.
  // fetchResults is stable per broadcastId, so the interval is not re-armed by the
  // background refetches it triggers.
  const liveStatus = results?.status;
  useEffect(() => {
    if (liveStatus !== 'sending') return;
    const id = setInterval(() => void fetchResults(true), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [liveStatus, fetchResults]);

  // --- share-sent-outcome D4: the ticker's recount, and the stats it shapes.
  const recountRetryPending = useCallback((count: number) => {
    if (rowsBehindRef.current) return; // the event's count stands until its refetch
    setRecount(count);
  }, []);
  const liveStats = useMemo(
    () =>
      results === null
        ? null
        : recount === undefined
          ? results.stats
          : { ...results.stats, retry_pending: recount },
    [results, recount],
  );

  return { status, results, notFound, refresh, retry, refreshing, liveStats, recountRetryPending };
}
