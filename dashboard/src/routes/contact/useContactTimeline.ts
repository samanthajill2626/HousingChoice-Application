// useContactTimeline — the contact detail page's left-pane data hook. Prefers
// the server-merged person-centric timeline (GET /api/contacts/:id/timeline,
// §C2); when that endpoint isn't live yet (ApiError 404) it assembles a
// MESSAGES-ONLY fallback client-side: fetch the inbox conversations, keep the
// ones whose participants include this contact, fetch each one's messages, then
// buildTimelineFallback() into a chronological TimelineMessage[]. This shows the
// contact's REAL seeded messages today (no milestones until BE2). Subscribes to
// the SSE stream and refetches (debounced) on message.persisted /
// conversation.updated so the stream stays live. Mirrors useToday's shape.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  getContactTimeline,
  getConversationMessages,
  getAllConversations,
  useEventStream,
  type Message,
  type SendMessageResult,
  type TimelineItem,
  type TimelineMessage,
  type TimelineScheduled,
} from '../../api/index.js';
import { mergeTimelineItems } from '../shared/threadPaging.js';
import { buildTimelineFallback } from './buildTimelineFallback.js';

export type TimelineStatus = 'loading' | 'ready' | 'error';
export type TimelineSource = 'server' | 'fallback';

/** The async-loaded data the hook holds internally (the public return type adds the
 *  optimistic-send methods, which live outside this state). */
interface TimelineData {
  status: TimelineStatus;
  /** Server items merged with any in-flight OPTIMISTIC sends (deduped by tsMsgId). */
  items: TimelineItem[];
  /** Not-yet-sent scheduled messages (the pinned "Upcoming" section). The
   *  fallback path (no /timeline endpoint yet) has none → []. */
  upcoming: TimelineScheduled[];
  /** The IANA zone those `upcoming` BODIES were composed in (spec D8) - the
   *  cards label their fire times in it so the card never contradicts the body
   *  it shows. Undefined on the fallback path (no scheduled bucket) or an older
   *  backend; the card then falls back to the browser zone. */
  upcomingTimezone: string | undefined;
  /** Which path produced `items` — 'server' (/timeline) or 'fallback' (assembled). */
  source: TimelineSource;
}

/** Options for `addOptimistic` (ADJ-12). An options object (not positional
 *  args) so the email channel can carry subject/email_* alongside the SMS/MMS
 *  toPhone/attachmentKeys. Omitting `type` keeps the legacy SMS/MMS behavior
 *  (type derived from whether attachmentKeys are present). */
export interface AddOptimisticOptions {
  /** SMS/MMS: the recipient number shown on the bubble. */
  toPhone?: string;
  /** SMS/MMS: uploaded attachment keys (their presence => an MMS bubble). */
  attachmentKeys?: string[];
  /** Email channel: render an optimistic EmailCard (type 'email') - NO toPhone,
   *  NO media placeholder (email attachments reconcile on the SSE refetch). */
  type?: 'email';
  subject?: string;
  email_from?: string;
  email_to?: string[];
  email_cc?: string[];
}

export interface ContactTimelineState extends TimelineData {
  /**
   * Refetch the timeline now (debounced with the SSE-driven refetches). Call
   * after an ON-PAGE mutation that writes a milestone (status change, opt-out
   * toggle, number added) — those emit no SSE event the hook listens to, so
   * without this the new pin sits server-side until an unrelated message
   * event happens to trigger a refetch.
   */
  refetch: () => void;
  /** Optimistic send: show an outbound bubble ("Sending…") immediately; returns a
   *  temp id to reconcile with. The options object (ADJ-12) defaults to today's
   *  SMS/MMS behavior; `type:'email'` renders an optimistic EmailCard instead. */
  addOptimistic: (conversationId: string, body: string, opts?: AddOptimisticOptions) => string;
  /** POST succeeded: stamp the real tsMsgId + status so the SSE refetch reconciles
   *  the bubble by id (then it advances Sending… → Sent → Delivered on its own). */
  resolveOptimistic: (tempId: string, result: SendMessageResult) => void;
  /** POST failed: drop the optimistic bubble (the caller restores the draft). */
  failOptimistic: (tempId: string) => void;
  /** Older history exists beyond the oldest entry currently held.
   *
   *  EXACT here, unlike the conversation hooks' documented heuristic: the
   *  timeline route computes an authoritative `nextCursor` from a limit+1 read
   *  (app/src/routes/contactTimeline.ts:935-942), so this is a real flag rather
   *  than "the page came back full, so there is probably more". Always false on
   *  the assembled 404 fallback path, which has no cursor to page with. */
  hasOlder: boolean;
  /** An older page is in flight - the control is disabled. */
  loadingOlder: boolean;
  /** Fetch and merge one older page. No-op while one is already in flight, and a
   *  no-op once the server has handed back a null cursor. */
  loadOlder: () => Promise<void>;
  /** Incremented ONLY when an older page has merged into `items` - never on the
   *  first load, an SSE refetch, an abort, or an error, and never reset. It is
   *  <Timeline>'s only prepend signal (spec section 4.5). */
  olderPagesLoaded: number;
}

