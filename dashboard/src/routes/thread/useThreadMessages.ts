// useThreadMessages — owns the message-timeline state for one conversation.
//
// The API returns messages NEWEST-FIRST; the chat renders OLDEST→bottom. This
// hook keeps an internal list sorted ASCENDING by tsMsgId (the server's
// `<providerTs>#<providerSid>` sort key) so the view can map it straight to
// bubbles. It handles:
//   - initial load + "load older" via the `before` cursor (oldest tsMsgId)
//   - OPTIMISTIC send: append a synthetic pending message immediately, then
//     reconcile it to the server's tsMsgId/status on the POST response
//   - DEDUPE by tsMsgId: every merge keys on tsMsgId, so the SSE echo of a
//     message we already appended (or a paged-in duplicate) is a no-op
//   - RETRY: re-POST the same body via sendMessage (there is no retry endpoint)
//   - live append when an SSE 'message.persisted' fires for this conversation
//
// Mutations call the endpoint functions directly (per the foundation hook
// guidance); GET loads use plain fetches we control so paging composes cleanly.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  listMessages,
  sendMessage,
  type Message,
  type MessagePersistedEvent,
} from '../../api';

/** How many messages to request per page. */
const PAGE_LIMIT = 50;

/** A locally-appended message awaiting its server tsMsgId (optimistic send). */
export interface PendingMessage extends Message {
  /** Marks a not-yet-reconciled optimistic bubble. */
  pending: true;
  /** Stable local key (the synthetic tsMsgId), so React keys stay put. */
  localId: string;
}

export type TimelineMessage = Message | PendingMessage;

export function isPending(m: TimelineMessage): m is PendingMessage {
  return (m as PendingMessage).pending === true;
}

export interface UseThreadMessages {
  /** Ascending by tsMsgId — render top→bottom as a chat. */
  messages: TimelineMessage[];
  loading: boolean;
  /** Initial-load error (paging/send errors surface via their own returns). */
  error: ApiError | undefined;
  /** True while a "load older" page is in flight. */
  loadingOlder: boolean;
  /** False once the server returns a short page (no more history). */
  hasMore: boolean;
  loadOlder: () => void;
  /**
   * Optimistically send `body`. Resolves to the SendMessageResult on success;
   * on failure the optimistic bubble is removed and the ApiError is thrown so
   * the composer can render it inline.
   */
  send: (body: string) => Promise<void>;
  /** Re-send a failed/undelivered message's body (no dedicated retry endpoint). */
  retry: (message: Message) => Promise<void>;
  /** Merge a live SSE message into the timeline (deduped by tsMsgId). */
  ingestEvent: (event: MessagePersistedEvent) => void;
}

/** Ascending sort key comparison on tsMsgId (string-sortable by design). */
function byTsMsgId(a: TimelineMessage, b: TimelineMessage): number {
  return a.tsMsgId < b.tsMsgId ? -1 : a.tsMsgId > b.tsMsgId ? 1 : 0;
}

/**
 * Merge `incoming` into `existing`, keyed by tsMsgId (dedupe), and re-sort
 * ascending. A later copy of a tsMsgId wins (so an SSE/refetch with an updated
 * delivery_status replaces the older copy). Pending bubbles (synthetic ids) are
 * preserved untouched.
 */
function mergeById(existing: TimelineMessage[], incoming: Message[]): TimelineMessage[] {
  const map = new Map<string, TimelineMessage>();
  for (const m of existing) map.set(m.tsMsgId, m);
  for (const m of incoming) map.set(m.tsMsgId, m);
  return Array.from(map.values()).sort(byTsMsgId);
}

let pendingSeq = 0;
function nextPendingId(): string {
  pendingSeq += 1;
  return `pending:${Date.now()}:${pendingSeq}`;
}

