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
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getBroadcastResults,
  useEventStream,
  type BroadcastResults,
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
    terminalSeenRef.current = false;
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
      // (1) Instant overlay of the live rollup onto whatever we have.
      setResults((prev) => (prev === null ? prev : { ...prev, status: e.status, stats: e.stats }));
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

  return { status, results, notFound, refresh, retry, refreshing };
}
