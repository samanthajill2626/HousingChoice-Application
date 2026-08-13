import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { exactTargetFromPath } from './routes.js';
import type {
  Browser,
  BrowserContext,
  CDPSession,
  ConsoleMessage,
  Locator,
  Page,
} from '@playwright/test';
import {
  parseProfilerArgs,
  toHermeticReseedPayload,
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
import type { FirewallController, FirewallRecordingToken } from './firewall.js';
import type {
  LocatorContract,
  ExactBrowserTarget,
  ResolverApi,
  ResolverDom,
  ResolverResult,
  RouteDefinition,
  TerminalContract,
} from './routes.js';
import type { BlockedWrite, RequestEvidence, SampleMode, SampleResult, TargetMetadata } from './types.js';
import { terminalAlternativeVisible } from './readiness.js';
import type { PageStoreSnapshot } from './readiness.js';
import type { SelfQaAttempt, SelfQaFixtureBindings, SelfQaSnapshot } from './selfQa.js';
import { allEndpointTemplates } from './templates.js';

const SAFE_FIREWALL_ENDPOINTS = new Set<string>([...allEndpointTemplates(), 'unmatched_api']);

export interface EscapedWriteFailureEvidence {
  reason: 'uncataloged_write_escaped_firewall';
  method: BlockedWrite['method'];
  endpointTemplate: string;
}

export function classifyEscapedWriteFailure(error: unknown): EscapedWriteFailureEvidence | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = error as Record<string, unknown>;
  if (value['reason'] !== 'uncataloged_write_escaped_firewall') return null;
  if (typeof value['evidence'] !== 'object' || value['evidence'] === null) return null;
  const evidence = value['evidence'] as Record<string, unknown>;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(evidence['method']))) return null;
  if (typeof evidence['endpointTemplate'] !== 'string'
    || !SAFE_FIREWALL_ENDPOINTS.has(evidence['endpointTemplate'])) return null;
  return {
    reason: 'uncataloged_write_escaped_firewall',
    method: evidence['method'] as BlockedWrite['method'],
    endpointTemplate: evidence['endpointTemplate'],
  };
}

export function performanceArtifactRoot(moduleUrl = import.meta.url): string {
  const repoRoot = resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
  return resolve(repoRoot, 'e2e', '.artifacts', 'performance');
}

export interface CliReportResult {
  exitCode: number;
  status: string;
  directoryName?: string;
  files?: string[];
  reasonCategories?: string[];
}

export interface CliRuntime {
  startHermetic(config: RunConfig, signal?: AbortSignal): Promise<unknown>;
  verifyHermetic(config: RunConfig, lifecycle: unknown): Promise<void>;
  reseedHermetic(config: RunConfig, lifecycle: unknown): Promise<void>;
  verifyLocal(config: RunConfig): Promise<void>;
  openDashboard(config: RunConfig, lifecycle?: unknown): Promise<unknown>;
  authenticateHermetic(config: RunConfig, dashboard: unknown): Promise<unknown>;
  authenticateLocal(config: RunConfig, dashboard: unknown): Promise<unknown>;
  authenticateHosted(config: RunConfig, dashboard: unknown): Promise<unknown>;
  warmup(config: RunConfig, dashboard: unknown, auth: unknown): Promise<void>;
  collect(config: RunConfig, dashboard: unknown, auth: unknown, signal?: AbortSignal): Promise<unknown>;
  report(config: RunConfig, collected: unknown, signal?: AbortSignal): Promise<CliReportResult>;
  closeDashboard(dashboard: unknown): Promise<void>;
  cleanupHermetic(lifecycle: unknown): Promise<unknown>;
  installHermeticSignalHandlers?(lifecycle: unknown): () => void;
}

export interface RunProfilerDeps {
  loadRuntime?: (config: RunConfig) => Promise<CliRuntime>;
  configDeps?: ParseRunConfigDeps;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  processEvents?: ProfilerProcessEventSource;
  stdinIsTTY?: boolean;
  forceExit?: (code: number) => void;
  forceExitGraceMs?: number;
}