export function useThreadMessages(conversationId: string): UseThreadMessages {
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // The set of real tsMsgIds we already hold — read inside callbacks without
  // re-subscribing them to `messages`.
  const seenRef = useRef<Set<string>>(new Set());
  const oldestRef = useRef<string | undefined>(undefined);

  const recordIds = useCallback((list: TimelineMessage[]) => {
    const seen = new Set<string>();
    let oldest: string | undefined;
    for (const m of list) {
      if (!isPending(m)) {
        seen.add(m.tsMsgId);
        if (oldest === undefined || m.tsMsgId < oldest) oldest = m.tsMsgId;
      }
    }
    seenRef.current = seen;
    oldestRef.current = oldest;
  }, []);

  const apply = useCallback(
    (updater: (prev: TimelineMessage[]) => TimelineMessage[]) => {
      setMessages((prev) => {
        const next = updater(prev);
        recordIds(next);
        return next;
      });
    },
    [recordIds],
  );

  // Initial load (and reload when the conversation id changes).
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(undefined);
    setMessages([]);
    seenRef.current = new Set();
    oldestRef.current = undefined;

    listMessages(conversationId, { limit: PAGE_LIMIT }, controller.signal)
      .then((page) => {
        if (!active) return;
        const ascending = [...page].sort(byTsMsgId);
        setMessages(ascending);
        recordIds(ascending);
        setHasMore(page.length >= PAGE_LIMIT);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err : new ApiError(0, 'unknown_error', String(err)));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [conversationId, recordIds]);

  const loadOlder = useCallback(() => {
    const before = oldestRef.current;
    if (before === undefined || loadingOlder) return;
    setLoadingOlder(true);
    listMessages(conversationId, { limit: PAGE_LIMIT, before })
      .then((page) => {
        apply((prev) => mergeById(prev, page));
        setHasMore(page.length >= PAGE_LIMIT);
      })
      .catch(() => {
        // A failed "load older" leaves history intact; the user can retry by
        // scrolling again. Surfaced quietly to keep the timeline non-blocking.
      })
      .finally(() => setLoadingOlder(false));
  }, [conversationId, loadingOlder, apply]);

  const send = useCallback(
    async (body: string): Promise<void> => {
      const localId = nextPendingId();
      // tsMsgId for an optimistic bubble must sort AFTER everything seen, so it
      // pins to the bottom; the high prefix guarantees that until reconciliation.
      const optimistic: PendingMessage = {
        conversationId,
        tsMsgId: `￿${localId}`,
        localId,
        pending: true,
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body,
        provider_sid: '',
        provider_ts: '',
        delivery_status: 'queued',
        created_at: new Date().toISOString(),
      };
      apply((prev) => [...prev, optimistic].sort(byTsMsgId));

      try {
        const result = await sendMessage(conversationId, { body });
        // Reconcile: swap the optimistic bubble for the real persisted message.
        apply((prev) => {
          const without = prev.filter((m) => !(isPending(m) && m.localId === localId));
          const reconciled: Message = {
            ...optimistic,
            tsMsgId: result.tsMsgId,
            provider_sid: result.providerSid,
            delivery_status: result.status,
          };
          // Drop the `pending`/`localId` synthetic fields off the reconciled copy.
          delete (reconciled as Partial<PendingMessage>).pending;
          delete (reconciled as Partial<PendingMessage>).localId;
          return mergeById(without, [reconciled]);
        });
      } catch (err) {
        // Failed send → remove the optimistic bubble; let the composer render it.
        apply((prev) => prev.filter((m) => !(isPending(m) && m.localId === localId)));
        throw err;
      }
    },
    [conversationId, apply],
  );

  const retry = useCallback(
    async (message: Message): Promise<void> => {
      const body = message.body ?? '';
      if (body.length === 0) {
        throw new ApiError(0, 'nothing_to_retry', 'This message has no text to re-send');
      }
      // Re-POST the same body (there is no dedicated retry endpoint). The send
      // path already does optimistic-append + reconcile + dedupe.
      await send(body);
    },
    [send],
  );

  const ingestEvent = useCallback(
    (event: MessagePersistedEvent) => {
      if (event.conversationId !== conversationId) return;
      // Dedupe: if we already hold this tsMsgId (e.g. our own optimistic send
      // just reconciled to it), only patch its delivery_status; otherwise fetch
      // a fresh page bounded so the new message lands without a full reload.
      if (seenRef.current.has(event.tsMsgId)) {
        apply((prev) =>
          prev.map((m) =>
            !isPending(m) && m.tsMsgId === event.tsMsgId
              ? { ...m, delivery_status: event.deliveryStatus }
              : m,
          ),
        );
        return;
      }
      // New message we haven't seen — pull the latest page and merge (deduped).
      listMessages(conversationId, { limit: PAGE_LIMIT })
        .then((page) => apply((prev) => mergeById(prev, page)))
        .catch(() => {
          // Non-fatal: the next event or a manual refresh will reconcile.
        });
    },
    [conversationId, apply],
  );

  return {
    messages,
    loading,
    error,
    loadingOlder,
    hasMore,
    loadOlder,
    send,
    retry,
    ingestEvent,
  };
}
