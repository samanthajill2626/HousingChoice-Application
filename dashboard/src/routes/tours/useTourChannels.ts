// useTourChannels - resolves the tour's conversation channels (the relay group +
// ONE 1:1 per person on the tour) and keeps their unread dots live via
// `conversation.updated`.
//
//   - group  = tour.groupThreadId (absent until [Open relay group] provisions it)
//              -> {conversationId, unread}: ONE relay thread the Group tab mounts.
//   - people = one channel per PersonChannelInput the CALLER passes
//              ({contactId, label}) -> {unread} on top: the SUM of unread across
//              that contact's NON-relay conversations on the inbox page (every
//              phone AND email thread they own), mirroring their inbox row.
//
// The people list is CALLER-OWNED and keyed by contactId - there are no fixed
// 'tenant' / 'landlord' slots any more (contact-rosters spec 6.6, slice 2). The
// tour page passes the ids it already renders (tour.tenantId + the unit's
// landlordId when there is one), never a phone-gated resolver: a tenant with no
// mobile number is still on the tour and keeps their tab. Slice 3 swaps the same
// input for the resolved ROSTER without this hook changing. A label is the
// person's DISPLAY NAME and nothing else - never a role word.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getConversations,
  markConversationRead,
  markInboxRead,
  useEventStream,
  type ConversationSummary,
  type ConversationUpdatedEvent,
  type Tour,
} from '../../api/index.js';
import { useUnread } from '../../app/UnreadContext.js';
import { contactClearKey, conversationClearKey } from '../../app/unreadKeys.js';
import { involvesContact } from '../contact/useContactTimeline.js';

export interface TourGroupChannel {
  /** The resolved conversationId, or null when no group thread exists yet. */
  conversationId: string | null;
  /** Unread messages on that conversation (drives the tab's unread dot). */
  unread: number;
}

/** One person the caller wants a 1:1 channel for. */
export interface PersonChannelInput {
  /** WHO the channel is with. May be '' while a page builds a loading
   *  placeholder - markPersonRead rejects that (see its guard). */
  contactId: string;
  /** The tab's whole label: the person's DISPLAY NAME. Never a role word. */
  label: string;
}

export interface PersonChannel {
  contactId: string;
  label: string;
  /** Summed unread across the contact's non-relay conversations (their inbox
   *  row), which is exactly the set markPersonRead's fan-out clears. */
  unread: number;
}

export interface TourChannelsState {
  status: 'loading' | 'ready' | 'error';
  group: TourGroupChannel;
  /** One channel per person input, in the caller's order. */
  people: PersonChannel[];
  /** Inject a just-provisioned GROUP conversationId (open-group). */
  setGroupConversationId: (conversationId: string) => void;
  /** Mark the group's single conversation read + zero its unread locally. The
   *  caller passes the channel's CURRENT conversationId + unread (the values from
   *  the render it fires in) so mark-read never depends on a ref a PARENT effect
   *  writes only AFTER this consumer's child effect runs. No-ops unless a resolved
   *  conversation has unread > 0. */
  markGroupRead: (conversationId: string | null, unread: number) => void;
  /** Mark a PERSON's comms read (the inbox fan-out) + zero that tab's unread
   *  locally, keyed by contactId. No-ops when the contact is unresolved or the tab
   *  has nothing unread - the consumer's effect re-runs on every render, so that
   *  guard plus the local zero BEFORE the network call is what keeps it from
   *  looping. */
  markPersonRead: (contactId: string | undefined, unread: number) => void;
}

interface Committed {
  status: 'loading' | 'ready' | 'error';
  group: TourGroupChannel;
  people: PersonChannel[];
  /** Which tourId the committed state describes. */
  forId: string;
}

/** Debounce window (ms) for SSE-triggered refetches - coalesces a burst of
 *  conversation events into one getConversations re-resolve. */
const REFETCH_DEBOUNCE_MS = 300;

/** Stable identity for "no resolved people yet" (a fresh [] would make the
 *  projection memo below recompute on every render). */
