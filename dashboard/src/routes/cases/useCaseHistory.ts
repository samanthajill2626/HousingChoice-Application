// useCaseHistory — the case detail page's provenance trail (F2.3). Abort-safe
// fetch of GET /api/cases/:id/history (newest-first), with cursor "load more"
// via the `before` opaque cursor (the ts of the oldest loaded row). Exposes
// rows + a loadMore() + hasMore. Mirrors useListing's derive-loading-on-id-
// change pattern (no synchronous setState in the effect → no cascading render).
//
// LIVE: a transition on this case emits a `case.updated` SSE event (the same one
// that live-moves the board); we subscribe and refetch the newest page so a
// status change shows up in the History panel without a manual reload — whether
// the change came from this page, another tab, or another user.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getPlacementHistory, useEventStream, type CaseUpdatedEvent, type HistoryRow } from '../../api/index.js';

export type HistoryStatus = 'loading' | 'ready' | 'error';

const PAGE = 20;

export interface CaseHistoryState {
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
  /** Which caseId the committed state describes (derive loading until it matches). */
  forId: string;
}

const LOADING: Omit<Committed, 'forId'> = {
  status: 'loading',
  rows: [],
  hasMore: false,
  loadingMore: false,
};

export function useCaseHistory(caseId: string): CaseHistoryState {
  const [state, setState] = useState<Committed>({ ...LOADING, forId: caseId });

  // Track the in-flight first-page request so a refetch (SSE-driven or caseId
  // change) supersedes the previous one and a late response can't clobber it.
  const abortRef = useRef<AbortController | null>(null);

  // Fetch (or refetch) the newest page. No synchronous loading reset — when
  // caseId changes we DERIVE loading during render (forId mismatch) until this
  // commits; a live refetch updates rows in place without a spinner flash.
  const fetchFirstPage = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    try {
      const page = await getPlacementHistory(caseId, { limit: PAGE }, signal);
      if (signal.aborted) return;
      setState({
        status: 'ready',
        rows: page,
        hasMore: page.length === PAGE,
        loadingMore: false,
        forId: caseId,
      });
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setState({ ...LOADING, status: 'error', forId: caseId });
    }
  }, [caseId]);

  // Initial page on mount / caseId change.
  useEffect(() => {
    // fetchFirstPage sets state only after an await (never synchronously) — a
    // fetch-on-mount, not the cascading-render case the rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchFirstPage();
    return () => abortRef.current?.abort();
  }, [fetchFirstPage]);

  // Live: refetch the newest page when THIS case changes (e.g. a status move).
  const onCaseUpdated = useCallback(
    (ev: CaseUpdatedEvent) => {
      if (ev.caseId === caseId) void fetchFirstPage();
    },
    [caseId, fetchFirstPage],
  );
  useEventStream({ onCaseUpdated });

  const loadMore = useCallback(() => {
    setState((prev) => {
      if (prev.loadingMore || prev.rows.length === 0 || prev.forId !== caseId) return prev;
      const before = prev.rows[prev.rows.length - 1]?.ts;
      if (before === undefined) return prev;
      const controller = new AbortController();
      void (async () => {
        try {
          const page = await getPlacementHistory(caseId, { limit: PAGE, before }, controller.signal);
          if (controller.signal.aborted) return;
          setState((s) =>
            s.forId !== caseId
              ? s
              : { ...s, rows: [...s.rows, ...page], hasMore: page.length === PAGE, loadingMore: false },
          );
        } catch (err) {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
            return;
          }
          // A failed "load more" keeps the existing rows; stop offering more.
          setState((s) => (s.forId !== caseId ? s : { ...s, hasMore: false, loadingMore: false }));
        }
      })();
      return { ...prev, loadingMore: true };
    });
  }, [caseId]);

  // Committed state is for a previous caseId → the new fetch is in flight.
  if (state.forId !== caseId) {
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
