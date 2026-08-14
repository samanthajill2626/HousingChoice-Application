import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  captureCdpClockAlignment,
  captureSuccessfulSurfaceEvidence,
  classifyEscapedWriteFailure,
  createRealInstrumentation,
  createRealSamplePage,
  exactTargetMatches,
  installProfilerProcessHandlers,
  main,
  performanceArtifactRoot,
  readPageStoreSnapshot,
  runDirectMain,
  runProfiler,
  terminalStateFor,
  targetPath,
  type CliRuntime,
} from './cli.js';
import { createFirewallRecordingToken, FirewallEscapedWriteError } from './firewall.js';
import type { TerminalUiProbe } from './readiness.js';
import type { RunConfig } from './config.js';
import { ROUTES } from './routes.js';
import { NetworkCollector, summarizePageMetrics, type SampleBrowser, type SampleInstrumentation } from './collect.js';

class AdapterLocator {
  constructor(
    private readonly present: boolean,
    private readonly clickAction: () => void,
  ) {}

  async count(): Promise<number> { return this.present ? 1 : 0; }
  first(): this { return this; }
  async isVisible(): Promise<boolean> { return this.present; }
  async click(): Promise<void> { this.clickAction(); }
}

class AdapterPage {
  current = 'http://dashboard.test/inbox?filter=groups';
  readonly events: string[] = [];
  missingTab = false;

  url(): string { return this.current; }
  async goto(url: string): Promise<void> { this.events.push(`goto:${url}`); this.current = url; }
  locator(selector: string): AdapterLocator {
    const href = selector.match(/^a\[href="(.+)"\]$/u)?.[1];
    return new AdapterLocator(href !== undefined, () => {
      this.events.push(`link:${href}`);
      this.current = `http://dashboard.test${href}`;
    });
  }
  getByRole(role: string, options: { name?: string } = {}): AdapterLocator {
    const name = options.name ?? '';
    const present = role !== 'tab' || !(this.missingTab && name === 'Unread');
    return new AdapterLocator(present, () => {
      this.events.push(`${role}:${name}`);
      const filter = name === 'All' ? '' : `?filter=${name.toLowerCase()}`;
      this.current = `http://dashboard.test/inbox${filter}`;
    });
  }
}

class TerminalProofLocator {
  constructor(
    private readonly page: TerminalProofPage,
    private readonly present: boolean,
  ) {}

  async count(): Promise<number> { return this.present ? 1 : 0; }
  first(): this { return this; }
  async isVisible(): Promise<boolean> { return this.present; }
  or(other: TerminalProofLocator): TerminalProofLocator {
    return new TerminalProofLocator(this.page, this.present || other.present);
  }
  locator(selector: string): TerminalProofLocator {
    return new TerminalProofLocator(this.page, this.present && selector === 'xpath=ancestor::*[@aria-labelledby][1]');
  }
  getByRole(role: string, options: { name?: string | RegExp } = {}): TerminalProofLocator {
    return this.page.role(role, options.name, this.present);
  }
  getByText(text: string | RegExp): TerminalProofLocator {
    return this.page.text(text, this.present);
  }
}

class TerminalProofPage {
  constructor(
    private readonly roles: readonly Readonly<{ role: string; name?: string; selected?: boolean }>[],
    private readonly texts: readonly string[],
  ) {}

  private matches(actual: string | undefined, expected: string | RegExp | undefined): boolean {
    if (expected === undefined) return actual === undefined;
    if (actual === undefined) return false;
    return typeof expected === 'string' ? actual === expected : expected.test(actual);
  }
  role(
    role: string,
    name: string | RegExp | undefined,
    parentPresent = true,
    selected?: boolean,
  ): TerminalProofLocator {
    return new TerminalProofLocator(
      this,
      parentPresent && this.roles.some((entry) => entry.role === role
        && this.matches(entry.name, name)
        && (selected === undefined || entry.selected === selected)),
    );
  }
  text(text: string | RegExp, parentPresent = true): TerminalProofLocator {
    return new TerminalProofLocator(
      this,
      parentPresent && this.texts.some((entry) => typeof text === 'string' ? entry === text : text.test(entry)),
    );
  }
  getByRole(role: string, options: { name?: string | RegExp; selected?: boolean } = {}): TerminalProofLocator {
    return this.role(role, options.name, true, options.selected);
  }
  getByText(text: string | RegExp): TerminalProofLocator {
    return this.text(text);
  }
}

type InboxRowKind = 'contact' | 'relay' | 'group';

class EvidenceLocator {
  constructor(
    private readonly rows: readonly { kind: InboxRowKind; detailLink: boolean }[] | null,
    private readonly row: { kind: InboxRowKind; detailLink: boolean } | null,
    private readonly matched: boolean,
  ) {}

  async count(): Promise<number> { return this.rows?.length ?? (this.matched ? 1 : 0); }
  first(): this { return this; }
  async isVisible(): Promise<boolean> { return this.matched; }
  getByRole(role: string): EvidenceLocator {
    return role === 'listitem' && this.rows !== null
      ? new EvidenceLocator(this.rows, null, false)
      : new EvidenceLocator(null, null, false);
  }
  nth(index: number): EvidenceLocator {
    return this.rows === null
      ? new EvidenceLocator(null, null, false)
      : new EvidenceLocator(null, this.rows[index] ?? null, this.rows[index] !== undefined);
  }
  getByText(text: string, options: { exact?: boolean } = {}): EvidenceLocator {
    const matched = options.exact === true && (
      (text === 'Relay group' && this.row?.kind === 'relay')
      || (text === 'Group text' && this.row?.kind === 'group')
    );
    return new EvidenceLocator(null, null, matched);
  }
  locator(selector: string): EvidenceLocator {
    return new EvidenceLocator(null, null, this.row?.detailLink === true && selector === 'a[href^="/conversations/"]');
  }
}

class EvidencePage {
  constructor(
    private readonly rows: readonly { kind: InboxRowKind; detailLink: boolean }[],
    private readonly markers: readonly string[],
    private readonly links: readonly string[] = [],
  ) {}

  getByRole(role: string, options: { name?: string; exact?: boolean } = {}): EvidenceLocator {
    if (role === 'list' && options.name === 'Conversations' && options.exact === true) {
      return new EvidenceLocator(this.rows, null, false);
    }
    if (role === 'link' && options.exact === true && typeof options.name === 'string') {
      return new EvidenceLocator(null, null, this.links.includes(options.name));
    }
    return new EvidenceLocator(null, null, false);
  }
  getByText(text: string | RegExp, options: { exact?: boolean } = {}): EvidenceLocator {
    const matched = typeof text === 'string'
      ? options.exact === true && this.markers.includes(text)
      : this.markers.some((marker) => text.test(marker));
    return new EvidenceLocator(null, null, matched);
  }
}