export interface ProfilerProcessEventSource {
  on(event: 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection', listener: (...args: unknown[]) => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection', listener: (...args: unknown[]) => void): unknown;
}

export function installProfilerProcessHandlers(
  controller: AbortController,
  source: ProfilerProcessEventSource = process,
  options: { onForceExitRequested?: () => void } = {},
): () => void {
  let terminationSignalCount = 0;
  const handleSignal = (): void => {
    terminationSignalCount += 1;
    if (terminationSignalCount > 1) {
      options.onForceExitRequested?.();
      return;
    }
    if (!controller.signal.aborted) controller.abort({ reason: 'interrupted' });
  };
  const handleUncaughtException = (): void => {
    if (!controller.signal.aborted) controller.abort({ reason: 'crashed' });
    options.onForceExitRequested?.();
  };
  const handleUnhandledRejection = (): void => {
    if (!controller.signal.aborted) controller.abort({ reason: 'crashed' });
  };
  for (const event of ['SIGINT', 'SIGTERM'] as const) source.on(event, handleSignal);
  source.on('uncaughtException', handleUncaughtException);
  source.on('unhandledRejection', handleUnhandledRejection);
  return () => {
    for (const event of ['SIGINT', 'SIGTERM'] as const) source.off(event, handleSignal);
    source.off('uncaughtException', handleUncaughtException);
    source.off('unhandledRejection', handleUnhandledRejection);
  };
}

async function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  const abortReason = (): { reason: string } => (
    typeof signal.reason === 'object'
    && signal.reason !== null
    && 'reason' in signal.reason
    && typeof signal.reason.reason === 'string'
      ? { reason: signal.reason.reason }
      : { reason: 'interrupted' }
  );
  if (signal.aborted) throw abortReason();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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

function ownerMarkerFailure(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  return candidate['reason'] === 'existing_session_live'
    && candidate['markerPath'] === 'e2e/.artifacts/performance-session.json'
    ? 'existing_session_live marker="e2e/.artifacts/performance-session.json"\n'
    : null;
}

function hermeticSeedCountsLine(config: RunConfig): string | null {
  const seed = toSafeRunConfig(config).seed;
  if (seed === null) return null;
  return `performance_seed_counts=${JSON.stringify(seed)}\n`;
}

function safeTerminalValues(value: unknown, pattern: RegExp): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => (
    typeof entry === 'string' && pattern.test(entry)
  )))].sort();
}

