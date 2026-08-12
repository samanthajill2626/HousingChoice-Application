import type { EndpointContract } from './routes.js';
import { normalizeCdpOffset, normalizeNodeOffset, type PageStoreSnapshot } from './readiness.js';
import { sanitizeRequestUrl, type EndpointTemplate, type SanitizedRequestUrl } from './templates.js';
import type {
  BlockedWrite,
  RequestEvidence,
  ResourceClass,
  SampleMode,
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
