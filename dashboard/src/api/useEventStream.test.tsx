import { render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventStreamProvider } from './EventStreamProvider.js';
import { useEventStream, type EventStreamHandlers } from './useEventStream.js';
import type { PlacementUpdatedEvent, ConversationUpdatedEvent } from './types.js';

// A minimal in-memory EventSource double: records the URL it was opened with,
// lets a test dispatch named events, and tracks close(). One live instance at a
// time is enough for these tests.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  withCredentials: boolean;
  closed = false;
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  emit(type: string, data: unknown): void {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners.get(type)?.forEach((fn) => fn(ev));
  }

  emitRaw(type: string, raw: string): void {
    const ev = new MessageEvent(type, { data: raw });
    this.listeners.get(type)?.forEach((fn) => fn(ev));
  }

  close(): void {
    this.closed = true;
  }
}

/** A subscriber component — registers handlers with the shared provider. */
function Sub(props: EventStreamHandlers): null {
  useEventStream(props);
  return null;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('EventStreamProvider + useEventStream', () => {
  it('opens a SINGLE EventSource on /api/events with credentials', () => {
    render(
      <EventStreamProvider>
        <Sub />
      </EventStreamProvider>,
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe('/api/events');
    expect(FakeEventSource.instances[0]?.withCredentials).toBe(true);
  });

  it('shares ONE connection across many subscribers', () => {
    render(
      <EventStreamProvider>
        <Sub />
        <Sub />
        <Sub />
      </EventStreamProvider>,
    );
    // The whole point of the consolidation: 3 consumers, 1 connection.
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('fans an event out to every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    render(
      <EventStreamProvider>
        <Sub onConversationUpdated={a} />
        <Sub onConversationUpdated={b} />
      </EventStreamProvider>,
    );
    const conv: ConversationUpdatedEvent = {
      conversationId: 'c1',
      last_activity_at: '2026-06-16T00:00:00Z',
      unread_count: 2,
      type: 'tenant_1to1',
      assignment: null,
      participant_display_name: 'Tasha',
    };
    act(() => {
      FakeEventSource.instances[0]?.emit('conversation.updated', conv);
    });
    expect(a).toHaveBeenCalledWith(conv);
    expect(b).toHaveBeenCalledWith(conv);
  });

  it('dispatches conversation.updated + placement.updated to typed handlers', () => {
    const onConversationUpdated = vi.fn();
    const onPlacementUpdated = vi.fn();
    render(
      <EventStreamProvider>
        <Sub onConversationUpdated={onConversationUpdated} onPlacementUpdated={onPlacementUpdated} />
      </EventStreamProvider>,
    );
    const src = FakeEventSource.instances[0];
    if (!src) throw new Error('no source');

    const conv: ConversationUpdatedEvent = {
      conversationId: 'c1',
      last_activity_at: '2026-06-16T00:00:00Z',
      unread_count: 2,
      type: 'tenant_1to1',
      assignment: null,
      participant_display_name: 'Tasha',
    };
    const kase: PlacementUpdatedEvent = {
      placementId: 'k1',
      tenantId: 't1',
      unitId: 'u1',
      stage: 'schedule_inspection',
      tour_date: null,
      next_deadline_type: null,
      next_deadline_at: null,
      group_thread: null,
      attention: false,
      lost_reason: null,
      updated_at: null,
    };
    act(() => {
      src.emit('conversation.updated', conv);
      src.emit('placement.updated', kase);
    });
    expect(onConversationUpdated).toHaveBeenCalledWith(conv);
    expect(onPlacementUpdated).toHaveBeenCalledWith(kase);
  });

  it('skips a subscriber opted out with enabled:false', () => {
    const on = vi.fn();
    const off = vi.fn();
    render(
      <EventStreamProvider>
        <Sub onConversationUpdated={on} />
        <Sub onConversationUpdated={off} enabled={false} />
      </EventStreamProvider>,
    );
    const conv: ConversationUpdatedEvent = {
      conversationId: 'c1',
      last_activity_at: '2026-06-16T00:00:00Z',
      unread_count: 0,
      type: 'tenant_1to1',
      assignment: null,
      participant_display_name: 'Tasha',
    };
    act(() => {
      FakeEventSource.instances[0]?.emit('conversation.updated', conv);
    });
    expect(on).toHaveBeenCalledWith(conv);
    expect(off).not.toHaveBeenCalled();
  });

  it('ignores malformed event JSON', () => {
    const onPlacementUpdated = vi.fn();
    render(
      <EventStreamProvider>
        <Sub onPlacementUpdated={onPlacementUpdated} />
      </EventStreamProvider>,
    );
    act(() => {
      FakeEventSource.instances[0]?.emitRaw('placement.updated', '{not json');
    });
    expect(onPlacementUpdated).not.toHaveBeenCalled();
  });

  it('closes the source when the provider unmounts', () => {
    const { unmount } = render(
      <EventStreamProvider>
        <Sub />
      </EventStreamProvider>,
    );
    const src = FakeEventSource.instances[0];
    unmount();
    expect(src?.closed).toBe(true);
  });

  it('stops delivering to a subscriber after it unmounts', () => {
    const a = vi.fn();
    const b = vi.fn();
    function Toggle({ showB }: { showB: boolean }): React.JSX.Element {
      return (
        <EventStreamProvider>
          <Sub onConversationUpdated={a} />
          {showB ? <Sub onConversationUpdated={b} /> : null}
        </EventStreamProvider>
      );
    }
    const { rerender } = render(<Toggle showB />);
    rerender(<Toggle showB={false} />);
    const conv: ConversationUpdatedEvent = {
      conversationId: 'c1',
      last_activity_at: '2026-06-16T00:00:00Z',
      unread_count: 0,
      type: 'tenant_1to1',
      assignment: null,
      participant_display_name: 'Tasha',
    };
    act(() => {
      FakeEventSource.instances[0]?.emit('conversation.updated', conv);
    });
    expect(a).toHaveBeenCalledWith(conv);
    expect(b).not.toHaveBeenCalled();
  });

  it('degrades to a no-op (no connection) when no provider is mounted', () => {
    // A consumer outside the provider must not crash and must open no connection —
    // it simply receives no live updates (matches the old EventSource-absent path).
    expect(() => render(<Sub onConversationUpdated={vi.fn()} />)).not.toThrow();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
