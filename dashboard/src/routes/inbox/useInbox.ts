// useInbox — owns the entity-centric inbox list for the active filter: the first
// page (GET /api/inbox), cursor "load more", optimistic mark-read / assign with
// rollback, and live updates. Degrades to an honest 'pending' state until the C8
// backend slice lands (GET /api/inbox 404s).
//
// Live-update policy: the SSE `conversation.updated` event is PER-CONVERSATION
// and carries no contactId, so it cannot soundly patch an aggregated CONTACT
// row. Per the design spec ("treat either event as 'something changed,
// reconcile'"), any inbox-affecting event schedules a debounced refetch of the
// current filter's first page — the proven useToday policy. A future row-keyed
// `inbox.updated` event would enable no-network patch-in-place (see the plan's
// contract notes). Self-initiated mark-read/assign ARE patched optimistically
// (we know the row), re-applied over a racing refetch while in flight, and
// rolled back on failure.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  assignInbox,
  getInbox,
  markInboxRead,
  useEventStream,
  type InboxFilter,
  type InboxRow as InboxRowData,
} from '../../api/index.js';

export type InboxStatus = 'loading' | 'pending' | 'ready' | 'error';

/** An in-flight optimistic mutation patch for one row (re-applied over refetches
 *  until the request settles). */
interface Pending {
  unreadCount?: number;
  assignment?: { userId: string; name: string } | null;
}

export interface InboxState {
  status: InboxStatus;
  rows: InboxRowData[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
  /** Optimistically mark a row's comms read (also called on row open). No-op if
   *  already read or the row can't be addressed. */
  markRead: (row: InboxRowData) => void;
  /** Optimistically set (userId) / clear (userId=null) a CONTACT row's
   *  assignment; `name` is the optimistic display name. No-op on unknown rows. */
  assign: (row: InboxRowData, userId: string | null, name: string) => void;
}

const PAGE_LIMIT = 30;
/** Debounce window (ms) for SSE-triggered reconcile-refetches — coalesces a
 *  burst of conversation.updated events into one refetch (matches useToday). */
const REFETCH_DEBOUNCE_MS = 300;

/** Stable identity for a row: contactId for contacts, phone for unknowns. */
export function rowKey(row: InboxRowData): string {
  return row.kind === 'contact' ? `c:${row.contactId ?? ''}` : `u:${row.phone ?? ''}`;
}

/** Newest-activity-first, matching the server's inbox ordering. */
function sortByActivity(rows: InboxRowData[]): InboxRowData[] {
  return [...rows].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
}

export function useInbox(filter: InboxFilter): InboxState {
  const [status, setStatus] = useState<InboxStatus>('loading');
  const [base, setBase] = useState<InboxRowData[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // In-flight optimistic patches keyed by rowKey; re-applied over refetches.
  const [pending, setPending] = useState<Map<string, Pending>>(new Map());

  const abortRef = useRef<AbortController | null>(null);

  const fetchFirstPage = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const pageData = await getInbox({ filter, limit: PAGE_LIMIT }, controller.signal);
      if (controller.signal.aborted) return;
      setBase(pageData.rows);
      setCursor(pageData.nextCursor);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        // C8 backend slice isn't live yet → honest pending state (not an error).
        setBase([]);
        setCursor(null);
        setStatus('pending');
        return;
      }
      setStatus('error');
    }
  }, [filter]);

  // Initial load + full reload whenever the filter changes.
  useEffect(() => {
    setStatus('loading');
    setBase([]);
    setCursor(null);
    setPending(new Map());
    void fetchFirstPage();
    return () => abortRef.current?.abort();
  }, [fetchFirstPage]);

  const retry = useCallback(() => {
    setStatus('loading');
    void fetchFirstPage();
  }, [fetchFirstPage]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    getInbox({ filter, limit: PAGE_LIMIT, cursor })
      .then((pageData) => {
        setBase((prev) => [...prev, ...pageData.rows]);
        setCursor(pageData.nextCursor);
      })
      .catch(() => {
        /* keep the cursor so the user can retry "Load more" */
      })
      .finally(() => setLoadingMore(false));
  }, [filter, cursor, loadingMore]);

  // --- SSE: debounced reconcile-refetch of the current filter's first page ---
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void fetchFirstPage();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchFirstPage]);

  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    },
    [],
  );

  useEventStream({ onConversationUpdated: scheduleRefetch });

  // --- Optimistic mutations -------------------------------------------------
  const setPatch = useCallback((key: string, patch: Pending) => {
    setPending((prev) => {
      const next = new Map(prev);
      next.set(key, { ...next.get(key), ...patch });
      return next;
    });
  }, []);
  const clearPatch = useCallback((key: string) => {
    setPending((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const markRead = useCallback(
    (row: InboxRowData) => {
      if (row.unreadCount === 0) return;
      const key = rowKey(row);
      const target =
        row.kind === 'contact' && row.contactId !== undefined
          ? ({ contactId: row.contactId } as const)
          : row.phone !== undefined
            ? ({ phone: row.phone } as const)
            : undefined;
      if (target === undefined) return; // unaddressable → don't fake success
      setPatch(key, { unreadCount: 0 });
      markInboxRead(target)
        .then(() => {
          // Commit to base so clearing the patch doesn't reveal a stale count.
          setBase((prev) => prev.map((r) => (rowKey(r) === key ? { ...r, unreadCount: 0 } : r)));
        })
        .catch(() => {
          /* rollback: dropping the patch restores base's original count */
        })
        .finally(() => clearPatch(key));
    },
    [setPatch, clearPatch],
  );

  const assign = useCallback(
    (row: InboxRowData, userId: string | null, name: string) => {
      if (row.kind !== 'contact' || row.contactId === undefined) return;
      const key = rowKey(row);
      const optimistic = userId === null ? null : { userId, name };
      setPatch(key, { assignment: optimistic });
      assignInbox(row.contactId, userId)
        .then(() => {
          setBase((prev) =>
            prev.map((r) => (rowKey(r) === key ? { ...r, assignment: optimistic ?? undefined } : r)),
          );
        })
        .catch(() => {
          /* rollback */
        })
        .finally(() => clearPatch(key));
    },
    [setPatch, clearPatch],
  );

  // --- Assemble the displayed rows ------------------------------------------
  const patched = base.map((row) => {
    const p = pending.get(rowKey(row));
    if (p === undefined) return row;
    return {
      ...row,
      ...(p.unreadCount !== undefined && { unreadCount: p.unreadCount }),
      ...(p.assignment !== undefined && { assignment: p.assignment ?? undefined }),
    };
  });
  // On the Unread filter a row optimistically marked read drops out immediately,
  // so the list (and the "all caught up" empty state) stay in sync with the action.
  const visible = filter === 'unread' ? patched.filter((r) => r.unreadCount > 0) : patched;
  const rows = sortByActivity(visible);

  return { status, rows, hasMore: cursor !== null, loadingMore, loadMore, retry, markRead, assign };
}
