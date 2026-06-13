// useEventStream — manages an EventSource on GET /api/events for the lifetime
// of the calling component, dispatching the two server events to typed
// callbacks. The browser EventSource carries the session cookie (same-origin)
// and auto-reconnects on transient drops; we add an explicit reconnect with
// backoff for the cases EventSource gives up on (and a manual close on
// unmount). Feature agents pass handlers; they never touch EventSource.
import { useEffect, useRef } from 'react';
import type { ConversationUpdatedEvent, MessagePersistedEvent } from './types.js';

export interface EventStreamHandlers {
  onConversationUpdated?: (event: ConversationUpdatedEvent) => void;
  onMessagePersisted?: (event: MessagePersistedEvent) => void;
  /** Called when the stream opens (after connect/reconnect). */
  onOpen?: () => void;
  /** Called when the stream errors (before a reconnect is scheduled). */
  onError?: () => void;
  /** Set false to disable the stream entirely (e.g. while anonymous). Default true. */
  enabled?: boolean;
}

/** Reconnect backoff bounds (ms). EventSource retries on its own for clean
 *  drops; this covers the give-up cases and caps the retry storm. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function useEventStream(handlers: EventStreamHandlers): void {
  const { enabled = true } = handlers;
  // Keep the latest handlers in a ref so the effect doesn't re-subscribe on
  // every render (handlers are typically inline functions).
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    let source: EventSource | null = null;
    let reconnectDelay = RECONNECT_MIN_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const parse = <T>(raw: string): T | undefined => {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    };

    const connect = (): void => {
      if (closed) return;
      source = new EventSource('/api/events', { withCredentials: true });

      source.addEventListener('open', () => {
        reconnectDelay = RECONNECT_MIN_MS; // healthy connection — reset backoff
        handlersRef.current.onOpen?.();
      });

      source.addEventListener('conversation.updated', (ev) => {
        const data = parse<ConversationUpdatedEvent>((ev as MessageEvent).data);
        if (data) handlersRef.current.onConversationUpdated?.(data);
      });

      source.addEventListener('message.persisted', (ev) => {
        const data = parse<MessagePersistedEvent>((ev as MessageEvent).data);
        if (data) handlersRef.current.onMessagePersisted?.(data);
      });

      source.addEventListener('error', () => {
        handlersRef.current.onError?.();
        // EventSource auto-reconnects while readyState is CONNECTING; only step
        // in when it has CLOSED (gave up) — reopen with capped backoff.
        if (source && source.readyState === EventSource.CLOSED && !closed) {
          source.close();
          source = null;
          reconnectTimer = setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
        }
      });
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [enabled]);
}
