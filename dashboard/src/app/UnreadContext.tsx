// UnreadContext — the single, app-level source of truth for the nav Inbox unread
// badge. Fetches GET /api/inbox?filter=unread (one row per unread contact → the
// badge count) and stays live off the SSE stream (debounced reconcile-refetch,
// same policy as every other live surface). Independent of the Inbox page's
// useInbox so there is ONE authoritative count (no divergent-count bugs).
// Degrades to null (no badge) until the C8 backend lands.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getInbox, getUnmatchedEmail, useEventStream } from '../api/index.js';

interface UnreadValue {
  /** Count of unread rows, or null when unknown/pending (render no badge). */
  unread: number | null;
  /** Count of unread UNMATCHED-email rows (the Email side-door badge), or null
   *  when unknown/pending (render no badge). NEVER counts quarantine. */
  unmatchedUnread: number | null;
}

const UnreadCtx = createContext<UnreadValue>({ unread: null, unmatchedUnread: null });
const REFETCH_DEBOUNCE_MS = 300;
const BADGE_LIMIT = 100;

export function UnreadProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [unread, setUnread] = useState<number | null>(null);
  const [unmatchedUnread, setUnmatchedUnread] = useState<number | null>(null);
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
    // fetchCount sets state only AFTER an await — a badge fetch-on-mount, not the
    // synchronous cascading-render case the rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  // --- The UNMATCHED-email badge: a SECOND independent count (the Email side-
  // door), fetched + kept-live exactly like the inbox count above but off its OWN
  // SSE event. Reads the server-computed capped `unreadCount` (NOT rows.length -
  // the server owns the unmatched-unread math; both tabs carry it). Degrades to
  // null (no badge) on 404/error, mirroring the inbox catch. ---
  const unmatchedAbortRef = useRef<AbortController | null>(null);
  const fetchUnmatchedCount = useCallback(async () => {
    unmatchedAbortRef.current?.abort();
    const controller = new AbortController();
    unmatchedAbortRef.current = controller;
    try {
      const page = await getUnmatchedEmail('unmatched', undefined, controller.signal);
      if (controller.signal.aborted) return;
      setUnmatchedUnread(page.unreadCount);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // 404 (slice not live) or any error -> no badge rather than a wrong number.
      setUnmatchedUnread(null);
    }
  }, []);

  useEffect(() => {
    // Same fetch-on-mount posture as the inbox count (state set only after await).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchUnmatchedCount();
    return () => unmatchedAbortRef.current?.abort();
  }, [fetchUnmatchedCount]);

  const unmatchedDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleUnmatchedRefetch = useCallback(() => {
    if (unmatchedDebounceRef.current !== undefined) clearTimeout(unmatchedDebounceRef.current);
    unmatchedDebounceRef.current = setTimeout(() => {
      unmatchedDebounceRef.current = undefined;
      void fetchUnmatchedCount();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchUnmatchedCount]);

  useEffect(
    () => () => {
      if (unmatchedDebounceRef.current !== undefined) clearTimeout(unmatchedDebounceRef.current);
    },
    [],
  );

  useEventStream({
    onConversationUpdated: scheduleRefetch,
    onUnmatchedEmailUpdated: scheduleUnmatchedRefetch,
  });

  return (
    <UnreadCtx.Provider value={{ unread, unmatchedUnread }}>{children}</UnreadCtx.Provider>
  );
}

export function useUnread(): UnreadValue {
  return useContext(UnreadCtx);
}
