// useRelayThread — the relay-group view's left-pane data hook. Analogous to
// useContactTimeline, but for a SINGLE fixed conversation: it feeds a known
// conversationId to GET /api/conversations/:id/messages (bypassing
// resolveSingleConversation, which is 1:1-only) and maps the newest-first
// Message[] into a chronological TimelineItem[] the shared <Timeline> renders.
//
// It reuses useContactTimeline's optimistic-send trio (addOptimistic /
// resolveOptimistic / failOptimistic) and its debounced SSE refetch: a
// message.persisted / conversation.updated event refetches the thread so a
// team reply's fan-out (and inbound member messages) show up live.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getConversationMessages,
  getConversationScheduled,
  useEventStream,
  type ConversationScheduledPage,
  type Message,
  type SendMessageResult,
  type TimelineItem,
  type TimelineMessage,
  type TimelineScheduled,
} from '../../api/index.js';
import { mergeTimelineItems, THREAD_PAGE_SIZE } from '../shared/threadPaging.js';

export type RelayThreadStatus = 'loading' | 'ready' | 'error';

interface PendingSend {
  tempId: string;
  item: TimelineMessage;
}

/** Debounce window (ms) for SSE-triggered refetches — coalesces a burst of
 *  message/conversation events into one refetch (matches useContactTimeline). */
const REFETCH_DEBOUNCE_MS = 300;

/** The ISO instant for a message: its provider_ts when present, else the
 *  `<ISO ts>#<sid>` prefix of its sort key, else '' (sorts last). */
function messageInstant(m: Message): string {
  if (typeof m.provider_ts === 'string' && m.provider_ts.length > 0) return m.provider_ts;
  const prefix = m.tsMsgId.split('#')[0] ?? '';
  return /^\d{4}-\d{2}-\d{2}T/.test(prefix) ? prefix : '';
}

/** Map a persisted Message -> a TimelineMessage bubble, or null to drop it.
 *  Relay threads never carry email or 1:1 call content: inbound email and
 *  calls thread into 1:1 conversations server-side, so a relay-group fetch
 *  never sees them - the check below is the relay-only contract, not defense. */
export function toTimelineMessage(m: Message): TimelineMessage | null {
  if (m.type === 'call' || m.type === 'email') return null;
  const at = messageInstant(m);
  const retryOf = typeof m['retry_of'] === 'string' ? (m['retry_of'] as string) : undefined;
  return {
    kind: 'message',
    id: m.tsMsgId,
    at,
    conversationId: m.conversationId,
    tsMsgId: m.tsMsgId,
    direction: m.direction,
    author: m.author,
    type: m.type,
    ...(m.body !== undefined && { body: m.body }),
    ...(m.media_attachments !== undefined && { media_attachments: m.media_attachments }),
    delivery_status: m.delivery_status,
    ...(m.error_code !== undefined && { error_code: m.error_code }),
    ...(retryOf !== undefined && { retry_of: retryOf }),
    ...(m.delivery_recipients !== undefined && { delivery_recipients: m.delivery_recipients }),
    ...(typeof m.relay_sender_key === 'string' && { relay_sender_key: m.relay_sender_key }),
  };
}

/** Build the chronological (oldest→newest) TimelineItem[] from a newest-first
 *  Message page. Exported for unit testing. */
export function buildRelayItems(messages: Message[]): TimelineItem[] {
  const mapped: TimelineMessage[] = [];
  for (const m of messages) {
    const item = toTimelineMessage(m);
    if (item !== null) mapped.push(item);
  }
  return mapped.sort((a, b) => {
    if (a.at === b.at) return 0;
    if (a.at === '') return 1;
    if (b.at === '') return -1;
    return a.at.localeCompare(b.at);
  });
}

