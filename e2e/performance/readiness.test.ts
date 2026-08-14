import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_READINESS_POLL_INTERVAL_MS,
  DEFAULT_SETTLE_WINDOW_MS,
  installPageStore,
  normalizeCdpOffset,
  normalizeNodeOffset,
  normalizePageOffset,
  waitForMeaningfulReady,
  type ReadinessClock,
  type ReadinessNetwork,
  type TerminalUiProbe,
} from './readiness.js';

class FakeClock implements ReadinessClock {
  value = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.value;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.value += ms;
  }
}

function uiAt(
  clock: FakeClock,
  at: number,
  state: 'populated' | 'empty' | 'error' | 'contradictory_terminal' | 'unknown' = 'populated',
): TerminalUiProbe {
  return {
    urlMatches: async () => true,
    structureVisible: async () => clock.now() >= at,
    terminalState: async () => clock.now() >= at ? state : 'unknown',
  };
}

function networkFrom(
  clock: FakeClock,
  stateAt: (now: number) => { pendingCount: number; lastQualifyingOffsetMs: number | null },
): ReadinessNetwork {
  return { snapshot: () => stateAt(clock.now()) };
}

describe('meaningful readiness', () => {
  it('matches any all-visible terminal alternative and rejects partial alternatives', async () => {
    const { terminalAlternativeVisible } = await import('./readiness.js');
    const visible = new Set(['checkbox', 'environment', 'alarms-empty', 'errors-list']);
    const alternatives = [
      ['checkbox', 'environment', 'alarms-list', 'errors-list'],
      ['checkbox', 'environment', 'alarms-empty', 'errors-list'],
    ] as const;
    await expect(terminalAlternativeVisible(alternatives, async (key) => visible.has(key)))
      .resolves.toBe(true);
    visible.delete('environment');
    await expect(terminalAlternativeVisible(alternatives, async (key) => visible.has(key)))
      .resolves.toBe(false);
  });

  it('uses the later network event when terminal UI appears first', async () => {
    const clock = new FakeClock();
    const result = await waitForMeaningfulReady({
      token: 'sample-a', clock, nodeOriginMs: 0, timeoutMs: 2_000,
      ui: uiAt(clock, 0),
      network: networkFrom(clock, (now) => ({
        pendingCount: now < 300 ? 1 : 0,
        lastQualifyingOffsetMs: now < 300 ? null : 300,
      })),
    });

    expect(result).toMatchObject({ status: 'ready', readyMs: 300, terminalState: 'populated' });
    expect(clock.now()).toBe(800);
  });

  it('uses the first observed terminal UI state when network settles first', async () => {
    const clock = new FakeClock();
    const result = await waitForMeaningfulReady({
      token: 'sample-b', clock, nodeOriginMs: 0, timeoutMs: 2_000,
      ui: uiAt(clock, 400),
      network: networkFrom(clock, () => ({ pendingCount: 0, lastQualifyingOffsetMs: 100 })),
    });

    expect(result.readyMs).toBe(400);
    expect(clock.now()).toBe(900);
  });

  it('resets quiet when a late qualifying request starts and finishes', async () => {
    const clock = new FakeClock();
    const result = await waitForMeaningfulReady({
      token: 'sample-c', clock, nodeOriginMs: 0, timeoutMs: 3_000,
      ui: uiAt(clock, 100),
      network: networkFrom(clock, (now) => {
        if (now < 400) return { pendingCount: 0, lastQualifyingOffsetMs: 200 };
        if (now < 700) return { pendingCount: 1, lastQualifyingOffsetMs: 400 };
        return { pendingCount: 0, lastQualifyingOffsetMs: 700 };
      }),
    });

    expect(result.readyMs).toBe(700);
    expect(clock.now()).toBe(1_200);
  });

  it('confirms for the settle window without adding it to readyMs', async () => {
    const clock = new FakeClock();
    const result = await waitForMeaningfulReady({
      token: 'sample-d', clock, nodeOriginMs: 0, timeoutMs: 2_000,
      ui: uiAt(clock, 200),
      network: networkFrom(clock, () => ({ pendingCount: 0, lastQualifyingOffsetMs: 150 })),
    });

    expect(DEFAULT_SETTLE_WINDOW_MS).toBe(500);
    expect(result.readyMs).toBe(200);
    expect(clock.now()).toBe(700);
  });

  it('polls only at the configured cadence through route-locator predicates', async () => {
    const clock = new FakeClock();
    const calls: number[] = [];
    const textContent = vi.fn(() => { throw new Error('dom_text_must_not_be_read'); });
    const ui: TerminalUiProbe & { textContent: typeof textContent } = {
      textContent,
      urlMatches: async () => { calls.push(clock.now()); return true; },
      structureVisible: async () => true,
      terminalState: async () => 'empty',
    };
    const result = await waitForMeaningfulReady({
      token: 'sample-e', clock, nodeOriginMs: 0, timeoutMs: 1_000,
      pollIntervalMs: 125, settleWindowMs: 250,
      ui,
      network: networkFrom(clock, () => ({ pendingCount: 0, lastQualifyingOffsetMs: 0 })),
    });

    expect(DEFAULT_READINESS_POLL_INTERVAL_MS).toBe(100);
    expect(result.readyMs).toBe(0);
    expect(calls).toEqual([0, 125, 250]);
    expect(textContent).not.toHaveBeenCalled();
  });

  it('retains the last terminal classification and evidence state on timeout', async () => {
    const clock = new FakeClock();
    const result = await waitForMeaningfulReady({
      token: 'sample-f', clock, nodeOriginMs: 0, timeoutMs: 350,
      ui: uiAt(clock, 100, 'error'),
      network: networkFrom(clock, () => ({ pendingCount: 1, lastQualifyingOffsetMs: 250 })),
    });

    expect(result).toMatchObject({
      status: 'timeout', readyMs: null, terminalState: 'error',
      pendingCount: 1, lastQualifyingOffsetMs: 250,
    });
  });

  it.each(['error', 'contradictory_terminal', 'unknown'] as const)('does not treat %s as ready', async (state) => {
    const clock = new FakeClock();
    const result = await waitForMeaningfulReady({
      token: `sample-${state}`, clock, nodeOriginMs: 0, timeoutMs: 300,
      ui: uiAt(clock, 0, state),
      network: networkFrom(clock, () => ({ pendingCount: 0, lastQualifyingOffsetMs: 0 })),
      settleWindowMs: 0,
    });

    expect(result).toMatchObject({ status: 'timeout', readyMs: null, terminalState: state });
  });
});

