// useContactTimeline — the contact detail page's left-pane data hook. Prefers
// the server-merged person-centric timeline (GET /api/contacts/:id/timeline,
// §C2); when that endpoint isn't live yet (ApiError 404) it assembles a
// MESSAGES-ONLY fallback client-side: fetch the inbox conversations, keep the
// ones whose participants include this contact, fetch each one's messages, then
// buildTimelineFallback() into a chronological TimelineMessage[]. This shows the
// contact's REAL seeded messages today (no milestones until BE2). Subscribes to
// the SSE stream and refetches (debounced) on message.persisted /
// conversation.updated so the stream stays live. Mirrors useToday's shape.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getContactTimeline,
  getConversationMessages,
  getConversations,
  useEventStream,
  type Message,
  type TimelineItem,
} from '../../api/index.js';
import { buildTimelineFallback } from './buildTimelineFallback.js';

export type TimelineStatus = 'loading' | 'ready' | 'error';
export type TimelineSource = 'server' | 'fallback';

export interface ContactTimelineState {
  status: TimelineStatus;
  items: TimelineItem[];
  /** Which path produced `items` — 'server' (/timeline) or 'fallback' (assembled). */
  source: TimelineSource;
}

/** Debounce window (ms) for SSE-triggered refetches — coalesces a burst of
 *  message/conversation events into one refetch. */
const REFETCH_DEBOUNCE_MS = 300;

/** True when the conversation summary's participant roster includes this contact. */
function involvesContact(
  participants: { contactId: string }[] | undefined,
  contactId: string,
): boolean {
  return (participants ?? []).some((p) => p.contactId === contactId);
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
    return { items: page.items, source: 'server' };
  } catch (err) {
    // Only a 404 means "endpoint not live yet" → assemble the fallback. Any
    // other failure (and the fallback's own failures) propagates to the error
    // state.
    if (!(err instanceof ApiError) || err.status !== 404) throw err;

    const conversations = (await getConversations(signal)).conversations.filter((c) =>
      involvesContact(c.participants, contactId),
    );
    const messagesByConvId = new Map<string, Message[]>();
    await Promise.all(
      conversations.map(async (c) => {
        messagesByConvId.set(c.conversationId, await getConversationMessages(c.conversationId, signal));
      }),
    );
    return { items: buildTimelineFallback(conversations, messagesByConvId), source: 'fallback' };
  }
}

export function useContactTimeline(contactId: string, kinds?: string): ContactTimelineState {
  const [state, setState] = useState<ContactTimelineState>({
    status: 'loading',
    items: [],
    source: 'server',
  });

  // Track the in-flight request so a refetch supersedes the previous one and a
  // late response from an aborted request can't clobber fresher state.
  const abortRef = useRef<AbortController | null>(null);

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

  return state;
}
