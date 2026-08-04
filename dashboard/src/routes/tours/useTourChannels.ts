// useTourChannels - resolves the tour's THREE conversation channels (group text,
// tenant 1:1, landlord/PM 1:1) and keeps their unread dots live via
// `conversation.updated`.
//
//   - group   = tour.groupThreadId (absent until [Open group text] provisions it)
//               -> {conversationId, unread}: ONE relay thread the Group tab mounts.
//   - tenant  = the tenant contact -> {unread} ONLY: the SUM of unread across the
//               contact's NON-relay conversations on the inbox page (every phone
//               AND email thread they own), mirroring their inbox row.
//   - landlord= the unit.landlordId contact, same person-shaped rule (the PM slot
//               when tourType='pm_team' - same person record).
//
// The 1:1 channels carry NO conversationId: their pane is the shared contact
// comms surface, which is keyed by CONTACT and fetches the person's whole
// timeline. Only the group channel resolves an id; create-on-demand for it
// (createTourRelay) injects the fresh id via setGroupConversationId so the thread
// mounts immediately.
//
// mark-read is CENTRALIZED here on purpose, in the two shapes the two channel
// kinds need: markGroupRead marks the SINGLE relay conversation read
// (POST /api/conversations/:id/read) and markPersonRead fires the contact-wide
// inbox fan-out (POST /api/inbox/:contactId/read - contact-page parity: viewing
// a person's tab clears every thread they own). Both zero the tab's unread
// locally FIRST so the dot clears at once and the consumer's per-render effect
// cannot loop.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getConversations,
  markConversationRead,
  markInboxRead,
  useEventStream,
  type ConversationSummary,
  type ConversationUpdatedEvent,
  type Tour,
} from '../../api/index.js';
import { involvesContact } from '../contact/useContactTimeline.js';

export type TourChannelKey = 'group' | 'tenant' | 'landlord';
/** The two channels that resolve to a PERSON rather than one conversation. */
export type TourPersonKey = 'tenant' | 'landlord';

export interface TourGroupChannel {
  /** The resolved conversationId, or null when no group thread exists yet. */
  conversationId: string | null;
  /** Unread messages on that conversation (drives the tab's unread dot). */
  unread: number;
}

export interface TourPersonChannel {
  /** Summed unread across the contact's non-relay conversations (their inbox
   *  row), which is exactly the set markPersonRead's fan-out clears. */
  unread: number;
}

export interface TourChannelsState {
  status: 'loading' | 'ready' | 'error';
  group: TourGroupChannel;
  tenant: TourPersonChannel;
  landlord: TourPersonChannel;
  /** Inject a just-provisioned GROUP conversationId (open-group). */
  setGroupConversationId: (conversationId: string) => void;
  /** Mark the group's single conversation read + zero its unread locally. The
   *  caller passes the channel's CURRENT conversationId + unread (the values from
   *  the render it fires in) so mark-read never depends on a ref a PARENT effect
   *  writes only AFTER this consumer's child effect runs. No-ops unless a resolved
   *  conversation has unread > 0. */
  markGroupRead: (conversationId: string | null, unread: number) => void;
  /** Mark a PERSON's comms read (the inbox fan-out) + zero that tab's unread
   *  locally. No-ops when the contact is unresolved or the tab has nothing
   *  unread - the consumer's effect re-runs on every render, so that guard plus
   *  the local zero BEFORE the network call is what keeps it from looping. */
  markPersonRead: (key: TourPersonKey, contactId: string | undefined, unread: number) => void;
}

interface Committed {
  status: 'loading' | 'ready' | 'error';
  group: TourGroupChannel;
  tenant: TourPersonChannel;
  landlord: TourPersonChannel;
  /** Which tourId the committed state describes. */
  forId: string;
}

/** Debounce window (ms) for SSE-triggered refetches - coalesces a burst of
 *  conversation events into one getConversations re-resolve. */
const REFETCH_DEBOUNCE_MS = 300;

