import type { SampleResult } from './types.js';

export const DEFAULT_READINESS_POLL_INTERVAL_MS = 100;
export const DEFAULT_SETTLE_WINDOW_MS = 500;

type TerminalState = SampleResult['terminalState'];

export interface ReadinessClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ReadinessNetworkSnapshot {
  pendingCount: number;
  lastQualifyingOffsetMs: number | null;
}

export interface ReadinessNetwork {
  snapshot(token: string): ReadinessNetworkSnapshot;
}

// The adapter deliberately has no DOM-text method. Callers implement these
// predicates from the route registry's URL and role/visibility/count locators.
export interface TerminalUiProbe {
  urlMatches(): Promise<boolean>;
  structureVisible(): Promise<boolean>;
  terminalState(): Promise<TerminalState>;
}

export interface WaitForMeaningfulReadyInput {
  token: string;
  clock: ReadinessClock;
  nodeOriginMs: number;
  timeoutMs: number;
  ui: TerminalUiProbe;
  network: ReadinessNetwork;
  pollIntervalMs?: number;
  settleWindowMs?: number;
}

export interface ReadinessResult extends ReadinessNetworkSnapshot {
  status: 'ready' | 'timeout';
  readyMs: number | null;
  terminalState: TerminalState;
  polls: number;
}

export async function terminalAlternativeVisible<T>(
  alternatives: readonly (readonly T[])[],
  visible: (contract: T) => Promise<boolean>,
): Promise<boolean> {
  for (const alternative of alternatives) {
    if (alternative.length === 0) continue;
    const states = await Promise.all(alternative.map((contract) => visible(contract)));
    if (states.every(Boolean)) return true;
  }
  return false;
}

function normalizedOffset(value: number, origin: number, scale: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(origin) || value < origin) return null;
  return Math.round((value - origin) * scale * 1_000) / 1_000;
}

export function normalizeCdpOffset(timestampSeconds: number, originSeconds: number): number | null {
  return normalizedOffset(timestampSeconds, originSeconds, 1_000);
}

export function normalizeNodeOffset(timestampMs: number, originMs: number): number | null {
  return normalizedOffset(timestampMs, originMs, 1);
}

export function normalizePageOffset(timestampMs: number, originMs: number): number | null {
  return normalizedOffset(timestampMs, originMs, 1);
}

export async function waitForMeaningfulReady(input: WaitForMeaningfulReadyInput): Promise<ReadinessResult> {
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS;
  const settleWindowMs = input.settleWindowMs ?? DEFAULT_SETTLE_WINDOW_MS;
  if (pollIntervalMs <= 0 || settleWindowMs < 0 || input.timeoutMs < 0) {
    throw new Error('invalid_readiness_timing');
  }

  let terminalState: TerminalState = 'unknown';
  let terminalOffsetMs: number | null = null;
  let polls = 0;
  let latest = input.network.snapshot(input.token);

  for (;;) {
    const nowOffsetMs = normalizeNodeOffset(input.clock.now(), input.nodeOriginMs);
    if (nowOffsetMs === null) throw new Error('node_clock_before_sample_origin');
    if (nowOffsetMs > input.timeoutMs) {
      return { status: 'timeout', readyMs: null, terminalState, polls, ...latest };
    }

    polls += 1;
    const [urlMatches, structureVisible, observedTerminal] = await Promise.all([
      input.ui.urlMatches(), input.ui.structureVisible(), input.ui.terminalState(),
    ]);
    const readyTerminal = observedTerminal === 'populated' || observedTerminal === 'empty';
    if (urlMatches && structureVisible && observedTerminal !== 'unknown') {
      if (readyTerminal) {
        if (observedTerminal !== terminalState || terminalOffsetMs === null) terminalOffsetMs = nowOffsetMs;
        terminalState = observedTerminal;
      } else {
        terminalState = observedTerminal;
        terminalOffsetMs = null;
      }
    } else if (terminalState !== 'unknown') {
      terminalState = 'unknown';
      terminalOffsetMs = null;
    }

    latest = input.network.snapshot(input.token);
    const candidate = terminalOffsetMs === null
      ? null
      : Math.max(terminalOffsetMs, latest.lastQualifyingOffsetMs ?? 0);
    if (
      candidate !== null &&
      latest.pendingCount === 0 &&
      nowOffsetMs - candidate >= settleWindowMs
    ) {
      return { status: 'ready', readyMs: candidate, terminalState, polls, ...latest };
    }
    if (nowOffsetMs === input.timeoutMs) {
      return { status: 'timeout', readyMs: null, terminalState, polls, ...latest };
    }
    await input.clock.sleep(Math.min(pollIntervalMs, input.timeoutMs - nowOffsetMs));
  }
}

export interface NumericPerformanceEntry {
  entryType: string;
  name?: string;
  startTime: number;
  duration?: number;
  responseStart?: number;
  domContentLoadedEventEnd?: number;
  loadEventEnd?: number;
}

