import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type {
  Browser,
  BrowserContext,
  CDPSession,
  ConsoleMessage,
  Locator,
  Page,
} from '@playwright/test';
import {
  parseRunConfig,
  toSafeRunConfig,
  type ParseRunConfigDeps,
  type RunConfig,
} from './config.js';
import type {
  CollectRunSamplesResult,
  NetworkCollector,
  SampleBrowser,
  SampleBrowserContext,
  SampleInstrumentation,
  SamplePage,
} from './collect.js';
import type { FirewallRecordingToken } from './firewall.js';
import type {
  LocatorContract,
  ResolverApi,
  ResolverDom,
  ResolverResult,
  RouteDefinition,
} from './routes.js';
import type { RequestEvidence, SampleMode, SampleResult, TargetMetadata } from './types.js';
import { terminalAlternativeVisible } from './readiness.js';
import type { PageStoreSnapshot } from './readiness.js';
import type { SelfQaAttempt, SelfQaFixtureBindings, SelfQaSnapshot } from './selfQa.js';

export interface CliReportResult {
  exitCode: number;
  status: string;
}

export interface CliRuntime {
  startHermetic(config: RunConfig): Promise<unknown>;
  verifyHermetic(config: RunConfig, lifecycle: unknown): Promise<void>;
  reseedHermetic(config: RunConfig, lifecycle: unknown): Promise<void>;
  verifyLocal(config: RunConfig): Promise<void>;
  openDashboard(config: RunConfig, lifecycle?: unknown): Promise<unknown>;
  authenticateHermetic(config: RunConfig, dashboard: unknown): Promise<unknown>;
  authenticateLocal(config: RunConfig, dashboard: unknown): Promise<unknown>;
  authenticateHosted(config: RunConfig, dashboard: unknown): Promise<unknown>;
  installFirewall(config: RunConfig, dashboard: unknown, auth: unknown): Promise<void>;
  warmup(config: RunConfig, dashboard: unknown, auth: unknown): Promise<void>;
  collect(config: RunConfig, dashboard: unknown, auth: unknown): Promise<unknown>;
  report(config: RunConfig, collected: unknown): Promise<CliReportResult>;
  closeDashboard(dashboard: unknown): Promise<void>;
  cleanupHermetic(lifecycle: unknown): Promise<unknown>;
  installHermeticSignalHandlers?(lifecycle: unknown): () => void;
}

export interface RunProfilerDeps {
  loadRuntime?: (config: RunConfig) => Promise<CliRuntime>;
  configDeps?: ParseRunConfigDeps;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function closedReason(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'reason' in error
    && typeof error.reason === 'string'
    && /^[a-z][a-z0-9_]{1,63}$/u.test(error.reason)
  ) {
    return error.reason;
  }
  return 'unexpected_failure';
}

function cleanupFailure(value: unknown): {
  lane: number;
  recoveryCommand: string;
} | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate['status'] !== 'cleanup_failed' && candidate['reason'] !== 'cleanup_failed'
  ) return null;
  if (
    !Number.isSafeInteger(candidate['lane'])
    || candidate['recoveryCommand'] !== 'npm run e2e:stop'
  ) return null;
  return { lane: candidate['lane'] as number, recoveryCommand: 'npm run e2e:stop' };
}

function hermeticSeedCountsLine(config: RunConfig): string | null {
  const seed = toSafeRunConfig(config).seed;
  if (seed === null) return null;
  const counts = {
    scale: seed.scale,
    contacts: seed.contacts,
    units: seed.units,
    placements: seed.placements,
    tours: seed.tours,
    conversations: seed.conversations,
    messagesPerConversation: seed.messagesPerConversation,
    broadcasts: seed.broadcasts,
    recipientsPerBroadcast: seed.recipientsPerBroadcast,
    messageCount: seed.messageCount,
    requestedRecipientCount: seed.requestedRecipientCount,
    resolvedRecipientsPerBroadcast: seed.resolvedRecipientsPerBroadcast,
    resolvedRecipientCount: seed.resolvedRecipientCount,
    requestedRelayGroupCount: seed.requestedRelayGroupCount,
    relayGroupCount: seed.relayGroupCount,
    clippedRelayGroupCount: seed.clippedRelayGroupCount,
    fixedUnmatchedEmailCount: seed.fixedUnmatchedEmailCount,
    physicalItemCount: seed.physicalItemCount,
    totalItemCount: seed.totalItemCount,
  };
  return `performance_seed_counts=${JSON.stringify(counts)}\n`;
}

async function closeQuietly(runtime: CliRuntime, dashboard: unknown): Promise<boolean> {
  try {
    await runtime.closeDashboard(dashboard);
    return true;
  } catch {
    return false;
  }
}

