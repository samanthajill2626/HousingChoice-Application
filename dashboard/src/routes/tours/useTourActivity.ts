// useTourActivity - the tour detail page's own lifecycle trail (the Activity
// card). A near-verbatim mirror of usePlacementHistory: an abort-safe fetch of
// GET /api/tours/:tourId/activity (newest-first) with a "load more" that pages
// older via the `before` cursor (the `id` of the oldest loaded row). Exposes
// rows + loadMore() + hasMore + loadingMore.
//
// LIVE: a mutation on this tour emits a `tour.updated` SSE event; we subscribe
// and refetch the newest page so a status change / group-open / conversion shows
// up in the Activity card without a manual reload - whether the change came from
// this page, another tab, or another user.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getTourActivity,
  useEventStream,
  type TourActivityEvent,
  type TourUpdatedEvent,
} from '../../api/index.js';

export type TourActivityStatus = 'loading' | 'ready' | 'error';

const PAGE = 20;

export interface TourActivityState {
  status: TourActivityStatus;
  rows: TourActivityEvent[];
  /** True when the last page was full -> another page may exist. */
  hasMore: boolean;
  /** True while a "load more" page is in flight. */
  loadingMore: boolean;
  loadMore: () => void;
}

interface Committed {
  status: TourActivityStatus;
  rows: TourActivityEvent[];
  hasMore: boolean;
  loadingMore: boolean;
  /** Which tourId the committed state describes (derive loading until it matches). */
  forId: string;
}

const LOADING: Omit<Committed, 'forId'> = {
  status: 'loading',
  rows: [],
  hasMore: false,
  loadingMore: false,
};

export function useTourActivity(tourId: string): TourActivityState {
  const [state, setState] = useState<Committed>({ ...LOADING, forId: tourId });

  // Track the in-flight first-page request so a refetch (SSE-driven or tourId
  // change) supersedes the previous one and a late response can't clobber it.
  const abortRef = useRef<AbortController | null>(null);

  const fetchFirstPage = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    try {
      const page = await getTourActivity(tourId, { limit: PAGE }, signal);
      if (signal.aborted) return;
      setState({
        status: 'ready',
        rows: page,
        hasMore: page.length === PAGE,
        loadingMore: false,
        forId: tourId,
      });
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setState({ ...LOADING, status: 'error', forId: tourId });
    }
  }, [tourId]);

  useEffect(() => {
    // fetchFirstPage sets state only after an await (never synchronously).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchFirstPage();
    return () => abortRef.current?.abort();
  }, [fetchFirstPage]);

  // Live: refetch the newest page when THIS tour changes.
  const onTourUpdated = useCallback(
    (ev: TourUpdatedEvent) => {
      if (ev.tourId === tourId) void fetchFirstPage();
    },
    [tourId, fetchFirstPage],
  );
  useEventStream({ onTourUpdated });

  const loadMore = useCallback(() => {
    setState((prev) => {
      if (prev.loadingMore || prev.rows.length === 0 || prev.forId !== tourId) return prev;
      const before = prev.rows[prev.rows.length - 1]?.id;
      if (before === undefined) return prev;
      const controller = new AbortController();
      void (async () => {
        try {
          const page = await getTourActivity(tourId, { limit: PAGE, before }, controller.signal);
          if (controller.signal.aborted) return;
          setState((s) =>
            s.forId !== tourId
              ? s
              : { ...s, rows: [...s.rows, ...page], hasMore: page.length === PAGE, loadingMore: false },
          );
        } catch (err) {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
            return;
          }
          // A failed "load more" keeps the existing rows; stop offering more.
          setState((s) => (s.forId !== tourId ? s : { ...s, hasMore: false, loadingMore: false }));
        }
      })();
      return { ...prev, loadingMore: true };
    });
  }, [tourId]);

  // Committed state is for a previous tourId -> the new fetch is in flight.
  if (state.forId !== tourId) return { ...LOADING, loadMore };
  return {
    status: state.status,
    rows: state.rows,
    hasMore: state.hasMore,
    loadingMore: state.loadingMore,
    loadMore,
  };
}
