import { randomUUID } from 'node:crypto';
import { devices } from '@playwright/test';
import type { InMemoryStorageState } from './auth.js';
import { PROFILER_CONTEXT_OPTIONS } from './firewall.js';
import {
  ROUTES,
  resolverSkipSampleResult,
  type EndpointContract,
  type ResolverResult,
  type RouteContractBranch,
  type RouteDefinition,
} from './routes.js';
import { normalizeCdpOffset, normalizeNodeOffset, type PageStoreSnapshot } from './readiness.js';
import { sanitizeRequestUrl, type EndpointTemplate, type SanitizedRequestUrl } from './templates.js';
import type {
  BlockedWrite,
  RequestEvidence,
  ResourceClass,
  SampleMode,
  SampleResult,
  TargetKind,
} from './types.js';

export interface BackgroundEndpointShape {
  endpointTemplate: EndpointTemplate;
  queryKeys: readonly string[];
}

export interface BackgroundRefreshDeclaration {
  sourceFingerprint: string;
  trigger: 'timer' | 'sse';
  shapes: readonly BackgroundEndpointShape[];
}

function shape(endpointTemplate: EndpointTemplate, queryKeys: readonly string[] = []): BackgroundEndpointShape {
  return Object.freeze({ endpointTemplate, queryKeys: Object.freeze([...queryKeys].sort()) });
}

// This is deliberately a source fingerprint ledger, not a permissive endpoint
// list. A new timer/subscriber must name its live source before a repeat can be
// removed from the readiness quiet window. The broadcast sending interval is
// absent: the terminal-fixture resolver makes seeing it contract drift.
const BACKGROUND_REFRESH_DECLARATIONS: BackgroundRefreshDeclaration[] = [
  { sourceFingerprint: 'dashboard/src/routes/settings/useSystemStatus.ts:124-132', trigger: 'timer', shapes: [shape('/api/system/alarms')] },
  { sourceFingerprint: 'dashboard/src/routes/tours/RemindersPanel.tsx:188-208', trigger: 'timer', shapes: [shape('/api/tours/:tourId/reminders')] },
  { sourceFingerprint: 'dashboard/src/routes/placements/usePlacementNudges.ts:96-116', trigger: 'timer', shapes: [shape('/api/placements/:placementId/nudges')] },
  {
    sourceFingerprint: 'dashboard/src/app/UnreadContext.tsx:19,52-115', trigger: 'sse',
    shapes: [shape('/api/inbox', ['filter', 'limit']), shape('/api/unmatched-email', ['filter'])],
  },
  { sourceFingerprint: 'dashboard/src/routes/today/useToday.ts:39,126-145', trigger: 'sse', shapes: [shape('/api/today', ['day', 'toursFrom', 'toursTo'])] },
  { sourceFingerprint: 'dashboard/src/routes/inbox/useInbox.ts:49,139-155', trigger: 'sse', shapes: [shape('/api/inbox', ['filter', 'limit'])] },
  { sourceFingerprint: 'dashboard/src/routes/email/useUnmatchedEmail.ts:69,142-158', trigger: 'sse', shapes: [shape('/api/unmatched-email', ['filter'])] },
  {
    sourceFingerprint: 'dashboard/src/routes/shared/useRoster.ts:98-137', trigger: 'sse',
    shapes: [shape('/api/tours/:tourId/roster'), shape('/api/placements/:placementId/roster')],
  },
  { sourceFingerprint: 'dashboard/src/routes/tours/useTourChannels.ts:100,221-241', trigger: 'sse', shapes: [shape('/api/conversations')] },
  { sourceFingerprint: 'dashboard/src/routes/placements/usePlacementChannels.ts:101,229-249', trigger: 'sse', shapes: [shape('/api/conversations')] },
  { sourceFingerprint: 'dashboard/src/routes/contact/useContactTimeline.ts:91,320-337', trigger: 'sse', shapes: [shape('/api/contacts/:contactId/timeline')] },
  { sourceFingerprint: 'dashboard/src/routes/broadcasts/useBroadcastResults.ts:41,120-138', trigger: 'sse', shapes: [shape('/api/broadcasts/:broadcastId/results')] },
];

