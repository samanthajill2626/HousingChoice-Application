import { DASHBOARD_MUTATION_CATALOG } from './mutationCatalog.js';
import { INTERCEPTION_SCOPE_VERSION } from './types.js';
import type { BlockedWrite, SampleMode } from './types.js';
import { sanitizeRequestUrl, type SanitizeRequestUrlInput, type SanitizedRequestUrl } from './templates.js';

export { INTERCEPTION_SCOPE_VERSION };

export const PROFILER_CONTEXT_OPTIONS = Object.freeze({ serviceWorkers: 'block' as const });
export const NEVER_INTERCEPTED_PATHS = Object.freeze(['/api/events'] as const);

type WriteMethod = BlockedWrite['method'];
type BlockedWritePhase = BlockedWrite['phase'];

export interface FirewallPausedRequest {
  requestId: string;
  request: { method: string; url: string };
  resourceType?: string;
  frameId?: string;
}

interface FirewallFrameTree {
  frame: { id: string; url: string };
  childFrames?: FirewallFrameTree[];
}

export interface FirewallCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (value: never) => void): this;
  detach(): Promise<void>;
}

export interface FirewallPage {
  url(): string;
  context(): { newCDPSession(page: FirewallPage): Promise<FirewallCdpSession> };
}

export interface FirewallController {
  assertHealthy(): Promise<void>;
  dispose(): Promise<void>;
}

export class FirewallConfigurationError extends Error {
  readonly reason = 'invalid_firewall_configuration';

  constructor() {
    super('invalid_firewall_configuration');
    this.name = 'FirewallConfigurationError';
  }
}

export class FirewallPhaseError extends Error {
  readonly reason = 'unclassified_firewall_phase';

  constructor() {
    super('unclassified_firewall_phase');
    this.name = 'FirewallPhaseError';
  }
}

export class UnknownFirewallMethodError extends Error {
  readonly reason = 'unknown_firewall_method';

  constructor() {
    super('unknown_firewall_method');
    this.name = 'UnknownFirewallMethodError';
  }
}

export class FirewallAttributionError extends Error {
  readonly reason = 'unattributed_blocked_write';

  constructor() {
    super('unattributed_blocked_write');
    this.name = 'FirewallAttributionError';
  }
}

export class FirewallHandlerError extends Error {
  readonly reason = 'firewall_handler_failed';

  constructor() {
    super('firewall_handler_failed');
    this.name = 'FirewallHandlerError';
  }
}

export type FirewallRecordingTokenInput =
  | {
      mode: 'cold';
      firstPartyOrigin: string;
      destinationPageUrl: string;
    }
  | {
      mode: 'warm';
      firstPartyOrigin: string;
      sourcePageUrl: string;
      destinationPageUrl: string;
      noNavigationProbe?: boolean;
    };

function normalizedOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new FirewallConfigurationError();
  }
}

function sanitizedPageKey(rawUrl: string, firstPartyOrigin: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FirewallPhaseError();
  }
  if (url.origin !== firstPartyOrigin) throw new FirewallPhaseError();
  const queryKeys = [...new Set(url.searchParams.keys())].sort((left, right) => left.localeCompare(right));
  return `${url.pathname}${queryKeys.length > 0 ? `?${queryKeys.join('&')}` : ''}`;
}

export class FirewallRecordingToken {
  readonly mode: SampleMode;
  readonly #firstPartyOrigin: string;
  readonly #sourcePageKey: string | null;
  readonly #destinationPageKey: string;
  readonly #noNavigationProbe: boolean;
  readonly #blockedWrites: BlockedWrite[] = [];