function writeReportOutput(report: CliReportResult, stdout: (text: string) => void): void {
  const directoryName = typeof report.directoryName === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(report.directoryName)
    ? report.directoryName
    : null;
  if (directoryName !== null) stdout(`performance_report=${directoryName}\n`);
  if (report.status !== 'privacy_failure') return;
  const files = safeTerminalValues(report.files, /^[a-z][a-z0-9._-]{0,127}$/u);
  const reasonCategories = safeTerminalValues(report.reasonCategories, /^[a-z][a-z0-9_]{1,63}$/u);
  stdout(`performance_privacy_failure=${JSON.stringify({ files, reasonCategories })}\n`);
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
    const parsed = parseProfilerArgs(argv, deps.configDeps);
    if (parsed.kind === 'help') {
      stdout(parsed.text);
      return 0;
    }
    config = parsed.config;
  } catch {
    stderr('configuration_invalid\n');
    return 1;
  }

  if (config.printConfig) {
    stdout(`${JSON.stringify(toSafeRunConfig(config))}\n`);
    return 0;
  }

  if (config.target === 'local' && (deps.stdinIsTTY ?? process.stdin.isTTY === true) !== true) {
    stderr('local_tty_required\n');
    return 1;
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
  const abortController = new AbortController();
  let forceExitRequested = false;
  let forceExitIssued = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;
  const forceExit = deps.forceExit ?? ((code: number) => process.exit(code));
  const forceExitGraceMs = Number.isSafeInteger(deps.forceExitGraceMs)
    && (deps.forceExitGraceMs ?? 0) >= 0
    ? deps.forceExitGraceMs!
    : 15_000;
  const issueForceExit = (): void => {
    if (forceExitIssued) return;
    forceExitIssued = true;
    forceExit(1);
  };
  const requestForceExit = (): void => {
    forceExitRequested = true;
    forceExitTimer ??= setTimeout(issueForceExit, forceExitGraceMs);
  };
  const detachFatalHandlers = installProfilerProcessHandlers(
    abortController,
    deps.processEvents ?? process,
    { onForceExitRequested: requestForceExit },
  );
  let fatalHandlersDetached = false;
  const finishFatalHandlers = (): void => {
    if (!fatalHandlersDetached) {
      fatalHandlersDetached = true;
      detachFatalHandlers();
    }
    if (forceExitTimer !== null) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
    if (forceExitRequested) issueForceExit();
  };
  const signal = abortController.signal;

  if (config.target === 'hermetic') {
    let lifecycle: unknown;
    try {
      lifecycle = await abortable(signal, () => runtime.startHermetic(config, signal));
    } catch (error) {
      const failure = cleanupFailure(error);
      const markerFailure = ownerMarkerFailure(error);
      if (markerFailure !== null) {
        stderr(markerFailure);
      } else if (failure !== null) {
        stderr(`cleanup_failed lane=${failure.lane} recovery="${failure.recoveryCommand}"\n`);
      } else {
        stderr(`${closedReason(error)}\n`);
      }
      finishFatalHandlers();
      return 1;
    }

    const detachSignals = runtime.installHermeticSignalHandlers?.(lifecycle);
    let dashboard: unknown;
    let exitCode = 1;
    try {
      await abortable(signal, () => runtime.verifyHermetic(config, lifecycle));
      await abortable(signal, () => runtime.reseedHermetic(config, lifecycle));
      dashboard = await abortable(signal, () => runtime.openDashboard(config, lifecycle));
      const auth = await abortable(signal, () => runtime.authenticateHermetic(config, dashboard));
      await abortable(signal, () => runtime.warmup(config, dashboard, auth));
      const collected = await abortable(signal, () => runtime.collect(config, dashboard, auth, signal));
      const report = await abortable(signal, () => runtime.report(config, collected, signal));
      writeReportOutput(report, stdout);
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
      finishFatalHandlers();
    }
    return exitCode;
  }

  let dashboard: unknown;
  try {
    if (config.target === 'local') await abortable(signal, () => runtime.verifyLocal(config));
    dashboard = await abortable(signal, () => runtime.openDashboard(config));
    const auth = config.target === 'local'
      ? await abortable(signal, () => runtime.authenticateLocal(config, dashboard))
      : await abortable(signal, () => runtime.authenticateHosted(config, dashboard));
    if (config.target === 'local') await abortable(signal, () => runtime.warmup(config, dashboard, auth));
    const collected = await abortable(signal, () => runtime.collect(config, dashboard, auth, signal));
    const report = await abortable(signal, () => runtime.report(config, collected, signal));
    writeReportOutput(report, stdout);
    return report.exitCode === 0 ? 0 : 1;
  } catch (error) {
    stderr(`${closedReason(error)}\n`);
    return 1;
  } finally {
    if (dashboard !== undefined) await closeQuietly(runtime, dashboard);
    finishFatalHandlers();
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

export async function runDirectMain(
  argv: string[] = process.argv.slice(2),
  deps: MainDeps = {},
): Promise<void> {
  try {
    await main(argv, deps);
  } catch {
    (deps.processLike ?? process).exitCode = 1;
    try {
      (deps.stderr ?? ((text: string) => process.stderr.write(text)))('crashed\n');
    } catch {
      // A closed terminal pipe must not turn the nonzero exit into another crash.
    }
  }
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
    ...(contract.selected !== undefined && { selected: contract.selected }),
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

async function terminalStateFor(
  page: Page,
  terminal: TerminalContract,
  selected?: LocatorContract,
): Promise<SampleResult['terminalState']> {
  if (await groupVisible(page, terminal.error, 'any')) return 'error';
  const [populated, empty, selectionSatisfied] = await Promise.all([
    terminalAlternativeVisible(
    terminal.populatedAlternatives,
    (contract) => visible(page, contract),
    ),
    terminalAlternativeVisible(
    terminal.emptyAlternatives,
    (contract) => visible(page, contract),
    ),
    selected === undefined ? Promise.resolve(true) : visible(page, selected),
  ]);
  if (!selectionSatisfied) return 'unknown';
  if (populated && empty) return 'contradictory_terminal';
  if (populated) return 'populated';
  if (empty) return 'empty';
  return 'unknown';
}

async function terminalState(page: Page, route: RouteDefinition): Promise<SampleResult['terminalState']> {
  const selected = route.source.action.kind === 'tab'
    ? { role: 'tab', name: route.source.action.name, exactness: 'exact' as const, selected: true as const }
    : undefined;
  return terminalStateFor(page, route.terminal, selected);
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
  readonly firewall: FirewallController;
  readonly baseUrl: string;
}

function absoluteUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).href;
}

export function targetPath(target: ExactBrowserTarget): string {
  const query = target.query.kind === 'absent'
    ? ''
    : `?${new URLSearchParams(Object.entries(target.query.values).sort(([left], [right]) => left.localeCompare(right))).toString()}`;
  return `${target.path}${query}`;
}

export function exactTargetMatches(url: string, target: ExactBrowserTarget): boolean {
  try {
    const current = new URL(url);
    const expected = new URL(targetPath(target), 'http://target.invalid');
    const currentEntries = [...current.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    const expectedEntries = [...expected.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    return current.pathname === expected.pathname
      && currentEntries.length === expectedEntries.length
      && currentEntries.every(([key, value], index) => key === expectedEntries[index]?.[0] && value === expectedEntries[index]?.[1]);
  } catch {
    return false;
  }
}

export function createRealSamplePage(input: {
  page: Page;
  context: BrowserContext;
  contextState: { token: FirewallRecordingToken | null };
  firewall: FirewallController;
  baseUrl: string;
  pageStoreInstaller: typeof import('./readiness.js')['pageStoreInstaller'];
}): RealPage {
  let firstSource = true;
  const targetNow = (target: ExactBrowserTarget): boolean => exactTargetMatches(input.page.url(), target);
  return {
    rawPage: input.page,
    contextState: input.contextState,
    firewall: input.firewall,
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
      const sourcePath = targetPath(route.source.target);
      if (firstSource || input.page.url() === '') {
        firstSource = false;
        await input.page.goto(absoluteUrl(input.baseUrl, sourcePath));
        return;
      }
      if (targetNow(route.source.target)) return;
      const exactLink = input.page.locator(`a[href="${sourcePath}"]`).first();
      if (await exactLink.count() > 0 && await exactLink.isVisible()) {
        await exactLink.click();
        return;
      }
      // Source preparation is outside the measured token. A direct source load
      // is the bounded fallback when the current route exposes no path to the
      // declared source; the destination click remains an in-app exact-href click.
      await input.page.goto(absoluteUrl(input.baseUrl, sourcePath));
    },
    async waitForSourceReady(route, timeoutMs): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        const sourceTerminal = route.source.sourceTerminal === undefined
          ? 'populated'
          : await terminalStateFor(input.page, route.source.sourceTerminal, route.source.sourceSelected);
        if (targetNow(route.source.target) && await visible(input.page, route.source.ready)
          && (sourceTerminal === 'populated' || sourceTerminal === 'empty')) return true;
        await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 100));
      }
      return false;
    },
    async activateWarmAction(route, destinationTarget): Promise<boolean> {
      if (route.source.action.kind === 'tab') {
        const tab = input.page.getByRole('tab', { name: route.source.action.name, exact: true });
        if (await tab.count() === 0 || !await tab.first().isVisible()) return false;
        await tab.first().click();
      } else {
        const destinationPath = targetPath(destinationTarget);
        const link = input.page.locator(`a[href="${destinationPath}"]`).first();
        if (await link.count() === 0 || !await link.isVisible()) return false;
        await link.click();
      }
      const deadline = Date.now() + 3_000;
      while (Date.now() <= deadline) {
        if (targetNow(destinationTarget)) return true;
        await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 25));
      }
      return false;
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

