// useFakeEvents SSE-hook tests. Stub EventSource with a controllable fake that
// records addEventListener handlers and exposes emit(type, data); assert the
// single onEvent handler fires for a message.appended frame, and the hook
// connects same-origin to /control/events with no credentials.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFakeEvents } from './useFakeEvents.js';

type Listener = (ev: { data?: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  withCredentials: boolean;
  closed = false;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string, opts?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = opts?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  close(): void {
    this.closed = true;
  }
  /** Test helper: dispatch a named SSE event to the registered listeners. */
  emit(type: string, data?: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data });
  }
}

const instances = () => FakeEventSource.instances;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useFakeEvents', () => {
  it('connects once to /control/events with no credentials', () => {
    renderHook(() => useFakeEvents({ onEvent: vi.fn() }));
    expect(instances()).toHaveLength(1);
    expect(instances()[0]!.url).toBe('/control/events');
    expect(instances()[0]!.withCredentials).toBe(false);
  });

  it('fires onEvent for a parsed message.appended event', () => {
    const onEvent = vi.fn();
    renderHook(() => useFakeEvents({ onEvent }));
    act(() =>
      instances()[0]!.emit(
        'message.appended',
        JSON.stringify({
          type: 'message.appended',
          partyNumber: '+15550100001',
          message: { sid: 'SM1', direction: 'inbound' },
        }),
      ),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message.appended', partyNumber: '+15550100001' }),
    );
  });

  it('ignores an unparseable frame (no throw, no call)', () => {
    const onEvent = vi.fn();
    renderHook(() => useFakeEvents({ onEvent }));
    act(() => instances()[0]!.emit('message.updated', 'not json'));
    expect(onEvent).not.toHaveBeenCalled();
  });

  // The listener list is an explicit allowlist — a named SSE frame that is not
  // registered is silently dropped. 'group.updated' must be subscribed or the
  // group view never updates live.
  it('fires onEvent for a parsed group.updated event', () => {
    const onEvent = vi.fn();
    renderHook(() => useFakeEvents({ onEvent }));
    act(() =>
      instances()[0]!.emit(
        'group.updated',
        JSON.stringify({
          type: 'group.updated',
          group: { poolNumber: '+15550160001', members: [], entries: [], lastActivityAt: '2026-06-15T00:00:00.000Z' },
        }),
      ),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'group.updated',
        group: expect.objectContaining({ poolNumber: '+15550160001' }),
      }),
    );
  });

  it('reconnects with capped exponential backoff on error (1s, then 2s)', () => {
    renderHook(() => useFakeEvents({ onEvent: vi.fn() }));
    const s0 = instances()[0]!;
    act(() => s0.emit('error'));
    act(() => vi.advanceTimersByTime(999));
    expect(instances()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(instances()).toHaveLength(2);
    expect(s0.closed).toBe(true);

    const s1 = instances()[1]!;
    act(() => s1.emit('error'));
    act(() => vi.advanceTimersByTime(1999));
    expect(instances()).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(instances()).toHaveLength(3);
  });

  it('cancels a pending reconnect and closes the source on unmount', () => {
    const { unmount } = renderHook(() => useFakeEvents({ onEvent: vi.fn() }));
    const s0 = instances()[0]!;
    act(() => s0.emit('error'));
    unmount();
    act(() => vi.advanceTimersByTime(60_000));
    expect(instances()).toHaveLength(1);
    expect(s0.closed).toBe(true);
  });
});