export const BACKGROUND_REFRESH_GETS: readonly BackgroundRefreshDeclaration[] = Object.freeze(
  BACKGROUND_REFRESH_DECLARATIONS.map((row) => Object.freeze({ ...row, shapes: Object.freeze([...row.shapes]) })),
);

const BACKGROUND_SHAPES = new Set(
  BACKGROUND_REFRESH_GETS.flatMap((declaration) => declaration.shapes.map(contractShape)),
);

const STREAM_PATH = '/api/events';

function contractShape(contract: { endpointTemplate: string; queryKeys: readonly string[] }): string {
  return `${contract.endpointTemplate}?${[...contract.queryKeys].sort().join('&')}`;
}

function isShellRequest(rawUrl: string, sanitized: SanitizedRequestUrl, routeKey: string): boolean {
  const key = contractShape(sanitized);
  if (key === '/api/inbox?filter&limit') {
    try {
      return routeKey !== '/inbox' || new URL(rawUrl).searchParams.get('filter') === 'unread';
    } catch {
      return false;
    }
  }
  if (key === '/api/unmatched-email?filter') {
    return routeKey !== '/email' && routeKey !== '/email/quarantine';
  }
  return false;
}

function resourceClassFor(type: string | undefined, sanitized: SanitizedRequestUrl): ResourceClass {
  if (sanitized.resourceClass !== 'other') return sanitized.resourceClass;
  switch (type?.toLowerCase()) {
    case 'document': return 'document';
    case 'script': return 'script';
    case 'stylesheet': return 'style';
    case 'font': return 'font';
    case 'image': return 'image';
    default: return 'other';
  }
}

export function createEmptyResourceCounts(): Record<ResourceClass, number> {
  return { document: 0, script: 0, style: 0, font: 0, image: 0, api: 0, other: 0 };
}

export type ConsoleCategory = 'client_truncated' | 'warning_other' | 'error_other';

const PAGE_CAP_PREFIXES = Object.freeze([
  'useContacts: page cap (',
  'useListings: page cap (',
  'usePlacements: getPlacements hit the ',
  'usePlacements: getContacts hit the ',
  'usePlacements: getUnits hit the ',
] as const);

export function classifyConsoleMessage(level: 'warning' | 'error', message: string): ConsoleCategory {
  if (level === 'warning' && PAGE_CAP_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return 'client_truncated';
  }
  return level === 'warning' ? 'warning_other' : 'error_other';
}

interface RequestStartEvent {
  requestId: string;
  timestamp: number;
  type?: string;
  request: { method: string; url: string };
}

interface ResponseEvent {
  requestId: string;
  timestamp: number;
  response: { status: number; [key: string]: unknown };
}

interface LoadingFinishedEvent {
  requestId: string;
  timestamp: number;
  encodedDataLength: number;
}

interface LoadingFailedEvent {
  requestId: string;
  timestamp: number;
  canceled?: boolean;
}

interface InFlightRequest {
  rawUrl: string;
  sanitized: SanitizedRequestUrl;
  resourceClass: ResourceClass;
  startSeconds: number;
  startOffsetMs: number;
  role: RequestEvidence['requestRole'];
  trackedPending: boolean;
  forceUnmatched: boolean;
  responseSeconds: number | null;
  status: number | null;
}

export interface NetworkCollectorInput {
  firstPartyOrigin: string;
  routeKey: string;
  mode: SampleMode;
  repeat: number;
  expectedGets: readonly EndpointContract[];
}

export interface BeginNetworkSampleInput {
  token: string;
  cdpOriginSeconds: number;
  nodeOriginMs: number;
}

export interface NetworkCollectorSnapshot {
  pendingCount: number;
  lastQualifyingOffsetMs: number | null;
  requestCount: number;
}

export interface EndedNetworkSample extends NetworkCollectorSnapshot {
  requests: RequestEvidence[];
  resourceCountsByClass: Record<ResourceClass, number>;
  resourceRequestCount: number;
  resourceTransferBytes: number;
  apiRequestCount: number;
  apiTransferBytes: number;
  backgroundRequestCount: number;
  backgroundTransferBytes: number;
  satisfiedRequired: string[];
  consoleCategories: Record<string, number>;
  blockedWrites: BlockedWrite[];
}

