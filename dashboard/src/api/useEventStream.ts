// useEventStream — manages an EventSource on GET /api/events for the lifetime of
// the calling component, dispatching the server events to typed callbacks. The
// browser EventSource carries the session cookie (same-origin) and auto-
// reconnects on transient drops; we OWN an explicit reconnect with capped
// exponential backoff for the cases EventSource gives up on (and a manual close
// on unmount). Feature code passes handlers in a ref-stable way; it never
// touches EventSource. Ported from dashboard-legacy/src/api/useEventStream.ts —
// trimmed to the events the new dashboard's Today queue consumes
// (conversation.updated, case.updated); add more handlers as later phases need.
import { useEffect, useRef } from 'react';
import type {
  CaseUpdatedEvent,
  ConversationUpdatedEvent,
  MessagePersistedEvent,
} from './types.js';

export interface EventStreamHandlers {
  onConversationUpdated?: (event: ConversationUpdatedEvent) => void;
  /** A case (M1.10) changed — live board move / attention / tour / deadline. */
  onCaseUpdated?: (event: CaseUpdatedEvent) => void;
  /** A message was persisted — the contact timeline refetches to show it live. */
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
  // every render (handlers are typically inline functions). Write the ref in a
  // passive effect rather than during render — the subscription only reads
  // handlersRef.current from event callbacks that fire after commit, so the
  // one-render-late update is invisible (and refs must not be mutated in render).
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;
    // Feature-detect EventSource: it's absent in non-browser environments (e.g.
    // jsdom under unit tests that don't stub it). Without this the hook would
    // throw on connect; degrade to "no live updates" instead.
    if (typeof EventSource === 'undefined') return;

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

      source.addEventListener('case.updated', (ev) => {
        const data = parse<CaseUpdatedEvent>((ev as MessageEvent).data);
        if (data) handlersRef.current.onCaseUpdated?.(data);
      });

      source.addEventListener('message.persisted', (ev) => {
        const data = parse<MessagePersistedEvent>((ev as MessageEvent).data);
        if (data) handlersRef.current.onMessagePersisted?.(data);
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
