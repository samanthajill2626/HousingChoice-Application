// useToday — the Today page's data hook. Prefers the server-assembled queue
// (GET /api/today, §C7); when that endpoint isn't live yet (ApiError 404) it
// falls back to assembling the SAME TodayItem[] client-side from /api/placements +
// /api/conversations + /api/tours (buildTodayFromSources). Subscribes to the SSE stream and
// refetches (debounced) on placement.updated / conversation.updated so the queue
// stays live. Returns a small { status, items, source } state for the view.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getPlacements,
  getConversations,
  getToday,
  getTours,
  useEventStream,
  type RelayCloseNag,
  type TodayItem,
} from '../../api/index.js';
import { buildTodayFromSources, localDayWindow, localYmd } from './buildToday.js';

export type TodayStatus = 'loading' | 'ready' | 'error';
export type TodaySource = 'server' | 'fallback';

export interface TodayState {
  status: TodayStatus;
  items: TodayItem[];
  /** Which path produced `items` — 'server' (/api/today) or 'fallback' (assembled). */
  source: TodaySource;
  /** Open relay groups whose 28-day close-nag is due (D5). Server-only - the
   *  client fallback can't derive it, so it's [] there. */
  relayCloseNags: RelayCloseNag[];
  /** Optimistically drop a nag row once its Close / Keep-open action succeeds (the
   *  server also drops it from the next refetch: close clears the nag, defer pushes
   *  it 28 days out). */
  dismissNag: (conversationId: string) => void;
}

/** Debounce window (ms) for SSE-triggered refetches — coalesces a burst of
 *  placement/conversation events (e.g. a broadcast send) into one refetch. */
const REFETCH_DEBOUNCE_MS = 300;

async function loadToday(
  signal: AbortSignal,
): Promise<{ items: TodayItem[]; source: TodaySource; relayCloseNags: RelayCloseNag[] }> {
  // The BROWSER owns "today". Compute the operator's local day (and its
  // boundary instants) once and use them for BOTH paths: pass ?day= + the
  // toursFrom/toursTo window to the timezone-agnostic server, and (via the same
  // `now`/window) fetch + fold Tour entities in the fallback — so the server and
  // the client build always agree on which day's tours to show. tours_today is
  // built from Tour entities; the legacy placement.tour_date basis is retired.
  const now = new Date();
  const day = localYmd(now);
  const window = localDayWindow(now);
  try {
    const res = await getToday(day, signal, window);
    return { items: res.items, source: 'server', relayCloseNags: res.relayCloseNags ?? [] };
  } catch (err) {
    // Only a 404 means "endpoint not live yet" → assemble client-side. Any other
    // failure (and the fallback's own failures) propagates to the error state.
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
    const [placements, conversations, tours] = await Promise.all([
      getPlacements(signal),
      getConversations(signal),
      getTours({ from: window.from, to: window.to }, signal),
    ]);
    const items = buildTodayFromSources(
      placements.placements,
      conversations.conversations,
      now,
      tours,
    );
    // The fallback can't derive the close nags (no close_nag_next_at on the
    // /api/placements or /api/conversations payloads) - leave it empty.
    return { items, source: 'fallback', relayCloseNags: [] };
  }
}

/** The fetched slice of the state (dismissNag is merged in on return). */
type TodayData = Omit<TodayState, 'dismissNag'>;

export function useToday(): TodayState {
  const [state, setState] = useState<TodayData>({
    status: 'loading',
    items: [],
    source: 'server',
    relayCloseNags: [],
  });

  // Optimistically drop a nag row after its Close / Keep-open action succeeds.
  // Stable (updater form), so it's referentially constant across renders.
  const dismissNag = useCallback((conversationId: string): void => {
    setState((prev) => ({
      ...prev,
      relayCloseNags: prev.relayCloseNags.filter((n) => n.conversationId !== conversationId),
    }));
  }, []);

  // Track the in-flight request so a refetch can supersede the previous one and
  // a late response from an aborted request can't clobber fresher state.
  const abortRef = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { items, source, relayCloseNags } = await loadToday(controller.signal);
      if (controller.signal.aborted) return;
      setState((prev) => ({ ...prev, status: 'ready', items, source, relayCloseNags }));
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      setState((prev) => ({ ...prev, status: 'error' }));
    }
  }, []);

  useEffect(() => {
    // fetchNow sets state only AFTER an await (never synchronously), so this is
    // not the cascading-render case the rule targets — it's a fetch-on-mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchNow();
    return () => abortRef.current?.abort();
  }, [fetchNow]);

  // Debounced SSE-driven refetch. The timer ref lives across renders; the SSE
  // handlers are ref-stable inside useEventStream.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void fetchNow();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchNow]);

  useEffect(() => () => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
  }, []);

  useEventStream({
    onPlacementUpdated: scheduleRefetch,
    onConversationUpdated: scheduleRefetch,
    // conversation-fact-extraction: a new/accepted/dismissed suggestion changes the
    // "AI suggestions to review" group count.
    onSuggestionUpdated: scheduleRefetch,
  });

  return { ...state, dismissNag };
}
