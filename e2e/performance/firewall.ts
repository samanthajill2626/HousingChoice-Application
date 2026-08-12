import type { BlockedWrite, SampleMode } from './types.js';
import { sanitizeRequestUrl, type SanitizeRequestUrlInput, type SanitizedRequestUrl } from './templates.js';

export const PROFILER_CONTEXT_OPTIONS = Object.freeze({ serviceWorkers: 'block' as const });
export const INTERCEPTED_PATH_PREFIXES = Object.freeze(['/api/', '/auth/', '/__dev/'] as const);
export const NEVER_INTERCEPTED_PATHS = Object.freeze(['/api/events'] as const);

type WriteMethod = BlockedWrite['method'];
type BlockedWritePhase = BlockedWrite['phase'];

export interface FirewallRequestLike {
  method(): string;
  url(): string;
  frame(): { url(): string };
}

export interface FirewallRouteLike {
  request(): FirewallRequestLike;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export type FirewallRoutePredicate = (url: URL) => boolean;
export type FirewallRouteHandler = (route: FirewallRouteLike) => Promise<void>;

export interface FirewallRouteRegistrar {
  route(predicate: FirewallRoutePredicate, handler: FirewallRouteHandler): Promise<void> | void;
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

function isScopedPath(pathname: string): boolean {
  return INTERCEPTED_PATH_PREFIXES.some((prefix) =>
    pathname === prefix.slice(0, -1) || pathname.startsWith(prefix),
  );
}

export function createFirewallRoutePredicate(firstPartyOrigin: string): FirewallRoutePredicate {
  const origin = normalizedOrigin(firstPartyOrigin);
  return (url) =>
    url.origin === origin &&
    isScopedPath(url.pathname) &&
    !NEVER_INTERCEPTED_PATHS.includes(url.pathname as (typeof NEVER_INTERCEPTED_PATHS)[number]);
}

export interface InstallRequestFirewallInput {
  context: FirewallRouteRegistrar;
  firstPartyOrigin: string;
  currentToken: () => FirewallRecordingToken | null;
  sanitize?: (input: SanitizeRequestUrlInput) => SanitizedRequestUrl;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WRITE_METHODS = new Set<WriteMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function installRequestFirewall(input: InstallRequestFirewallInput): Promise<void> {
  const firstPartyOrigin = normalizedOrigin(input.firstPartyOrigin);
  const sanitize = input.sanitize ?? sanitizeRequestUrl;
  await input.context.route(createFirewallRoutePredicate(firstPartyOrigin), async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    if (READ_METHODS.has(method)) {
      await route.continue();
      return;
    }
    if (!WRITE_METHODS.has(method as WriteMethod)) {
      await route.abort('blockedbyclient');
      throw new UnknownFirewallMethodError();
    }

    const token = input.currentToken();
    if (token === null) {
      await route.abort('blockedbyclient');
      return;
    }

    let phase: BlockedWritePhase;
    try {
      phase = token.phaseFor(request.frame().url());
    } catch (error) {
      await route.abort('blockedbyclient');
      throw error;
    }
    const sanitized = sanitize({
      rawUrl: request.url(),
      method,
      firstPartyOrigin,
      resourceType: 'fetch',
    });
    await route.abort('blockedbyclient');
    token.record({
      method: method as WriteMethod,
      endpointTemplate: sanitized.endpointTemplate,
      phase,
    });
  });
}