export async function runProfiler(
  argv: string[],
  deps: RunProfilerDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  let config: RunConfig;
  try {
    config = parseRunConfig(argv, deps.configDeps);
  } catch {
    stderr('configuration_invalid\n');
    return 1;
  }

  if (config.printConfig) {
    stdout(`${JSON.stringify(toSafeRunConfig(config))}\n`);
    return 0;
  }

  if (config.target === 'hermetic') {
    const countsLine = hermeticSeedCountsLine(config);
    if (countsLine !== null) stdout(countsLine);
  }

  let runtime: CliRuntime;
  try {
    runtime = await (deps.loadRuntime ?? loadDefaultRuntime)(config);
  } catch (error) {
    stderr(`${closedReason(error)}\n`);
    return 1;
  }

  if (config.target === 'hermetic') {
    let lifecycle: unknown;
    try {
      lifecycle = await runtime.startHermetic(config);
    } catch (error) {
      const failure = cleanupFailure(error);
      if (failure !== null) {
        stderr(`cleanup_failed lane=${failure.lane} recovery="${failure.recoveryCommand}"\n`);
      } else {
        stderr(`${closedReason(error)}\n`);
      }
      return 1;
    }

    const detachSignals = runtime.installHermeticSignalHandlers?.(lifecycle);
    let dashboard: unknown;
    let exitCode = 1;
    try {
      await runtime.verifyHermetic(config, lifecycle);
      await runtime.reseedHermetic(config, lifecycle);
      dashboard = await runtime.openDashboard(config, lifecycle);
      const auth = await runtime.authenticateHermetic(config, dashboard);
      await runtime.installFirewall(config, dashboard, auth);
      await runtime.warmup(config, dashboard, auth);
      const collected = await runtime.collect(config, dashboard, auth);
      const report = await runtime.report(config, collected);
      exitCode = report.exitCode === 0 ? 0 : 1;
    } catch (error) {
      stderr(`${closedReason(error)}\n`);
      exitCode = 1;
    } finally {
      if (dashboard !== undefined && !await closeQuietly(runtime, dashboard)) exitCode = 1;
      let cleanup: unknown;
      try {
        cleanup = await runtime.cleanupHermetic(lifecycle);
      } catch {
        cleanup = { status: 'cleanup_failed', lane: -1, recoveryCommand: 'npm run e2e:stop' };
      }
      const failure = cleanupFailure(cleanup);
      if (failure !== null) {
        stderr(`cleanup_failed lane=${failure.lane} recovery="${failure.recoveryCommand}"\n`);
        exitCode = 1;
      }
      detachSignals?.();
    }
    return exitCode;
  }

  let dashboard: unknown;
  try {
    if (config.target === 'local') await runtime.verifyLocal(config);
    dashboard = await runtime.openDashboard(config);
    const auth = config.target === 'local'
      ? await runtime.authenticateLocal(config, dashboard)
      : await runtime.authenticateHosted(config, dashboard);
    await runtime.installFirewall(config, dashboard, auth);
    if (config.target === 'local') await runtime.warmup(config, dashboard, auth);
    const collected = await runtime.collect(config, dashboard, auth);
    const report = await runtime.report(config, collected);
    return report.exitCode === 0 ? 0 : 1;
  } catch (error) {
    stderr(`${closedReason(error)}\n`);
    return 1;
  } finally {
    if (dashboard !== undefined) await closeQuietly(runtime, dashboard);
  }
}

