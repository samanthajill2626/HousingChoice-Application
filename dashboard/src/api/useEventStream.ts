// useEventStream — subscribe a component to the app's SHARED server-event stream.
// The single EventSource lives in <EventStreamProvider> (api/EventStreamProvider);
// this hook just registers the caller's handlers with it, so any number of
// consumers (Inbox badge, contact timeline, mark-read, Today, …) share ONE
// /api/events connection instead of opening one each. The public API is
// unchanged from the original per-hook connection version — callers pass the same
// handlers object and never touch EventSource.
//
// When no provider is mounted (e.g. a unit test that renders a consumer without
// the app shell) the hook degrades to "no live updates" — the same graceful
// no-op the original had when EventSource was unavailable in jsdom.
import { useEffect, useRef } from 'react';
import { useOptionalEventStreamContext, type EventStreamHandlers } from './EventStreamProvider.js';

export type { EventStreamHandlers } from './EventStreamProvider.js';

export function useEventStream(handlers: EventStreamHandlers): void {
  const ctx = useOptionalEventStreamContext();

  // Keep the latest handlers in a stable box the provider reads at dispatch time,
  // so handler identity changing each render (inline functions) never forces a
  // re-subscribe. Written in a passive effect, not during render (a ref must not
  // be mutated in render).
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  // Register once for the component's lifetime. `subscribe` is provider-stable.
  const subscribe = ctx?.subscribe;
  useEffect(() => {
    if (!subscribe) return;
    return subscribe(ref);
  }, [subscribe]);
}