export interface RelayThreadState {
  status: RelayThreadStatus;
  items: TimelineItem[];
  /** Not-yet-sent scheduled messages routed to THIS group (the pinned
   *  "Upcoming" section — the owner tour's pending reminder rungs). Empty for
   *  1:1 conversations (their upcoming lives on the contact timeline) and
   *  best-effort: a failed fetch leaves the bucket empty, never errors the
   *  thread. */
  upcoming: TimelineScheduled[];
  /** The IANA zone the `upcoming` BODIES were composed in (spec D8) - the cards
   *  label their fire times in it so a navigator outside the org's zone never
   *  reads a time that contradicts the body beside it. Undefined when the bucket
   *  is empty or the fetch failed; the card then falls back to the browser zone. */
  upcomingTimezone: string | undefined;
  /** Older history exists beyond the oldest entry currently held.
   *
   *  HEURISTIC, not an authoritative flag. GET /api/conversations/:id/messages
   *  returns a bare array with no `hasMore`, so a FULL page is read as "there is
   *  probably more". On a thread whose length is an exact multiple of the page
   *  size this shows the control once when nothing older exists; clicking it
   *  fetches an empty page and the control disappears. The label can therefore be
   *  briefly wrong, but only in the harmless direction - a full page always means
   *  more MAY exist, and a short page means the end was reached for every page
   *  the server can actually return in full. The one caveat is the read itself:
   *  messagesRepo.listByConversation discards LastEvaluatedKey, so a Query capped
   *  at DynamoDB's 1MB limit would also come back short and read as end-of-
   *  history. At 50 rows of realistic message size that is roughly an order of
   *  magnitude away, but it is why this is a heuristic and not a proof. The
   *  honest fix (server returns hasMore from a limit+1 read, and surfaces the
   *  cap) is deferred, not rejected: spec section 4.4.
   *
   *  This holds ONLY because the bound below is derived from the same RAW page
   *  this count comes from - see oldestFetchedIdRef. */
  hasOlder: boolean;
  /** An older page is in flight - the control is disabled. */
  loadingOlder: boolean;
  /** Fetch and merge one older page. No-op while one is already in flight. */
  loadOlder: () => Promise<void>;
  /** Incremented ONLY when an older page has merged into `items`.
   *
   *  This is the renderer's only reliable signal that a PREPEND happened, and
   *  <Timeline> uses it to decide when to restore the scroll anchor. Nothing
   *  observable from the item list can replace it: an SSE append grows the list
   *  without a prepend, and the "Comms only" toggle changes the FIRST rendered
   *  item without one either (Timeline renders the filtered `visible`, not
   *  `items`). Spec section 4.5. */
  olderPagesLoaded: number;
  /** Optimistic send: show an outbound bubble ("Sending…") immediately; returns a
   *  temp id to reconcile with. */
  addOptimistic: (
    conversationId: string,
    body: string,
    toPhone?: string,
    attachmentKeys?: string[],
  ) => string;
  /** POST succeeded: stamp the real tsMsgId + status so the SSE refetch reconciles. */
  resolveOptimistic: (tempId: string, result: SendMessageResult) => void;
  /** POST failed: drop the optimistic bubble (the caller restores the draft). */
  failOptimistic: (tempId: string) => void;
}