export class NetworkCollector {
  readonly #input: NetworkCollectorInput;
  #token: string | null = null;
  #cdpOriginSeconds = 0;
  #nodeOriginMs = 0;
  #inFlight = new Map<string, InFlightRequest>();
  #requests: RequestEvidence[] = [];
  #resourceCounts = createEmptyResourceCounts();
  #resourceTransferBytes = 0;
  #apiTransferBytes = 0;
  #backgroundTransferBytes = 0;
  #apiRequestCount = 0;
  #resourceRequestCount = 0;
  #backgroundRequestCount = 0;
  #lastQualifyingOffsetMs: number | null = null;
  #completedFullUrls = new Set<string>();
  #satisfiedRequired = new Set<string>();
  #terminalVisible = false;
  #consoleCategories: Record<string, number> = {};
  #blockedWrites: BlockedWrite[] = [];
  #expectedShapes: Set<string>;

  constructor(input: NetworkCollectorInput) {
    this.#input = input;
    this.#expectedShapes = new Set(input.expectedGets.map(contractShape));
  }

  beginSample(input: BeginNetworkSampleInput): void {
    this.#token = input.token;
    this.#cdpOriginSeconds = input.cdpOriginSeconds;
    this.#nodeOriginMs = input.nodeOriginMs;
    this.#inFlight.clear();
    this.#requests = [];
    this.#resourceCounts = createEmptyResourceCounts();
    this.#resourceTransferBytes = 0;
    this.#apiTransferBytes = 0;
    this.#backgroundTransferBytes = 0;
    this.#apiRequestCount = 0;
    this.#resourceRequestCount = 0;
    this.#backgroundRequestCount = 0;
    this.#lastQualifyingOffsetMs = null;
    this.#completedFullUrls.clear();
    this.#satisfiedRequired.clear();
    this.#terminalVisible = false;
    this.#consoleCategories = {};
    this.#blockedWrites = [];
  }