interface PendingSend {
  tempId: string;
  item: TimelineMessage;
}

/** Debounce window (ms) for SSE-triggered refetches — coalesces a burst of
 *  message/conversation events into one refetch. */
const REFETCH_DEBOUNCE_MS = 300;

/** True when the conversation summary's participant roster includes this contact.
 *  Tolerates BOTH wire shapes: a roster of `{contactId}` objects (the contract /
 *  relay groups) and a roster of bare contactId STRINGS (how seeded + some 1:1
 *  conversations serialize today — the API passes `item.participants` through
 *  unchanged). Without the string case, seeded 1:1 timelines come back empty. */
export function involvesContact(
  participants: ReadonlyArray<string | { contactId?: string }> | undefined,
  contactId: string,
): boolean {
  return (participants ?? []).some((p) =>
    typeof p === 'string' ? p === contactId : p.contactId === contactId,
  );
}

/** Defensive normalization of the SERVER timeline. Per contract C2 the server
 *  owns `at` (the ISO sort key) and returns items chronological — but to be
 *  robust to an item that omits `at`, derive it from the `<ISO ts>#<id>` prefix
 *  of `id` (the message sort-key shape), and (stable-)sort oldest→newest. A no-op
 *  when the server already provides a proper `at` + order. (Items with no
 *  derivable instant keep their relative order and sort last.) */
export function normalizeServerItems(items: TimelineItem[]): TimelineItem[] {
  const withAt = items.map((item) => {
    if (item.at && item.at.length > 0) return { item, at: item.at };
    const prefix = item.id.split('#')[0] ?? '';
    const at = /^\d{4}-\d{2}-\d{2}T/.test(prefix) ? prefix : '';
    return { item: at ? { ...item, at } : item, at };
  });
  return withAt
    .sort((a, b) => {
      if (a.at === b.at) return 0;
      if (a.at === '') return 1;
      if (b.at === '') return -1;
      return a.at.localeCompare(b.at);
    })
    .map((x) => x.item);
}

async function loadTimeline(
  contactId: string,
  kinds: string | undefined,
  signal: AbortSignal,
): Promise<{
  items: TimelineItem[];
  upcoming: TimelineScheduled[];
  upcomingTimezone: string | undefined;
  source: TimelineSource;
  /** [R5] Returned from the HELPER only - it must never reach TimelineData, which
   *  ContactTimelineState extends (every member there becomes a public one). */
  nextCursor: string | null;
}> {
  try {
    const page = await getContactTimeline(
      contactId,
      kinds !== undefined ? { kinds } : {},
      signal,
    );
    return {
      items: normalizeServerItems(page.items),
      upcoming: page.upcoming ?? [],
      upcomingTimezone: page.timezone,
      source: 'server',
      nextCursor: page.nextCursor,
    };
  } catch (err) {
    // Only a 404 means "endpoint not live yet" → assemble the fallback. Any
    // other failure (and the fallback's own failures) propagates to the error
    // state.
    if (!(err instanceof ApiError) || err.status !== 404) throw err;

    // NOTE: reads only the FIRST inbox page (no nextCursor paging). A
    // transitional limitation — BE2's /timeline supersedes this entirely, and a
    // single contact's threads almost always fit one page.
    // MULTI-PARTY THREADS ARE EXCLUDED BY TYPE, not left to the roster match.
    // `involvesContact` matches any roster entry, and a multi-party roster names
    // up to nine contacts - so a group thread reaching this fallback would pull
    // the WHOLE group transcript into one member's 1:1 timeline. The 50-row
    // inbox page cannot return one today (group texts live in their own
    // partition; relay groups front a pool number), which is exactly why this
    // filter had no type guard at all - and why it needs one before a future
    // reader change makes the omission load-bearing.
    const conversations = (await getAllConversations(signal)).items.filter(
      (c) =>
        c.type !== 'relay_group' &&
        c.type !== 'group_text' &&
        involvesContact(c.participants, contactId),
    );
    const messagesByConvId = new Map<string, Message[]>();
    // allSettled: one failed per-conversation fetch drops THAT thread rather
    // than failing the whole timeline (the others still render).
    const results = await Promise.allSettled(
      conversations.map(async (c) => ({
        id: c.conversationId,
        messages: await getConversationMessages(c.conversationId, {}, signal),
      })),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') messagesByConvId.set(r.value.id, r.value.messages);
    }
    // The messages-only fallback has no scheduled bucket (that's a /timeline-only
    // envelope) — default upcoming to [] (m1).
    // With no bucket there is no composing zone to carry either.
    return {
      items: buildTimelineFallback(conversations, messagesByConvId),
      upcoming: [],
      upcomingTimezone: undefined,
      source: 'fallback',
      // The assembled fallback has no cursor to page with (spec decision 6): it
      // is a client-side re-read of the newest messages of every 1:1 thread, not
      // a window into one ordered feed.
      nextCursor: null,
    };
  }
}

