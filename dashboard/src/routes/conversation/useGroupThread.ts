// useGroupThread - the NATIVE group-text view's left-pane data hook. Modeled on
// useRelayThread (a single fixed conversationId fed to
// GET /api/conversations/:id/messages, mapped into the chronological
// TimelineItem[] the shared <Timeline> renders) with two deliberate differences:
//
//   - NO scheduled bucket. useRelayThread also fetches
//     GET /api/conversations/:id/scheduled, which returns `{ scheduled: [] }`
//     for any non-relay thread (200, not an error) - so calling it here would be
//     one wasted request per thread open. Group threads have no automated sends
//     in v1 (spec 10), so the "Upcoming" section is structurally empty.
//   - The optimistic-send trio IS here (S5), copied from useRelayThread: a group
//     reply posts to the same route and its bubble must appear instantly rather
//     than after the round trip. Its `'team'` sender sentinel resolves to "Team"
//     through the shared attribution resolver, exactly as the relay one does.
//
// SSE: message.persisted / conversation.updated schedule the same debounced
// refetch as the relay thread, so an inbound member message appears live.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getConversationMessages,
  useEventStream,
  type SendMessageResult,
  type TimelineItem,
  type TimelineMessage,
} from '../../api/index.js';
import { mergeTimelineItems, THREAD_PAGE_SIZE } from '../shared/threadPaging.js';
import { buildRelayItems } from './useRelayThread.js';

export type GroupThreadStatus = 'loading' | 'ready' | 'error';

interface PendingSend {
  tempId: string;
  item: TimelineMessage;
}

/** Debounce window (ms) for SSE-triggered refetches - coalesces a burst of
 *  message/conversation events into one refetch (matches useRelayThread). */
const REFETCH_DEBOUNCE_MS = 300;

export interface GroupThreadState {
  status: GroupThreadStatus;
  items: TimelineItem[];
  /** Bumped once per SSE-triggered (debounced) refetch of this thread.
   *
   *  A15. The view's OTHER read - the member panel's `getGroupMembers` - has to
   *  move on exactly the same beat as the transcript, or the delivery chips and
   *  the roster beside them make two contradictory statements about the same
   *  member until a reload. Exposing the tick rather than having the view open a
   *  SECOND `useEventStream` subscription keeps one subscriber, one debounce and
   *  one definition of "something changed in this thread". */
  refetchSignal: number;
  /** Refetch now (the view's error-state retry). */
  refresh: () => void;
  /** Older history exists beyond the oldest entry held. HEURISTIC: the messages
   *  route returns no `hasMore`, so a FULL page is read as "probably more". A
   *  thread that is an exact multiple of the page size shows the control once
   *  with nothing behind it; the click fetches an empty page and it disappears.
   *  Wrong only in the harmless direction. One caveat on "short means the end":
   *  messagesRepo.listByConversation discards LastEvaluatedKey, so a Query capped
   *  at DynamoDB's 1MB limit would also come back short and read as
   *  end-of-history - an order of magnitude away at 50 rows of realistic size,
   *  but it is why this is a heuristic. Spec section 4.4. */
  hasOlder: boolean;
  /** An older page is in flight - the control is disabled. */
  loadingOlder: boolean;
  /** Fetch and merge one older page. No-op while one is already in flight. */
  loadOlder: () => Promise<void>;
  /** Incremented ONLY when an older page has merged - <Timeline>'s prepend
   *  signal. Nothing observable from the item list can replace it: an append
   *  grows the list without a prepend, and the "Comms only" toggle changes the
   *  first RENDERED item without one. Spec section 4.5.
   *
   *  NOT interchangeable with `refetchSignal` above, despite the similar shape:
   *  that one bumps on the SSE tick BEFORE the fetch resolves and bumps even
   *  when the refetch then errors. This one bumps only after a page has actually
   *  merged. A consumer that reaches for the wrong counter fires a bogus scroll
   *  restore on every inbound message. */
  olderPagesLoaded: number;
  /** Optimistic send: show the outbound bubble immediately; returns a temp id. */
  addOptimistic: (conversationId: string, body: string) => string;
  /** POST succeeded: stamp the real tsMsgId + status so the refetch reconciles. */
  resolveOptimistic: (tempId: string, result: SendMessageResult) => void;
  /** POST failed: drop the bubble (the composer restores the draft). */
  failOptimistic: (tempId: string) => void;
}

