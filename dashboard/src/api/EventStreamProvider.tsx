// EventStreamProvider — owns the ONE EventSource the whole authenticated app
// shares. Every feature that wants live updates calls useEventStream(handlers)
// (unchanged API); under the hood each call just registers its handlers here, so
// the app holds a SINGLE /api/events connection instead of one per consumer.
//
// Why one connection: over HTTP/1.1 (the Vite dev server, and any non-h2 origin)
// a browser caps ~6 connections per host. EventSource streams stay open forever,
// so N independent useEventStream callers (badge + timeline + mark-read + …) burn
// N of those slots permanently and starve ordinary fetches/POSTs — they queue and
// appear to hang. Fanning one stream out to many subscribers fixes that at the
// root. Mount this INSIDE the auth gate so the stream only runs when logged in.
//
// The reconnect/backoff logic is ported verbatim from the original per-hook
// useEventStream (capped exponential backoff for the give-up cases EventSource
// won't retry itself; a manual close on unmount).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type {
  PlacementUpdatedEvent,
  ConversationUpdatedEvent,
  MessagePersistedEvent,
  BroadcastUpdatedEvent,
  ScheduledUpdatedEvent,
} from './types.js';

export interface EventStreamHandlers {
  onConversationUpdated?: (event: ConversationUpdatedEvent) => void;
  /** A placement (M1.10) changed — live board move / attention / tour / deadline. */
  onPlacementUpdated?: (event: PlacementUpdatedEvent) => void;
  /** A message was persisted — the contact timeline refetches to show it live. */
  onMessagePersisted?: (event: MessagePersistedEvent) => void;
  /** A scheduled ladder (tour reminder / placement nudge) was armed/rescheduled/
   *  canceled — the contact timeline refetches its pinned "Upcoming" section. */
  onScheduledUpdated?: (event: ScheduledUpdatedEvent) => void;
  /** A broadcast changed — the Results view overlays status+stats live (then
   *  refetches for the per-recipient detail the payload omits). */
  onBroadcastUpdated?: (event: BroadcastUpdatedEvent) => void;
  /** Called when the stream opens (after connect/reconnect). */
  onOpen?: () => void;
  /** Called when the stream errors (before a reconnect is scheduled). */
  onError?: () => void;
  /** Set false to opt this subscriber OUT of events (the shared connection stays
   *  open for the others). Default true. */
  enabled?: boolean;
}

/** A stable box holding a subscriber's latest handlers. The provider reads
 *  `.current` at dispatch time so handlers can change between renders without
 *  re-registering. */
export type HandlersRef = { readonly current: EventStreamHandlers };

interface EventStreamContextValue {
  /** Register a subscriber; returns an unsubscribe fn. Stable for the provider's
   *  lifetime, so callers can use it as an effect dependency safely. */
  subscribe: (ref: HandlersRef) => () => void;
}

const EventStreamContext = createContext<EventStreamContextValue | null>(null);

/** Reconnect backoff bounds (ms). EventSource retries on its own for clean
 *  drops; this covers the give-up cases and caps the retry storm. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function EventStreamProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // The live subscriber set. Mutated only from subscribe()/unsubscribe() (effect
  // time, never render) and read only from the EventSource callbacks (post-commit).
  const subscribersRef = useRef<Set<HandlersRef>>(new Set());

  const subscribe = useCallback((ref: HandlersRef): (() => void) => {
    subscribersRef.current.add(ref);
    return () => {
      subscribersRef.current.delete(ref);
    };
  }, []);

  useEffect(() => {
    // Feature-detect EventSource: absent in non-browser environments (e.g. jsdom
    // tests that don't stub it). Degrade to "no live updates" instead of throwing.
    if (typeof EventSource === 'undefined') return;

    let source: EventSource | null = null;
    let reconnectDelay = RECONNECT_MIN_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const parse = <T,>(raw: string): T | undefined => {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    };

    // Fan one event out to every enabled subscriber's current handler.
    const dispatch = <T,>(
      pick: (h: EventStreamHandlers) => ((event: T) => void) | undefined,
      data: T,
    ): void => {
      for (const ref of subscribersRef.current) {
        if (ref.current.enabled === false) continue;
        pick(ref.current)?.(data);
      }
    };
    const fire = (pick: (h: EventStreamHandlers) => (() => void) | undefined): void => {
      for (const ref of subscribersRef.current) {
        if (ref.current.enabled === false) continue;
        pick(ref.current)?.();
      }
    };

    const connect = (): void => {
      if (closed) return;
      source = new EventSource('/api/events', { withCredentials: true });

      source.addEventListener('open', () => {
        reconnectDelay = RECONNECT_MIN_MS; // healthy connection — reset backoff
        fire((h) => h.onOpen);
      });

      source.addEventListener('conversation.updated', (ev) => {
        const data = parse<ConversationUpdatedEvent>((ev as MessageEvent).data);
        if (data) dispatch((h) => h.onConversationUpdated, data);
      });

      source.addEventListener('placement.updated', (ev) => {
        const data = parse<PlacementUpdatedEvent>((ev as MessageEvent).data);
        if (data) dispatch((h) => h.onPlacementUpdated, data);
      });

      source.addEventListener('message.persisted', (ev) => {
        const data = parse<MessagePersistedEvent>((ev as MessageEvent).data);
        if (data) dispatch((h) => h.onMessagePersisted, data);
      });

      source.addEventListener('broadcast.updated', (ev) => {
        const data = parse<BroadcastUpdatedEvent>((ev as MessageEvent).data);
        if (data) dispatch((h) => h.onBroadcastUpdated, data);
      });

      source.addEventListener('scheduled.updated', (ev) => {
        const data = parse<ScheduledUpdatedEvent>((ev as MessageEvent).data);
        if (data) dispatch((h) => h.onScheduledUpdated, data);
      });

      source.addEventListener('error', () => {
        fire((h) => h.onError);
        if (closed) return;
        // OWN the reconnect with capped exponential backoff — do NOT defer to
        // EventSource's native retry. On a refused/down origin the browser keeps
        // readyState at CONNECTING and retries at a FIXED ~3s forever (never
        // reaching CLOSED), so a CLOSED-only guard never engaged the backoff and a
        // prolonged outage hammered every ~3s with no ramp. Closing + rescheduling
        // ourselves gives a real 1s→2s→…→30s back-off. The reconnectTimer guard
        // coalesces the repeated 'error' events one drop fires into one reconnect.
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
  }, []);

  const value = useMemo<EventStreamContextValue>(() => ({ subscribe }), [subscribe]);
  return <EventStreamContext.Provider value={value}>{children}</EventStreamContext.Provider>;
}

/** Internal: the shared subscribe fn, or null when no provider is mounted. The
 *  whole authenticated app is wrapped by one in App.tsx, so in practice this is
 *  non-null for every real consumer; useEventStream degrades to "no live updates"
 *  when it's null (e.g. a jsdom unit test that doesn't mount the provider —
 *  matching the original hook's behavior when EventSource was absent). */
export function useOptionalEventStreamContext(): EventStreamContextValue | null {
  return useContext(EventStreamContext);
}
