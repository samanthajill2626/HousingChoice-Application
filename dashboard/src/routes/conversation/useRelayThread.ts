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
  type Message,
  type SendMessageResult,
  type TimelineItem,
  type TimelineMessage,
  type TimelineScheduled,
} from '../../api/index.js';

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

/** Map a persisted Message → a TimelineMessage bubble. Call records (type
 *  'call') are dropped — a relay thread carries only sms/mms. */
export function toTimelineMessage(m: Message): TimelineMessage | null {
  if (m.type === 'call') return null;
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

  // In-flight OPTIMISTIC sends, reconciled against the server thread by tsMsgId.
  const [pending, setPending] = useState<PendingSend[]>([]);
  const tempIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

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
      // The scheduled bucket rides along BEST-EFFORT: a failure there must
      // never blank a working thread (it just leaves Upcoming empty).
      const [messages, scheduled] = await Promise.all([
        getConversationMessages(conversationId, controller.signal),
        getConversationScheduled(conversationId, controller.signal).catch(
          (): TimelineScheduled[] => [],
        ),
      ]);
      if (controller.signal.aborted) return;
      setServerItems(buildRelayItems(messages));
      setUpcoming(scheduled);
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

  return { status, items, upcoming, addOptimistic, resolveOptimistic, failOptimistic };
}
