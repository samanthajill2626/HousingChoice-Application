// useFakeEvents — manages an EventSource on GET /control/events for the lifetime
// of the calling component, dispatching the engine's live state-changes to a
// single typed `onEvent` handler. Adapted from the dashboard's useEventStream
// (handlers-in-ref, capped exponential backoff 1s→30s, manual close on unmount),
// but same-origin with NO credentials (the fake-twilio host sets no cookies).
import { useEffect, useRef } from 'react';
import type { EngineEvent } from './types.js';

export interface FakeEventHandlers {
  onEvent: (event: EngineEvent) => void;
  /** Called when the stream opens (after connect/reconnect). */
  onOpen?: () => void;
  /** Called when the stream errors (before a reconnect is scheduled). */
  onError?: () => void;
  /** Set false to disable the stream entirely. Default true. */
  enabled?: boolean;
}

/** The four engine event names emitted over SSE (see fake-twilio engine.ts). */
const EVENT_TYPES = ['message.appended', 'message.updated', 'persona.added', 'reset'] as const;

/** Reconnect backoff bounds (ms). EventSource retries on its own for clean
 *  drops; this covers the give-up cases and caps the retry storm. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function useFakeEvents(handlers: FakeEventHandlers): void {
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

    const parse = (raw: string): EngineEvent | undefined => {
      try {
        return JSON.parse(raw) as EngineEvent;
      } catch {
        return undefined;
      }
    };

    const connect = (): void => {
      if (closed) return;
      // Same-origin, no credentials — the fake-twilio host sets no cookies.
      source = new EventSource('/control/events');

      source.addEventListener('open', () => {
        reconnectDelay = RECONNECT_MIN_MS; // healthy connection — reset backoff
        handlersRef.current.onOpen?.();
      });

      for (const type of EVENT_TYPES) {
        source.addEventListener(type, (ev) => {
          const data = parse((ev as MessageEvent).data);
          if (data) handlersRef.current.onEvent(data);
        });
      }

      source.addEventListener('error', () => {
        handlersRef.current.onError?.();
        if (closed) return;
        // OWN the reconnect with capped exponential backoff (mirror the dashboard):
        // closing + rescheduling ourselves gives a real 1s→2s→…→30s back-off; the
        // reconnectTimer guard coalesces the repeated 'error' events one drop fires
        // into a single scheduled reconnect.
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
