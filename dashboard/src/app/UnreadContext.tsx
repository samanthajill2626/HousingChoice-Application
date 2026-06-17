// UnreadContext — the single, app-level source of truth for the nav Inbox unread
// badge. Fetches GET /api/inbox?filter=unread (one row per unread contact → the
// badge count) and stays live off the SSE stream (debounced reconcile-refetch,
// same policy as every other live surface). Independent of the Inbox page's
// useInbox so there is ONE authoritative count (no divergent-count bugs).
// Degrades to null (no badge) until the C8 backend lands.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getInbox, useEventStream } from '../api/index.js';

interface UnreadValue {
  /** Count of unread rows, or null when unknown/pending (render no badge). */
  unread: number | null;
}

const UnreadCtx = createContext<UnreadValue>({ unread: null });
const REFETCH_DEBOUNCE_MS = 300;
const BADGE_LIMIT = 100;

export function UnreadProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [unread, setUnread] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchCount = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const page = await getInbox({ filter: 'unread', limit: BADGE_LIMIT }, controller.signal);
      if (controller.signal.aborted) return;
      setUnread(page.rows.length);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // 404 (slice not live) or any error → no badge rather than a wrong number.
      setUnread(null);
    }
  }, []);

  useEffect(() => {
    void fetchCount();
    return () => abortRef.current?.abort();
  }, [fetchCount]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void fetchCount();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchCount]);

  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    },
    [],
  );

  useEventStream({ onConversationUpdated: scheduleRefetch });

  return <UnreadCtx.Provider value={{ unread }}>{children}</UnreadCtx.Provider>;
}

export function useUnread(): UnreadValue {
  return useContext(UnreadCtx);
}
