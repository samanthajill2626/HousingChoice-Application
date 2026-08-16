// UnreadContext - the single, app-level source of truth for the nav Inbox unread
// badge. Fetches GET /api/inbox/unread-count (a cheap, index-backed count that is
// independent of the row-list page shape) and stays live off the SSE stream
// (debounced reconcile-refetch, same policy as every other live surface, plus a
// reconcile on stream OPEN so an SSE blackout cannot leave the badge drifted).
// Independent of the Inbox page's useInbox so there is ONE authoritative count
// (no divergent-count bugs). Degrades to null (no badge) on any error.
//
// OPTIMISTIC LAYER (spec 4.7.2): the server is the reconciling authority, but a
// mark-read the operator just performed shows up in the badge IMMEDIATELY rather
// than ~2s later. Surfaces that VERIFIED unread > 0 before marking call
// noteRowsCleared([key]) beside their own optimistic patch; the displayed count
// subtracts the pending clears until a fetch that started AFTER the clear
// resolves and hands authority back to the server.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getUnmatchedEmail, getUnreadCount, useEventStream } from '../api/index.js';

interface UnreadValue {
  /** Count of unread rows, or null when unknown/pending (render no badge). */
  unread: number | null;
  /** Count of unread UNMATCHED-email rows (the Email side-door badge), or null
   *  when unknown/pending (render no badge). NEVER counts quarantine. */
  unmatchedUnread: number | null;
  /** Record an optimistic clear for each key (see unreadKeys.ts). Idempotent by
   *  key. No-op without a provider. */
  noteRowsCleared: (keys: string[]) => void;
  /** Undo those clears when the mark-read request failed. No-op without a
   *  provider. */
  rollbackRowsCleared: (keys: string[]) => void;
}

// The no-op function defaults matter: hooks that consume this context are mounted
// BARE in a dozen unit-test files, and a provider-less render must not throw.
const UnreadCtx = createContext<UnreadValue>({
  unread: null,
  unmatchedUnread: null,
  noteRowsCleared: () => {},
  rollbackRowsCleared: () => {},
});
const REFETCH_DEBOUNCE_MS = 300;
/** How long after a resolve that expired pending clears to fire ONE follow-up
 *  reconcile: the index image the server just read may still have been stale. */
const RECHECK_DELAY_MS = 2000;
/** Backstop for a clear that NO reconcile ever expires (no SSE event arrived and
 *  no refetch happened). The server is the authority; a pending clear may never
 *  outlive this window. */
const PENDING_CLEAR_TTL_MS = 10_000;

/** One optimistic clear. `startGen` is the fetch generation that was current when
 *  the clear was recorded, which is how "a fetch that STARTED AFTER this clear"
 *  is decided: wall-clock ms cannot answer that question (two events inside one
 *  millisecond are indistinguishable, and the test suite pins Date outright). */
interface PendingClear {
  startGen: number;
  at: number;
}

/** Drop clears older than the TTL. Returns true when the map changed. */
function sweepExpiredClears(map: Map<string, PendingClear>, now: number): boolean {
  let dropped = false;
  for (const [key, entry] of map) {
    if (now - entry.at >= PENDING_CLEAR_TTL_MS) {
      map.delete(key);
      dropped = true;
    }
  }
  return dropped;
}

