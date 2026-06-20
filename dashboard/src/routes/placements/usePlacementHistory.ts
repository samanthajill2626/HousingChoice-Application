// usePlacementHistory — the placement detail page's provenance trail (F2.3). Abort-safe
// fetch of GET /api/placements/:id/history (newest-first), with cursor "load more"
// via the `before` opaque cursor (the ts of the oldest loaded row). Exposes
// rows + a loadMore() + hasMore. Mirrors useListing's derive-loading-on-id-
// change pattern (no synchronous setState in the effect → no cascading render).
//
// LIVE: a transition on this placement emits a `placement.updated` SSE event (the same one
// that live-moves the board); we subscribe and refetch the newest page so a
// status change shows up in the History panel without a manual reload — whether
// the change came from this page, another tab, or another user.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getPlacementHistory, useEventStream, type PlacementUpdatedEvent, type HistoryRow } from '../../api/index.js';

export type HistoryStatus = 'loading' | 'ready' | 'error';

const PAGE = 20;

export interface PlacementHistoryState {
  status: HistoryStatus;
  rows: HistoryRow[];
  /** True when the last page was full → another page may exist. */
  hasMore: boolean;
  /** True while a "load more" page is in flight. */
  loadingMore: boolean;
  loadMore: () => void;
}

interface Committed {
  status: HistoryStatus;
  rows: HistoryRow[];
  hasMore: boolean;
  loadingMore: boolean;
  /** Which placementId the committed state describes (derive loading until it matches). */
  forId: string;
}

const LOADING: Omit<Committed, 'forId'> = {
  status: 'loading',
  rows: [],
  hasMore: false,
  loadingMore: false,
};

export function usePlacementHistory(placementId: string): PlacementHistoryState {
  const [state, setState] = useState<Committed>({ ...LOADING, forId: placementId });

  // Track the in-flight first-page request so a refetch (SSE-driven or placementId
  // change) supersedes the previous one and a late response can't clobber it.
  const abortRef = useRef<AbortController | null>(null);

  // Fetch (or refetch) the newest page. No synchronous loading reset — when
  // placementId changes we DERIVE loading during render (forId mismatch) until this
  // commits; a live refetch updates rows in place without a spinner flash.
  const fetchFirstPage = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    try {
      const page = await getPlacementHistory(placementId, { limit: PAGE }, signal);
      if (signal.aborted) return;
      setState({
        status: 'ready',
        rows: page,
        hasMore: page.length === PAGE,
        loadingMore: false,
        forId: placementId,
      });
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setState({ ...LOADING, status: 'error', forId: placementId });
    }
  }, [placementId]);

  // Initial page on mount / placementId change.
  useEffect(() => {
    // fetchFirstPage sets state only after an await (never synchronously) — a
    // fetch-on-mount, not the cascading-render case the rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchFirstPage();
    return () => abortRef.current?.abort();
  }, [fetchFirstPage]);

  // Live: refetch the newest page when THIS placement changes (e.g. a status move).
  const onPlacementUpdated = useCallback(
    (ev: PlacementUpdatedEvent) => {
      if (ev.placementId === placementId) void fetchFirstPage();
    },
    [placementId, fetchFirstPage],
  );
  useEventStream({ onPlacementUpdated });

  const loadMore = useCallback(() => {
    setState((prev) => {
      if (prev.loadingMore || prev.rows.length === 0 || prev.forId !== placementId) return prev;
      const before = prev.rows[prev.rows.length - 1]?.ts;
      if (before === undefined) return prev;
      const controller = new AbortController();
      void (async () => {
        try {
          const page = await getPlacementHistory(placementId, { limit: PAGE, before }, controller.signal);
          if (controller.signal.aborted) return;
          setState((s) =>
            s.forId !== placementId
              ? s
              : { ...s, rows: [...s.rows, ...page], hasMore: page.length === PAGE, loadingMore: false },
          );
        } catch (err) {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
            return;
          }
          // A failed "load more" keeps the existing rows; stop offering more.
          setState((s) => (s.forId !== placementId ? s : { ...s, hasMore: false, loadingMore: false }));
        }
      })();
      return { ...prev, loadingMore: true };
    });
  }, [placementId]);

  // Committed state is for a previous placementId → the new fetch is in flight.
  if (state.forId !== placementId) {
    return { ...LOADING, loadMore };
  }
  return {
    status: state.status,
    rows: state.rows,
    hasMore: state.hasMore,
    loadingMore: state.loadingMore,
    loadMore,
  };
}