export interface MainDeps extends RunProfilerDeps {
  processLike?: { exitCode: number | undefined };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  deps: MainDeps = {},
): Promise<void> {
  const code = await runProfiler(argv, deps);
  (deps.processLike ?? process).exitCode = code;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function namedMatcher(contract: LocatorContract): string | RegExp | undefined {
  if (contract.name === undefined || contract.exactness === 'role_only') return undefined;
  if (contract.exactness === 'regex') return new RegExp(contract.name, 'u');
  if (contract.exactness === 'prefix') return new RegExp(`^${escapeRegex(contract.name)}`, 'u');
  return contract.name;
}

function locatorRoot(page: Page, contract: LocatorContract): Page | Locator {
  if (contract.scope === undefined) return page;
  return page.getByRole('region', { name: contract.scope, exact: true }).or(
    page.getByRole('heading', { name: contract.scope, exact: true })
      .locator('xpath=ancestor::*[@aria-labelledby][1]'),
  );
}

function locatorFor(page: Page, contract: LocatorContract): Locator {
  const root = locatorRoot(page, contract);
  const matcher = namedMatcher(contract);
  if (contract.role === 'text') {
    if (matcher === undefined) return root.locator('text=*');
    return root.getByText(matcher, { exact: contract.exactness === 'exact' });
  }
  return root.getByRole(contract.role as never, {
    ...(matcher !== undefined && { name: matcher }),
    ...(contract.exactness === 'exact' && { exact: true }),
  });
}

async function visible(page: Page, contract: LocatorContract): Promise<boolean> {
  try {
    const locator = locatorFor(page, contract);
    return await locator.count() > 0 && await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function groupVisible(
  page: Page,
  contracts: readonly LocatorContract[],
  combine: 'any' | 'all',
): Promise<boolean> {
  if (contracts.length === 0) return false;
  const values = await Promise.all(contracts.map((contract) => visible(page, contract)));
  return combine === 'all' ? values.every(Boolean) : values.some(Boolean);
}

async function terminalState(page: Page, route: RouteDefinition): Promise<SampleResult['terminalState']> {
  if (await groupVisible(page, route.terminal.error, 'any')) return 'error';
  if (await terminalAlternativeVisible(
    route.terminal.populatedAlternatives,
    (contract) => visible(page, contract),
  )) return 'populated';
  if (await terminalAlternativeVisible(
    route.terminal.emptyAlternatives,
    (contract) => visible(page, contract),
  )) return 'empty';
  return 'unknown';
}

export async function readPageStoreSnapshot(
  read: () => Promise<PageStoreSnapshot | null>,
): Promise<PageStoreSnapshot | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

interface RealPage extends SamplePage {
  readonly rawPage: Page;
  readonly contextState: { token: FirewallRecordingToken | null };
  readonly baseUrl: string;
}

function absoluteUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).href;
}

function createRealSamplePage(input: {
  page: Page;
  context: BrowserContext;
  contextState: { token: FirewallRecordingToken | null };
  baseUrl: string;
  pageStoreInstaller: typeof import('./readiness.js')['pageStoreInstaller'];
}): RealPage {
  let firstSource = true;
  const pathNow = (): string => {
    try { return new URL(input.page.url()).pathname; } catch { return ''; }
  };
  return {
    rawPage: input.page,
    contextState: input.contextState,
    baseUrl: input.baseUrl,
    async installNextDocumentBootstrap(token): Promise<void> {
      await input.context.addInitScript(input.pageStoreInstaller, {
        bootstrap: { token, cutoffMs: 0 },
      });
    },
    async goto(path): Promise<void> {
      await input.page.goto(absoluteUrl(input.baseUrl, path));
    },
    async prepareWarmSource(route): Promise<void> {
      if (firstSource || pathNow() === '') {
        firstSource = false;
        await input.page.goto(absoluteUrl(input.baseUrl, route.source.path));
        return;
      }
      if (pathNow() === route.source.path) return;
      const exactLink = input.page.locator(`a[href="${route.source.path}"]`).first();
      if (await exactLink.count() > 0 && await exactLink.isVisible()) {
        await exactLink.click();
        return;
      }
      // Source preparation is outside the measured token. A direct source load
      // is the bounded fallback when the current route exposes no path to the
      // declared source; the destination click remains an in-app exact-href click.
      await input.page.goto(absoluteUrl(input.baseUrl, route.source.path));
    },
    async waitForSourceReady(route, timeoutMs): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        if (pathNow() === route.source.path && await visible(input.page, route.source.ready)) return true;
        await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 100));
      }
      return false;
    },
    async clickExactHref(href): Promise<boolean> {
      const link = input.page.locator(`a[href="${href}"]`).first();
      if (await link.count() === 0 || !await link.isVisible()) return false;
      await link.click();
      return true;
    },
    async countRelayConversationLinks(): Promise<number> {
      return await input.page.locator('a[href^="/conversations/"]').count();
    },
  };
}

interface SamplingModules {
  collect: typeof import('./collect.js');
  firewall: typeof import('./firewall.js');
  readiness: typeof import('./readiness.js');
  routes: typeof import('./routes.js');
}

function createRealSampleBrowser(input: {
  browser: Browser;
  baseUrl: string;
  modules: SamplingModules;
}): SampleBrowser {
  return {
    async newContext(options: unknown): Promise<SampleBrowserContext> {
      const context = await input.browser.newContext({
        ...(options as Record<string, unknown>),
        baseURL: input.baseUrl,
      });
      const contextState = { token: null as FirewallRecordingToken | null };
      await input.modules.firewall.installRequestFirewall({
        context: context as never,
        firstPartyOrigin: input.baseUrl,
        currentToken: () => contextState.token,
      });
      return {
        async installBasePageStore(): Promise<void> {
          await input.modules.readiness.installPageStoreInitScript(context as never);
        },
        async newPage(): Promise<SamplePage> {
          const page = await context.newPage();
          return createRealSamplePage({
            page,
            context,
            contextState,
            baseUrl: input.baseUrl,
            pageStoreInstaller: input.modules.readiness.pageStoreInstaller,
          });
        },
        async close(): Promise<void> {
          await context.close();
        },
      };
    },
  };
}

async function cdpTimestamp(session: CDPSession): Promise<number> {
  await session.send('Performance.enable');
  const result = await session.send('Performance.getMetrics') as {
    metrics?: Array<{ name: string; value: number }>;
  };
  return result.metrics?.find((metric) => metric.name === 'Timestamp')?.value ?? 0;
}

