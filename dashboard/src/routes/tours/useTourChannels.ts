// useTourChannels - resolves the tour's THREE conversation channels (group text,
// tenant 1:1, landlord/PM 1:1) to their conversationIds + unread counts, and
// keeps the unread dots live via `conversation.updated`.
//
//   - group   = tour.groupThreadId (absent until [Open group text] provisions it).
//   - tenant  = the tenant contact's most-recent NON-relay conversation.
//   - landlord= the unit.landlordId contact's most-recent NON-relay conversation
//               (the PM slot when tourType='pm_team' - same person record).
//
// A channel with no thread yet resolves to conversationId=null; create-on-demand
// (ensureContactConversation on first 1:1 send / createTourRelay for the group)
// injects the fresh id via setConversationId so the thread mounts immediately.
//
// mark-read is CENTRALIZED here on purpose: markRead(key) marks the SINGLE
// conversation read (POST /api/conversations/:id/read) and zeroes that channel's
// unread locally so the tab dot clears at once. It MUST NOT use the contact-wide
// inbox fan-out read (markInboxRead) - that would clear the contact's OTHER
// threads, wiping a sibling channel tab's unread.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getConversations,
  markConversationRead,
  useEventStream,
  type ConversationSummary,
  type ConversationUpdatedEvent,
  type Tour,
} from '../../api/index.js';
import { involvesContact } from '../contact/useContactTimeline.js';

export type TourChannelKey = 'group' | 'tenant' | 'landlord';

export interface TourChannelInfo {
  /** The resolved conversationId, or null when no thread exists yet. */
  conversationId: string | null;
  /** Unread messages on that conversation (drives the tab's unread dot). */
  unread: number;
}

export interface TourChannelsState {
  status: 'loading' | 'ready' | 'error';
  group: TourChannelInfo;
  tenant: TourChannelInfo;
  landlord: TourChannelInfo;
  /** Inject a just-resolved conversationId (open-group / create-on-first-send). */
  setConversationId: (key: TourChannelKey, conversationId: string) => void;
  /** Mark a channel's single conversation read + zero its unread locally. The
   *  caller passes the channel's CURRENT conversationId + unread (the values from
   *  the render it fires in) so mark-read never depends on a ref a PARENT effect
   *  writes only AFTER this consumer's child effect runs. No-ops unless a resolved
   *  conversation has unread > 0. */
  markRead: (key: TourChannelKey, conversationId: string | null, unread: number) => void;
}

interface Committed {
  status: 'loading' | 'ready' | 'error';
  group: TourChannelInfo;
  tenant: TourChannelInfo;
  landlord: TourChannelInfo;
  /** Which tourId the committed state describes. */
  forId: string;
}

/** Debounce window (ms) for SSE-triggered refetches - coalesces a burst of
 *  conversation events into one getConversations re-resolve. */
const REFETCH_DEBOUNCE_MS = 300;

/** Resolve the three channels from a fresh inbox page, preserving an id we
 *  already hold when the fresh page can't resolve one yet (a create-on-demand
 *  thread not on the first inbox page) so the open thread never unmounts. */
function resolveChannels(
  prev: Pick<Committed, 'group' | 'tenant' | 'landlord'>,
  groupThreadId: string | undefined,
  tenantId: string,
  landlordId: string | undefined,
  summaries: ConversationSummary[],
): Pick<Committed, 'group' | 'tenant' | 'landlord'> {
  const byId = (id: string): ConversationSummary | undefined =>
    summaries.find((s) => s.conversationId === id);
  const one21 = (contactId: string): ConversationSummary | undefined =>
    summaries.find((s) => s.type !== 'relay_group' && involvesContact(s.participants, contactId));
  const merge = (prevCh: TourChannelInfo, id: string | null): TourChannelInfo => {
    if (id) {
      const s = byId(id);
      return { conversationId: id, unread: s ? s.unread_count : prevCh.unread };
    }
    if (prevCh.conversationId) {
      const s = byId(prevCh.conversationId);
      return { conversationId: prevCh.conversationId, unread: s ? s.unread_count : prevCh.unread };
    }
    return { conversationId: null, unread: 0 };
  };
  const tenantHit = one21(tenantId);
  const landlordHit = landlordId ? one21(landlordId) : undefined;
  return {
    group: merge(prev.group, groupThreadId ?? null),
    tenant: merge(prev.tenant, tenantHit?.conversationId ?? null),
    landlord: merge(prev.landlord, landlordHit?.conversationId ?? null),
  };
}

