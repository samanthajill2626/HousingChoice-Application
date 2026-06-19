// useToday — the Today page's data hook. Prefers the server-assembled queue
// (GET /api/today, §C7); when that endpoint isn't live yet (ApiError 404) it
// falls back to assembling the SAME TodayItem[] client-side from /api/cases +
// /api/conversations (buildTodayFromSources). Subscribes to the SSE stream and
// refetches (debounced) on case.updated / conversation.updated so the queue
// stays live. Returns a small { status, items, source } state for the view.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getCases,
  getConversations,
  getToday,
  useEventStream,
  type TodayItem,
} from '../../api/index.js';
import { buildTodayFromSources, localYmd } from './buildToday.js';

export type TodayStatus = 'loading' | 'ready' | 'error';
export type TodaySource = 'server' | 'fallback';

export interface TodayState {
  status: TodayStatus;
  items: TodayItem[];
  /** Which path produced `items` — 'server' (/api/today) or 'fallback' (assembled). */
  source: TodaySource;
}

/** Debounce window (ms) for SSE-triggered refetches — coalesces a burst of
 *  case/conversation events (e.g. a broadcast send) into one refetch. */
const REFETCH_DEBOUNCE_MS = 300;

async function loadToday(
  signal: AbortSignal,
): Promise<{ items: TodayItem[]; source: TodaySource }> {
  // The BROWSER owns "today". Compute the operator's local calendar day once and
  // use it for BOTH paths: pass it as ?day= to the timezone-agnostic server, and
  // (via the same `now`) as the tour_date basis in the fallback — so the server
  // and the client build always agree on which day's tours to show.
  const now = new Date();
  const day = localYmd(now);
  try {
    const res = await getToday(day, signal);
    return { items: res.items, source: 'server' };
  } catch (err) {
    // Only a 404 means "endpoint not live yet" → assemble client-side. Any other
    // failure (and the fallback's own failures) propagates to the error state.
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
    const [cases, conversations] = await Promise.all([getCases(signal), getConversations(signal)]);
    const items = buildTodayFromSources(cases.cases, conversations.conversations, now);
    return { items, source: 'fallback' };
  }
}

export function useToday(): TodayState {
  const [state, setState] = useState<TodayState>({
    status: 'loading',
    items: [],
    source: 'server',
  });

  // Track the in-flight request so a refetch can supersede the previous one and
  // a late response from an aborted request can't clobber fresher state.
  const abortRef = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { items, source } = await loadToday(controller.signal);
      if (controller.signal.aborted) return;
      setState({ status: 'ready', items, source });
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
    onCaseUpdated: scheduleRefetch,
    onConversationUpdated: scheduleRefetch,
  });

  return state;
}
