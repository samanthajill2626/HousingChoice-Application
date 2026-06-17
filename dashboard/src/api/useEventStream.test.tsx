import { render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventStream, type EventStreamHandlers } from './useEventStream.js';
import type { CaseUpdatedEvent, ConversationUpdatedEvent } from './types.js';

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

function Harness(props: EventStreamHandlers): null {
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

describe('useEventStream', () => {
  it('opens an EventSource on /api/events with credentials', () => {
    render(<Harness />);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe('/api/events');
    expect(FakeEventSource.instances[0]?.withCredentials).toBe(true);
  });

  it('does not connect when disabled', () => {
    render(<Harness enabled={false} />);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('dispatches conversation.updated + case.updated to typed handlers', () => {
    const onConversationUpdated = vi.fn();
    const onCaseUpdated = vi.fn();
    render(<Harness onConversationUpdated={onConversationUpdated} onCaseUpdated={onCaseUpdated} />);
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
    const kase: CaseUpdatedEvent = {
      caseId: 'k1',
      tenantId: 't1',
      unitId: 'u1',
      stage: 'touring',
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
      src.emit('case.updated', kase);
    });
    expect(onConversationUpdated).toHaveBeenCalledWith(conv);
    expect(onCaseUpdated).toHaveBeenCalledWith(kase);
  });

  it('ignores malformed event JSON', () => {
    const onCaseUpdated = vi.fn();
    render(<Harness onCaseUpdated={onCaseUpdated} />);
    act(() => {
      FakeEventSource.instances[0]?.emitRaw('case.updated', '{not json');
    });
    expect(onCaseUpdated).not.toHaveBeenCalled();
  });

  it('closes the source on unmount', () => {
    const { unmount } = render(<Harness />);
    const src = FakeEventSource.instances[0];
    unmount();
    expect(src?.closed).toBe(true);
  });
});