function initialChannels(groupThreadId: string | undefined): Pick<Committed, 'group' | 'tenant' | 'landlord'> {
  return {
    group: { conversationId: groupThreadId ?? null, unread: 0 },
    tenant: { conversationId: null, unread: 0 },
    landlord: { conversationId: null, unread: 0 },
  };
}

export function useTourChannels(tour: Tour, landlordId: string | undefined): TourChannelsState {
  const tourId = tour.tourId;
  const tenantId = tour.tenantId;
  const groupThreadId = tour.groupThreadId;

  const [state, setState] = useState<Committed>(() => ({
    status: 'loading',
    ...initialChannels(groupThreadId),
    forId: tourId,
  }));

  const abortRef = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    try {
      const page = await getConversations(signal);
      if (signal.aborted) return;
      setState((prev) => {
        const base =
          prev.forId === tourId
            ? prev
            : { status: 'loading' as const, ...initialChannels(groupThreadId), forId: tourId };
        const resolved = resolveChannels(base, groupThreadId, tenantId, landlordId, page.conversations);
        return { status: 'ready', ...resolved, forId: tourId };
      });
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setState((prev) =>
        prev.forId === tourId
          ? { ...prev, status: 'error' }
          : { status: 'error', ...initialChannels(groupThreadId), forId: tourId },
      );
    }
  }, [tourId, groupThreadId, tenantId, landlordId]);

  useEffect(() => {
    // fetchNow sets state only after an await (never synchronously).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchNow();
    return () => abortRef.current?.abort();
  }, [fetchNow]);

  // Debounced SSE refetch: a conversation.updated keeps unread dots live AND
  // picks up a newly-created 1:1 thread once it lands on the inbox.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void fetchNow();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchNow]);
  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    },
    [],
  );
  const onConversationUpdated = useCallback(
    (_ev: ConversationUpdatedEvent) => {
      scheduleRefetch();
    },
    [scheduleRefetch],
  );
  useEventStream({ onConversationUpdated });

  const setConversationId = useCallback(
    (key: TourChannelKey, conversationId: string) => {
      setState((prev) =>
        prev.forId !== tourId ? prev : { ...prev, [key]: { conversationId, unread: 0 } },
      );
    },
    [tourId],
  );

  // markRead takes the channel's CURRENT conversationId + unread as ARGUMENTS
  // (from the consumer that has them at effect time) instead of reading a ref: the
  // ref mirror was written in a PARENT passive effect that runs AFTER the child
  // mark-read effect, so on the loading->ready commit the ref was stale (null id /
  // unread 0) and the INITIAL active tab never auto-marked-read. Zeroing unread
  // locally makes the immediate re-render a no-op (no fire loop); it fires again
  // only when a real event raises unread. Single conversation only - NEVER the
  // contact-wide inbox fan-out (that would clear sibling channel tabs).
  const markRead = useCallback((key: TourChannelKey, conversationId: string | null, unread: number) => {
    if (conversationId === null || unread <= 0) return;
    setState((prev) => (prev[key].unread === 0 ? prev : { ...prev, [key]: { ...prev[key], unread: 0 } }));
    void markConversationRead(conversationId).catch(() => {
      /* best-effort - a failed mark-read must not break the view */
    });
  }, []);

  if (state.forId !== tourId) {
    return {
      status: 'loading',
      ...initialChannels(groupThreadId),
      setConversationId,
      markRead,
    };
  }
  return {
    status: state.status,
    group: state.group,
    tenant: state.tenant,
    landlord: state.landlord,
    setConversationId,
    markRead,
  };
}
