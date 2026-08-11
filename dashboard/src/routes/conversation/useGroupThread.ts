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
//   - NO optimistic-send trio yet. S4 ships the READ path; the composer (and
//     with it the optimistic bubble) is S5's - see GroupTextView's send seam.
//
// SSE: message.persisted / conversation.updated schedule the same debounced
// refetch as the relay thread, so an inbound member message appears live.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getConversationMessages,
  useEventStream,
  type TimelineItem,
} from '../../api/index.js';
import { buildRelayItems } from './useRelayThread.js';

export type GroupThreadStatus = 'loading' | 'ready' | 'error';

/** Debounce window (ms) for SSE-triggered refetches - coalesces a burst of
 *  message/conversation events into one refetch (matches useRelayThread). */
const REFETCH_DEBOUNCE_MS = 300;

export interface GroupThreadState {
  status: GroupThreadStatus;
  items: TimelineItem[];
  /** Refetch now (the view's error-state retry). */
  refresh: () => void;
}

export function useGroupThread(conversationId: string): GroupThreadState {
  const [status, setStatus] = useState<GroupThreadStatus>('loading');
  const [items, setItems] = useState<TimelineItem[]>([]);
  const abortRef = useRef<AbortController | null>(null);

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
      setItems(buildRelayItems(messages));
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

  return { status, items, refresh };
}
