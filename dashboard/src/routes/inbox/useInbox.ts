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
  /** The server withheld group-text rows this filter would otherwise show (page
   *  one takes the newest 50; the partition walk has its own budget). The page
   *  renders the "showing the latest" affordance instead of implying the list is
   *  complete. There is no exact total by design. */
  groupsTruncated: boolean;
  /** How many group-text rows are actually ON SCREEN for this filter.
   *
   *  A26, CORRECTED by adversarial 30. A26 moved this count off the displayed
   *  list and onto the server page, which fixed the wrong half of the drift: on
   *  the Unread filter `rows` drops every row the operator marks read while the
   *  server page does not, so the notice could claim "the latest 2 unread group
   *  texts" with ZERO group rows on screen. The notice is a statement about the
   *  rendered list, so it counts the rendered list. A26's own case survives
   *  because it only ever bit on Unread: on All and Groups a marked-read row
   *  stays in the list, so this number does not tick under a standing
   *  truncation claim. `groupsTruncated` remains the server's separate,
   *  untouched statement that MORE exist than were handed down. */
  groupRowsShown: number;
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

/** Stable identity for a row: conversationId for the two multi-party kinds,
 *  contactId for contacts, phone for unknowns. The four prefixes never collide -
 *  native group texts take `gt:` because `g:` is already relay's, and the
 *  trailing branch is the UNKNOWN case, so an unhandled kind would key as `u:`
 *  (empty phone) and collide with every other unhandled row. */
export function rowKey(row: InboxRowData): string {
  if (row.kind === 'relay_group') return `g:${row.conversationId ?? ''}`;
  if (row.kind === 'group_text') return `gt:${row.conversationId ?? ''}`;
  return row.kind === 'contact' ? `c:${row.contactId ?? ''}` : `u:${row.phone ?? ''}`;
}

/** Group-text rows in a list (the basis for the truncation notice's count - see
 *  `InboxState.groupRowsShown`). */
function countGroupRows(rows: InboxRowData[]): number {
  return rows.filter((r) => r.kind === 'group_text').length;
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
  const [groupsTruncated, setGroupsTruncated] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // In-flight optimistic patches keyed by rowKey; re-applied over refetches.
  const [pending, setPending] = useState<Map<string, Pending>>(new Map());

  const abortRef = useRef<AbortController | null>(null);
  // Bumped on every committed optimistic mutation; a first-page refetch that
  // started before the commit (so it read pre-mutation server state) is then
  // discarded instead of clobbering the commit.
  const genRef = useRef(0);
  // C2 / spec 11's defense-in-depth pair. `loadMore` gets its OWN abort handle
  // and its own generation, both keyed on the FILTER rather than on optimistic
  // mutations: a page fetched for the previous filter must never append to the
  // new filter's list, and its cursor addresses a different DynamoDB partition,
  // so installing it would 400 the next Load more.
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const filterGenRef = useRef(0);
  // The SSE-RECONCILE axis (adversarial 29). Bumped whenever a first-page read
  // COMMITS - the initial load, a retry, or a debounced reconcile - so an
  // in-flight `loadMore` can tell that the list it was a continuation of has
  // been replaced underneath it. Without it, the page appends to a list it does
  // not continue (duplicate rowKeys, silently skipped rows - `rows` is not
  // deduped) and installs a cursor addressing a position the list no longer
  // holds, which the next Load more 400s on. The filter axis already had this
  // guard; this is the same guard on the other axis that can move `base`.
  const firstPageGenRef = useRef(0);

  const fetchFirstPage = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = genRef.current;
    try {
      const pageData = await getInbox({ filter, limit: PAGE_LIMIT }, controller.signal);
      if (controller.signal.aborted || gen !== genRef.current) return;
      firstPageGenRef.current += 1;
      setBase(pageData.rows);
      setCursor(pageData.nextCursor);
      setGroupsTruncated(pageData.groupsTruncated === true);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        // C8 backend slice isn't live yet → honest pending state (not an error).
        firstPageGenRef.current += 1;
        setBase([]);
        setCursor(null);
        setGroupsTruncated(false);
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
    // A NEW filter is a new partition: bump the loadMore generation and abort any
    // in-flight page BEFORE the reset, so a response already on the wire cannot
    // append to the list we are about to build (C2).
    filterGenRef.current += 1;
    loadMoreAbortRef.current?.abort();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    setBase([]);
    setCursor(null);
    setGroupsTruncated(false);
    setLoadingMore(false);
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
    // Same abort + generation pattern as fetchFirstPage above (C2). The filter
    // and cursor are captured at callback creation, so without this a tab switch
    // mid-flight appends the OLD filter's rows and installs a cursor addressing
    // the OLD partition - which the server tag-check then 400s into the empty
    // .catch below, leaving contaminated rows and a permanently dead Load more.
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    const gen = filterGenRef.current;
    const firstPageGen = firstPageGenRef.current;
    const filterStale = (): boolean => controller.signal.aborted || gen !== filterGenRef.current;
    // The SECOND axis (adversarial 29): a first-page read committed while this
    // page was on the wire, so `base` is no longer the list this page continues
    // and `cursor` is no longer the position it was fetched from. Kept SEPARATE
    // from `filterStale` because the two want different cleanup: a filter change
    // has its own effect that already reset `loadingMore`, whereas nothing else
    // clears it here - leaving it set would spin Load more forever.
    const reconcileStale = (): boolean => firstPageGen !== firstPageGenRef.current;
    getInbox({ filter, limit: PAGE_LIMIT, cursor }, controller.signal)
      .then((pageData) => {
        if (filterStale() || reconcileStale()) return;
        setBase((prev) => [...prev, ...pageData.rows]);
        setCursor(pageData.nextCursor);
      })
      .catch(() => {
        /* keep the cursor so the user can retry "Load more" */
      })
      .finally(() => {
        // The filter-change effect already cleared the flag for the new filter;
        // clearing it again from a stale page would re-enable the button under a
        // page that IS in flight. A reconcile-stale page DOES clear it: the
        // reconcile installed a fresh cursor, so Load more is live again.
        if (!filterStale()) setLoadingMore(false);
      });
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
      // success). A MULTI-PARTY row (relay_group / group_text) marks read through
      // its OWN conversation (POST /api/conversations/:id/read), NOT the
      // contact/phone fan-out - the inbox mark-read routes both fan out over a
      // contact's participant-keyed threads, which a group thread has none of.
      let read: (() => Promise<void>) | undefined;
      if (row.kind === 'relay_group' || row.kind === 'group_text') {
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

  return {
    status,
    rows,
    groupsTruncated,
    // Counted off the RENDERED list (adversarial 30) - see `InboxState`.
    groupRowsShown: countGroupRows(rows),
    hasMore: cursor !== null,
    loadingMore,
    loadMore,
    retry,
    markRead,
  };
}