export interface PageStoreSnapshot {
  longTasks: { totalMs: number; maxMs: number; count: number };
  paint: { fcpMs: number | null; lcpMs: number | null };
  navigation: { ttfbMs: number | null; domContentLoadedMs: number | null; loadMs: number | null };
  domElements: number | null;
}

export interface PagePerformanceStore {
  beginSample(token: string, cutoffMs: number): void;
  record(token: string, entry: NumericPerformanceEntry): void;
  endSample(token: string): PageStoreSnapshot | null;
}

export interface PageStoreBootstrap {
  token: string;
  cutoffMs: number;
}

interface PageStoreHost {
  performance?: {
    now(): number;
    getEntriesByType(type: string): Array<NumericPerformanceEntry>;
  };
  document?: { getElementsByTagName(name: string): { length: number } };
  PerformanceObserver?: new (
    callback: (list: { getEntries(): Array<NumericPerformanceEntry> }) => void,
  ) => { observe(options: { type: string; buffered: boolean }): void };
  __hcPerformanceStore?: PagePerformanceStore;
}

export interface PageStoreInstallerArgument {
  bootstrap?: PageStoreBootstrap;
  // Tests can provide a host. A serialized init script omits it and uses its
  // own document's globalThis, so the same installer owns both code paths.
  host?: PageStoreHost;
}

export function pageStoreInstaller(argument: PageStoreInstallerArgument = {}): PagePerformanceStore {
  const host = argument.host ?? globalThis as unknown as PageStoreHost;
  let store = host.__hcPerformanceStore;
  if (store === undefined) {
    let token: string | null = null;
    let cutoffMs = 0;
    let longTasks: number[] = [];
    let fcpMs: number | null = null;
    let lcpMs: number | null = null;

    store = {
      beginSample(nextToken: string, nextCutoffMs: number): void {
        token = nextToken;
        cutoffMs = nextCutoffMs;
        longTasks = [];
        fcpMs = null;
        lcpMs = null;
      },
      record(eventToken: string, entry: NumericPerformanceEntry): void {
        if (eventToken !== token || entry.startTime < cutoffMs) return;
        const offset = entry.startTime - cutoffMs;
        if (entry.entryType === 'longtask') {
          const duration = typeof entry.duration === 'number' && Number.isFinite(entry.duration)
            ? Math.max(0, entry.duration)
            : 0;
          longTasks.push(duration);
        } else if (entry.entryType === 'paint' && entry.name === 'first-contentful-paint') {
          fcpMs = offset;
        } else if (entry.entryType === 'largest-contentful-paint') {
          lcpMs = offset;
        }
      },
      endSample(eventToken: string): PageStoreSnapshot | null {
        if (eventToken !== token) return null;
        const navigationEntry = host.performance?.getEntriesByType('navigation')[0];
        const native = (value: number | undefined): number | null =>
          typeof value === 'number' && Number.isFinite(value) && value >= cutoffMs ? value - cutoffMs : null;
        return {
          longTasks: {
            totalMs: longTasks.reduce((total, value) => total + value, 0),
            maxMs: longTasks.length === 0 ? 0 : Math.max(...longTasks),
            count: longTasks.length,
          },
          paint: { fcpMs, lcpMs },
          navigation: {
            ttfbMs: native(navigationEntry?.responseStart),
            domContentLoadedMs: native(navigationEntry?.domContentLoadedEventEnd),
            loadMs: native(navigationEntry?.loadEventEnd),
          },
          domElements: host.document?.getElementsByTagName('*').length ?? null,
        };
      },
    };
    host.__hcPerformanceStore = store;

    if (host.PerformanceObserver !== undefined) {
      for (const entryType of ['longtask', 'paint', 'largest-contentful-paint']) {
        const observer = new host.PerformanceObserver((list) => {
          const activeToken = token;
          if (activeToken === null) return;
          for (const entry of list.getEntries()) store?.record(activeToken, entry);
        });
        try {
          observer.observe({ type: entryType, buffered: true });
        } catch {
          // A missing performance-entry type becomes a null metric, not a page failure.
        }
      }
    }
  }
  if (argument.bootstrap !== undefined) {
    store.beginSample(argument.bootstrap.token, argument.bootstrap.cutoffMs);
  }
  return store;
}

export function installPageStore(host: Record<string, unknown>, bootstrap?: PageStoreBootstrap): PagePerformanceStore {
  return pageStoreInstaller({ host: host as PageStoreHost, ...(bootstrap !== undefined && { bootstrap }) });
}

export interface InitScriptTarget {
  addInitScript(
    script: (argument: PageStoreInstallerArgument) => PagePerformanceStore,
    argument: PageStoreInstallerArgument,
  ): Promise<void> | void;
}

// Call once with no bootstrap on the base context and again with a token on a
// fresh cold page. Idempotence prevents the second call from duplicating observers.
export async function installPageStoreInitScript(
  target: InitScriptTarget,
  bootstrap?: PageStoreBootstrap,
): Promise<void> {
  await target.addInitScript(pageStoreInstaller, { ...(bootstrap !== undefined && { bootstrap }) });
}
