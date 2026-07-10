// useInbox — owns the entity-centric inbox list for the active filter: the first
// page (GET /api/inbox), cursor "load more", optimistic mark-read with
// rollback, and live updates. Degrades to an honest 'pending' state until the C8
// backend slice lands (GET /api/inbox 404s).
//
// Live-update policy: the SSE `conversation.updated` event is PER-CONVERSATION
// and carries no contactId, so it cannot soundly patch an aggregated CONTACT
// row. Per the design spec ("treat either event as 'something changed,
// reconcile'"), any inbox-affecting event schedules a debounced refetch of the
// current filter's first page — the proven useToday policy. A future row-keyed
// `inbox.updated` event would enable no-network patch-in-place (see the plan's
// contract notes). Self-initiated mark-read IS patched optimistically
// (we know the row), re-applied over a racing refetch while in flight, and
// rolled back on failure.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getInbox,
  markConversationRead,
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
}

const PAGE_LIMIT = 30;
/** Debounce window (ms) for SSE-triggered reconcile-refetches — coalesces a
 *  burst of conversation.updated events into one refetch (matches useToday). */
const REFETCH_DEBOUNCE_MS = 300;

/** Stable identity for a row: conversationId for relay groups, contactId for
 *  contacts, phone for unknowns. The three prefixes never collide. */
export function rowKey(row: InboxRowData): string {
  if (row.kind === 'relay_group') return `g:${row.conversationId ?? ''}`;
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
  // Bumped on every committed optimistic mutation; a first-page refetch that
  // started before the commit (so it read pre-mutation server state) is then
  // discarded instead of clobbering the commit.
  const genRef = useRef(0);

  const fetchFirstPage = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = genRef.current;
    try {
      const pageData = await getInbox({ filter, limit: PAGE_LIMIT }, controller.signal);
      if (controller.signal.aborted || gen !== genRef.current) return;
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

  // Initial load + full reload whenever the filter changes. The synchronous
  // reset clears four independent state atoms (status/base/cursor/pending) on a
  // filter change; folding them into one derived state would obscure this hook's
  // gen-ref race handling, so this reset-on-key-change is suppressed deliberately.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
  // Clear only the field this mutation owns - so concurrent overlays on the same
  // row don't wipe each other's still-in-flight state.
  const clearPatch = useCallback((key: string, field: keyof Pending) => {
    setPending((prev) => {
      const entry = prev.get(key);
      if (entry === undefined || !(field in entry)) return prev;
      const next = new Map(prev);
      const remaining = { ...entry };
      delete remaining[field];
      if (Object.keys(remaining).length === 0) next.delete(key);
      else next.set(key, remaining);
      return next;
    });
  }, []);

  const markRead = useCallback(
    (row: InboxRowData) => {
      if (row.unreadCount === 0) return;
      const key = rowKey(row);
      // Resolve the read action per KIND (bail if unaddressable — don't fake
      // success). A relay_group row marks read through its OWN conversation
      // (POST /api/conversations/:id/read), NOT the contact/phone fan-out.
      let read: (() => Promise<void>) | undefined;
      if (row.kind === 'relay_group') {
        if (row.conversationId !== undefined) {
          const conversationId = row.conversationId;
          read = () => markConversationRead(conversationId);
        }
      } else if (row.kind === 'contact' && row.contactId !== undefined) {
        const contactId = row.contactId;
        read = () => markInboxRead({ contactId });
      } else if (row.phone !== undefined) {
        const phone = row.phone;
        read = () => markInboxRead({ phone });
      }
      if (read === undefined) return; // unaddressable → don't fake success
      setPatch(key, { unreadCount: 0 });
      read()
        .then(() => {
          genRef.current += 1; // commit wins over any in-flight pre-commit refetch
          // Commit to base so clearing the patch doesn't reveal a stale count.
          setBase((prev) => prev.map((r) => (rowKey(r) === key ? { ...r, unreadCount: 0 } : r)));
        })
        .catch(() => {
          /* rollback: dropping the patch restores base's original count */
        })
        .finally(() => clearPatch(key, 'unreadCount'));
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
    };
  });
  // On the Unread filter a row optimistically marked read drops out immediately,
  // so the list (and the "all caught up" empty state) stay in sync with the action.
  const visible = filter === 'unread' ? patched.filter((r) => r.unreadCount > 0) : patched;
  const rows = sortByActivity(visible);

  return { status, rows, hasMore: cursor !== null, loadingMore, loadMore, retry, markRead };
}
