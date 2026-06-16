// useEventStream — manages an EventSource on GET /api/events for the lifetime
// of the calling component, dispatching the two server events to typed
// callbacks. The browser EventSource carries the session cookie (same-origin)
// and auto-reconnects on transient drops; we add an explicit reconnect with
// backoff for the cases EventSource gives up on (and a manual close on
// unmount). Feature agents pass handlers; they never touch EventSource.
import { useEffect, useRef } from 'react';
import type {
  BroadcastUpdatedEvent,
  CaseUpdatedEvent,
  ConversationUpdatedEvent,
  MessagePersistedEvent,
} from './types.js';

export interface EventStreamHandlers {
  onConversationUpdated?: (event: ConversationUpdatedEvent) => void;
  onMessagePersisted?: (event: MessagePersistedEvent) => void;
  /** A share-broadcast (M1.8) progressed — live status + rolled-up stats. */
  onBroadcastUpdated?: (event: BroadcastUpdatedEvent) => void;
  /** A case (M1.10) changed — live board move / attention / tour / deadline. */
  onCaseUpdated?: (event: CaseUpdatedEvent) => void;
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

      source.addEventListener('broadcast.updated', (ev) => {
        const data = parse<BroadcastUpdatedEvent>((ev as MessageEvent).data);
        if (data) handlersRef.current.onBroadcastUpdated?.(data);
      });

      source.addEventListener('case.updated', (ev) => {
        const data = parse<CaseUpdatedEvent>((ev as MessageEvent).data);
        if (data) handlersRef.current.onCaseUpdated?.(data);
      });

      source.addEventListener('error', () => {
        handlersRef.current.onError?.();
        if (closed) return;
        // OWN the reconnect with capped exponential backoff — do NOT defer to
        // EventSource's native retry. On a refused/down origin the browser keeps
        // readyState at CONNECTING and retries at a FIXED ~3s forever (it never
        // reaches CLOSED), so a CLOSED-only guard never engaged the backoff and
        // a prolonged outage hammered every ~3s with no ramp. Closing +
        // rescheduling ourselves gives a real 1s→2s→…→30s back-off. The
        // reconnectTimer guard coalesces the repeated 'error' events one drop
        // fires into a single scheduled reconnect.
        if (reconnectTimer !== undefined) return;
        source?.close();
        source = null;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
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