/** Total unread across the contact's NON-relay conversations on this inbox page.
 *  A relay_group NEVER counts - its unread belongs to the Group tab, and the 1:1
 *  fan-out read cannot clear it (relay groups front the POOL number, so the
 *  contact's threads never include one). An email-keyed thread is recognised by
 *  the participants ROSTER alone: `participant_email` is not a dashboard field.
 *  HONEST LIMITATION: the inbox page is the first 50 OPEN conversations, so a
 *  thread off that page is invisible to the dot. */
function sumUnread(summaries: ConversationSummary[], contactId: string): number {
  return summaries.reduce(
    (total, s) =>
      s.type !== 'relay_group' && involvesContact(s.participants, contactId)
        ? total + s.unread_count
        : total,
    0,
  );
}

/** Resolve the three channels from a fresh inbox page. The GROUP keeps the
 *  preserve-an-id-we-already-hold merge (a just-provisioned thread is not on the
 *  inbox page yet, and it must never unmount); the 1:1s are pure sums. */
function resolveChannels(
  prev: Pick<Committed, 'group' | 'tenant' | 'landlord'>,
  groupThreadId: string | undefined,
  tenantId: string,
  landlordId: string | undefined,
  summaries: ConversationSummary[],
): Pick<Committed, 'group' | 'tenant' | 'landlord'> {
  const byId = (id: string): ConversationSummary | undefined =>
    summaries.find((s) => s.conversationId === id);
  const merge = (prevCh: TourGroupChannel, id: string | null): TourGroupChannel => {
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
  return {
    group: merge(prev.group, groupThreadId ?? null),
    tenant: { unread: sumUnread(summaries, tenantId) },
    landlord: { unread: landlordId ? sumUnread(summaries, landlordId) : 0 },
  };
}

function initialChannels(groupThreadId: string | undefined): Pick<Committed, 'group' | 'tenant' | 'landlord'> {
  return {
    group: { conversationId: groupThreadId ?? null, unread: 0 },
    tenant: { unread: 0 },
    landlord: { unread: 0 },
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

  const setGroupConversationId = useCallback(
    (conversationId: string) => {
      setState((prev) =>
        prev.forId !== tourId ? prev : { ...prev, group: { conversationId, unread: 0 } },
      );
    },
    [tourId],
  );

  // markGroupRead takes the channel's CURRENT conversationId + unread as ARGUMENTS
  // (from the consumer that has them at effect time) instead of reading a ref: the
  // ref mirror was written in a PARENT passive effect that runs AFTER the child
  // mark-read effect, so on the loading->ready commit the ref was stale (null id /
  // unread 0) and the INITIAL active tab never auto-marked-read. Zeroing unread
  // locally makes the immediate re-render a no-op (no fire loop); it fires again
  // only when a real event raises unread. Single conversation only - the group's
  // read must NEVER fan out (that would clear the sibling 1:1 tabs).
  const markGroupRead = useCallback((conversationId: string | null, unread: number) => {
    if (conversationId === null || unread <= 0) return;
    setState((prev) => (prev.group.unread === 0 ? prev : { ...prev, group: { ...prev.group, unread: 0 } }));
    void markConversationRead(conversationId).catch(() => {
      /* best-effort - a failed mark-read must not break the view */
    });
  }, []);

  // markPersonRead is the CONTACT fan-out (the contact page's own mark-read):
  // viewing a person's tab clears the unread on every thread they own, which is
  // exactly the set the tab's summed dot counts. Same ordering contract as
  // markGroupRead - guard, zero LOCALLY, then fire - and the guard is what stops
  // the consumer's every-render effect from POSTing in a loop.
  const markPersonRead = useCallback(
    (key: TourPersonKey, contactId: string | undefined, unread: number) => {
      if (contactId === undefined || unread <= 0) return;
      setState((prev) => (prev[key].unread === 0 ? prev : { ...prev, [key]: { unread: 0 } }));
      void markInboxRead({ contactId }).catch(() => {
        /* best-effort - a failed mark-read must not break the view */
      });
    },
    [],
  );

  if (state.forId !== tourId) {
    return {
      status: 'loading',
      ...initialChannels(groupThreadId),
      setGroupConversationId,
      markGroupRead,
      markPersonRead,
    };
  }
  return {
    status: state.status,
    group: state.group,
    tenant: state.tenant,
    landlord: state.landlord,
    setGroupConversationId,
    markGroupRead,
    markPersonRead,
  };
}