const NO_PEOPLE: PersonChannel[] = [];

/** Total unread across the contact's NON-multi-party conversations on this inbox
 *  page. A relay_group NEVER counts - its unread belongs to the Group tab, and
 *  the 1:1 fan-out read cannot clear it (relay groups front the POOL number, so
 *  the contact's threads never include one). A native group_text is excluded for
 *  a STRONGER reason: it matches by ROSTER, and one group roster matches up to
 *  nine contacts at once, so counting it would add the same unread to every
 *  member's 1:1 dot - a nine-fold over-count no 1:1 mark-read can clear
 *  (exclusion is the only correct handling here, not a preference). An
 *  email-keyed thread is recognised by the participants ROSTER alone:
 *  `participant_email` is not a dashboard field.
 *  HONEST LIMITATION: the inbox page is the first 50 OPEN conversations, so a
 *  thread off that page is invisible to the dot. */
function sumUnread(summaries: ConversationSummary[], contactId: string): number {
  return summaries.reduce(
    (total, s) =>
      s.type !== 'relay_group' &&
      s.type !== 'group_text' &&
      involvesContact(s.participants, contactId)
        ? total + s.unread_count
        : total,
    0,
  );
}

/** Resolve the channels from a fresh inbox page. The GROUP keeps the
 *  preserve-an-id-we-already-hold merge (a just-provisioned thread is not on the
 *  inbox page yet, and it must never unmount); the 1:1s are pure sums. */
function resolveChannels(
  prev: Pick<Committed, 'group' | 'people'>,
  groupThreadId: string | undefined,
  people: PersonChannelInput[],
  summaries: ConversationSummary[],
): Pick<Committed, 'group' | 'people'> {
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
    // Falsy id -> 0, never a sum: an empty contactId is a page's loading
    // placeholder, not a person whose threads could be counted.
    people: people.map((p) => ({ ...p, unread: p.contactId ? sumUnread(summaries, p.contactId) : 0 })),
  };
}

function initialGroup(groupThreadId: string | undefined): TourGroupChannel {
  return { conversationId: groupThreadId ?? null, unread: 0 };
}

function initialChannels(
  groupThreadId: string | undefined,
  people: PersonChannelInput[],
): Pick<Committed, 'group' | 'people'> {
  return { group: initialGroup(groupThreadId), people: people.map((p) => ({ ...p, unread: 0 })) };
}