export function createRealSampleBrowser(input: {
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
      const firewalls: FirewallController[] = [];
      return {
        async installBasePageStore(): Promise<void> {
          await input.modules.readiness.installPageStoreInitScript(context as never);
        },
        async newPage(): Promise<SamplePage> {
          const page = await context.newPage();
          const firewall = await input.modules.firewall.installRequestFirewall({
            page: page as never,
            firstPartyOrigin: input.baseUrl,
            currentToken: () => contextState.token,
          });
          firewalls.push(firewall);
          return createRealSamplePage({
            page,
            context,
            contextState,
            firewall,
            baseUrl: input.baseUrl,
            pageStoreInstaller: input.modules.readiness.pageStoreInstaller,
          });
        },
        async close(): Promise<BlockedWrite[]> {
          const trailingWrites: BlockedWrite[] = [];
          try {
            await Promise.all(firewalls.map(async (firewall) => {
              await firewall.dispose();
              trailingWrites.push(...firewall.drainOutOfSampleEvidence());
            }));
          } finally {
            await context.close();
          }
          return trailingWrites;
        },
      };
    },
  };
}

export async function captureCdpClockAlignment(
  session: Pick<CDPSession, 'send'>,
  now: () => number = () => performance.now(),
): Promise<{ cdpOriginSeconds: number; nodeOriginMs: number }> {
  await session.send('Performance.enable');
  const beforeMs = now();
  const result = await session.send('Performance.getMetrics') as {
    metrics?: Array<{ name: string; value: number }>;
  };
  const afterMs = now();
  return {
    cdpOriginSeconds: result.metrics?.find((metric) => metric.name === 'Timestamp')?.value ?? 0,
    nodeOriginMs: beforeMs + ((afterMs - beforeMs) / 2),
  };
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
      await page.firewall.assertHealthy();
      begin.onOutOfSampleWrites?.(page.firewall.drainOutOfSampleEvidence());
      adaptersActive = true;
      token = begin.token;
      destinationPath = begin.destinationPageUrl;
      collector = new input.modules.collect.NetworkCollector({
        firstPartyOrigin: input.baseUrl,
        surfaceId: input.route.surfaceId,
        behaviorFamily: input.route.behaviorFamily,
        mode: input.mode,
        repeat: input.repeat,
        expectedGets: input.modules.routes.expectedGets(input.route, input.mode, begin.branch),
      });
      cdp = await page.rawPage.context().newCDPSession(page.rawPage);
      cdp.on('Network.requestWillBeSent', (event) => collector?.requestWillBeSent(token, event as never));
      cdp.on('Network.responseReceived', (event) => collector?.responseReceived(token, event as never));
      cdp.on('Network.loadingFinished', (event) => collector?.loadingFinished(token, event as never));
      cdp.on('Network.loadingFailed', (event) => collector?.loadingFailed(token, event as never));
      await cdp.send('Network.enable');
      const alignment = await captureCdpClockAlignment(cdp);
      nodeOriginMs = alignment.nodeOriginMs;
      collector.beginSample({
        token,
        cdpOriginSeconds: alignment.cdpOriginSeconds,
        nodeOriginMs,
      });
      consoleListener = (message) => {
        const level = message.type() === 'error' ? 'error' : message.type() === 'warning' ? 'warning' : null;
        if (level !== null) collector?.noteConsole(token, level, message.text(), performance.now());
      };
      page.rawPage.on('console', consoleListener);
      const recordingToken = input.modules.firewall.createFirewallRecordingToken(
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
      page.contextState.token = recordingToken;
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
              await page!.firewall.assertHealthy({ settle: false });
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
        await page.firewall.assertHealthy();
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
          surfaceId: input.route.surfaceId,
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
          surfaceEvidence: null,
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
    route.surfaceId === '/contacts/:contactId'
    || route.surfaceId === '/conversations/:conversationId'
    || route.surfaceId === '/tours/:tourId'
    || route.surfaceId === '/placements/:placementId'
  )) {
    return routes.resolveBoundSelfQaDetail(route.surfaceId, selfQaBindings, dom);
  }
  switch (route.resolver) {
    case 'static':
      if (route.coldTarget.kind !== 'static') throw new Error('static_cold_target_required');
      return Promise.resolve({
        kind: 'resolved',
        coldPath: route.coldTarget.path,
        warmTarget: exactTargetFromPath(route.coldTarget.path),
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
  ownerToken: string;
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
}): Promise<{ attempts: SelfQaAttempt[]; outOfSampleWrites: BlockedWrite[] }> {
  const attempts: SelfQaAttempt[] = [];
  const outOfSampleWrites: BlockedWrite[] = [];
  const context = await input.browser.newContext({
    baseURL: input.baseUrl,
    storageState: input.storageState as never,
    serviceWorkers: 'block',
  });
  const state = { token: null as FirewallRecordingToken | null };
  const page = await context.newPage();
  const firewall = await input.firewall.installRequestFirewall({
    page: page as never,
    firstPartyOrigin: input.baseUrl,
    currentToken: () => state.token,
  });
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
    outOfSampleWrites.push(...firewall.drainOutOfSampleEvidence());
    await link.click();
    await page.waitForURL((url) => url.pathname === href, { timeout: 120_000 });
    await page.waitForTimeout(750);
    await firewall.assertHealthy();
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
    outOfSampleWrites.push(...firewall.drainOutOfSampleEvidence());
    await expand.click();
    await page.waitForTimeout(750);
    await firewall.assertHealthy();
    attempts.push(...input.selfQa.supplementalAttempts('unmatched_email', state.token.evidence()));
  } finally {
    state.token = null;
    try {
      await firewall.dispose();
      outOfSampleWrites.push(...firewall.drainOutOfSampleEvidence());
    } finally {
      await context.close();
    }
  }
  return { attempts, outOfSampleWrites };
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
    async startHermetic(_runConfig, signal): Promise<DefaultLifecycle> {
      if (lifecycleModule === null) throw new Error('unexpected_failure');
      activeLifecycle = await lifecycleModule.startOwnedHermeticLifecycle({ signal }) as DefaultLifecycle;
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
        expectedOwnerToken: lifecycle.ownerToken,
      });
    },
    async reseedHermetic(runConfig, owned): Promise<void> {
      const lifecycle = owned as DefaultLifecycle;
      lifecycle.assertAlive();
      if (runConfig.seed === null) throw new Error('unexpected_failure');
      const payload = toHermeticReseedPayload(runConfig);
      const timeoutMs = Math.max(120_000, Math.min(3_600_000, 120_000 + runConfig.seed.totalItemCount * 20));
      const response = await fetch(`${lifecycle.appBaseUrl}/__dev/performance/reseed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
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
    async warmup(): Promise<void> {
      // collectRunSamples owns the discarded warmup; this phase pins its place
      // before collection and remains an explicit sequencing seam for tests.
    },
    async collect(runConfig, value, _auth, signal): Promise<unknown> {
      const dashboard = value as DefaultDashboard;
      if (dashboard.storageState === null) {
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
      let partialReason: 'browser_failure' | 'uncataloged_write_escaped_firewall' | undefined;
      let safetyFailure: EscapedWriteFailureEvidence | undefined;
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
          signal,
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
      } catch (error) {
        activeLifecycle?.assertAlive();
        const escaped = classifyEscapedWriteFailure(error);
        if (escaped !== null) {
          partialReason = escaped.reason;
          safetyFailure = escaped;
        } else {
          if (firewallModule.isFirewallSafetyError(error)) throw error;
          partialReason = 'browser_failure';
        }
        result = {
          samples: [],
          orders: [],
          warmup: runConfig.target === 'hosted-dev'
            ? { performed: false, surfaceId: null }
            : { performed: true, surfaceId: '/' },
          lowSampleCount: true,
          relayDomCheck: null,
          branches: [],
          outOfSampleWrites: [],
        };
      }
      activeLifecycle?.assertAlive();
      let selfQa: import('./selfQa.js').SelfQaResult | undefined;
      if (runConfig.selfQa !== null) {
        if (selfQaBindings === undefined || selfQaBefore === undefined) throw new Error('self_qa_fixture_proof_failed');
        let supplemental = { attempts: [] as SelfQaAttempt[], outOfSampleWrites: [] as BlockedWrite[] };
        if (runConfig.selfQa === 'full') {
          try {
            supplemental = await runSupplementalSelfQaProbes({
              browser: dashboard.browser as Browser,
              baseUrl: dashboard.baseUrl,
              storageState: dashboard.storageState,
              bindings: selfQaBindings,
              firewall: firewallModule,
              selfQa: selfQaModule,
            });
          } catch (error) {
            const escaped = classifyEscapedWriteFailure(error);
            if (escaped === null) throw error;
            partialReason = escaped.reason;
            safetyFailure = escaped;
          }
        }
        result.outOfSampleWrites.push(...supplemental.outOfSampleWrites);
        const selfQaAfter = await selfQaModule.reduceSelfQaSnapshot(selfQaBindings, selfQaApi);
        const attempts = [
          ...selfQaModule.attemptsFromSamples(result.samples),
          ...supplemental.attempts,
        ];
        selfQa = selfQaModule.evaluateSelfQa({
          mode: runConfig.selfQa,
          routes: selectedRoutes,
          samples: result.samples,
          requests,
          branches: result.branches,
          attempts,
          outOfSampleWrites: result.outOfSampleWrites,
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
        outOfSampleWrites: result.outOfSampleWrites,
        browserVersion: dashboard.browser.version(),
        viewport: collectModule.DESKTOP_CHROME_SAMPLE_CONTEXT.viewport,
        target: dashboard.targetMetadata,
        ...(partialReason !== undefined && { partialReason }),
        ...(safetyFailure !== undefined && { safetyFailure }),
        ...(selfQa !== undefined && { selfQa }),
      };
    },
    async report(runConfig, collected, signal): Promise<CliReportResult> {
      const value = collected as Record<string, unknown>;
      let baselineJson: string | undefined;
      if (runConfig.baselinePath !== null) {
        const fs = await import('node:fs/promises');
        baselineJson = await fs.readFile(runConfig.baselinePath, 'utf8');
      }
      const result = await reportModule.writePerformanceReport({
        outputRoot: performanceArtifactRoot(),
        config: toSafeRunConfig(runConfig),
        target: value['target'] as never,
        samples: value['samples'] as never[],
        requests: value['requests'] as never[],
        routeOrders: value['routeOrders'] as never[],
        browser: {
          version: value['browserVersion'] as string,
          viewport: value['viewport'] as { width: number; height: number },
        },
        warmup: value['warmup'] as { performed: boolean; surfaceId: string | null },
        relayDomCheck: value['relayDomCheck'] as null,
        checkpointBranches: value['checkpointBranches'] as never[],
        outOfSampleWrites: value['outOfSampleWrites'] as never[],
        ...(value['partialReason'] === 'browser_failure' && { partialReason: 'browser_failure' as const }),
        ...(value['partialReason'] === 'uncataloged_write_escaped_firewall' && {
          partialReason: 'uncataloged_write_escaped_firewall' as const,
        }),
        ...(value['safetyFailure'] !== undefined && { safetyFailure: value['safetyFailure'] as never }),
        ...(value['selfQa'] !== undefined && { selfQa: value['selfQa'] as import('./selfQa.js').SelfQaResult }),
        ...(baselineJson !== undefined && { baselineJson }),
        signal,
      });
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
if (direct) {
  void runDirectMain();
}
