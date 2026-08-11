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
  /** Refetch now (the view's error-state retry). */
  refresh: () => void;
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

  // A new conversation resets any leftover optimistic bubbles.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending([]);
  }, [conversationId]);

  const fetchNow = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const messages = await getConversationMessages(conversationId, controller.signal);
      if (controller.signal.aborted) return;
      // buildRelayItems is the shared multi-party mapper: it carries
      // relay_sender_key + delivery_recipients onto each bubble, which is
      // exactly what group messages persist (spec 4.3).
      setServerItems(buildRelayItems(messages));
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      setStatus('error');
    }
  }, [conversationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchNow();
    return () => abortRef.current?.abort();
  }, [fetchNow]);

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

  const refresh = useCallback(() => {
    setStatus('loading');
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

  return { status, items, refresh, addOptimistic, resolveOptimistic, failOptimistic };
}