export function useTourChannels(tour: Tour, people: PersonChannelInput[]): TourChannelsState {
  const tourId = tour.tourId;
  const groupThreadId = tour.groupThreadId;
  // The nav badge's optimistic layer. Both functions are identity-stable by
  // contract (UnreadContext memoizes them over a ref-held map), which is what
  // keeps the mark-read callbacks below - and therefore this hook's returned
  // object - out of a consumer effect's re-fire loop.
  const { noteRowsCleared, rollbackRowsCleared } = useUnread();

  // Callers build `people` INLINE, so a fresh array identity arrives on every
  // render - keying the fetch on that identity would refetch forever. Stabilize
  // it by VALUE: the JSON string is the memo's ONLY input, so the unstable array
  // cannot smuggle itself back in through a dependency.
  const peopleJson = JSON.stringify(people);
  const peopleInputs = useMemo<PersonChannelInput[]>(
    () => JSON.parse(peopleJson) as PersonChannelInput[],
    [peopleJson],
  );

  const [state, setState] = useState<Committed>(() => ({
    status: 'loading',
    ...initialChannels(groupThreadId, peopleInputs),
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
            : { status: 'loading' as const, ...initialChannels(groupThreadId, peopleInputs), forId: tourId };
        const resolved = resolveChannels(base, groupThreadId, peopleInputs, page.conversations);
        return { status: 'ready', ...resolved, forId: tourId };
      });
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setState((prev) =>
        prev.forId === tourId
          ? { ...prev, status: 'error' }
          : { status: 'error', ...initialChannels(groupThreadId, peopleInputs), forId: tourId },
      );
    }
  }, [tourId, groupThreadId, peopleInputs]);

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
  const markGroupRead = useCallback(
    (conversationId: string | null, unread: number) => {
      if (conversationId === null || unread <= 0) return;
      setState((prev) => (prev.group.unread === 0 ? prev : { ...prev, group: { ...prev.group, unread: 0 } }));
      // Past the guard this group is UNREAD, and the close-reset ruling zeroes a
      // relay group's unread as it closes - so every row THIS rail realistically
      // shows (a tour's live group, rendered from a feed of open/connecting
      // groups the operator is working right now) is a row the nav badge counts,
      // and decrementing it is sound. Pre-ruling this wiring was excluded
      // outright: a closed-but-unread group would have decremented a row the
      // badge never counted. NOT a universal invariant - an inbound landing on an
      // already-closed group still re-stamps the flag, so a closed row can carry
      // unread; see docs/issues/inbound-reflags-closed-relay-group.md. The
      // residual cost there is a transient badge under-count until the next
      // reconcile, not a wrong write.
      const clearKey = conversationClearKey(conversationId);
      noteRowsCleared([clearKey]);
      void markConversationRead(conversationId).catch(() => {
        /* best-effort - a failed mark-read must not break the view */
        rollbackRowsCleared([clearKey]);
      });
    },
    [noteRowsCleared, rollbackRowsCleared],
  );

  // markPersonRead is the CONTACT fan-out (the contact page's own mark-read):
  // viewing a person's tab clears the unread on every thread they own, which is
  // exactly the set the tab's summed dot counts. Same ordering contract as
  // markGroupRead - guard, zero LOCALLY, then fire - and the guard is what stops
  // the consumer's every-render effect from POSTing in a loop.
  const markPersonRead = useCallback(
    (contactId: string | undefined, unread: number) => {
      // Falsy, not `=== undefined`: an EMPTY id would POST /api/inbox//read. The
      // placement twin really does build a placeholder with tenantId: '' while
      // its bundle loads, so the guard has to reject '' as well as undefined.
      if (!contactId || unread <= 0) return;
      setState((prev) => {
        const hit = prev.people.find((p) => p.contactId === contactId);
        if (hit === undefined || hit.unread === 0) return prev;
        return {
          ...prev,
          people: prev.people.map((p) => (p.contactId === contactId ? { ...p, unread: 0 } : p)),
        };
      });
      // Beside the request, never inside the setState updater (an updater must
      // stay pure - StrictMode double-invokes it). The badge decrement follows
      // the REQUEST guard above, which is the caller's fresh unread value.
      const clearKey = contactClearKey(contactId);
      noteRowsCleared([clearKey]);
      void markInboxRead({ contactId }).catch(() => {
        /* best-effort - a failed mark-read must not break the view */
        rollbackRowsCleared([clearKey]);
      });
    },
    [noteRowsCleared, rollbackRowsCleared],
  );

  // The people we RETURN are the CURRENT inputs carrying the unread the last
  // resolved inbox page holds for each of them. Returning the committed snapshot
  // instead would lag the rail by a whole fetch: the landlord contact resolves
  // after the tour does, and their tab must appear on the next render, not a
  // round trip later (and a person the page drops must lose theirs at once).
  const committedPeople = state.forId === tourId ? state.people : NO_PEOPLE;
  const channelPeople = useMemo(
    () =>
      peopleInputs.map((p) => {
        const resolved = committedPeople.find((c) => c.contactId === p.contactId);
        return { ...p, unread: resolved === undefined ? 0 : resolved.unread };
      }),
    [peopleInputs, committedPeople],
  );

  if (state.forId !== tourId) {
    return {
      status: 'loading',
      group: initialGroup(groupThreadId),
      people: channelPeople,
      setGroupConversationId,
      markGroupRead,
      markPersonRead,
    };
  }
  return {
    status: state.status,
    group: state.group,
    people: channelPeople,
    setGroupConversationId,
    markGroupRead,
    markPersonRead,
  };
}