  #active(token: string, timestamp: number): number | null {
    if (token !== this.#token) return null;
    return normalizeCdpOffset(timestamp, this.#cdpOriginSeconds);
  }

  #roleFor(rawUrl: string, sanitized: SanitizedRequestUrl): { role: RequestEvidence['requestRole']; forceUnmatched: boolean } {
    const key = contractShape(sanitized);
    const expected = this.#expectedShapes.has(key);
    const completed = this.#completedFullUrls.has(rawUrl);
    if (isShellRequest(rawUrl, sanitized, this.#input.routeKey)) {
      if (expected && !this.#satisfiedRequired.has(key)) return { role: 'required', forceUnmatched: false };
      if (this.#input.mode === 'warm' || completed) return { role: 'background_shell', forceUnmatched: false };
    }
    if (completed && this.#terminalVisible && this.#satisfiedRequired.has(key) && BACKGROUND_SHAPES.has(key)) {
      return { role: 'background_refresh', forceUnmatched: false };
    }
    return { role: 'required', forceUnmatched: completed && !BACKGROUND_SHAPES.has(key) };
  }

  requestWillBeSent(token: string, event: RequestStartEvent): void {
    const startOffsetMs = this.#active(token, event.timestamp);
    if (startOffsetMs === null || event.request.method.toUpperCase() !== 'GET') return;
    let parsed: URL;
    try {
      parsed = new URL(event.request.url);
    } catch {
      return;
    }
    if (parsed.origin === new URL(this.#input.firstPartyOrigin).origin && parsed.pathname === STREAM_PATH) return;

    const sanitized = sanitizeRequestUrl({
      rawUrl: event.request.url,
      method: 'GET',
      firstPartyOrigin: this.#input.firstPartyOrigin,
      resourceType: event.type,
    });
    const resourceClass = resourceClassFor(event.type, sanitized);
    const { role, forceUnmatched } = this.#roleFor(event.request.url, sanitized);
    const firstParty = sanitized.originClass === 'first_party';
    const trackedPending = firstParty && role === 'required';
    this.#resourceCounts[resourceClass] += 1;
    if (role === 'required') {
      this.#resourceRequestCount += 1;
      if (resourceClass === 'api') this.#apiRequestCount += 1;
      if (trackedPending) this.#lastQualifyingOffsetMs = startOffsetMs;
    } else {
      this.#backgroundRequestCount += 1;
    }
    this.#inFlight.set(event.requestId, {
      rawUrl: event.request.url, sanitized, resourceClass, startSeconds: event.timestamp,
      startOffsetMs, role, trackedPending, forceUnmatched, responseSeconds: null, status: null,
    });
  }

  responseReceived(token: string, event: ResponseEvent): void {
    if (this.#active(token, event.timestamp) === null) return;
    const pending = this.#inFlight.get(event.requestId);
    if (pending === undefined) return;
    pending.responseSeconds = event.timestamp;
    pending.status = Number.isFinite(event.response.status) ? event.response.status : null;
  }

  loadingFinished(token: string, event: LoadingFinishedEvent): void {
    this.#finish(token, event.requestId, event.timestamp, 'finished', event.encodedDataLength);
  }

  loadingFailed(token: string, event: LoadingFailedEvent): void {
    this.#finish(token, event.requestId, event.timestamp, event.canceled === true ? 'aborted' : 'failed', null);
  }

  #finish(
    token: string,
    requestId: string,
    timestamp: number,
    outcome: RequestEvidence['outcome'],
    encodedDataLength: number | null,
  ): void {
    const finishOffset = this.#active(token, timestamp);
    if (finishOffset === null) return;
    const pending = this.#inFlight.get(requestId);
    if (pending === undefined) return;
    this.#inFlight.delete(requestId);
    const bytes = encodedDataLength !== null && Number.isFinite(encodedDataLength)
      ? Math.max(0, encodedDataLength)
      : null;
    const key = contractShape(pending.sanitized);
    if (outcome !== 'aborted') {
      this.#completedFullUrls.add(pending.rawUrl);
      if (this.#expectedShapes.has(key)) this.#satisfiedRequired.add(key);
    }
    if (pending.trackedPending) this.#lastQualifyingOffsetMs = finishOffset;
    if (bytes !== null) {
      if (pending.role === 'required') {
        this.#resourceTransferBytes += bytes;
        if (pending.resourceClass === 'api') this.#apiTransferBytes += bytes;
      } else {
        this.#backgroundTransferBytes += bytes;
      }
    }
    this.#requests.push({
      routeKey: this.#input.routeKey,
      mode: this.#input.mode,
      repeat: this.#input.repeat,
      method: 'GET',
      resourceClass: pending.resourceClass,
      originClass: pending.sanitized.originClass,
      endpointTemplate: pending.sanitized.endpointTemplate,
      queryKeys: [...pending.sanitized.queryKeys],
      startOffsetMs: pending.startOffsetMs,
      durationMs: Math.max(0, Math.round((timestamp - pending.startSeconds) * 1_000 * 1_000) / 1_000),
      ttfbMs: pending.responseSeconds === null
        ? null
        : Math.max(0, Math.round((pending.responseSeconds - pending.startSeconds) * 1_000 * 1_000) / 1_000),
      status: pending.status,
      transferBytes: bytes,
      outcome,
      requestRole: pending.role,
      unmatchedApi: pending.sanitized.unmatchedApi || pending.forceUnmatched,
    });
  }

  markTerminalVisible(token: string): void {
    if (token === this.#token) this.#terminalVisible = true;
  }

  noteConsole(token: string, level: 'warning' | 'error', message: string, nodeTimestampMs: number): void {
    if (token !== this.#token || normalizeNodeOffset(nodeTimestampMs, this.#nodeOriginMs) === null) return;
    const category = classifyConsoleMessage(level, message);
    this.#consoleCategories[category] = (this.#consoleCategories[category] ?? 0) + 1;
  }

  noteBlockedWrite(token: string, write: BlockedWrite): void {
    if (token === this.#token) this.#blockedWrites.push({ ...write });
  }

  snapshot(token: string): NetworkCollectorSnapshot {
    if (token !== this.#token) return { pendingCount: 0, lastQualifyingOffsetMs: null, requestCount: 0 };
    let pendingCount = 0;
    for (const pending of this.#inFlight.values()) if (pending.trackedPending) pendingCount += 1;
    return { pendingCount, lastQualifyingOffsetMs: this.#lastQualifyingOffsetMs, requestCount: this.#requests.length };
  }

  endSample(token: string): EndedNetworkSample {
    const snapshot = this.snapshot(token);
    return {
      ...snapshot,
      requests: this.#requests.map((row) => ({ ...row, queryKeys: [...row.queryKeys] })),
      resourceCountsByClass: { ...this.#resourceCounts },
      resourceRequestCount: this.#resourceRequestCount,
      resourceTransferBytes: this.#resourceTransferBytes,
      apiRequestCount: this.#apiRequestCount,
      apiTransferBytes: this.#apiTransferBytes,
      backgroundRequestCount: this.#backgroundRequestCount,
      backgroundTransferBytes: this.#backgroundTransferBytes,
      satisfiedRequired: [...this.#satisfiedRequired].sort(),
      consoleCategories: { ...this.#consoleCategories },
      blockedWrites: this.#blockedWrites.map((write) => ({ ...write })),
    };
  }
}

export interface SummarizePageMetricsInput {
  mode: SampleMode;
  page: PageStoreSnapshot;
  consoleCategories: Record<string, number>;
}

export function summarizePageMetrics(input: SummarizePageMetricsInput): {
  navigation: PageStoreSnapshot['navigation'];
  paint: PageStoreSnapshot['paint'];
  longTasks: PageStoreSnapshot['longTasks'];
  domElements: number | null;
  clientTruncated: boolean;
} {
  const emptyNavigation = { ttfbMs: null, domContentLoadedMs: null, loadMs: null };
  const emptyPaint = { fcpMs: null, lcpMs: null };
  return {
    navigation: input.mode === 'cold' ? { ...input.page.navigation } : emptyNavigation,
    paint: input.mode === 'cold' ? { ...input.page.paint } : emptyPaint,
    longTasks: { ...input.page.longTasks },
    domElements: input.page.domElements,
    clientTruncated: (input.consoleCategories.client_truncated ?? 0) > 0,
  };
}

export interface SamplePage {
  // The adapter registers a next-document init script that calls the shared
  // idempotent page-store installer and begins this token with performance.now().
  installNextDocumentBootstrap(token: string): Promise<void>;
  goto(path: string): Promise<void>;
  // The adapter reaches the declared source inside the existing SPA shell. It
  // may directly load only the first shell; later calls use real accessible
  // navigation and keep this page/context alive.
  prepareWarmSource(route: RouteDefinition): Promise<void>;
  waitForSourceReady(route: RouteDefinition, timeoutMs: number): Promise<boolean>;
  clickExactHref(href: string): Promise<boolean>;
  countRelayConversationLinks(): Promise<number>;
}

export interface SampleBrowserContext {
  // The real adapter installs readiness.pageStoreInstaller on the context.
  installBasePageStore(): Promise<void>;
  newPage(): Promise<SamplePage>;
  close(): Promise<void>;
}

export interface SampleBrowser {
  newContext(options: unknown): Promise<SampleBrowserContext>;
}

export interface BeginProtocolSampleInput {
  page: SamplePage;
  token: string;
  route: RouteDefinition;
  branch: RouteContractBranch;
  mode: SampleMode;
  repeat: number;
  destinationPageUrl: string;
  sourcePageUrl?: string;
}

export interface CollectProtocolSampleInput {
  page: SamplePage;
  token: string;
  route: RouteDefinition;
  branch: RouteContractBranch;
  mode: SampleMode;
  repeat: number;
}

export interface SampleInstrumentation {
  // One call resets page/CDP/Node/firewall state under the same token and
  // captures each collector's native cutoff. The driver never flips a phase.
  beginSample(input: BeginProtocolSampleInput): Promise<void>;
  collectSample(input: CollectProtocolSampleInput): Promise<SampleResult>;
}

export const DESKTOP_CHROME_SAMPLE_CONTEXT = Object.freeze({
  ...devices['Desktop Chrome'],
  ...PROFILER_CONTEXT_OPTIONS,
});

function contextOptions(storageState: InMemoryStorageState): Record<string, unknown> {
  return { ...DESKTOP_CHROME_SAMPLE_CONTEXT, storageState };
}

function normalizeBlockedWriteDependency(result: SampleResult): SampleResult {
  if (result.status !== 'timeout' || result.blockedWrites.length === 0) return result;
  return {
    ...result,
    status: 'blocked_write_dependency',
    reason: 'blocked_write_prevented_ready',
  };
}

export interface CollectColdSampleInput {
  browser: SampleBrowser;
  storageState: InMemoryStorageState;
  route: RouteDefinition;
  repeat: number;
  resolved: ResolverResult;
  instrumentation: SampleInstrumentation;
  token?: string;
}

export async function collectColdSample(input: CollectColdSampleInput): Promise<SampleResult> {
  if (input.resolved.kind === 'skip') {
    return resolverSkipSampleResult(input.route.key, 'cold', input.repeat, input.resolved.reason);
  }

  const token = input.token ?? randomUUID();
  const context = await input.browser.newContext(contextOptions(input.storageState));
  try {
    await context.installBasePageStore();
    const page = await context.newPage();
    await page.installNextDocumentBootstrap(token);
    await input.instrumentation.beginSample({
      page,
      token,
      route: input.route,
      branch: input.resolved.branch,
      mode: 'cold',
      repeat: input.repeat,
      destinationPageUrl: input.resolved.coldPath,
    });
    await page.goto(input.resolved.coldPath);
    const result = await input.instrumentation.collectSample({
      page,
      token,
      route: input.route,
      branch: input.resolved.branch,
      mode: 'cold',
      repeat: input.repeat,
    });
    return normalizeBlockedWriteDependency(result);
  } finally {
    await context.close();
  }
}

export interface CollectWarmSampleInput {
  page: SamplePage;
  route: RouteDefinition;
  repeat: number;
  sourceTimeoutMs: number;
  resolve: () => Promise<ResolverResult>;
  instrumentation: SampleInstrumentation;
  token?: string;
}

export async function collectWarmSample(input: CollectWarmSampleInput): Promise<SampleResult> {
  await input.page.prepareWarmSource(input.route);
  if (!await input.page.waitForSourceReady(input.route, input.sourceTimeoutMs)) {
    return resolverSkipSampleResult(input.route.key, 'warm', input.repeat, 'source_not_ready');
  }

  const resolved = await input.resolve();
  if (resolved.kind === 'skip') {
    return resolverSkipSampleResult(input.route.key, 'warm', input.repeat, resolved.reason);
  }

  const token = input.token ?? randomUUID();
  await input.instrumentation.beginSample({
    page: input.page,
    token,
    route: input.route,
    branch: resolved.branch,
    mode: 'warm',
    repeat: input.repeat,
    sourcePageUrl: input.route.source.path,
    destinationPageUrl: resolved.warmHref,
  });
  if (!await input.page.clickExactHref(resolved.warmHref)) {
    return resolverSkipSampleResult(input.route.key, 'warm', input.repeat, 'fixture_not_navigable');
  }
  const result = await input.instrumentation.collectSample({
    page: input.page,
    token,
    route: input.route,
    branch: resolved.branch,
    mode: 'warm',
    repeat: input.repeat,
  });
  return normalizeBlockedWriteDependency(result);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function deterministicRouteOrder<T>(routes: readonly T[], seed: number): T[] {
  if (!Number.isSafeInteger(seed) || seed <= 0) throw new Error('invalid_route_order_seed');
  const ordered = [...routes];
  const random = seededRandom(seed);
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [ordered[index], ordered[other]] = [ordered[other]!, ordered[index]!];
  }
  return ordered;
}

function rotate<T>(values: readonly T[], repeat: number): T[] {
  if (values.length === 0) return [];
  const offset = repeat % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

export interface SampleOrderRecord {
  mode: SampleMode;
  repeat: number;
  routeKeys: string[];
}

export interface RelayDomCheck {
  expectedCount: number;
  renderedCount: number;
  shortfall: boolean;
}

export interface CollectRunSamplesResult {
  samples: SampleResult[];
  orders: SampleOrderRecord[];
  warmup: { performed: boolean; routeKey: string | null };
  lowSampleCount: boolean;
  relayDomCheck: RelayDomCheck | null;
}

export interface CollectRunSamplesInput {
  browser: SampleBrowser;
  storageState: InMemoryStorageState;
  target: TargetKind;
  routes: readonly RouteDefinition[];
  coldRepeats: number;
  warmRepeats: number;
  routeOrderSeed: number;
  sourceTimeoutMs: number;
  expectedRelayLinkCount?: number;
  resolveCold(route: RouteDefinition): Promise<ResolverResult>;
  resolveWarm(route: RouteDefinition, page: SamplePage): Promise<ResolverResult>;
  instrumentationFor(
    route: RouteDefinition,
    mode: SampleMode,
    repeat: number,
  ): SampleInstrumentation;
  tokenFactory?: (mode: SampleMode, repeat: number, route: RouteDefinition) => string;
}

function assertRepeatCount(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid_repeat_count');
}

export async function collectRunSamples(input: CollectRunSamplesInput): Promise<CollectRunSamplesResult> {
  assertRepeatCount(input.coldRepeats);
  assertRepeatCount(input.warmRepeats);
  if (input.routes.length === 0) throw new Error('empty_route_registry');

  const samples: SampleResult[] = [];
  const orders: SampleOrderRecord[] = [];
  const tokenFor = input.tokenFactory ?? ((mode, repeat, route) => `${mode}-${repeat}-${route.key}-${randomUUID()}`);
  const baseOrder = deterministicRouteOrder(input.routes, input.routeOrderSeed);
  const shouldWarmup = input.target !== 'hosted-dev';

  if (shouldWarmup) {
    const warmupRoute = ROUTES[0]!;
    const resolved = await input.resolveCold(warmupRoute);
    await collectColdSample({
      browser: input.browser,
      storageState: input.storageState,
      route: warmupRoute,
      repeat: -1,
      resolved,
      instrumentation: input.instrumentationFor(warmupRoute, 'cold', -1),
      token: tokenFor('cold', -1, warmupRoute),
    });
  }

  for (let repeat = 0; repeat < input.coldRepeats; repeat += 1) {
    const ordered = rotate(baseOrder, repeat);
    orders.push({ mode: 'cold', repeat, routeKeys: ordered.map((route) => route.key) });
    for (const route of ordered) {
      const resolved = await input.resolveCold(route);
      samples.push(await collectColdSample({
        browser: input.browser,
        storageState: input.storageState,
        route,
        repeat,
        resolved,
        instrumentation: input.instrumentationFor(route, 'cold', repeat),
        token: tokenFor('cold', repeat, route),
      }));
    }
  }

  let relayDomCheck: RelayDomCheck | null = null;
  const warmContext = await input.browser.newContext(contextOptions(input.storageState));
  try {
    await warmContext.installBasePageStore();
    const page = await warmContext.newPage();
    for (let repeat = 0; repeat < input.warmRepeats; repeat += 1) {
      const ordered = rotate(baseOrder, repeat);
      orders.push({ mode: 'warm', repeat, routeKeys: ordered.map((route) => route.key) });
      for (const route of ordered) {
        const result = await collectWarmSample({
          page,
          route,
          repeat,
          sourceTimeoutMs: input.sourceTimeoutMs,
          resolve: () => input.resolveWarm(route, page),
          instrumentation: input.instrumentationFor(route, 'warm', repeat),
          token: tokenFor('warm', repeat, route),
        });
        samples.push(result);
        if (
          input.target === 'hermetic' &&
          input.expectedRelayLinkCount !== undefined &&
          route.key === '/inbox' &&
          result.status === 'ok' &&
          relayDomCheck === null
        ) {
          const renderedCount = await page.countRelayConversationLinks();
          relayDomCheck = {
            expectedCount: input.expectedRelayLinkCount,
            renderedCount,
            shortfall: renderedCount < input.expectedRelayLinkCount,
          };
        }
      }
    }
  } finally {
    await warmContext.close();
  }

  return {
    samples,
    orders,
    warmup: shouldWarmup ? { performed: true, routeKey: '/' } : { performed: false, routeKey: null },
    lowSampleCount: input.coldRepeats < 3 || input.warmRepeats < 3,
    relayDomCheck,
  };
}
