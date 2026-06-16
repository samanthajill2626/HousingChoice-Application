// useEventStream reconnect-backoff tests. The hook must drive its OWN capped
// exponential backoff (1s→2s→…→30s) on a down/refused origin — NOT defer to the
// browser's native EventSource retry (which holds readyState at CONNECTING and
// retries at a fixed ~3s forever, so the old CLOSED-only guard never engaged the
// backoff). Stub EventSource + fake timers to drive open/error deterministically.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventStream } from './useEventStream.js';

type Listener = (ev: { data?: string }) => void;

/** A controllable fake EventSource: records instances + lets a test fire events. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CLOSED = 2 as const;
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
  /** Test helper: dispatch an event to the registered listeners. */
  fire(type: string, data?: string): void {
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

describe('useEventStream reconnect backoff', () => {
  it('connects once on mount (same-origin, with credentials)', () => {
    renderHook(() => useEventStream({}));
    expect(instances()).toHaveLength(1);
    expect(instances()[0]!.url).toBe('/api/events');
    expect(instances()[0]!.withCredentials).toBe(true);
  });

  it('reconnects with capped exponential backoff on a refused origin (1s, then 2s)', () => {
    renderHook(() => useEventStream({}));
    const s0 = instances()[0]!;

    act(() => s0.fire('error'));
    act(() => vi.advanceTimersByTime(999));
    expect(instances()).toHaveLength(1); // not yet — backoff is 1000ms
    act(() => vi.advanceTimersByTime(1));
    expect(instances()).toHaveLength(2); // reconnected at 1s
    expect(s0.closed).toBe(true); // the dead source was closed, not left dangling

    // Next failure backs off to 2s (the ramp the old code never reached).
    const s1 = instances()[1]!;
    act(() => s1.fire('error'));
    act(() => vi.advanceTimersByTime(1999));
    expect(instances()).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(instances()).toHaveLength(3); // reconnected at 2s
  });

  it('coalesces the repeated error events one drop fires into a single reconnect', () => {
    renderHook(() => useEventStream({}));
    const s0 = instances()[0]!;
    act(() => {
      s0.fire('error');
      s0.fire('error');
      s0.fire('error');
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(instances()).toHaveLength(2); // ONE reconnect, not three
  });

  it('resets the backoff after a healthy reconnect (open)', () => {
    renderHook(() => useEventStream({}));
    act(() => instances()[0]!.fire('error'));
    act(() => vi.advanceTimersByTime(1000)); // → s1; next delay would be 2s

    const s1 = instances()[1]!;
    act(() => s1.fire('open')); // healthy — reset backoff to the 1s floor
    act(() => s1.fire('error'));
    act(() => vi.advanceTimersByTime(999));
    expect(instances()).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(instances()).toHaveLength(3); // reconnected at 1s again, not 2s
  });

  it('dispatches a parsed case.updated event to the handler', () => {
    const onCaseUpdated = vi.fn();
    renderHook(() => useEventStream({ onCaseUpdated }));
    act(() => instances()[0]!.fire('case.updated', JSON.stringify({ caseId: 'c1', stage: 'applied' })));
    expect(onCaseUpdated).toHaveBeenCalledWith(expect.objectContaining({ caseId: 'c1', stage: 'applied' }));
  });

  it('cancels a pending reconnect and closes the source on unmount', () => {
    const { unmount } = renderHook(() => useEventStream({}));
    const s0 = instances()[0]!;
    act(() => s0.fire('error')); // schedule a reconnect at 1s
    unmount(); // must clear the timer + close
    act(() => vi.advanceTimersByTime(60_000));
    expect(instances()).toHaveLength(1); // the scheduled reconnect never fired
    expect(s0.closed).toBe(true);
  });
});