export function createRealInstrumentation(input: {
  route: RouteDefinition;
  mode: SampleMode;
  repeat: number;
  baseUrl: string;
  readyTimeoutMs: number;
  settleMs: number;
  pollMs: number;
  modules: SamplingModules;
  requests: RequestEvidence[];
}): SampleInstrumentation {
  let collector: NetworkCollector | null = null;
  let cdp: CDPSession | null = null;
  let page: RealPage | null = null;
  let token = '';
  let nodeOriginMs = 0;
  let destinationPath = '';
  let consoleListener: ((message: ConsoleMessage) => void) | null = null;
  let adaptersActive = false;

  const finishAdapters = async (): Promise<void> => {
    if (!adaptersActive) return;
    adaptersActive = false;
    const activePage = page;
    const activeConsoleListener = consoleListener;
    const activeCdp = cdp;
    cdp = null;
    consoleListener = null;
    if (activePage !== null && activeConsoleListener !== null) {
      try { activePage.rawPage.off('console', activeConsoleListener); } catch { /* closed cleanup */ }
    }
    if (activePage !== null) activePage.contextState.token = null;
    if (activeCdp !== null) await activeCdp.detach().catch(() => undefined);
  };

  return {
    async beginSample(begin): Promise<void> {
      page = begin.page as RealPage;
      adaptersActive = true;
      token = begin.token;
      destinationPath = begin.destinationPageUrl;
      nodeOriginMs = performance.now();
      collector = new input.modules.collect.NetworkCollector({
        firstPartyOrigin: input.baseUrl,
        routeKey: input.route.key,
        mode: input.mode,
        repeat: input.repeat,
        expectedGets: input.modules.routes.expectedGets(input.route, input.mode, begin.branch),
      });
      cdp = await page.rawPage.context().newCDPSession(page.rawPage);
      await cdp.send('Network.enable');
      const originSeconds = await cdpTimestamp(cdp);
      collector.beginSample({ token, cdpOriginSeconds: originSeconds, nodeOriginMs });
      cdp.on('Network.requestWillBeSent', (event) => collector?.requestWillBeSent(token, event as never));
      cdp.on('Network.responseReceived', (event) => collector?.responseReceived(token, event as never));
      cdp.on('Network.loadingFinished', (event) => collector?.loadingFinished(token, event as never));
      cdp.on('Network.loadingFailed', (event) => collector?.loadingFailed(token, event as never));
      consoleListener = (message) => {
        const level = message.type() === 'error' ? 'error' : message.type() === 'warning' ? 'warning' : null;
        if (level !== null) collector?.noteConsole(token, level, message.text(), performance.now());
      };
      page.rawPage.on('console', consoleListener);
      page.contextState.token = input.modules.firewall.createFirewallRecordingToken(
        input.mode === 'cold'
          ? {
              mode: 'cold',
              firstPartyOrigin: input.baseUrl,
              destinationPageUrl: absoluteUrl(input.baseUrl, begin.destinationPageUrl),
            }
          : {
              mode: 'warm',
              firstPartyOrigin: input.baseUrl,
              sourcePageUrl: absoluteUrl(input.baseUrl, begin.sourcePageUrl!),
              destinationPageUrl: absoluteUrl(input.baseUrl, begin.destinationPageUrl),
              ...(begin.sourcePageUrl === begin.destinationPageUrl && { noNavigationProbe: true }),
            },
      );
      if (input.mode === 'warm') {
        await page.rawPage.evaluate(({ sampleToken }) => {
          const host = globalThis as typeof globalThis & {
            __hcPerformanceStore?: { beginSample(value: string, cutoff: number): void };
          };
          host.__hcPerformanceStore?.beginSample(sampleToken, performance.now());
        }, { sampleToken: token });
      }
    },
    async disposeSample(): Promise<void> {
      await finishAdapters();
    },
    async collectSample(): Promise<SampleResult> {
      if (collector === null || page === null) throw new Error('unexpected_failure');
      try {
        const route = input.route;
        const readiness = await input.modules.readiness.waitForMeaningfulReady({
          token,
          clock: {
            now: () => performance.now(),
            sleep: (ms) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)),
          },
          nodeOriginMs,
          timeoutMs: input.readyTimeoutMs,
          pollIntervalMs: input.pollMs,
          settleWindowMs: input.settleMs,
          network: collector,
          ui: {
            async urlMatches(): Promise<boolean> {
              try {
                return new URL(page!.rawPage.url()).pathname === new URL(
                  absoluteUrl(input.baseUrl, destinationPath),
                ).pathname;
              } catch {
                return false;
              }
            },
            async structureVisible(): Promise<boolean> {
              if (route.terminal.structure.length === 0) return true;
              const values = await Promise.all(route.terminal.structure.map((contract) => visible(page!.rawPage, contract)));
              return values.every(Boolean);
            },
            async terminalState(): Promise<SampleResult['terminalState']> {
              const state = await terminalState(page!.rawPage, route);
              if (state !== 'unknown') collector?.markTerminalVisible(token);
              return state;
            },
          },
        });
        for (const write of page.contextState.token?.evidence() ?? []) collector.noteBlockedWrite(token, write);
        const ended = collector.endSample(token);
        input.requests.push(...ended.requests);
        const pageSnapshot = await readPageStoreSnapshot(async () => (
          await page!.rawPage.evaluate(({ sampleToken }) => {
            const host = globalThis as typeof globalThis & {
              __hcPerformanceStore?: { endSample(value: string): unknown };
            };
            return host.__hcPerformanceStore?.endSample(sampleToken) ?? null;
          }, { sampleToken: token }) as PageStoreSnapshot | null
        ));
        const metrics = input.modules.collect.summarizePageMetrics({
          mode: input.mode,
          page: pageSnapshot ?? {
            navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null },
            paint: { fcpMs: null, lcpMs: null },
            longTasks: { totalMs: 0, maxMs: 0, count: 0 },
            domElements: null,
          },
          consoleCategories: ended.consoleCategories,
        });
        return {
          routeKey: input.route.key,
          mode: input.mode,
          repeat: input.repeat,
          status: readiness.status === 'ready' ? 'ok' : 'timeout',
          readyMs: readiness.readyMs,
          navigation: metrics.navigation,
          paint: metrics.paint,
          longTasks: metrics.longTasks,
          domElements: metrics.domElements,
          apiRequestCount: ended.apiRequestCount,
          apiTransferBytes: ended.apiTransferBytes,
          resourceRequestCount: ended.resourceRequestCount,
          resourceTransferBytes: ended.resourceTransferBytes,
          resourceCountsByClass: ended.resourceCountsByClass,
          backgroundRequestCount: ended.backgroundRequestCount,
          backgroundTransferBytes: ended.backgroundTransferBytes,
          blockedWrites: ended.blockedWrites,
          consoleCategories: ended.consoleCategories,
          clientTruncated: metrics.clientTruncated,
          terminalState: readiness.terminalState,
          reason: readiness.status === 'ready' ? null : 'ready_timeout',
        };
      } finally {
        await finishAdapters();
      }
    },
  };
}