function runtime(events: string[], overrides: Partial<CliRuntime> = {}): CliRuntime {
  const phase = <T>(name: string, value: T) => vi.fn(async () => {
    events.push(name);
    return value;
  });
  return {
    startHermetic: phase('start', { lane: 7 }),
    verifyHermetic: phase('verify', undefined),
    reseedHermetic: phase('reseed', undefined),
    openDashboard: phase('dashboard', { kind: 'dashboard' }),
    verifyLocal: phase('local-proof', undefined),
    authenticateHermetic: phase('auth-hermetic', { storageState: {} }),
    authenticateLocal: phase('auth-local', { storageState: {} }),
    authenticateHosted: phase('auth-hosted', { storageState: {} }),
    warmup: phase('warmup', undefined),
    collect: phase('collect', { samples: [] }),
    report: phase('report', { exitCode: 0, status: 'written' }),
    closeDashboard: phase('close-dashboard', undefined),
    cleanupHermetic: phase('cleanup', { status: 'cleaned', lane: 7 }),
    ...overrides,
  };
}

describe('exact browser targets', () => {
  it('requires Inbox destination selection and tablist independently of activation kind', async () => {
    const cli = await import('./cli.js') as typeof import('./cli.js') & {
      terminalStateForRoute: (
        page: never,
        route: (typeof ROUTES)[number],
      ) => Promise<'populated' | 'empty' | 'error' | 'unknown' | 'contradictory_terminal'>;
    };
    const all = ROUTES.find((route) => route.surfaceId === 'inbox-all')!;
    expect(all.source.action).toEqual({ kind: 'link', href: '/inbox' });

    const populated = (selectedName: string, includeTablist = true, selected = true) => new TerminalProofPage(
      [
        ...(includeTablist ? [{ role: 'tablist', name: 'Inbox filters' }] : []),
        { role: 'tab', name: selectedName, selected },
        { role: 'list', name: 'Conversations' },
      ],
      [],
    );
    await expect(cli.terminalStateForRoute(populated('All') as never, all)).resolves.toBe('populated');
    await expect(cli.terminalStateForRoute(populated('All', true, false) as never, all)).resolves.toBe('unknown');
    await expect(cli.terminalStateForRoute(populated('All', false) as never, all)).resolves.toBe('unknown');

    const empty = new TerminalProofPage(
      [
        { role: 'tablist', name: 'Inbox filters' },
        { role: 'tab', name: 'All', selected: true },
      ],
      ['No conversations yet'],
    );
    await expect(cli.terminalStateForRoute(empty as never, all)).resolves.toBe('empty');
    const contradictory = new TerminalProofPage(
      [
        { role: 'tablist', name: 'Inbox filters' },
        { role: 'tab', name: 'All', selected: true },
        { role: 'list', name: 'Conversations' },
      ],
      ['No conversations yet'],
    );
    await expect(cli.terminalStateForRoute(contradictory as never, all)).resolves.toBe('contradictory_terminal');

    for (const route of ROUTES.filter((candidate) => candidate.behaviorFamily === 'inbox' && candidate !== all)) {
      const expected = route.label.slice('Inbox: '.length);
      await expect(cli.terminalStateForRoute(populated('All') as never, route)).resolves.toBe('unknown');
      await expect(cli.terminalStateForRoute(populated(expected) as never, route)).resolves.toBe('populated');
    }
  });

  it('proves the live relay conversation and relay-number terminals through exact DOM roles and text', async () => {
    const conversation = ROUTES.find((route) => route.surfaceId === '/conversations/:conversationId')!;
    const numbers = ROUTES.find((route) => route.surfaceId === '/settings/numbers')!;
    const relayConversation = new TerminalProofPage(
      [{ role: 'link', name: 'Back to inbox' }],
      ['Relay group'],
    );
    const staleConversation = new TerminalProofPage(
      [{ role: 'link', name: 'Back to inbox' }],
      ['Group text'],
    );
    await expect(terminalStateFor(relayConversation as never, conversation.terminal)).resolves.toBe('populated');
    await expect(terminalStateFor(staleConversation as never, conversation.terminal)).resolves.toBe('unknown');

    const numberRoles = [
      { role: 'heading', name: 'Our number' },
      { role: 'heading', name: 'Relay group numbers' },
    ] as const;
    const populatedNumbers = new TerminalProofPage(
      [...numberRoles, { role: 'list', name: 'Pool number counts' }],
      ['Not set'],
    );
    const emptyNumbers = new TerminalProofPage(
      numberRoles,
      ['Not set', 'No relay group numbers yet - a number is provisioned with the first relay group.'],
    );
    const contradictoryNumbers = new TerminalProofPage(
      [...numberRoles, { role: 'list', name: 'Pool number counts' }],
      ['Not set', 'No relay group numbers yet - a number is provisioned with the first relay group.'],
    );
    const staleNumbers = new TerminalProofPage(
      [
        { role: 'heading', name: 'Our number' },
        { role: 'heading', name: 'Group text numbers' },
      ],
      ['Not set', 'No group text numbers yet - a number is provisioned with the first group text.'],
    );
    await expect(terminalStateFor(populatedNumbers as never, numbers.terminal)).resolves.toBe('populated');
    await expect(terminalStateFor(emptyNumbers as never, numbers.terminal)).resolves.toBe('empty');
    await expect(terminalStateFor(contradictoryNumbers as never, numbers.terminal)).resolves.toBe('contradictory_terminal');
    await expect(terminalStateFor(staleNumbers as never, numbers.terminal)).resolves.toBe('unknown');
  });

  it('accepts only normalized query-equivalent targets and rejects extra source state', () => {
    expect(targetPath({ path: '/inbox', query: { kind: 'absent' } })).toBe('/inbox');
    expect(targetPath({ path: '/inbox', query: { kind: 'fixed', values: { filter: 'unread' } } })).toBe('/inbox?filter=unread');
    expect(exactTargetMatches('http://dashboard.test/inbox', { path: '/inbox', query: { kind: 'absent' } })).toBe(true);
    expect(exactTargetMatches('http://dashboard.test/inbox?filter=unread&limit=30', {
      path: '/inbox', query: { kind: 'fixed', values: { filter: 'unread' } },
    })).toBe(false);
    expect(exactTargetMatches('http://dashboard.test/inbox?filter=unread', {
      path: '/inbox', query: { kind: 'fixed', values: { filter: 'unread' } },
    })).toBe(true);
    expect(exactTargetMatches('http://dashboard.test/inbox?filter=unread', { path: '/inbox', query: { kind: 'absent' } })).toBe(false);
    expect(exactTargetMatches('http://dashboard.test/inbox?filter=unread&extra=1', {
      path: '/inbox', query: { kind: 'fixed', values: { filter: 'unread' } },
    })).toBe(false);
  });

  it('real adapter restores bare All before each filtered or detail activation and rejects a missing fixed tab', async () => {
    const raw = new AdapterPage();
    const page = createRealSamplePage({
      page: raw as never,
      context: { addInitScript: async () => undefined } as never,
      contextState: { token: null },
      firewall: {} as never,
      baseUrl: 'http://dashboard.test',
      pageStoreInstaller: (() => undefined) as never,
    });
    const unread = ROUTES.find((route) => route.surfaceId === 'inbox-unread')!;
    const groups = ROUTES.find((route) => route.surfaceId === 'inbox-groups')!;
    const conversation = ROUTES.find((route) => route.surfaceId === '/conversations/:conversationId')!;
    const unreadTarget = { path: '/inbox', query: { kind: 'fixed' as const, values: { filter: 'unread' as const } } };
    const groupsTarget = { path: '/inbox', query: { kind: 'fixed' as const, values: { filter: 'groups' as const } } };
    const conversationTarget = { path: '/conversations/fixed', query: { kind: 'absent' as const } };

    await page.prepareWarmSource(unread);
    expect(raw.url()).toBe('http://dashboard.test/inbox');
    expect(await page.activateWarmAction(unread, unreadTarget)).toBe(true);
    expect(raw.url()).toBe('http://dashboard.test/inbox?filter=unread');
    await page.prepareWarmSource(groups);
    expect(raw.url()).toBe('http://dashboard.test/inbox');
    expect(await page.activateWarmAction(groups, groupsTarget)).toBe(true);
    await page.prepareWarmSource(conversation);
    expect(raw.url()).toBe('http://dashboard.test/inbox');
    expect(await page.activateWarmAction(conversation, conversationTarget)).toBe(true);
    expect(raw.events).toEqual([
      'goto:http://dashboard.test/inbox', 'tab:Unread', 'link:/inbox', 'tab:Groups', 'link:/inbox', 'link:/conversations/fixed',
    ]);

    raw.current = 'http://dashboard.test/inbox?filter=groups';
    raw.missingTab = true;
    await page.prepareWarmSource(unread);
    expect(await page.activateWarmAction(unread, unreadTarget)).toBe(false);
  });

  it('keeps a filtered destination non-ready when the real adapter returns to bare Inbox and preserves contradictory terminal evidence', async () => {
    const raw = new AdapterPage();
    raw.current = 'http://dashboard.test/inbox?filter=unread';
    const cdp = {
      send: vi.fn(async (method: string) => method === 'Performance.getMetrics'
        ? { metrics: [{ name: 'Timestamp', value: 1 }] }
        : {}),
      on: vi.fn(),
      detach: vi.fn(async () => undefined),
    };
    const rawWithProtocol = Object.assign(raw, {
      context: () => ({ newCDPSession: vi.fn(async () => cdp) }),
      on: vi.fn(),
      off: vi.fn(),
      evaluate: vi.fn(async () => ({
        navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null },
        paint: { fcpMs: null, lcpMs: null },
        longTasks: { totalMs: 0, maxMs: 0, count: 0 },
        domElements: 1,
      })),
    });
    const firewall = {
      assertHealthy: vi.fn(async () => undefined),
      drainOutOfSampleEvidence: vi.fn(() => []),
    };
    const page = createRealSamplePage({
      page: rawWithProtocol as never,
      context: { addInitScript: async () => undefined } as never,
      contextState: { token: null },
      firewall: firewall as never,
      baseUrl: 'http://dashboard.test',
      pageStoreInstaller: (() => undefined) as never,
    });
    const unread = ROUTES.find((route) => route.surfaceId === 'inbox-unread')!;
    const instrumentation = (await import('./cli.js')).createRealInstrumentation({
      route: unread,
      mode: 'warm',
      repeat: 0,
      baseUrl: 'http://dashboard.test',
      readyTimeoutMs: 10,
      settleMs: 0,
      pollMs: 1,
      modules: {
        collect: { NetworkCollector, summarizePageMetrics },
        firewall: { createFirewallRecordingToken: () => ({ evidence: () => [] }) },
        readiness: {
          waitForMeaningfulReady: async ({ ui }: { ui: Pick<TerminalUiProbe, 'urlMatches'> }) => {
            expect(await ui.urlMatches()).toBe(true);
            raw.current = 'http://dashboard.test/inbox';
            expect(await ui.urlMatches()).toBe(false);
            return {
              status: 'timeout', readyMs: null, terminalState: 'contradictory_terminal', polls: 2,
              pendingCount: 0, lastQualifyingOffsetMs: null,
            };
          },
        },
        routes: { expectedGets: () => [] },
      },
      requests: [],
    } as never);

    await instrumentation.beginSample({
      page,
      token: 'filtered-destination',
      route: unread,
      branch: { kind: 'none' },
      mode: 'warm',
      repeat: 0,
      sourcePageUrl: '/inbox',
      destinationPageUrl: '/inbox?filter=unread',
    });
    await expect(instrumentation.collectSample({
      page, token: 'filtered-destination', route: unread, branch: { kind: 'none' }, mode: 'warm', repeat: 0,
    })).resolves.toMatchObject({ status: 'timeout', terminalState: 'contradictory_terminal', reason: 'contradictory_terminal' });
  });

  it('captures only safe Inbox row counts and fixed truncation booleans', async () => {
    const all = ROUTES.find((route) => route.surfaceId === 'inbox-all')!;
    const unread = ROUTES.find((route) => route.surfaceId === 'inbox-unread')!;
    const unknown = ROUTES.find((route) => route.surfaceId === 'inbox-unknown')!;
    const groups = ROUTES.find((route) => route.surfaceId === 'inbox-groups')!;
    const createEvidencePage = (markers: readonly string[], rows = 0, links: readonly string[] = []) => createRealSamplePage({
      page: new EvidencePage(
        Array.from({ length: rows }, () => ({ kind: 'contact' as const, detailLink: false })),
        markers,
        links,
      ) as never,
      context: { addInitScript: async () => undefined } as never,
      contextState: { token: null },
      firewall: {} as never,
      baseUrl: 'http://dashboard.test',
      pageStoreInstaller: (() => undefined) as never,
    });

    await expect(createEvidencePage([], 3, ['See all group texts']).captureSurfaceEvidence(all, 1)).resolves.toEqual({
      kind: 'inbox', filter: 'all', renderedRowCount: 3, groupsTruncated: true, initialInboxPageRequestCount: 1,
    });
    await expect(createEvidencePage([], 0, ['Browse all group texts (read and unread)']).captureSurfaceEvidence(unread, 1)).resolves.toMatchObject({
      filter: 'unread', groupsTruncated: true,
    });
    await expect(createEvidencePage([], 0, ['See all group texts']).captureSurfaceEvidence(unknown, 1)).resolves.toMatchObject({
      filter: 'unknown', groupsTruncated: true,
    });
    await expect(createEvidencePage(['Showing the latest 1 group text.']).captureSurfaceEvidence(groups, 1)).resolves.toMatchObject({
      filter: 'groups', renderedRowCount: 0, groupsTruncated: true,
    });
    await expect(createEvidencePage(['Showing the latest 2 group texts.']).captureSurfaceEvidence(groups, 1)).resolves.toMatchObject({
      groupsTruncated: true,
    });
    await expect(createEvidencePage(['Not all group texts are shown here.']).captureSurfaceEvidence(groups, 1)).resolves.toMatchObject({
      groupsTruncated: true,
    });
    await expect(createEvidencePage(['See all group texts']).captureSurfaceEvidence(all, 1)).resolves.toMatchObject({
      groupsTruncated: false,
    });
    await expect(createEvidencePage(['See all group texts']).captureSurfaceEvidence(unknown, 1)).resolves.toMatchObject({
      groupsTruncated: false,
    });
    await expect(createEvidencePage(['Browse all group texts (read and unread)']).captureSurfaceEvidence(unread, 1)).resolves.toMatchObject({
      groupsTruncated: false,
    });
    await expect(createEvidencePage(['Showing the latest 0 group texts.']).captureSurfaceEvidence(groups, 1)).resolves.toMatchObject({
      groupsTruncated: false,
    });
  });

  it('counts relay rows only when the exact label and descendant detail link agree', async () => {
    const page = createRealSamplePage({
      page: new EvidencePage([
        { kind: 'contact', detailLink: false },
        { kind: 'relay', detailLink: true },
        { kind: 'group', detailLink: true },
        { kind: 'relay', detailLink: false },
      ], []) as never,
      context: { addInitScript: async () => undefined } as never,
      contextState: { token: null },
      firewall: {} as never,
      baseUrl: 'http://dashboard.test',
      pageStoreInstaller: (() => undefined) as never,
    });

    await expect(page.countRelayConversationLinks()).resolves.toBe(1);
  });

  it('attaches evidence only to successful owned Inbox and conversation-detail surfaces', async () => {
    const page = createRealSamplePage({
      page: new EvidencePage([], []) as never,
      context: { addInitScript: async () => undefined } as never,
      contextState: { token: null },
      firewall: {} as never,
      baseUrl: 'http://dashboard.test',
      pageStoreInstaller: (() => undefined) as never,
    });
    const all = ROUTES.find((route) => route.surfaceId === 'inbox-all')!;
    const detail = ROUTES.find((route) => route.surfaceId === '/conversations/:conversationId')!;
    const other = ROUTES.find((route) => route.surfaceId === '/')!;
    const request = {
      surfaceId: 'inbox-all', mode: 'cold' as const, repeat: 0, method: 'GET', resourceClass: 'api' as const,
      originClass: 'first_party' as const, endpointTemplate: '/api/inbox', queryKeys: ['filter', 'limit'],
      inboxRequestClass: 'inbox_page_all' as const, startOffsetMs: 0, durationMs: 1, ttfbMs: 1, status: 200,
      transferBytes: 1, outcome: 'finished' as const, requestRole: 'required' as const, unmatchedApi: false,
    };

    await expect(captureSuccessfulSurfaceEvidence(page, all, [request])).resolves.toMatchObject({
      kind: 'inbox', initialInboxPageRequestCount: 1,
    });
    const aborted = { ...request, outcome: 'aborted' as const, status: null, transferBytes: null };
    await expect(captureSuccessfulSurfaceEvidence(page, all, [aborted, request])).resolves.toMatchObject({
      kind: 'inbox', initialInboxPageRequestCount: 1,
    });
    await expect(captureSuccessfulSurfaceEvidence(page, all, [request, { ...request, startOffsetMs: 2 }])).resolves.toMatchObject({
      kind: 'inbox', initialInboxPageRequestCount: 2,
    });
    await expect(captureSuccessfulSurfaceEvidence(page, all, [aborted])).resolves.toMatchObject({
      kind: 'inbox', initialInboxPageRequestCount: 0,
    });
    await expect(captureSuccessfulSurfaceEvidence(page, detail, [])).resolves.toEqual({
      kind: 'conversation_detail', initialRenderedMessageCount: null,
    });
    await expect(captureSuccessfulSurfaceEvidence(page, other, [])).resolves.toBeNull();
  });
});