export function UnreadProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [serverCount, setServerCount] = useState<number | null>(null);
  const [capped, setCapped] = useState(false);
  const [unmatchedUnread, setUnmatchedUnread] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The pending-clears map lives in a REF, with its SIZE mirrored into state as
  // the render trigger (and a monotonic version so an effect can see a mutation
  // that happens to leave the size unchanged). That is what lets
  // noteRowsCleared/rollbackRowsCleared be useCallback(..., []) - and their
  // identity stability is load-bearing, not a style nit: markRead's dep array
  // (useInbox) and the channel hooks' returned object both flow into consumer
  // effect deps, so a churning identity POST-loops. Rendering off the mirrored
  // size (rather than reading the ref during render) also keeps the render pure.
  const pendingClearsRef = useRef<Map<string, PendingClear>>(new Map());
  // Both are published together after any map mutation (from event handlers,
  // timers and fetch resolves - never during render). The version exists so the
  // TTL effect still re-runs on a mutation that leaves the SIZE unchanged.
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingVersion, setPendingVersion] = useState(0);
  // Bumped BEFORE each fetch starts. A resolve whose generation is no longer the
  // current one started before a newer fetch and is discarded, so a slow response
  // cannot clobber newer state; it is also how clear expiry orders itself.
  const fetchGenRef = useRef(0);
  const inFlightRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recheckRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The follow-up reconcile has to call the SAME fetch that scheduled it; it goes
  // through a ref rather than a direct self-reference (which would make the
  // callback its own dependency).
  const fetchCountRef = useRef<() => void>(() => {});

  const fetchCount = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    inFlightRef.current = true;
    try {
      const count = await getUnreadCount(controller.signal);
      if (controller.signal.aborted || gen !== fetchGenRef.current) return;
      inFlightRef.current = false;
      setServerCount(count.unreadCount);
      setCapped(count.capped);
      // EXPIRY: every clear recorded BEFORE this fetch started is now the
      // server's business. NO VALUE COMPARISON - a "did the number drop?"
      // predicate creates stuck states when the count legitimately stays put.
      // `truncated` deliberately does NOT participate: a truncated count is small
      // and real-so-far, so the optimistic layer stays on for it.
      const map = pendingClearsRef.current;
      let expired = 0;
      for (const [key, entry] of map) {
        if (entry.startGen < gen) {
          map.delete(key);
          expired += 1;
        }
      }
      if (expired > 0) {
        setPendingCount(map.size);
        setPendingVersion((v) => v + 1);
        // ONE follow-up reconcile, unless a fetch is already scheduled or on the
        // wire (then that one provides the convergence instead). THE BOUND IS
        // "at most one SCHEDULED follow-up at a time" - NOT a no-cascade
        // property: a clear recorded between scheduling and firing IS expired by
        // the follow-up and may schedule another, so continuous clicking sustains
        // a bounded chain with one pending fetch at a time.
        if (
          recheckRef.current === undefined &&
          debounceRef.current === undefined &&
          !inFlightRef.current
        ) {
          recheckRef.current = setTimeout(() => {
            recheckRef.current = undefined;
            fetchCountRef.current();
          }, RECHECK_DELAY_MS);
        }
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      if (gen !== fetchGenRef.current) return;
      inFlightRef.current = false;
      // 404 (slice not live) or any error -> no badge rather than a wrong number.
      setServerCount(null);
      setCapped(false);
    }
  }, []);

  useEffect(() => {
    fetchCountRef.current = () => void fetchCount();
    // fetchCount sets state only AFTER an await - a badge fetch-on-mount, not the
    // synchronous cascading-render case the rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchCount();
    return () => abortRef.current?.abort();
  }, [fetchCount]);

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
      if (recheckRef.current !== undefined) clearTimeout(recheckRef.current);
    },
    [],
  );

  const noteRowsCleared = useCallback((keys: string[]) => {
    const map = pendingClearsRef.current;
    const now = Date.now();
    let changed = sweepExpiredClears(map, now);
    for (const key of keys) {
      // IDEMPOTENT BY KEY: the row-click + contact-page double POST, a StrictMode
      // double-invoke, and a cross-surface duplicate all collapse onto ONE entry,
      // so one logical row can only decrement the badge once.
      if (map.has(key)) continue;
      map.set(key, { startGen: fetchGenRef.current, at: now });
      changed = true;
    }
    if (changed) {
      setPendingCount(map.size);
      setPendingVersion((v) => v + 1);
    }
  }, []);

  const rollbackRowsCleared = useCallback((keys: string[]) => {
    const map = pendingClearsRef.current;
    let changed = false;
    for (const key of keys) {
      if (map.delete(key)) changed = true;
    }
    if (changed) {
      setPendingCount(map.size);
      setPendingVersion((v) => v + 1);
    }
  }, []);

  // TTL BACKSTOP. The effect re-runs on every map mutation and returns early when
  // the map is empty, so the timer exists ONLY while clears are pending. It is
  // armed at the last mutation, so by the time it fires EVERY entry is at least
  // PENDING_CLEAR_TTL_MS old and the sweep always empties the map.
  useEffect(() => {
    if (pendingCount === 0) return;
    const timer = setTimeout(() => {
      const map = pendingClearsRef.current;
      if (sweepExpiredClears(map, Date.now())) {
        setPendingCount(map.size);
        setPendingVersion((v) => v + 1);
      }
    }, PENDING_CLEAR_TTL_MS);
    return () => clearTimeout(timer);
  }, [pendingCount, pendingVersion]);

  // --- The UNMATCHED-email badge: a SECOND independent count (the Email side-
  // door), fetched + kept-live exactly like the inbox count above but off its OWN
  // SSE event. Reads the server-computed capped `unreadCount` (NOT rows.length -
  // the server owns the unmatched-unread math; both tabs carry it). Degrades to
  // null (no badge) on 404/error, mirroring the inbox catch. It gets NO optimistic
  // layer (spec non-goal 3). ---
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
    // RECONNECT RECONCILE: the stream opening (first connect OR a reconnect after
    // a blackout) is exactly when the badge is most likely to be drifted.
    onOpen: scheduleRefetch,
  });

  // DISPLAYED COUNT. While CAPPED the subtraction is SUPPRESSED: the number is a
  // floor at BADGE_COUNT_CAP, so decrementing it would flick 99+ -> 99 -> 99+ for
  // no information. Clamped so the badge can never go negative.
  const unread =
    serverCount === null ? null : capped ? serverCount : Math.max(0, serverCount - pendingCount);

  // Memoized: every nav leaf consumes this context (NavContents.tsx), and the two
  // functions must not churn identity for their consumers' dep arrays.
  const value = useMemo<UnreadValue>(
    () => ({ unread, unmatchedUnread, noteRowsCleared, rollbackRowsCleared }),
    [unread, unmatchedUnread, noteRowsCleared, rollbackRowsCleared],
  );

  return <UnreadCtx.Provider value={value}>{children}</UnreadCtx.Provider>;
}

export function useUnread(): UnreadValue {
  return useContext(UnreadCtx);
}