export function useGroupThread(conversationId: string): GroupThreadState {
  const [status, setStatus] = useState<GroupThreadStatus>('loading');
  const [serverItems, setServerItems] = useState<TimelineItem[]>([]);
  const [pending, setPending] = useState<PendingSend[]>([]);
  const tempIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Bumped ONLY on a successful older-page merge - <Timeline>'s prepend signal.
  const [olderPagesLoaded, setOlderPagesLoaded] = useState(0);
  // [R4] Ref, not state: two clicks in one tick share one render closure.
  const loadingOlderRef = useRef(false);
  // [R3] The bound comes from the RAW newest-first page, never from mapped items.
  const oldestFetchedIdRef = useRef<string | null>(null);
  // Its own controller: an SSE refetch aborts abortRef and must not cancel an
  // in-flight "Load older" the operator just asked for.
  const olderAbortRef = useRef<AbortController | null>(null);
  const loadedIdRef = useRef<string | null>(null);

  const addOptimistic = useCallback((convId: string, body: string): string => {
    tempIdRef.current += 1;
    const tempId = `optimistic:${tempIdRef.current}`;
    setPending((p) => [
      ...p,
      {
        tempId,
        item: {
          kind: 'message',
          id: tempId,
          at: new Date().toISOString(),
          conversationId: convId,
          tsMsgId: tempId,
          direction: 'outbound',
          author: 'teammate',
          // Group sends are TEXT ONLY in v1 (spec 6.2), so there is no
          // attachment placeholder to carry.
          type: 'sms',
          body,
          delivery_status: 'queued',
          relay_sender_key: 'team',
        },
      },
    ]);
    return tempId;
  }, []);

  const resolveOptimistic = useCallback((tempId: string, result: SendMessageResult): void => {
    setPending((p) =>
      p.map((x) =>
        x.tempId === tempId
          ? {
              ...x,
              item: {
                ...x.item,
                id: result.tsMsgId,
                tsMsgId: result.tsMsgId,
                delivery_status: result.status,
              },
            }
          : x,
      ),
    );
  }, []);

  const failOptimistic = useCallback((tempId: string): void => {
    setPending((p) => p.filter((x) => x.tempId !== tempId));
  }, []);

  // A new conversation resets any leftover optimistic bubbles, and every piece
  // of paging state that describes the OLD thread.
  //
  // olderPagesLoaded is deliberately NOT reset. It is a monotonic change signal,
  // not a count of what is on screen: dropping it back to 0 would itself read as
  // a change to <Timeline> and consume a scroll anchor that no prepend produced.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending([]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasOlder(false);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    oldestFetchedIdRef.current = null;
    olderAbortRef.current?.abort();
  }, [conversationId]);

  const fetchNow = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const messages = await getConversationMessages(
        conversationId,
        { limit: THREAD_PAGE_SIZE },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      // buildRelayItems is the shared multi-party mapper: it carries
      // relay_sender_key + delivery_recipients onto each bubble, which is
      // exactly what group messages persist (spec 4.3).
      const fresh = buildRelayItems(messages);
      const isFirstLoad = loadedIdRef.current !== conversationId;
      loadedIdRef.current = conversationId;
      // A4: the first load REPLACES (nothing is held), but it still goes through
      // mergeTimelineItems so ordering is identical before and after any merge.
      // buildRelayItems returns 0 for equal `at` and JS sort is stable, so a raw
      // page keeps NEWEST-FIRST order within a tie while the merge breaks the tie
      // by ascending id - assigning `fresh` directly would reshuffle same-instant
      // messages on the first SSE refetch, with no user action.
      setServerItems((prev) =>
        isFirstLoad ? mergeTimelineItems([], fresh) : mergeTimelineItems(prev, fresh),
      );
      if (isFirstLoad) {
        // Only the FIRST load decides these: hasOlder describes the far end of
        // the thread, which a refetch of the newest page says nothing about, and
        // re-baselining the bound would discard pages already walked.
        //
        // [R3] Both come from the RAW page, never the mapped items.
        oldestFetchedIdRef.current = messages[messages.length - 1]?.tsMsgId ?? null;
        // Spec 4.4 heuristic: the route carries no hasMore, so a FULL page means
        // "probably more". Wrong only in the harmless direction - an exact
        // multiple of the page size shows the control once and one empty fetch
        // retires it; no history is ever unreachable.
        setHasOlder(messages.length >= THREAD_PAGE_SIZE);
      }
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      setStatus('error');
    }
  }, [conversationId]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlderRef.current) return;
    const before = oldestFetchedIdRef.current;
    if (before === null) return;
    loadingOlderRef.current = true;
    olderAbortRef.current?.abort();
    const controller = new AbortController();
    olderAbortRef.current = controller;
    setLoadingOlder(true);
    try {
      const older = await getConversationMessages(
        conversationId,
        { limit: THREAD_PAGE_SIZE, before },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      // Mapped ONCE, outside every setState updater (React may invoke an updater
      // twice, so the "did anything actually merge?" decision cannot live in one).
      const olderItems = buildRelayItems(older);
      // Spec 4.5: an older page that merges NOTHING is not a prepend, so neither
      // the item state nor the counter moves. The check is on the MAPPED page,
      // not the raw one - buildRelayItems drops calls and email, so a full raw
      // page can map to zero rows, which is equally not a prepend. A bogus bump
      // fires <Timeline>'s scroll anchor for a prepend that never happened and
      // swallows the pill of any append coalesced into the same commit.
      if (olderItems.length > 0) {
        setServerItems((prev) => mergeTimelineItems(prev, olderItems));
        // Bump LAST and only here: this is what tells <Timeline> a prepend landed.
        setOlderPagesLoaded((n) => n + 1);
      }
      // The bound and hasOlder come from the RAW page either way - that is what
      // lets the operator keep paging through a run of fully-dropped pages.
      const oldest = older[older.length - 1]?.tsMsgId;
      if (oldest !== undefined) oldestFetchedIdRef.current = oldest;
      // Spec 4.4 heuristic again, on the same RAW page the bound above came from.
      setHasOlder(older.length >= THREAD_PAGE_SIZE);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // Keep hasOlder as-is so the control stays and the operator can retry; the
      // history already on screen is still correct.
    } finally {
      // Guarded exactly like the state setter beside it: an ABORTED request no
      // longer owns the in-flight guard, so a late-settling one must not clear it
      // out from under a NEWER request. Unreachable through the button (disabled
      // by loadingOlder), but the deferred scroll-triggered auto-loader (spec
      // section 6) calls loadOlder() programmatically. The abort path that DOES
      // need the guard cleared (a conversation change) clears it itself in the
      // reset effect above.
      if (!controller.signal.aborted) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [conversationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchNow();
    return () => abortRef.current?.abort();
  }, [fetchNow]);

  // Mirrors the abortRef cleanup above for the independent older-page controller.
  useEffect(() => () => olderAbortRef.current?.abort(), []);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [refetchSignal, setRefetchSignal] = useState(0);
  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      // Published on the SAME tick as the transcript fetch (A15), so anything
      // else the view reads about this thread reconciles together rather than
      // drifting apart until a reload.
      setRefetchSignal((n) => n + 1);
      void fetchNow();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchNow]);

  // Keyed on `conversationId`, NOT `[]` - see useRelayThread for the full
  // reasoning. An armed timer captured the old `fetchNow` and would write the
  // previous thread's page into this instance after a switch; merge-by-id makes
  // that permanent rather than transient. This hook FILTERS SSE events by
  // conversationId, which narrows the window but does not close it: the filter
  // runs when the event arrives, and the switch happens after the timer is armed.
  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
      }
    },
    [conversationId],
  );

  // FILTERED to THIS thread (adversarial 20). `/api/events` is one org-wide
  // firehose - every message to every conversation in the org reaches every open
  // browser - and `scheduleRefetch` used to ignore the payload entirely. That
  // was already a wasted transcript read; once A15 tied the member panel to the
  // same tick it also fired `GET /group-members`, which does a `findByPhone`
  // plus a `readNumberSuppression` per member (~18 DynamoDB reads for a
  // 9-member group) and may issue a conditional roster write. Both event shapes
  // carry `conversationId` as a required field, and nothing about another
  // thread is news to this view, so a non-matching (or unreadable) id is
  // dropped rather than paid for.
  const onThreadEvent = useCallback(
    (event: { conversationId?: string }) => {
      if (event.conversationId !== conversationId) return;
      scheduleRefetch();
    },
    [conversationId, scheduleRefetch],
  );

  useEventStream({
    onMessagePersisted: onThreadEvent,
    onConversationUpdated: onThreadEvent,
  });

  const refresh = useCallback(() => {
    setStatus('loading');
    // The retry must REPLACE, not union a stale transcript into a fresh read.
    loadedIdRef.current = null;
    void fetchNow();
  }, [fetchNow]);

  // Merge server items with optimistic sends, dropping any bubble the server has
  // caught up to (matched by tsMsgId). Optimistic items carry at=now, so they
  // sort last - appended after the chronological server items.
  const items = useMemo(() => {
    if (pending.length === 0) return serverItems;
    const serverIds = new Set<string>();
    for (const i of serverItems) if (i.kind === 'message') serverIds.add(i.tsMsgId);
    const extra = pending.filter((p) => !serverIds.has(p.item.tsMsgId)).map((p) => p.item);
    return extra.length === 0 ? serverItems : [...serverItems, ...extra];
  }, [serverItems, pending]);

  return {
    status,
    items,
    refetchSignal,
    refresh,
    hasOlder,
    loadingOlder,
    loadOlder,
    olderPagesLoaded,
    addOptimistic,
    resolveOptimistic,
    failOptimistic,
  };
}