function resolverFor(
  route: RouteDefinition,
  api: ResolverApi,
  dom: ResolverDom,
  routes: typeof import('./routes.js'),
  selfQaBindings?: Readonly<SelfQaFixtureBindings>,
): Promise<ResolverResult> {
  if (selfQaBindings !== undefined && (
    route.key === '/contacts/:contactId'
    || route.key === '/conversations/:conversationId'
    || route.key === '/tours/:tourId'
    || route.key === '/placements/:placementId'
  )) {
    return routes.resolveBoundSelfQaDetail(route.key, selfQaBindings, dom);
  }
  switch (route.resolver) {
    case 'static':
      return Promise.resolve({
        kind: 'resolved',
        coldPath: route.pathTemplate,
        warmHref: route.source.href,
        branch: { kind: 'none' },
      });
    case 'contact': return routes.resolveContactDetail(api, dom);
    case 'unit': return routes.resolveUnitDetail(api, dom);
    case 'tour': return routes.resolveTourDetail(api, dom);
    case 'placement': return routes.resolvePlacementDetail(api, dom);
    case 'conversation': return routes.resolveConversationDetail(api, dom);
    case 'broadcast': return routes.resolveBroadcastDetail(api, dom);
  }
}

interface DefaultLifecycle {
  lane: number;
  childPid: number;
  appBaseUrl: string;
  dashboardBaseUrl: string;
  tablePrefix: string;
  assertAlive(): void;
  cleanup(): Promise<import('./lifecycle.js').LifecycleCleanupResult>;
}

interface DefaultDashboard {
  browser: { close(): Promise<void>; version(): string };
  authContext: {
    request: {
      get(path: string, options?: { params?: Readonly<Record<string, string>> }): Promise<{ status(): number; json(): Promise<unknown> }>;
      post(path: string, options?: { data?: unknown }): Promise<{ status(): number; json(): Promise<unknown> }>;
    };
    storageState(): Promise<{ cookies: unknown[]; origins: unknown[] }>;
    newPage(): Promise<unknown>;
    close(): Promise<void>;
  };
  baseUrl: string;
  firewallInstalled: boolean;
  targetMetadata: unknown;
  storageState: { cookies: unknown[]; origins: unknown[] } | null;
}

async function runSupplementalSelfQaProbes(input: {
  browser: Browser;
  baseUrl: string;
  storageState: { cookies: unknown[]; origins: unknown[] };
  bindings: Readonly<SelfQaFixtureBindings>;
  firewall: typeof import('./firewall.js');
  selfQa: typeof import('./selfQa.js');
}): Promise<SelfQaAttempt[]> {
  const attempts: SelfQaAttempt[] = [];
  const context = await input.browser.newContext({
    baseURL: input.baseUrl,
    storageState: input.storageState as never,
    serviceWorkers: 'block',
  });
  const state = { token: null as FirewallRecordingToken | null };
  await input.firewall.installRequestFirewall({
    context: context as never,
    firstPartyOrigin: input.baseUrl,
    currentToken: () => state.token,
  });
  const page = await context.newPage();
  try {
    await page.goto(absoluteUrl(input.baseUrl, '/inbox'));
    const href = `/contacts/${input.bindings.inbox_row}`;
    const link = page.locator(`a[href="${href}"]`).first();
    await link.waitFor({ state: 'visible', timeout: 120_000 });
    state.token = input.firewall.createFirewallRecordingToken({
      mode: 'warm',
      firstPartyOrigin: input.baseUrl,
      sourcePageUrl: absoluteUrl(input.baseUrl, '/inbox'),
      destinationPageUrl: absoluteUrl(input.baseUrl, href),
    });
    await link.click();
    await page.waitForURL((url) => url.pathname === href, { timeout: 120_000 });
    await page.waitForTimeout(750);
    attempts.push(...input.selfQa.supplementalAttempts('inbox_row', state.token.evidence()));

    state.token = null;
    await page.goto(absoluteUrl(input.baseUrl, '/email'));
    const list = page.getByRole('list', { name: 'Unmatched email', exact: true });
    await list.waitFor({ state: 'visible', timeout: 120_000 });
    const row = list.locator(':scope > li').nth(input.bindings.unmatched_row_index);
    const expand = row.locator('button[aria-expanded]').first();
    await expand.waitFor({ state: 'visible', timeout: 120_000 });
    state.token = input.firewall.createFirewallRecordingToken({
      mode: 'warm',
      firstPartyOrigin: input.baseUrl,
      sourcePageUrl: absoluteUrl(input.baseUrl, '/email'),
      destinationPageUrl: absoluteUrl(input.baseUrl, '/email'),
      noNavigationProbe: true,
    });
    await expand.click();
    await page.waitForTimeout(750);
    attempts.push(...input.selfQa.supplementalAttempts('unmatched_email', state.token.evidence()));
  } finally {
    state.token = null;
    await context.close();
  }
  return attempts;
}