const configDeps = {
  cwd: 'W:\\tmp\\page-performance-profiler',
  now: () => new Date('2026-08-12T12:00:00.000Z'),
  randomRouteOrderSeed: () => 42,
};

describe('top-level profiler sequencing', () => {
  it('reduces escaped-write failures to allowlisted evidence for partial reporting', () => {
    const error = new FirewallEscapedWriteError({ method: 'POST', endpointTemplate: 'unmatched_api' });
    Object.assign(error, { rawUrl: 'https://dashboard.example.test/api/private?email=person@example.test' });
    expect(classifyEscapedWriteFailure(error)).toEqual({
      reason: 'uncataloged_write_escaped_firewall',
      method: 'POST',
      endpointTemplate: 'unmatched_api',
    });
    expect(classifyEscapedWriteFailure({
      reason: 'uncataloged_write_escaped_firewall',
      evidence: { method: 'POST', endpointTemplate: '/api/private/person@example.test' },
    })).toBeNull();
  });
  it('classifies signals separately from crashes and unregisters every process handler', () => {
    for (const event of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const) {
      const source = new EventEmitter();
      const controller = new AbortController();
      const detach = installProfilerProcessHandlers(controller, source as never);
      source.emit(event, new Error('private.person@example.test'));
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toEqual({
        reason: event === 'SIGINT' || event === 'SIGTERM' ? 'interrupted' : 'crashed',
      });
      expect(JSON.stringify(controller.signal.reason)).not.toContain('private.person');
      detach();
      expect(source.eventNames()).toEqual([]);
    }
  });

  it('requests a forced exit after a second termination signal', () => {
    const source = new EventEmitter();
    const controller = new AbortController();
    const onForceExitRequested = vi.fn();
    const detach = installProfilerProcessHandlers(
      controller,
      source as never,
      { onForceExitRequested },
    );

    source.emit('SIGINT');
    expect(onForceExitRequested).not.toHaveBeenCalled();
    source.emit('SIGINT');
    expect(onForceExitRequested).toHaveBeenCalledOnce();
    detach();
  });

  it('does not arm force-exit for an unhandled rejection or override an active signal exit', () => {
    const rejectionSource = new EventEmitter();
    const rejectionController = new AbortController();
    const rejectionForce = vi.fn();
    const detachRejection = installProfilerProcessHandlers(
      rejectionController,
      rejectionSource as never,
      { onForceExitRequested: rejectionForce },
    );
    rejectionSource.emit('unhandledRejection', new Error('private.person@example.test'));
    expect(rejectionController.signal.reason).toEqual({ reason: 'crashed' });
    expect(rejectionForce).not.toHaveBeenCalled();
    detachRejection();

    const signalSource = new EventEmitter();
    const signalController = new AbortController();
    const signalForce = vi.fn();
    const detachSignal = installProfilerProcessHandlers(
      signalController,
      signalSource as never,
      { onForceExitRequested: signalForce },
    );
    signalSource.emit('SIGINT');
    signalSource.emit('unhandledRejection', new Error('late rejection'));
    expect(signalController.signal.reason).toEqual({ reason: 'interrupted' });
    expect(signalForce).not.toHaveBeenCalled();
    detachSignal();

    const exceptionSource = new EventEmitter();
    const exceptionController = new AbortController();
    const exceptionForce = vi.fn();
    const detachException = installProfilerProcessHandlers(
      exceptionController,
      exceptionSource as never,
      { onForceExitRequested: exceptionForce },
    );
    exceptionSource.emit('uncaughtException', new Error('fatal'));
    expect(exceptionForce).toHaveBeenCalledOnce();
    detachException();
  });

  it('aligns the Node clock to the midpoint of the CDP timestamp round trip', async () => {
    const send = vi.fn(async (method: string) => method === 'Performance.getMetrics'
      ? { metrics: [{ name: 'Timestamp', value: 123.5 }] }
      : {});
    const now = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(112);

    await expect(captureCdpClockAlignment({ send } as never, now)).resolves.toEqual({
      cdpOriginSeconds: 123.5,
      nodeOriginMs: 106,
    });
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'Performance.enable',
      'Performance.getMetrics',
    ]);
  });

  it('anchors performance artifacts to the repository instead of the caller cwd', () => {
    expect(performanceArtifactRoot()).toMatch(/[\\/]e2e[\\/]\.artifacts[\\/]performance$/u);
    expect(performanceArtifactRoot()).not.toContain('e2e\\e2e');
  });

  it('disposes real sample adapters once across cancellation and later collector cleanup', async () => {
    const cliModule = await import('./cli.js') as typeof import('./cli.js') & {
      createRealInstrumentation?: (input: unknown) => SampleInstrumentation;
    };
    expect(cliModule.createRealInstrumentation).toBeTypeOf('function');
    if (cliModule.createRealInstrumentation === undefined) return;

    const detach = vi.fn(async () => undefined);
    const cdp = {
      send: vi.fn(async (method: string) => method === 'Performance.getMetrics'
        ? { metrics: [{ name: 'Timestamp', value: 1 }] }
        : {}),
      on: vi.fn(),
      detach,
    };
    const on = vi.fn();
    const off = vi.fn();
    const contextState = { token: null as { evidence(): []; } | null };
    const page = {
      rawPage: {
        context: () => ({ newCDPSession: vi.fn(async () => cdp) }),
        on,
        off,
        evaluate: vi.fn(async () => undefined),
      },
      contextState,
      firewall: {
        assertHealthy: vi.fn(async () => undefined),
        drainOutOfSampleEvidence: vi.fn(() => []),
        dispose: vi.fn(async () => undefined),
      },
      baseUrl: 'http://127.0.0.1:9111',
    };
    const collectorInputs: unknown[] = [];
    class FakeNetworkCollector {
      constructor(input: unknown) { collectorInputs.push(input); }
      beginSample(): void {}
    }
    const inboxRoute = ROUTES.find((route) => route.surfaceId === 'inbox-unread')!;
    const instrumentation = cliModule.createRealInstrumentation({
      route: inboxRoute,
      mode: 'warm',
      repeat: 0,
      baseUrl: 'http://127.0.0.1:9111',
      readyTimeoutMs: 10,
      settleMs: 1,
      pollMs: 1,
      modules: {
        collect: { NetworkCollector: FakeNetworkCollector },
        firewall: { createFirewallRecordingToken: () => ({ evidence: () => [] }) },
        readiness: {
          waitForMeaningfulReady: async () => { throw new Error('readiness_failed'); },
        },
        routes: { expectedGets: () => [] },
      },
      requests: [],
    } as never);

    await instrumentation.beginSample({
      page: page as never,
      token: 'real-warm',
      route: inboxRoute,
      branch: { kind: 'none' },
      mode: 'warm',
      repeat: 0,
      sourcePageUrl: '/',
      destinationPageUrl: '/',
    });
    expect(on).toHaveBeenCalledOnce();
    expect(collectorInputs[0]).toMatchObject({ behaviorFamily: 'inbox' });
    expect(contextState.token).not.toBeNull();

    await instrumentation.disposeSample();
    await instrumentation.disposeSample();
    await expect(instrumentation.collectSample({
      page: page as never,
      token: 'real-warm',
      route: inboxRoute,
      branch: { kind: 'none' },
      mode: 'warm',
      repeat: 0,
    })).rejects.toThrowError('readiness_failed');

    expect(contextState.token).toBeNull();
    expect(off).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
  });

  it('retains a blocked write recorded during delayed post-readiness surface evidence', async () => {
    const route = ROUTES.find((candidate) => candidate.surfaceId === 'inbox-all')!;
    const handlers = new Map<string, (event: unknown) => void>();
    const cdp = {
      send: vi.fn(async (method: string) => method === 'Performance.getMetrics'
        ? { metrics: [{ name: 'Timestamp', value: 1 }] }
        : {}),
      on: vi.fn((event: string, listener: (value: unknown) => void) => handlers.set(event, listener)),
      detach: vi.fn(async () => undefined),
    };
    const events: string[] = [];
    const contextState = { token: null as ReturnType<typeof createFirewallRecordingToken> | null };
    const page = {
      rawPage: {
        context: () => ({ newCDPSession: vi.fn(async () => cdp) }),
        on: vi.fn(),
        off: vi.fn(),
        url: () => 'http://127.0.0.1:9111/inbox',
        evaluate: vi.fn(async () => ({
          navigation: { ttfbMs: 1, domContentLoadedMs: 2, loadMs: 3 },
          paint: { fcpMs: 4, lcpMs: 5 },
          longTasks: { totalMs: 0, maxMs: 0, count: 0 },
          domElements: 6,
        })),
      },
      contextState,
      firewall: {
        assertHealthy: vi.fn(async () => { events.push('health'); }),
        drainOutOfSampleEvidence: vi.fn(() => []),
      },
      async captureSurfaceEvidence() {
        events.push('surface:start');
        contextState.token!.record({
          method: 'POST',
          endpointTemplate: '/api/conversations/:conversationId/read',
          phase: 'destination_mount',
        });
        await Promise.resolve();
        events.push('surface:end');
        return {
          kind: 'inbox' as const,
          filter: 'all' as const,
          renderedRowCount: 1,
          groupsTruncated: false,
          initialInboxPageRequestCount: 0,
        };
      },
    };
    const instrumentation = createRealInstrumentation({
      route,
      mode: 'cold',
      repeat: 0,
      baseUrl: 'http://127.0.0.1:9111',
      readyTimeoutMs: 10,
      settleMs: 1,
      pollMs: 1,
      modules: {
        collect: { NetworkCollector, summarizePageMetrics },
        firewall: { createFirewallRecordingToken },
        readiness: {
          waitForMeaningfulReady: async () => ({
            status: 'ready', readyMs: 7, terminalState: 'populated', polls: 1,
            pendingCount: 0, lastQualifyingOffsetMs: null,
          }),
        },
        routes: { expectedGets: () => [] },
      },
      requests: [],
    } as never);

    await instrumentation.beginSample({
      page: page as never, token: 'late-write', route, branch: { kind: 'none' },
      mode: 'cold', repeat: 0, destinationPageUrl: '/inbox',
    });
    const result = await instrumentation.collectSample({
      page: page as never, token: 'late-write', route, branch: { kind: 'none' }, mode: 'cold', repeat: 0,
    });

    expect(result.blockedWrites).toContainEqual({
      method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount',
    });
    expect(events).toEqual(['health', 'surface:start', 'surface:end', 'health']);
    expect(contextState.token).toBeNull();
    expect(handlers.has('Network.requestWillBeSent')).toBe(true);
  });

  it('fails a sample closed when an Inbox request has an invalid page tuple', async () => {
    const route = ROUTES.find((candidate) => candidate.surfaceId === 'inbox-all')!;
    const handlers = new Map<string, (event: any) => void>();
    const cdp = {
      send: vi.fn(async (method: string) => method === 'Performance.getMetrics'
        ? { metrics: [{ name: 'Timestamp', value: 1 }] }
        : {}),
      on: vi.fn((event: string, listener: (value: any) => void) => handlers.set(event, listener)),
      detach: vi.fn(async () => undefined),
    };
    const contextState = { token: null as ReturnType<typeof createFirewallRecordingToken> | null };
    const page = {
      rawPage: {
        context: () => ({ newCDPSession: vi.fn(async () => cdp) }),
        on: vi.fn(),
        off: vi.fn(),
        url: () => 'http://127.0.0.1:9111/inbox',
        evaluate: vi.fn(async () => ({
          navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null },
          paint: { fcpMs: null, lcpMs: null },
          longTasks: { totalMs: 0, maxMs: 0, count: 0 },
          domElements: 1,
        })),
      },
      contextState,
      firewall: { assertHealthy: vi.fn(async () => undefined), drainOutOfSampleEvidence: vi.fn(() => []) },
      async captureSurfaceEvidence() { return null; },
    };
    const requests: import('./types.js').RequestEvidence[] = [];
    const instrumentation = createRealInstrumentation({
      route, mode: 'cold', repeat: 0, baseUrl: 'http://127.0.0.1:9111',
      readyTimeoutMs: 10, settleMs: 1, pollMs: 1,
      modules: {
        collect: { NetworkCollector, summarizePageMetrics },
        firewall: { createFirewallRecordingToken },
        readiness: {
          waitForMeaningfulReady: async () => {
            handlers.get('Network.requestWillBeSent')!({
              requestId: 'malformed', timestamp: 1.01, type: 'Fetch',
              request: {
                method: 'GET',
                url: 'http://127.0.0.1:9111/api/inbox?filter=private-value&limit=31',
              },
            });
            handlers.get('Network.responseReceived')!({
              requestId: 'malformed', timestamp: 1.02, response: { status: 200 },
            });
            handlers.get('Network.loadingFinished')!({
              requestId: 'malformed', timestamp: 1.03, encodedDataLength: 10,
            });
            return {
              status: 'ready', readyMs: 5, terminalState: 'populated', polls: 1,
              pendingCount: 0, lastQualifyingOffsetMs: null,
            };
          },
        },
        routes: { expectedGets: () => [] },
      },
      requests,
    } as never);

    await instrumentation.beginSample({
      page: page as never, token: 'bad-inbox', route, branch: { kind: 'none' },
      mode: 'cold', repeat: 0, destinationPageUrl: '/inbox',
    });
    const result = await instrumentation.collectSample({
      page: page as never, token: 'bad-inbox', route, branch: { kind: 'none' }, mode: 'cold', repeat: 0,
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'endpoint_contract_mismatch', surfaceEvidence: null });
    expect(requests).toEqual([expect.objectContaining({
      endpointTemplate: '/api/inbox', queryKeys: ['filter', 'limit'],
      unmatchedApi: true,
    })]);
    expect(requests[0]).not.toHaveProperty('inboxRequestClass');
    expect(JSON.stringify({ result, requests })).not.toContain('private-value');
    expect(JSON.stringify({ result, requests })).not.toContain('inbox_endpoint_contract_failure');
  });

  it('makes every sampled page wait for a real per-page firewall installation', async () => {
    const cliModule = await import('./cli.js') as typeof import('./cli.js') & {
      createRealSampleBrowser?: (input: unknown) => SampleBrowser;
    };
    expect(cliModule.createRealSampleBrowser).toBeTypeOf('function');
    if (cliModule.createRealSampleBrowser === undefined) return;
    const installRequestFirewall = vi.fn(async () => {
      throw { reason: 'invalid_firewall_configuration' };
    });
    const rawPage = {};
    const rawContext = {
      newPage: vi.fn(async () => rawPage),
      close: vi.fn(async () => undefined),
    };
    const browser = cliModule.createRealSampleBrowser({
      browser: { newContext: vi.fn(async () => rawContext) },
      baseUrl: 'http://127.0.0.1:9111',
      modules: {
        readiness: { installPageStoreInitScript: vi.fn() },
        firewall: { installRequestFirewall },
      },
    } as never);
    const context = await browser.newContext({});

    await expect(context.newPage()).rejects.toMatchObject({ reason: 'invalid_firewall_configuration' });
    expect(rawContext.newPage).toHaveBeenCalledOnce();
    expect(installRequestFirewall).toHaveBeenCalledOnce();
  });

  it('degrades an unavailable auxiliary page snapshot to null without exposing the browser error', async () => {
    const read = vi.fn(async () => {
      throw new Error('private.person@example.test browser target closed');
    });

    await expect(readPageStoreSnapshot(read)).resolves.toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });

  it('parse failures and print-config perform zero runtime, network, lifecycle, or browser work', async () => {
    const loadRuntime = vi.fn();
    const invalidStdout = vi.fn();
    const invalidStderr = vi.fn();
    await expect(runProfiler(['hermetic', '--scale=101', '--baseline=invalid-config-sentinel.json'], {
      loadRuntime,
      configDeps,
      stdout: invalidStdout,
      stderr: invalidStderr,
    })).resolves.toBe(1);
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(invalidStdout).not.toHaveBeenCalled();
    expect(invalidStderr.mock.calls).toEqual([['configuration_invalid\n']]);
    expect(JSON.stringify(invalidStderr.mock.calls)).not.toContain('invalid-config-sentinel');

    const stdout = vi.fn();
    await expect(runProfiler(['hermetic', '--print-config'], { loadRuntime, configDeps, stdout })).resolves.toBe(0);
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledOnce();
    expect(stdout.mock.calls[0]![0].trim().split(/\r?\n/u)).toHaveLength(1);
    expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({ target: 'hermetic' });
  });

  it('renders --help and -h before target parsing or any runtime side effect', async () => {
    const loadRuntime = vi.fn();
    const stdout = vi.fn();
    const stderr = vi.fn();

    await expect(runProfiler(['--help'], { loadRuntime, stdout, stderr })).resolves.toBe(0);
    const longHelp = stdout.mock.calls[0]?.[0];
    expect(typeof longHelp).toBe('string');
    expect(stderr).not.toHaveBeenCalled();
    expect(loadRuntime).not.toHaveBeenCalled();

    stdout.mockClear();
    await expect(runProfiler(['hermetic', '-h'], { loadRuntime, stdout, stderr })).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(longHelp);
    expect(stderr).not.toHaveBeenCalled();
    expect(loadRuntime).not.toHaveBeenCalled();
  });

  it('prints the canonical resolved hermetic manifest before runtime loading and startup', async () => {
    const events: string[] = [];
    const value = runtime(events);
    const stdout = vi.fn((text: string) => events.push(`stdout:${text}`));
    const loadRuntime = vi.fn(async () => {
      events.push('load-runtime');
      return value;
    });

    await expect(runProfiler([
      'hermetic',
      '--scale=1',
      '--baseline=baseline-path-sentinel.json',
    ], { configDeps, loadRuntime, stdout })).resolves.toBe(0);

    expect(stdout).toHaveBeenCalledOnce();
    const expectedLine = stdout.mock.calls[0]![0];
    expect(events.slice(0, 3)).toEqual([
      `stdout:${expectedLine}`,
      'load-runtime',
      'start',
    ]);
    const printedManifest = JSON.parse(expectedLine.slice('performance_seed_counts='.length));
    const printConfigStdout = vi.fn();
    await expect(runProfiler(['hermetic', '--scale=1', '--print-config'], {
      configDeps,
      loadRuntime,
      stdout: printConfigStdout,
    })).resolves.toBe(0);
    expect(printedManifest).toEqual(JSON.parse(printConfigStdout.mock.calls[0]![0]).seed);
    expect(printedManifest).toMatchObject({ workloadModelVersion: expect.any(Number) });
    expect(expectedLine).not.toContain('baseline-path-sentinel');
  });

  it('keeps the closed failure reason after the hermetic count line', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(runProfiler(['hermetic'], {
      configDeps,
      stdout,
      stderr,
      loadRuntime: vi.fn(async () => {
        throw { reason: 'target_proof_failed', secret: 'runtime-secret-sentinel' };
      }),
    })).resolves.toBe(1);

    expect(stdout).toHaveBeenCalledOnce();
    expect(stdout.mock.calls[0]![0]).toMatch(/^performance_seed_counts=\{/u);
    expect(stderr.mock.calls).toEqual([['target_proof_failed\n']]);
    expect(JSON.stringify([stdout.mock.calls, stderr.mock.calls])).not.toContain('runtime-secret-sentinel');
  });

  it('runs hermetic parse/start/verify/reseed/dashboard/auth/firewall/warmup/collect/report/final cleanup', async () => {
    const events: string[] = [];
    const value = runtime(events);
    const exit = await runProfiler(['hermetic'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
    });
    expect(exit).toBe(0);
    expect(events).toEqual([
      'start', 'verify', 'reseed', 'dashboard', 'auth-hermetic',
      'warmup', 'collect', 'report', 'close-dashboard', 'cleanup',
    ]);
  });

  it('aborts an active hermetic phase on SIGINT and still runs owned cleanup', async () => {
    const events: string[] = [];
    const processEvents = new EventEmitter();
    const value = runtime(events, {
      verifyHermetic: vi.fn(async () => {
        events.push('verify');
        await new Promise<void>(() => undefined);
      }),
    });
    const stderr = vi.fn();
    const running = runProfiler(['hermetic'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
      processEvents: processEvents as never,
      stderr,
    });
    await vi.waitFor(() => expect(value.verifyHermetic).toHaveBeenCalledOnce());
    processEvents.emit('SIGINT');

    await expect(running).resolves.toBe(1);
    expect(events.at(-1)).toBe('cleanup');
    expect(stderr).toHaveBeenCalledWith('interrupted\n');
  });

  it('reports a crash category, cleans owned state, and only then forces nonzero exit', async () => {
    const events: string[] = [];
    const processEvents = new EventEmitter();
    const forceExit = vi.fn((code: number) => events.push(`force-exit-${code}`));
    const value = runtime(events, {
      verifyHermetic: vi.fn(async () => {
        events.push('verify');
        await new Promise<void>(() => undefined);
      }),
    });
    const stderr = vi.fn();
    const running = runProfiler(['hermetic'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
      processEvents: processEvents as never,
      stderr,
      forceExit,
    });
    await vi.waitFor(() => expect(value.verifyHermetic).toHaveBeenCalledOnce());
    processEvents.emit('uncaughtException', new Error('private.person@example.test'));

    await expect(running).resolves.toBe(1);
    expect(events.slice(-2)).toEqual(['cleanup', 'force-exit-1']);
    expect(stderr.mock.calls).toEqual([['crashed\n']]);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('private.person');
  });

  it('forces a nonzero exit after the second signal grace even when cleanup is wedged', async () => {
    const events: string[] = [];
    const processEvents = new EventEmitter();
    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const value = runtime(events, {
      verifyHermetic: vi.fn(async () => {
        events.push('verify');
        await new Promise<void>(() => undefined);
      }),
      cleanupHermetic: vi.fn(async () => {
        events.push('cleanup-started');
        await cleanupBlocked;
        events.push('cleanup-finished');
        return { status: 'cleaned', lane: 7 };
      }),
    });
    const forceExit = vi.fn();
    const running = runProfiler(['hermetic'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
      processEvents: processEvents as never,
      stderr: vi.fn(),
      forceExit,
      forceExitGraceMs: 5,
    });
    await vi.waitFor(() => expect(value.verifyHermetic).toHaveBeenCalledOnce());
    processEvents.emit('SIGINT');
    await vi.waitFor(() => expect(value.cleanupHermetic).toHaveBeenCalledOnce());
    processEvents.emit('SIGINT');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const forcedWhileCleanupWasBlocked = forceExit.mock.calls.length > 0;
    releaseCleanup();
    await running;

    expect(forcedWhileCleanupWasBlocked).toBe(true);
    expect(forceExit).toHaveBeenCalledWith(1);
  });

  it('always cleans hermetic startup, profiling, report, browser, and privacy failures', async () => {
    for (const failure of ['verifyHermetic', 'reseedHermetic', 'openDashboard', 'authenticateHermetic', 'warmup', 'collect', 'report'] as const) {
      const events: string[] = [];
      const value = runtime(events, {
        [failure]: vi.fn(async () => {
          events.push(failure);
          throw new Error('private.person@example.test W:\\secret\\contact-123');
        }),
      });
      const stderr = vi.fn();
      const exit = await runProfiler(['hermetic'], {
        configDeps,
        loadRuntime: vi.fn(async () => value),
        stderr,
      });
      expect(exit, failure).toBe(1);
      expect(events.at(-1), failure).toBe('cleanup');
      expect(JSON.stringify(stderr.mock.calls)).not.toContain('private.person');
      expect(JSON.stringify(stderr.mock.calls)).not.toContain('contact-123');
    }
  });

  it('makes cleanup failure nonzero and prints only lane plus static recovery command', async () => {
    const events: string[] = [];
    const stderr = vi.fn();
    const value = runtime(events, {
      cleanupHermetic: vi.fn(async () => {
        events.push('cleanup');
        return { status: 'cleanup_failed', reason: 'cleanup_failed', lane: 7, recoveryCommand: 'npm run e2e:stop' };
      }),
    });
    await expect(runProfiler(['hermetic'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
      stderr,
    })).resolves.toBe(1);
    expect(stderr.mock.calls).toEqual([['cleanup_failed lane=7 recovery="npm run e2e:stop"\n']]);
  });

  it('runs local proof/TTY existing-user auth/firewall/warmup/collect/report without lifecycle or seed', async () => {
    const events: string[] = [];
    const value = runtime(events);
    const stdout = vi.fn();
    await expect(runProfiler(['local', '--base-url=http://localhost:5174'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
      stdout,
      stdinIsTTY: true,
    })).resolves.toBe(0);
    expect(events).toEqual([
      'local-proof', 'dashboard', 'auth-local', 'warmup',
      'collect', 'report', 'close-dashboard',
    ]);
    expect(value.startHermetic).not.toHaveBeenCalled();
    expect(value.reseedHermetic).not.toHaveBeenCalled();
    expect(value.cleanupHermetic).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('refuses noninteractive local mode before runtime loading or target traffic', async () => {
    const loadRuntime = vi.fn();
    const stderr = vi.fn();

    await expect(runProfiler(['local', '--base-url=http://localhost:5174'], {
      configDeps,
      loadRuntime,
      stderr,
      stdinIsTTY: false,
    })).resolves.toBe(1);

    expect(loadRuntime).not.toHaveBeenCalled();
    expect(stderr.mock.calls).toEqual([['local_tty_required\n']]);
  });

  it('runs hosted headed login/admin/env proof/firewall/collect/report without seed or warmup', async () => {
    const events: string[] = [];
    const value = runtime(events);
    const stdout = vi.fn();
    await expect(runProfiler(['hosted-dev', '--base-url=https://dev.example.test', '--headed'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
      stdout,
    })).resolves.toBe(0);
    expect(events).toEqual([
      'dashboard', 'auth-hosted', 'collect', 'report', 'close-dashboard',
    ]);
    expect(value.startHermetic).not.toHaveBeenCalled();
    expect(value.verifyLocal).not.toHaveBeenCalled();
    expect(value.reseedHermetic).not.toHaveBeenCalled();
    expect(value.warmup).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('returns zero for slower valid comparisons and nonzero for closed safety/auth/privacy/browser failures', async () => {
    const slower = runtime([], {
      report: vi.fn(async () => ({ exitCode: 0, status: 'written', comparison: 'slower' })),
    });
    await expect(runProfiler(['hermetic'], {
      configDeps,
      loadRuntime: vi.fn(async () => slower),
    })).resolves.toBe(0);

    for (const phase of ['verifyLocal', 'authenticateHosted', 'collect', 'report'] as const) {
      const value = runtime([], { [phase]: vi.fn(async () => { throw new Error('closed_failure'); }) });
      const argv = phase === 'verifyLocal'
        ? ['local', '--base-url=http://localhost:5174']
        : phase === 'authenticateHosted'
          ? ['hosted-dev', '--base-url=https://dev.example.test', '--headed']
          : ['hermetic'];
      await expect(runProfiler(argv, {
        configDeps,
        loadRuntime: vi.fn(async () => value),
        stdinIsTTY: true,
      })).resolves.toBe(1);
    }
  });

  it('prints a fixed safe privacy failure record without candidate content', async () => {
    const stdout = vi.fn();
    const sensitiveValue = 'private.person@example.com';
    const value = runtime([], {
      report: vi.fn(async () => ({
        exitCode: 1,
        status: 'privacy_failure',
        directoryName: '20260812T123456789Z-33334444-quarantined',
        files: ['summary.json', 'report.md', sensitiveValue],
        reasonCategories: ['email_address', sensitiveValue],
      })),
    });

    await expect(runProfiler(['hermetic'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
      stdout,
    })).resolves.toBe(1);

    const output = stdout.mock.calls.map(([text]) => text as string).join('');
    expect(output).toContain('performance_report=20260812T123456789Z-33334444-quarantined\n');
    expect(output).toContain('performance_privacy_failure={"files":["report.md","summary.json"],"reasonCategories":["email_address"]}\n');
    expect(output).not.toContain(sensitiveValue);
  });

  it('propagates a finalized checkpoint mismatch report as nonzero without another lifecycle pass', async () => {
    const events: string[] = [];
    const value = runtime(events, {
      report: vi.fn(async () => {
        events.push('checkpoint-report');
        return { exitCode: 1, status: 'checkpoint_mismatch' };
      }),
    });
    await expect(runProfiler([
      'hermetic', '--scale=1', '--cold-repeats=1', '--warm-repeats=1', '--contract-checkpoint',
    ], { configDeps, loadRuntime: vi.fn(async () => value) })).resolves.toBe(1);
    expect(events).toContain('checkpoint-report');
    expect(events.at(-1)).toBe('cleanup');
  });

  it('main sets the supplied process exit code instead of throwing raw failures', async () => {
    const processLike = { exitCode: undefined as number | undefined };
    await main(['bad-target'], {
      processLike,
      loadRuntime: vi.fn(),
      configDeps,
    });
    expect(processLike.exitCode).toBe(1);
  });

  it('keeps a top-level stdout EPIPE nonzero after owned cleanup even when stderr is also closed', async () => {
    const events: string[] = [];
    const value = runtime(events, {
      report: vi.fn(async () => ({
        exitCode: 0,
        status: 'written',
        directoryName: '20260812T123456789Z-eeee5555',
      })),
    });
    const processLike = { exitCode: undefined as number | undefined };
    const closedPipe = (): never => { throw Object.assign(new Error('closed pipe'), { code: 'EPIPE' }); };
    let stdoutWrites = 0;
    const closeAfterSeed = (): void => {
      stdoutWrites += 1;
      if (stdoutWrites > 1) closedPipe();
    };

    await expect(runDirectMain(['hermetic'], {
      processLike,
      configDeps,
      loadRuntime: vi.fn(async () => value),
      stdout: closeAfterSeed,
      stderr: closedPipe,
    })).resolves.toBeUndefined();

    expect(processLike.exitCode).toBe(1);
    expect(events).toContain('cleanup');
  });
});