describe('clock-domain normalization', () => {
  it('normalizes CDP, Node, and page clocks only against their own origins', () => {
    expect(normalizeCdpOffset(51.25, 50)).toBe(1_250);
    expect(normalizeNodeOffset(11_250, 10_000)).toBe(1_250);
    expect(normalizePageOffset(8_750, 7_500)).toBe(1_250);
  });

  it('rejects values before each native cutoff', () => {
    expect(normalizeCdpOffset(49.999, 50)).toBeNull();
    expect(normalizeNodeOffset(9_999, 10_000)).toBeNull();
    expect(normalizePageOffset(7_499, 7_500)).toBeNull();
  });
});

class FakePerformanceObserver {
  static callbacks: Array<(list: { getEntries(): Array<Record<string, unknown>> }) => void> = [];
  readonly callback: (list: { getEntries(): Array<Record<string, unknown>> }) => void;

  constructor(callback: (list: { getEntries(): Array<Record<string, unknown>> }) => void) {
    this.callback = callback;
    FakePerformanceObserver.callbacks.push(callback);
  }

  observe(): void {}
}

describe('page performance store', () => {
  it('installs one observer set and keeps the first cold-document entry under the active token', () => {
    FakePerformanceObserver.callbacks = [];
    const host: Record<string, unknown> = {
      performance: {
        now: () => 25,
        getEntriesByType: (type: string) => type === 'navigation'
          ? [{ entryType: 'navigation', startTime: 0, responseStart: 30, domContentLoadedEventEnd: 40, loadEventEnd: 50 }]
          : [],
      },
      document: { getElementsByTagName: () => ({ length: 42 }) },
      PerformanceObserver: FakePerformanceObserver,
    };
    const first = installPageStore(host, { token: 'cold-1', cutoffMs: 20 });
    const second = installPageStore(host);

    expect(second).toBe(first);
    expect(FakePerformanceObserver.callbacks).toHaveLength(3);
    FakePerformanceObserver.callbacks[0]!({ getEntries: () => [
      { entryType: 'longtask', startTime: 19, duration: 99 },
      { entryType: 'longtask', startTime: 26, duration: 30 },
    ] });
    FakePerformanceObserver.callbacks[1]!({ getEntries: () => [
      { entryType: 'paint', name: 'first-contentful-paint', startTime: 27 },
    ] });
    FakePerformanceObserver.callbacks[2]!({ getEntries: () => [
      { entryType: 'largest-contentful-paint', startTime: 28 },
    ] });

    expect(first.endSample('cold-1')).toMatchObject({
      longTasks: { totalMs: 30, maxMs: 30, count: 1 },
      paint: { fcpMs: 7, lcpMs: 8 },
      navigation: { ttfbMs: 10, domContentLoadedMs: 20, loadMs: 30 },
      domElements: 42,
    });
  });

  it('atomically replaces tokens and ignores prior blank-document and stale-token entries', () => {
    FakePerformanceObserver.callbacks = [];
    let now = 5;
    const host: Record<string, unknown> = {
      performance: { now: () => now, getEntriesByType: () => [] },
      document: { getElementsByTagName: () => ({ length: 3 }) },
      PerformanceObserver: FakePerformanceObserver,
    };
    const store = installPageStore(host);
    store.beginSample('blank', 0);
    FakePerformanceObserver.callbacks[0]!({ getEntries: () => [{ entryType: 'longtask', startTime: 4, duration: 4 }] });
    now = 100;
    store.beginSample('destination', 100);
    store.record('blank', { entryType: 'longtask', startTime: 101, duration: 50 });
    store.record('destination', { entryType: 'longtask', startTime: 99, duration: 50 });
    store.record('destination', { entryType: 'longtask', startTime: 110, duration: 10 });

    expect(store.endSample('blank')).toBeNull();
    expect(store.endSample('destination')).toMatchObject({
      longTasks: { totalMs: 10, maxMs: 10, count: 1 },
      paint: { fcpMs: null, lcpMs: null },
    });
  });
});
