// useInbox — owns the inbox's conversation list: the first page (loaded via the
// shared useApi), cursor pagination ("load more"), and live updates from the SSE
// stream. Kept apart from the view so the screen stays declarative.
//
// Live-update policy (documented per the M1.4 brief):
//   - 'conversation.updated' for a conversation ALREADY in the list: patch the
//     row in place (preview / unread_count / last_activity_at) and re-sort so it
//     bubbles to the top — no network call.
//   - 'conversation.updated' for a conversation NOT in the list (e.g. a brand-new
//     thread, or one past the loaded pages): refetch the FIRST page and merge it
//     over the head of the current list. Simple and correct: the server returns
//     the inbox newest-activity-first, so a refetch of page one surfaces the new
//     row at the top while preserving any extra pages the user already loaded.
//     We coalesce bursts of such events into a single refetch.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  listConversations,
  useApi,
  type ConversationSummary,
  type ConversationUpdatedEvent,
} from '../../api/index.js';

const PAGE_LIMIT = 30;
/** Debounce window for coalescing "unknown conversation" refetch triggers. */
const REFETCH_DEBOUNCE_MS = 400;

export interface InboxState {
  conversations: ConversationSummary[];
  /** First-page load (initial + retry). */
  loading: boolean;
  /** First-page load error (null once a page has loaded). */
  error: ApiError | undefined;
  /** Re-run the first-page load (retry button). */
  retry: () => void;
  /** Whether another page is available. */
  hasMore: boolean;
  /** A subsequent page is currently loading. */
  loadingMore: boolean;
  loadMore: () => void;
  /** Apply a live conversation.updated event. */
  applyUpdate: (event: ConversationUpdatedEvent) => void;
}

/** Newest-activity-first, matching the server's inbox ordering. */
function sortByActivity(rows: ConversationSummary[]): ConversationSummary[] {
  return [...rows].sort(
    (a, b) => new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime(),
  );
}

export function useInbox(): InboxState {
  // First page via the shared GET hook (aborts on unmount; refetch = retry).
  const firstPage = useApi(
    (signal) => listConversations({ status: 'open', limit: PAGE_LIMIT }, signal),
    [],
  );

  const [extra, setExtra] = useState<ConversationSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Live patches applied on top of the fetched data, keyed by conversationId.
  const [patches, setPatches] = useState<Map<string, ConversationUpdatedEvent>>(new Map());

  // Reset paged/patched state whenever the first page reloads (initial + retry).
  useEffect(() => {
    if (firstPage.data) {
      setExtra([]);
      setCursor(firstPage.data.nextCursor);
      setPatches(new Map());
    }
  }, [firstPage.data]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    listConversations({ status: 'open', limit: PAGE_LIMIT, cursor })
      .then((page) => {
        setExtra((prev) => [...prev, ...page.conversations]);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        // Keep the cursor so the user can try "Load more" again.
      })
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore]);

  // --- Live updates ---------------------------------------------------------
  // A ref view of the currently displayed ids, so the SSE handler can decide
  // "in list?" without being re-created on every render.
  const knownIdsRef = useRef<Set<string>>(new Set());
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const applyUpdate = useCallback(
    (event: ConversationUpdatedEvent) => {
      if (knownIdsRef.current.has(event.conversationId)) {
        // Known row — patch in place; re-sort happens at assembly time.
        setPatches((prev) => {
          const next = new Map(prev);
          next.set(event.conversationId, event);
          return next;
        });
        return;
      }
      // Unknown conversation — coalesce into one first-page refetch.
      if (refetchTimerRef.current !== undefined) clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = setTimeout(() => {
        firstPage.refetch();
      }, REFETCH_DEBOUNCE_MS);
    },
    [firstPage],
  );

  useEffect(
    () => () => {
      if (refetchTimerRef.current !== undefined) clearTimeout(refetchTimerRef.current);
    },
    [],
  );

  // Assemble the displayed list: fetched rows + extra pages, with live patches
  // merged in, de-duped, and sorted newest-first.
  const base = [...(firstPage.data?.conversations ?? []), ...extra];
  const byId = new Map<string, ConversationSummary>();
  for (const row of base) {
    const patch = patches.get(row.conversationId);
    byId.set(
      row.conversationId,
      patch
        ? {
            ...row,
            last_activity_at: patch.last_activity_at,
            unread_count: patch.unread_count,
            // Merge type + assignment from the event so the needs-review chip
            // and Assigned chip re-evaluate live (e.g. unknown_1to1 → tenant_1to1
            // after triage, or assignment changing).
            type: patch.type,
            assignment: patch.assignment,
            ...(patch.preview !== undefined && { preview: patch.preview }),
          }
        : row,
    );
  }
  const conversations = sortByActivity([...byId.values()]);
  knownIdsRef.current = new Set(byId.keys());

  return {
    conversations,
    loading: firstPage.loading && firstPage.data === undefined,
    error: firstPage.error,
    retry: firstPage.refetch,
    hasMore: cursor !== null,
    loadingMore,
    loadMore,
    applyUpdate,
  };
}