async function loadDefaultRuntime(config: RunConfig): Promise<CliRuntime> {
  const playwright = await import('@playwright/test');
  const authModule = await import('./auth.js');
  const targetModule = await import('./targets.js');
  const firewallModule = await import('./firewall.js');
  const collectModule = await import('./collect.js');
  const readinessModule = await import('./readiness.js');
  const routesModule = await import('./routes.js');
  const reportModule = await import('./report.js');
  const selfQaModule = await import('./selfQa.js');
  const seedModule = await import('../../app/src/lib/seed/performance.js');
  const samplingModules: SamplingModules = {
    collect: collectModule,
    firewall: firewallModule,
    readiness: readinessModule,
    routes: routesModule,
  };
  const profilerCommit = await targetModule.captureProfilerCommit();
  const rawFetch = async (url: string, init: { method: 'GET' | 'POST'; body?: string }) => {
    const response = await fetch(url, {
      method: init.method,
      ...(init.body !== undefined && {
        body: init.body,
        headers: { 'content-type': 'application/json' },
      }),
    });
    return { status: response.status, json: () => response.json() };
  };
  let lifecycleModule: typeof import('./lifecycle.js') | null = null;
  if (config.target === 'hermetic') lifecycleModule = await import('./lifecycle.js');
  let targetMetadata: unknown = null;
  let activeLifecycle: DefaultLifecycle | null = null;
  let selfQaBindings: Readonly<SelfQaFixtureBindings> | undefined;
  let selfQaBefore: SelfQaSnapshot | undefined;

  const dashboardRequest = (dashboard: DefaultDashboard) => async (
    path: '/auth/dev-login' | '/auth/me' | '/api/system/flags',
    options: { method: 'GET' | 'POST'; data?: Record<string, unknown> },
  ) => {
    return options.method === 'GET'
      ? await dashboard.authContext.request.get(path)
      : await dashboard.authContext.request.post(path, { data: options.data });
  };

  return {
    async startHermetic(): Promise<DefaultLifecycle> {
      if (lifecycleModule === null) throw new Error('unexpected_failure');
      activeLifecycle = await lifecycleModule.startOwnedHermeticLifecycle() as DefaultLifecycle;
      return activeLifecycle;
    },
    async verifyHermetic(_runConfig, owned): Promise<void> {
      const lifecycle = owned as DefaultLifecycle;
      lifecycle.assertAlive();
      targetMetadata = await targetModule.verifyHermeticTarget({
        appBaseUrl: lifecycle.appBaseUrl,
        rawFetch,
        expectedTablePrefix: lifecycle.tablePrefix,
        profilerCommit,
      });
    },
    async reseedHermetic(runConfig, owned): Promise<void> {
      const lifecycle = owned as DefaultLifecycle;
      lifecycle.assertAlive();
      if (runConfig.seed === null) throw new Error('unexpected_failure');
      const input = {
        scale: runConfig.seed.scale,
        contacts: runConfig.seed.contacts,
        units: runConfig.seed.units,
        placements: runConfig.seed.placements,
        tours: runConfig.seed.tours,
        conversations: runConfig.seed.conversations,
        messagesPerConversation: runConfig.seed.messagesPerConversation,
        broadcasts: runConfig.seed.broadcasts,
        recipientsPerBroadcast: runConfig.seed.recipientsPerBroadcast,
      };
      const timeoutMs = Math.max(120_000, Math.min(3_600_000, 120_000 + runConfig.seed.totalItemCount * 20));
      const response = await fetch(`${lifecycle.appBaseUrl}/__dev/performance/reseed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input, anchor: runConfig.seed.anchor }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) {
        throw new targetModule.SafeTargetError('hermetic', 'target_reseed_failed', response.status);
      }
      lifecycle.assertAlive();
    },
    async verifyLocal(runConfig): Promise<void> {
      targetMetadata = await targetModule.verifyLocalTarget({
        baseUrl: runConfig.baseUrl!, rawFetch, profilerCommit,
      });
    },
    async openDashboard(runConfig, owned): Promise<DefaultDashboard> {
      const baseUrl = runConfig.target === 'hermetic'
        ? (owned as DefaultLifecycle).dashboardBaseUrl
        : runConfig.baseUrl!;
      const browser = await playwright.chromium.launch({
        headless: !runConfig.headed,
        ...(runConfig.browserChannel === 'chrome' && { channel: 'chrome' }),
      });
      const authContext = await browser.newContext({ baseURL: baseUrl, serviceWorkers: 'block' });
      return {
        browser,
        authContext,
        baseUrl,
        firewallInstalled: false,
        targetMetadata,
        storageState: null,
      } as DefaultDashboard;
    },
    async authenticateHermetic(runConfig, value): Promise<unknown> {
      const dashboard = value as DefaultDashboard;
      const auth = await authModule.authenticateHermetic({
        email: runConfig.loginEmail,
        dashboardRequest: dashboardRequest(dashboard),
        storageState: () => dashboard.authContext.storageState(),
      });
      dashboard.storageState = auth.storageState;
      dashboard.targetMetadata = targetMetadata;
      return auth;
    },
    async authenticateLocal(runConfig, value): Promise<unknown> {
      const dashboard = value as DefaultDashboard;
      const readline = await import('node:readline/promises');
      const auth = await authModule.authenticateLocal({
        baseUrl: runConfig.baseUrl!,
        email: runConfig.loginEmail,
        stdinIsTTY: process.stdin.isTTY === true,
        readConfirmation: async () => {
          const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
          try { return await prompt.question(`Type PROFILE ${runConfig.baseUrl}: `); }
          finally { prompt.close(); }
        },
        dashboardRequest: dashboardRequest(dashboard),
        storageState: () => dashboard.authContext.storageState(),
      });
      dashboard.storageState = auth.storageState;
      dashboard.targetMetadata = targetMetadata;
      return auth;
    },
    async authenticateHosted(runConfig, value): Promise<unknown> {
      const dashboard = value as DefaultDashboard;
      const auth = await authModule.authenticateHosted({
        headed: runConfig.headed,
        openLoginPage: async () => {
          const page = await dashboard.authContext.newPage() as {
            goto(path: string): Promise<unknown>;
            close(): Promise<void>;
          };
          await page.goto('/');
          return page;
        },
        dashboardRequest: dashboardRequest(dashboard),
        storageState: () => dashboard.authContext.storageState(),
        sleep: (ms) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)),
        now: Date.now,
        timeoutMs: runConfig.loginTimeoutMs,
        pollMs: runConfig.pollMs,
      });
      dashboard.storageState = auth.storageState;
      targetMetadata = await targetModule.verifyHostedTarget({
        baseUrl: runConfig.baseUrl!,
        headed: runConfig.headed,
        dashboardRequest: dashboardRequest(dashboard),
        profilerCommit,
      });
      dashboard.targetMetadata = targetMetadata;
      return auth;
    },
    async installFirewall(_runConfig, value): Promise<void> {
      const dashboard = value as DefaultDashboard;
      await firewallModule.installRequestFirewall({
        context: dashboard.authContext as never,
        firstPartyOrigin: dashboard.baseUrl,
        currentToken: () => null,
      });
      dashboard.firewallInstalled = true;
    },
    async warmup(): Promise<void> {
      // collectRunSamples owns the discarded warmup; this phase pins its place
      // before collection and remains an explicit sequencing seam for tests.
    },
    async collect(runConfig, value): Promise<unknown> {
      const dashboard = value as DefaultDashboard;
      if (!dashboard.firewallInstalled || dashboard.storageState === null) {
        throw new Error('unexpected_failure');
      }
      activeLifecycle?.assertAlive();
      const requests: RequestEvidence[] = [];
      const browser = createRealSampleBrowser({
        browser: dashboard.browser as Browser,
        baseUrl: dashboard.baseUrl,
        modules: samplingModules,
      });
      const resolverApi: ResolverApi = {
        async get(path, query): Promise<unknown> {
          const response = await dashboard.authContext.request.get(path, { params: query });
          if (response.status() < 200 || response.status() >= 300) return {};
          try { return await response.json(); } catch { return {}; }
        },
      };
      const selfQaApi = {
        async get(path: string, query?: Readonly<Record<string, string>>): Promise<unknown> {
          const response = await dashboard.authContext.request.get(path, { params: query });
          if (response.status() < 200 || response.status() >= 300) throw new Error('self_qa_snapshot_failed');
          try { return await response.json(); } catch { throw new Error('self_qa_snapshot_failed'); }
        },
      };
      const selectedRoutes = runConfig.selfQa === null
        ? routesModule.ROUTES
        : selfQaModule.routesForSelfQa(runConfig.selfQa, routesModule.ROUTES);
      if (runConfig.selfQa !== null) {
        if (runConfig.target !== 'hermetic' || runConfig.seed === null) throw new Error('self_qa_target_invalid');
        const privateFixtures = seedModule.resolvePerformanceSelfQaFixtures(runConfig.seed);
        selfQaBindings = await selfQaModule.proveSelfQaFixtures(privateFixtures, selfQaApi);
        selfQaBefore = await selfQaModule.reduceSelfQaSnapshot(selfQaBindings, selfQaApi);
      }
      const coldDom: ResolverDom = {
        hasExactLink: async () => true,
        browserNow: async () => new Date(),
      };
      let partialReason: 'browser_failure' | undefined;
      let result: CollectRunSamplesResult;
      try {
        result = await collectModule.collectRunSamples({
          browser,
          storageState: dashboard.storageState,
          target: runConfig.target,
          routes: selectedRoutes,
          coldRepeats: runConfig.coldRepeats,
          warmRepeats: runConfig.warmRepeats,
          routeOrderSeed: runConfig.routeOrderSeed,
          sourceTimeoutMs: runConfig.sourceTimeoutMs,
          ...(runConfig.seed !== null && { expectedRelayLinkCount: runConfig.seed.relayGroupCount }),
          resolveCold: (route) => resolverFor(route, resolverApi, coldDom, routesModule, selfQaBindings),
          resolveWarm: (route, samplePage) => {
            const realPage = samplePage as RealPage;
            const dom: ResolverDom = {
              async hasExactLink(href): Promise<boolean> {
                const link = realPage.rawPage.locator(`a[href="${href}"]`).first();
                try {
                  await link.waitFor({ state: 'visible', timeout: runConfig.sourceTimeoutMs });
                  return true;
                } catch {
                  return false;
                }
              },
              async browserNow(): Promise<Date> {
                return new Date(await realPage.rawPage.evaluate(() => Date.now()));
              },
            };
            return resolverFor(route, resolverApi, dom, routesModule, selfQaBindings);
          },
          instrumentationFor: (route, mode, repeat) => createRealInstrumentation({
            route,
            mode,
            repeat,
            baseUrl: dashboard.baseUrl,
            readyTimeoutMs: runConfig.readyTimeoutMs,
            settleMs: runConfig.settleMs,
            pollMs: runConfig.pollMs,
            modules: samplingModules,
            requests,
          }),
        });
      } catch {
        activeLifecycle?.assertAlive();
        partialReason = 'browser_failure';
        result = {
          samples: [],
          orders: [],
          warmup: runConfig.target === 'hosted-dev'
            ? { performed: false, routeKey: null }
            : { performed: true, routeKey: '/' },
          lowSampleCount: true,
          relayDomCheck: null,
          branches: [],
        };
      }
      activeLifecycle?.assertAlive();
      let selfQa: import('./selfQa.js').SelfQaResult | undefined;
      if (runConfig.selfQa !== null) {
        if (selfQaBindings === undefined || selfQaBefore === undefined) throw new Error('self_qa_fixture_proof_failed');
        const supplementalAttempts = runConfig.selfQa === 'full'
          ? await runSupplementalSelfQaProbes({
              browser: dashboard.browser as Browser,
              baseUrl: dashboard.baseUrl,
              storageState: dashboard.storageState,
              bindings: selfQaBindings,
              firewall: firewallModule,
              selfQa: selfQaModule,
            })
          : [];
        const selfQaAfter = await selfQaModule.reduceSelfQaSnapshot(selfQaBindings, selfQaApi);
        const attempts = [
          ...selfQaModule.attemptsFromSamples(result.samples),
          ...supplementalAttempts,
        ];
        selfQa = selfQaModule.evaluateSelfQa({
          mode: runConfig.selfQa,
          routes: selectedRoutes,
          samples: result.samples,
          requests,
          branches: result.branches,
          attempts,
          stateChecks: selfQaModule.compareSelfQaSnapshots(selfQaBefore, selfQaAfter),
          relayDomCheck: result.relayDomCheck,
          supplementalSampleCount: 0,
          reportProof: {
            privacyScanRequired: true,
            countManifest: runConfig.seed !== null,
            coldRanking: true,
            warmRanking: true,
          },
        });
      }
      return {
        samples: result.samples,
        requests,
        routeOrders: result.orders,
        warmup: result.warmup,
        relayDomCheck: result.relayDomCheck,
        checkpointBranches: result.branches,
        browserVersion: dashboard.browser.version(),
        viewport: collectModule.DESKTOP_CHROME_SAMPLE_CONTEXT.viewport,
        target: dashboard.targetMetadata,
        ...(partialReason !== undefined && { partialReason }),
        ...(selfQa !== undefined && { selfQa }),
      };
    },
    async report(runConfig, collected): Promise<CliReportResult> {
      const value = collected as Record<string, unknown>;
      let baselineJson: string | undefined;
      if (runConfig.baselinePath !== null) {
        const fs = await import('node:fs/promises');
        baselineJson = await fs.readFile(runConfig.baselinePath, 'utf8');
      }
      const result = await reportModule.writePerformanceReport({
        outputRoot: resolve(process.cwd(), 'e2e', '.artifacts', 'performance'),
        config: toSafeRunConfig(runConfig),
        target: value['target'] as never,
        samples: value['samples'] as never[],
        requests: value['requests'] as never[],
        routeOrders: value['routeOrders'] as never[],
        browser: {
          version: value['browserVersion'] as string,
          viewport: value['viewport'] as { width: number; height: number },
        },
        warmup: value['warmup'] as { performed: boolean; routeKey: string | null },
        relayDomCheck: value['relayDomCheck'] as null,
        checkpointBranches: value['checkpointBranches'] as never[],
        ...(value['partialReason'] === 'browser_failure' && { partialReason: 'browser_failure' as const }),
        ...(value['selfQa'] !== undefined && { selfQa: value['selfQa'] as import('./selfQa.js').SelfQaResult }),
        ...(baselineJson !== undefined && { baselineJson }),
      });
      process.stdout.write(`performance_report=${result.directoryName}\n`);
      return result as CliReportResult;
    },
    async closeDashboard(value): Promise<void> {
      const dashboard = value as DefaultDashboard;
      await dashboard.authContext.close().catch(() => undefined);
      await dashboard.browser.close();
    },
    async cleanupHermetic(value): Promise<unknown> {
      return await (value as DefaultLifecycle).cleanup();
    },
    installHermeticSignalHandlers(value): () => void {
      if (lifecycleModule === null) return () => undefined;
      return lifecycleModule.installOwnedLifecycleSignalHandlers(
        value as DefaultLifecycle,
        process,
        (result) => {
          if (result.status === 'cleanup_failed') process.exitCode = 1;
        },
      );
    },
  };
}

const direct = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (direct) void main();