export function useContactTimeline(contactId: string, kinds?: string): ContactTimelineState {
  const [state, setState] = useState<TimelineData>({
    status: 'loading',
    items: [],
    upcoming: [],
    upcomingTimezone: undefined,
    source: 'server',
  });

  // In-flight OPTIMISTIC sends, shown immediately and reconciled against the
  // server timeline by tsMsgId (dropped once the refetch carries the real row).
  const [pending, setPending] = useState<PendingSend[]>([]);
  const tempIdRef = useRef(0);

  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Bumped ONLY on a successful older-page merge - <Timeline>'s prepend signal.
  const [olderPagesLoaded, setOlderPagesLoaded] = useState(0);
  // [R4] Ref guard, as in the conversation hooks: state lands a render too late
  // to stop a second click in the same tick.
  const loadingOlderRef = useRef(false);
  // [R5] The cursor is NOT part of TimelineData: ContactTimelineState extends it,
  // so anything added there becomes a public member and would leak an opaque
  // server token onto the object ContactCommsPane/ContactCommsTab pass around. A
  // ref written only inside async callbacks (never during render) also stays
  // clear of the enabled react-hooks/refs render-purity rule.
  const cursorRef = useRef<string | null>(null);
  const olderAbortRef = useRef<AbortController | null>(null);
  // [R3-analogue] Keyed on contact AND kinds: fetchNow depends on both, so a
  // kinds change is a NEW feed - merging the filtered page into the unfiltered
  // one would make the filter look broken and strand the cursor.
  const loadedKeyRef = useRef<string | null>(null);

  // Track the in-flight request so a refetch supersedes the previous one and a
  // late response from an aborted request can't clobber fresher state.
  const abortRef = useRef<AbortController | null>(null);

  const addOptimistic = useCallback(
    (conversationId: string, body: string, opts?: AddOptimisticOptions): string => {
      tempIdRef.current += 1;
      const tempId = `optimistic:${tempIdRef.current}`;
      const { toPhone, attachmentKeys, type, subject, email_from, email_to, email_cc } = opts ?? {};
      const shared = {
        kind: 'message' as const,
        id: tempId,
        at: new Date().toISOString(),
        conversationId,
        tsMsgId: tempId,
        direction: 'outbound' as const,
        author: 'teammate' as const,
        body,
        // 'queued' renders as "Sending..." (deliveryStatus) - the in-progress state.
        delivery_status: 'queued' as const,
      };
      // Email channel (A6): an optimistic EmailCard. No toPhone, no media
      // placeholder - an email attachment reconciles when the refetch lands.
      if (type === 'email') {
        const item: TimelineMessage = {
          ...shared,
          type: 'email',
          ...(subject !== undefined && { subject }),
          ...(email_from !== undefined && { email_from }),
          ...(email_to !== undefined && { email_to }),
          ...(email_cc !== undefined && { email_cc }),
        };
        setPending((p) => [...p, { tempId, item }]);
        return tempId;
      }
      // Optimistic MMS: carry placeholder media_attachments so the bubble shows
      // an attachment count immediately. The temp tsMsgId has no provider sid, so
      // MessageBubble renders the count chip (real thumbnails land on refetch).
      // The stored contentType is a placeholder - it is not rendered while there
      // is no servable sid.
      const hasMedia = attachmentKeys !== undefined && attachmentKeys.length > 0;
      const item: TimelineMessage = {
        ...shared,
        type: hasMedia ? 'mms' : 'sms',
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

  // A new contact (or a new kinds filter) resets any leftover optimistic bubbles
  // from the previous feed, and every piece of paging state that described it.
  // An intentional reset-on-key-change (the bubbles are appended by several
  // handlers, so deriving them isn't practical) — not a cascading-render smell.
  //
  // This MUST be by hand: ContactDetail.tsx:115-118 states outright that a
  // contactId change re-renders the SAME component instance with no remount, so
  // anything not cleared here LEAKS across contacts - a click landing in that
  // window would merge a page fetched on contact A's cursor boundary into contact
  // B and leave B holding A's cursor.
  //
  // Keyed on kinds as well because fetchNow depends on [contactId, kinds]: a
  // filter change is a new feed, and keying on contactId alone would leave an
  // in-flight older page un-aborted and the guard un-cleared. setPending([]) now
  // runs on a kinds change too - correct, an optimistic bubble belongs to the
  // feed it was sent from and fetchNow is re-running anyway.
  //
  // olderPagesLoaded is deliberately NOT reset. It is a monotonic change signal,
  // not a count of what is on screen: dropping it back to 0 would itself read as
  // a change to <Timeline> and consume a scroll anchor that no prepend produced.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending([]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingOlder(false);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasOlder(false);
    loadingOlderRef.current = false;
    cursorRef.current = null;
    olderAbortRef.current?.abort();
  }, [contactId, kinds]);

  const fetchNow = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { items, upcoming, upcomingTimezone, source, nextCursor } = await loadTimeline(
        contactId,
        kinds,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const loadedKey = `${contactId}|${kinds ?? ''}`;
      const isFirstLoad = loadedKeyRef.current !== loadedKey;
      loadedKeyRef.current = loadedKey;
      if (isFirstLoad) {
        // Only the FIRST load of a feed sets these; a refetch of the newest page
        // says nothing about the far end and must not resurrect a cursor the
        // operator has already paged past.
        cursorRef.current = nextCursor;
        setHasOlder(nextCursor !== null);
      }
      if (source === 'fallback') {
        // Spec decision 6: the assembled fallback has no cursor to page with.
        // Checked on EVERY load, not just the first: a refetch can 404 into the
        // fallback after a successful first page and would otherwise leave a live
        // control whose every click 404s.
        cursorRef.current = null;
        setHasOlder(false);
      }
      setState((prev) => ({
        status: 'ready',
        // A4: the first load REPLACES (nothing held is carried), but it still goes
        // through mergeTimelineItems so the ordering contract is identical before
        // and after any merge - normalizeServerItems returns 0 on an `at` tie and
        // JS sort is stable, so a raw page keeps its own order within a tie while
        // the merge breaks the tie by ascending id.
        //
        // A16: this merge keys on `id`, while the optimistic dedupe below keys on
        // `tsMsgId`. The two coincide for every message shape in the tree today
        // (buildTimelineFallback and the server both set id = tsMsgId, and only
        // kind === 'message' items carry a tsMsgId at all), but nothing enforces
        // it - a future item shape whose id diverges would show a duplicate.
        items: isFirstLoad ? mergeTimelineItems([], items) : mergeTimelineItems(prev.items, items),
        upcoming,
        upcomingTimezone,
        source,
      }));
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // The spread PRESERVES items, so a merged older page survives a failed
      // refetch rather than the operator losing history they already paged in.
      setState((prev) => ({ ...prev, status: 'error' }));
    }
  }, [contactId, kinds]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlderRef.current) return;
    const cursor = cursorRef.current;
    if (cursor === null) return;
    loadingOlderRef.current = true;
    olderAbortRef.current?.abort();
    const controller = new AbortController();
    olderAbortRef.current = controller;
    setLoadingOlder(true);
    try {
      // getContactTimeline DIRECTLY, never loadTimeline. That helper's 404 branch
      // assembles the whole-inbox fallback, which on an older page would (a) have
      // no cursor parameter to page with at all, (b) fan out one getConversations
      // plus one getConversationMessages per thread on every click, (c) merge a
      // messages-only re-read of the NEWEST messages into a source: 'server'
      // timeline while still bumping olderPagesLoaded - firing <Timeline>'s
      // prepend anchor for a prepend that never happened - and (d) re-scan the
      // inbox on every click for a soft-deleted contact, whose 404 is
      // contact_not_found rather than "endpoint not live yet".
      const page = await getContactTimeline(
        contactId,
        {
          ...(kinds !== undefined && { kinds }),
          cursor,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      // Exact, not heuristic: nextCursor is authoritative for this route. Taken
      // from the page either way, so a page that merges nothing still advances
      // the cursor and the operator can keep paging.
      cursorRef.current = page.nextCursor;
      setHasOlder(page.nextCursor !== null);
      // Normalized ONCE, outside the updater: React may invoke an updater twice,
      // so the "did anything actually merge?" decision cannot live inside one.
      const olderItems = normalizeServerItems(page.items);
      // Spec 4.5: an older page that merges NOTHING is not a prepend, so neither
      // the item state nor the counter moves. Bumping would fire <Timeline>'s
      // scroll anchor for a prepend that never happened and swallow the pill of
      // any append coalesced into the same commit.
      if (olderItems.length > 0) {
        setState((prev) => ({
          ...prev,
          // `upcoming` / `upcomingTimezone` are a FIRST-PAGE-ONLY bucket
          // server-side (the route gathers them only when `cursor` is absent), so
          // an older page carries none. The spread keeps what the first page gave
          // us rather than blanking the pinned section.
          items: mergeTimelineItems(prev.items, olderItems),
        }));
        // Bump LAST and only here: this is what tells <Timeline> a prepend landed.
        setOlderPagesLoaded((n) => n + 1);
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // Leave the cursor intact so the control stays and the operator can retry.
      // A failed older page must never error the whole timeline: the history they
      // already have is still correct.
    } finally {
      // Guarded exactly like the state setter beside it: an ABORTED request no
      // longer owns the in-flight guard, so a late-settling one must not clear it
      // out from under a NEWER request. Unreachable through the button (disabled
      // by loadingOlder), but the deferred scroll-triggered auto-loader (spec
      // section 6) calls loadOlder() programmatically. The abort path that DOES
      // need the guard cleared (a contact or kinds change) clears it itself in
      // the reset effect above.
      if (!controller.signal.aborted) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [contactId, kinds]);

  useEffect(() => {
    // fetchNow sets state only AFTER an await (never synchronously) — a
    // fetch-on-mount/refetch, not the cascading-render case the rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchNow();
    return () => abortRef.current?.abort();
  }, [fetchNow]);

  // Mirrors the abortRef cleanup above for the independent older-page controller.
  useEffect(() => () => olderAbortRef.current?.abort(), []);

  // Debounced SSE-driven refetch. The timer ref lives across renders; the SSE
  // handlers are ref-stable inside useEventStream.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void fetchNow();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchNow]);

  // Keyed on the same identity `fetchNow` is - `[contactId, kinds]`, NOT `[]`.
  // An armed timer captured the old `fetchNow`, so surviving a contact switch
  // (or a kinds change) means reading the PREVIOUS feed and writing it into this
  // instance, which is now showing a different one. Merge-by-id makes that
  // permanent rather than transient, and this hook is the one that does not
  // remount across a contactId change (ContactDetail re-renders the same
  // instance), so nothing else would clear it.
  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
      }
    },
    [contactId, kinds],
  );

  useEventStream({
    onMessagePersisted: scheduleRefetch,
    onConversationUpdated: scheduleRefetch,
    // A tour-reminder / placement-nudge ladder was armed/rescheduled/canceled —
    // refetch so the pinned "Upcoming" section updates live (Task 6).
    onScheduledUpdated: scheduleRefetch,
  });

  // Merge server items with optimistic sends, dropping any optimistic bubble the
  // server has already caught up to (matched by tsMsgId) so there's no duplicate
  // once the refetch lands. Optimistic items carry `at = now`, so they sort last
  // (newest) — appended after the chronological server items.
  const items = useMemo(() => {
    if (pending.length === 0) return state.items;
    const serverIds = new Set<string>();
    for (const i of state.items) if (i.kind === 'message') serverIds.add(i.tsMsgId);
    const extra = pending.filter((p) => !serverIds.has(p.item.tsMsgId)).map((p) => p.item);
    return extra.length === 0 ? state.items : [...state.items, ...extra];
  }, [state.items, pending]);

  return {
    status: state.status,
    items,
    upcoming: state.upcoming,
    upcomingTimezone: state.upcomingTimezone,
    source: state.source,
    // Shares the SSE debounce, so an on-page mutation racing an SSE burst still
    // coalesces into one refetch.
    refetch: scheduleRefetch,
    addOptimistic,
    resolveOptimistic,
    failOptimistic,
    hasOlder,
    loadingOlder,
    loadOlder,
    olderPagesLoaded,
  };
}