export function useRelayThread(conversationId: string): RelayThreadState {
  const [status, setStatus] = useState<RelayThreadStatus>('loading');
  const [serverItems, setServerItems] = useState<TimelineItem[]>([]);
  const [upcoming, setUpcoming] = useState<TimelineScheduled[]>([]);
  // Rides with the bucket (same fetch, same failure posture): the zone those
  // bodies were composed in.
  const [upcomingTimezone, setUpcomingTimezone] = useState<string | undefined>(undefined);

  // In-flight OPTIMISTIC sends, reconciled against the server thread by tsMsgId.
  const [pending, setPending] = useState<PendingSend[]>([]);
  const tempIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Bumped ONLY on a successful older-page merge - <Timeline>'s prepend signal.
  const [olderPagesLoaded, setOlderPagesLoaded] = useState(0);
  // [R4] The in-flight guard is a REF, not render state: two clicks in one tick
  // share a single render closure, so a state-based guard would let the second
  // through - firing a duplicate read that aborts the first and can strand the
  // button in a disabled state.
  const loadingOlderRef = useRef(false);
  // [R3] The `before` bound, taken from the RAW newest-first page (its LAST
  // element is its oldest). Never derived from the mapped items: buildRelayItems
  // drops calls and email, so a page can map to fewer rows - or none - and a
  // mapped-derived bound would leave a live button with nothing to page from.
  const oldestFetchedIdRef = useRef<string | null>(null);
  // Older-page fetches get their OWN controller: an SSE refetch aborts abortRef,
  // and must not cancel an in-flight "Load older" the operator just asked for.
  const olderAbortRef = useRef<AbortController | null>(null);
  // Which conversation the held items belong to, so the FIRST load of a thread
  // replaces state while every later load merges into it.
  const loadedIdRef = useRef<string | null>(null);

  const addOptimistic = useCallback(
    (convId: string, body: string, toPhone?: string, attachmentKeys?: string[]): string => {
      tempIdRef.current += 1;
      const tempId = `optimistic:${tempIdRef.current}`;
      // Optimistic MMS: carry placeholder media_attachments so the bubble shows an
      // attachment count immediately (no provider sid yet -> count chip; real
      // thumbnails land on refetch). The placeholder contentType is not rendered.
      const hasMedia = attachmentKeys !== undefined && attachmentKeys.length > 0;
      const item: TimelineMessage = {
        kind: 'message',
        id: tempId,
        at: new Date().toISOString(),
        conversationId: convId,
        tsMsgId: tempId,
        direction: 'outbound',
        author: 'teammate',
        type: hasMedia ? 'mms' : 'sms',
        body,
        delivery_status: 'queued',
        relay_sender_key: 'team',
        ...(toPhone !== undefined && { toPhone }),
        ...(hasMedia && {
          media_attachments: attachmentKeys.map((k) => ({
            s3Key: k,
            contentType: 'application/octet-stream',
          })),
        }),
      };
      setPending((p) => [...p, { tempId, item }]);
      return tempId;
    },
    [],
  );

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
      // The scheduled bucket rides along BEST-EFFORT: a failure there must
      // never blank a working thread (it just leaves Upcoming empty).
      const [messages, scheduled] = await Promise.all([
        getConversationMessages(conversationId, { limit: THREAD_PAGE_SIZE }, controller.signal),
        getConversationScheduled(conversationId, controller.signal).catch(
          (): ConversationScheduledPage => ({ scheduled: [] }),
        ),
      ]);
      if (controller.signal.aborted) return;
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
      setUpcoming(scheduled.scheduled);
      setUpcomingTimezone(scheduled.timezone);
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
      // Mapped ONCE, outside every setState updater: React may invoke an updater
      // twice, so the "did anything actually merge?" decision cannot live inside
      // one.
      const olderItems = buildRelayItems(older);
      // Spec 4.5: an older page that merges NOTHING is not a prepend, so neither
      // the item state nor the counter moves. The check is on the MAPPED page,
      // not the raw one - buildRelayItems drops calls and email, so a full raw
      // page can map to zero rows, which is equally not a prepend. Merging an
      // empty page would only allocate a new array and force a pointless
      // re-render; bumping the counter would fire <Timeline>'s scroll anchor for
      // a prepend that never happened, and (because the consume branch returns
      // early) swallow the "New messages" pill of any append coalesced into that
      // same commit. Spec 4.4's accepted heuristic makes this reachable BY
      // DESIGN: every thread whose length is an exact multiple of the page size
      // ends on exactly this click.
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
      // A failed older-page read leaves hasOlder alone so the control stays and
      // the operator can retry. It must never error the whole thread: the
      // history they already have is still correct.
    } finally {
      // Guarded exactly like setLoadingOlder below: an ABORTED request no longer
      // owns the in-flight guard, so a late-settling one must not clear it out
      // from under a NEWER request. Unreachable through the button (disabled by
      // loadingOlder), but the deferred scroll-triggered auto-loader (spec
      // section 6) calls loadOlder() programmatically, and the ref exists
      // precisely because state lands a render too late to stop it. The abort
      // paths that DO need the guard cleared (a conversation change) clear it
      // themselves in the reset effect above.
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

  // Debounced SSE-driven refetch (message.persisted / conversation.updated).
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

  useEventStream({
    onMessagePersisted: scheduleRefetch,
    onConversationUpdated: scheduleRefetch,
    // A reminder ladder was armed/fired/rescheduled/canceled — refetch so the
    // pinned "Upcoming" section updates live (mirrors useContactTimeline).
    onScheduledUpdated: scheduleRefetch,
  });

  // Merge server items with optimistic sends, dropping any optimistic bubble the
  // server has caught up to (matched by tsMsgId). Optimistic items carry at=now,
  // so they sort last (newest) — appended after the chronological server items.
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
    upcoming,
    upcomingTimezone,
    hasOlder,
    loadingOlder,
    loadOlder,
    olderPagesLoaded,
    addOptimistic,
    resolveOptimistic,
    failOptimistic,
  };
}
