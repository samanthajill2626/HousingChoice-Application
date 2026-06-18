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
  getConversations,
  useEventStream,
  type Message,
  type SendMessageResult,
  type TimelineItem,
  type TimelineMessage,
} from '../../api/index.js';
import { buildTimelineFallback } from './buildTimelineFallback.js';

export type TimelineStatus = 'loading' | 'ready' | 'error';
export type TimelineSource = 'server' | 'fallback';

export interface ContactTimelineState {
  status: TimelineStatus;
  /** Server items merged with any in-flight OPTIMISTIC sends (deduped by tsMsgId). */
  items: TimelineItem[];
  /** Which path produced `items` — 'server' (/timeline) or 'fallback' (assembled). */
  source: TimelineSource;
  /** Optimistic send: show an outbound bubble ("Sending…") immediately; returns a
   *  temp id to reconcile with. */
  addOptimistic: (conversationId: string, body: string, toPhone?: string) => string;
  /** POST succeeded: stamp the real tsMsgId + status so the SSE refetch reconciles
   *  the bubble by id (then it advances Sending… → Sent → Delivered on its own). */
  resolveOptimistic: (tempId: string, result: SendMessageResult) => void;
  /** POST failed: drop the optimistic bubble (the caller restores the draft). */
  failOptimistic: (tempId: string) => void;
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
): Promise<{ items: TimelineItem[]; source: TimelineSource }> {
  try {
    const page = await getContactTimeline(
      contactId,
      kinds !== undefined ? { kinds } : {},
      signal,
    );
    return { items: normalizeServerItems(page.items), source: 'server' };
  } catch (err) {
    // Only a 404 means "endpoint not live yet" → assemble the fallback. Any
    // other failure (and the fallback's own failures) propagates to the error
    // state.
    if (!(err instanceof ApiError) || err.status !== 404) throw err;

    // NOTE: reads only the FIRST inbox page (no nextCursor paging). A
    // transitional limitation — BE2's /timeline supersedes this entirely, and a
    // single contact's threads almost always fit one page.
    const conversations = (await getConversations(signal)).conversations.filter((c) =>
      involvesContact(c.participants, contactId),
    );
    const messagesByConvId = new Map<string, Message[]>();
    // allSettled: one failed per-conversation fetch drops THAT thread rather
    // than failing the whole timeline (the others still render).
    const results = await Promise.allSettled(
      conversations.map(async (c) => ({
        id: c.conversationId,
        messages: await getConversationMessages(c.conversationId, signal),
      })),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') messagesByConvId.set(r.value.id, r.value.messages);
    }
    return { items: buildTimelineFallback(conversations, messagesByConvId), source: 'fallback' };
  }
}

export function useContactTimeline(contactId: string, kinds?: string): ContactTimelineState {
  const [state, setState] = useState<ContactTimelineState>({
    status: 'loading',
    items: [],
    source: 'server',
  });

  // In-flight OPTIMISTIC sends, shown immediately and reconciled against the
  // server timeline by tsMsgId (dropped once the refetch carries the real row).
  const [pending, setPending] = useState<PendingSend[]>([]);
  const tempIdRef = useRef(0);

  // Track the in-flight request so a refetch supersedes the previous one and a
  // late response from an aborted request can't clobber fresher state.
  const abortRef = useRef<AbortController | null>(null);

  const addOptimistic = useCallback(
    (conversationId: string, body: string, toPhone?: string): string => {
      tempIdRef.current += 1;
      const tempId = `optimistic:${tempIdRef.current}`;
      const item: TimelineMessage = {
        kind: 'message',
        id: tempId,
        at: new Date().toISOString(),
        conversationId,
        tsMsgId: tempId,
        direction: 'outbound',
        author: 'teammate',
        type: 'sms',
        body,
        // 'queued' renders as "Sending…" (deliveryStatus) — the in-progress state.
        delivery_status: 'queued',
        ...(toPhone !== undefined && { toPhone }),
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

  // A new contact resets any leftover optimistic bubbles from the previous one.
  useEffect(() => {
    setPending([]);
  }, [contactId]);

  const fetchNow = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { items, source } = await loadTimeline(contactId, kinds, controller.signal);
      if (controller.signal.aborted) return;
      setState({ status: 'ready', items, source });
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      setState((prev) => ({ ...prev, status: 'error' }));
    }
  }, [contactId, kinds]);

  useEffect(() => {
    void fetchNow();
    return () => abortRef.current?.abort();
  }, [fetchNow]);

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

  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    },
    [],
  );

  useEventStream({
    onMessagePersisted: scheduleRefetch,
    onConversationUpdated: scheduleRefetch,
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
    source: state.source,
    addOptimistic,
    resolveOptimistic,
    failOptimistic,
  };
}