  constructor(input: FirewallRecordingTokenInput) {
    this.mode = input.mode;
    this.#firstPartyOrigin = normalizedOrigin(input.firstPartyOrigin);
    this.#destinationPageKey = sanitizedPageKey(input.destinationPageUrl, this.#firstPartyOrigin);
    this.#sourcePageKey = input.mode === 'warm'
      ? sanitizedPageKey(input.sourcePageUrl, this.#firstPartyOrigin)
      : null;
    this.#noNavigationProbe = input.mode === 'warm' && input.noNavigationProbe === true;
    if (input.mode === 'warm') {
      const samePage = this.#sourcePageKey === this.#destinationPageKey;
      if (samePage !== this.#noNavigationProbe) throw new FirewallConfigurationError();
    }
  }

  phaseFor(frameUrl: string): BlockedWritePhase {
    if (this.mode === 'cold') return 'destination_mount';
    const framePageKey = sanitizedPageKey(frameUrl, this.#firstPartyOrigin);
    if (framePageKey !== this.#sourcePageKey && framePageKey !== this.#destinationPageKey) {
      throw new FirewallPhaseError();
    }
    if (this.#noNavigationProbe) return 'source_click';
    return framePageKey === this.#sourcePageKey ? 'source_click' : 'destination_mount';
  }

  record(write: BlockedWrite): void {
    this.#blockedWrites.push(Object.freeze({ ...write }));
  }

  evidence(): BlockedWrite[] {
    return this.#blockedWrites.map((write) => ({ ...write }));
  }
}

export function createFirewallRecordingToken(input: FirewallRecordingTokenInput): FirewallRecordingToken {
  return new FirewallRecordingToken(input);
}

function firstPartyMutationPaths(): string[] {
  return [...new Set(DASHBOARD_MUTATION_CATALOG
    .map((entry) => entry.pathCategory)
    .filter((path) => path.startsWith('/api/') || path.startsWith('/auth/') || path.startsWith('/__dev/')))]
    .filter((path) => !NEVER_INTERCEPTED_PATHS.includes(path as never))
    .sort();
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function pathTemplateRegex(template: string): RegExp {
  const pattern = template.split('/').map((segment) =>
    segment.startsWith(':') ? '[^/]+' : escapedRegex(segment)).join('/');
  return new RegExp(`^${pattern}$`, 'u');
}

const MUTATION_PATHS = firstPartyMutationPaths();
const MUTATION_PATH_REGEXES = MUTATION_PATHS.map(pathTemplateRegex);

function pathToFetchPatterns(origin: string, path: string): string[] {
  if (path.includes('/:')) return [`${origin}${path.replace(/:[A-Za-z][A-Za-z0-9]*/gu, '*')}`];
  return [`${origin}${path}`, `${origin}${path}?*`];
}

export function firewallRequestPatterns(firstPartyOrigin: string): string[] {
  const origin = normalizedOrigin(firstPartyOrigin);
  return [...new Set(MUTATION_PATHS.flatMap((path) => pathToFetchPatterns(origin, path)))].sort();
}

export function isFirewallScopedUrl(rawUrl: string, firstPartyOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.origin === normalizedOrigin(firstPartyOrigin)
    && !NEVER_INTERCEPTED_PATHS.includes(url.pathname as never)
    && MUTATION_PATH_REGEXES.some((pattern) => pattern.test(url.pathname));
}

export function isCatalogPathIntercepted(pathCategory: string): boolean {
  return MUTATION_PATHS.includes(pathCategory);
}

export interface InstallRequestFirewallInput {
  page: FirewallPage;
  firstPartyOrigin: string;
  currentToken: () => FirewallRecordingToken | null;
  sanitize?: (input: SanitizeRequestUrlInput) => SanitizedRequestUrl;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WRITE_METHODS = new Set<WriteMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function installRequestFirewall(input: InstallRequestFirewallInput): Promise<FirewallController> {
  const firstPartyOrigin = normalizedOrigin(input.firstPartyOrigin);
  const sanitize = input.sanitize ?? sanitizeRequestUrl;
  const session = await input.page.context().newCDPSession(input.page);
  let disposed = false;
  let failure: Error | null = null;
  let failureObserved = false;
  const pending = new Set<Promise<void>>();
  const frameUrls = new Map<string, string>();
  const latch = (error: unknown): void => {
    if (disposed || failure !== null) return;
    failure = error instanceof FirewallPhaseError
      || error instanceof UnknownFirewallMethodError
      || error instanceof FirewallAttributionError
      ? error
      : new FirewallHandlerError();
  };

  const handle = async (event: FirewallPausedRequest): Promise<void> => {
    const method = event.request.method.toUpperCase();
    if (!isFirewallScopedUrl(event.request.url, firstPartyOrigin)) {
      await session.send('Fetch.continueRequest', { requestId: event.requestId });
      return;
    }
    if (READ_METHODS.has(method)) {
      await session.send('Fetch.continueRequest', { requestId: event.requestId });
      return;
    }
    await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
    if (!WRITE_METHODS.has(method as WriteMethod)) {
      latch(new UnknownFirewallMethodError());
      return;
    }
    const token = input.currentToken();
    if (token === null) {
      latch(new FirewallAttributionError());
      return;
    }
    let phase: BlockedWritePhase;
    try {
      phase = token.phaseFor(
        event.frameId === undefined
          ? input.page.url()
          : frameUrls.get(event.frameId) ?? input.page.url(),
      );
    } catch (error) {
      latch(error);
      return;
    }
    const sanitized = sanitize({
      rawUrl: event.request.url,
      method,
      firstPartyOrigin,
      resourceType: event.resourceType ?? 'Fetch',
    });
    token.record({ method: method as WriteMethod, endpointTemplate: sanitized.endpointTemplate, phase });
  };

  session.on('Fetch.requestPaused', (value) => {
    const task = handle(value as FirewallPausedRequest).catch(latch).finally(() => pending.delete(task));
    pending.add(task);
  });
  session.on('Page.frameNavigated', (value) => {
    const event = value as unknown as { frame?: { id?: string; url?: string } };
    if (typeof event.frame?.id === 'string' && typeof event.frame.url === 'string') {
      frameUrls.set(event.frame.id, event.frame.url);
    }
  });
  session.on('Page.navigatedWithinDocument', (value) => {
    const event = value as unknown as { frameId?: string; url?: string };
    if (typeof event.frameId === 'string' && typeof event.url === 'string') {
      frameUrls.set(event.frameId, event.url);
    }
  });
  session.on('Page.frameDetached', (value) => {
    const event = value as unknown as { frameId?: string };
    if (typeof event.frameId === 'string') frameUrls.delete(event.frameId);
  });
  await session.send('Page.enable');
  const frameTreeResult = await session.send('Page.getFrameTree') as { frameTree?: FirewallFrameTree };
  const rememberFrameTree = (tree: FirewallFrameTree | undefined): void => {
    if (tree === undefined) return;
    frameUrls.set(tree.frame.id, tree.frame.url);
    for (const child of tree.childFrames ?? []) rememberFrameTree(child);
  };
  rememberFrameTree(frameTreeResult.frameTree);
  await session.send('Fetch.enable', {
    patterns: firewallRequestPatterns(firstPartyOrigin).map((urlPattern) => ({ urlPattern })),
  });

  return Object.freeze({
    async assertHealthy(): Promise<void> {
      await Promise.allSettled([...pending]);
      if (failure !== null) {
        failureObserved = true;
        throw failure;
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      await Promise.allSettled([...pending]);
      const unobservedFailure = failureObserved ? null : failure;
      disposed = true;
      await session.send('Fetch.disable').catch(() => undefined);
      await session.send('Page.disable').catch(() => undefined);
      await session.detach().catch(() => undefined);
      if (unobservedFailure !== null) throw unobservedFailure;
    },
  });
}
