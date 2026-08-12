import { execFile } from 'node:child_process';
import type { TargetKind, TargetMetadata } from './types.js';
import { assertProfilerPingIdentity } from '../../scripts/lib/profilerOwnership.mjs';

export type TargetFailureReason =
  | 'target_base_url_invalid'
  | 'target_scheme_invalid'
  | 'target_headed_required'
  | 'target_ping_failed'
  | 'target_ping_malformed'
  | 'target_ping_not_dev'
  | 'target_prefix_mismatch'
  | 'target_revision_mismatch'
  | 'target_owner_mismatch'
  | 'target_admin_required'
  | 'target_env_not_dev'
  | 'target_reseed_failed';

export class SafeTargetError extends Error {
  readonly target: TargetKind;
  readonly reason: TargetFailureReason;
  readonly statusCode?: number;

  constructor(target: TargetKind, reason: TargetFailureReason, statusCode?: number) {
    super(reason);
    this.name = 'SafeTargetError';
    this.stack = undefined;
    this.target = target;
    this.reason = reason;
    if (statusCode !== undefined) this.statusCode = statusCode;
  }

  toJSON(): { target: TargetKind; reason: TargetFailureReason; statusCode?: number } {
    return {
      target: this.target,
      reason: this.reason,
      ...(this.statusCode !== undefined && { statusCode: this.statusCode }),
    };
  }
}

export interface JsonResponse {
  status: number | (() => number);
  json: () => Promise<unknown>;
}

export type RawFetch = (url: string, init: { method: 'GET' | 'POST'; body?: string }) => Promise<JsonResponse>;
export type DashboardRequest = (
  path: '/auth/me' | '/api/system/flags',
  init: { method: 'GET' },
) => Promise<JsonResponse>;

function statusOf(response: JsonResponse): number {
  return typeof response.status === 'function' ? response.status() : response.status;
}

function safeUrl(target: TargetKind, raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new SafeTargetError(target, 'target_base_url_invalid');
  }
}

function hasCleanBaseShape(url: URL): boolean {
  return (
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
  );
}

export function normalizeTargetBaseUrl(target: 'local' | 'hosted-dev', raw: string): string {
  const url = safeUrl(target, raw);
  if (!hasCleanBaseShape(url)) throw new SafeTargetError(target, 'target_base_url_invalid');
  if (target === 'local') {
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'http:' || url.port !== '5174' || !loopback) {
      throw new SafeTargetError(target, 'target_base_url_invalid');
    }
  } else if (url.protocol !== 'https:') {
    throw new SafeTargetError(target, 'target_scheme_invalid');
  }
  return url.origin;
}

export function normalizeGitRevision(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(normalized) ? normalized : null;
}

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
}

export type GitRevisionRunner = () => Promise<GitCommandResult>;

async function defaultGitRevisionRunner(cwd: string): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd, windowsHide: true }, (error, stdout) => {
      resolve({ ok: error === null, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
}

export async function captureProfilerCommit(
  run: GitRevisionRunner = () => defaultGitRevisionRunner(process.cwd()),
): Promise<string | null> {
  try {
    const result = await run();
    return result.ok ? normalizeGitRevision(result.stdout) : null;
  } catch {
    return null;
  }
}

async function safeJson(target: TargetKind, response: JsonResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SafeTargetError(target, 'target_ping_malformed', statusOf(response));
  }
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function metadata(
  target: TargetKind,
  proof: TargetMetadata['proof'],
  profilerCommit: string | null,
  targetAppCommit: string | null,
  targetVersionStatus: TargetMetadata['targetVersionStatus'],
): TargetMetadata {
  return {
    target,
    proof,
    profilerCommit: normalizeGitRevision(profilerCommit),
    targetAppCommit: normalizeGitRevision(targetAppCommit),
    targetVersionStatus,
  };
}

async function readPing(
  target: 'local' | 'hermetic',
  rawFetch: RawFetch,
  pingUrl: string,
): Promise<Record<string, unknown>> {
  let response: JsonResponse;
  try {
    response = await rawFetch(pingUrl, { method: 'GET' });
  } catch {
    throw new SafeTargetError(target, 'target_ping_failed');
  }
  const status = statusOf(response);
  if (status !== 200) throw new SafeTargetError(target, 'target_ping_failed', status);
  const body = objectBody(await safeJson(target, response));
  if (body === null) throw new SafeTargetError(target, 'target_ping_malformed', status);
  return body;
}

export async function verifyLocalTarget(deps: {
  baseUrl: string;
  rawFetch: RawFetch;
  profilerCommit: string | null;
}): Promise<TargetMetadata> {
  const baseUrl = normalizeTargetBaseUrl('local', deps.baseUrl);
  const body = await readPing('local', deps.rawFetch, `${baseUrl}/__dev/ping`);
  if (body['dev'] !== true) throw new SafeTargetError('local', 'target_ping_not_dev');
  if (body['tablePrefix'] !== 'hc-local-') throw new SafeTargetError('local', 'target_prefix_mismatch');
  const targetAppCommit = normalizeGitRevision(body['appCommit']);
  return metadata(
    'local',
    'local_stack',
    deps.profilerCommit,
    targetAppCommit,
    targetAppCommit === null ? 'unverified' : 'verified',
  );
}

export async function verifyHermeticTarget(deps: {
  appBaseUrl: string;
  rawFetch: RawFetch;
  expectedTablePrefix: string;
  profilerCommit: string | null;
  expectedOwnerToken: string;
}): Promise<TargetMetadata> {
  if (!/^hc-local-[1-9][0-9]*-$/.test(deps.expectedTablePrefix)) {
    throw new SafeTargetError('hermetic', 'target_prefix_mismatch');
  }
  const body = await readPing('hermetic', deps.rawFetch, `${deps.appBaseUrl}/__dev/ping`);
  if (body['dev'] !== true) throw new SafeTargetError('hermetic', 'target_ping_not_dev');
  if (body['tablePrefix'] !== deps.expectedTablePrefix) {
    throw new SafeTargetError('hermetic', 'target_prefix_mismatch');
  }
  const profilerCommit = normalizeGitRevision(deps.profilerCommit);
  let identity: ReturnType<typeof assertProfilerPingIdentity>;
  try {
    identity = assertProfilerPingIdentity({
      expectedCommit: profilerCommit,
      expectedOwnerToken: deps.expectedOwnerToken,
      body,
      allowUnverifiedRevision: true,
    });
  } catch (error) {
    throw new SafeTargetError(
      'hermetic',
      error instanceof Error && error.message === 'profiler_owner_identity_mismatch'
        ? 'target_owner_mismatch'
        : 'target_revision_mismatch',
    );
  }
  return metadata(
    'hermetic',
    'hermetic_lane',
    profilerCommit,
    identity.targetAppCommit,
    identity.targetVersionStatus,
  );
}

async function dashboardJson(
  dashboardRequest: DashboardRequest,
  path: '/auth/me' | '/api/system/flags',
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let response: JsonResponse;
  try {
    response = await dashboardRequest(path, { method: 'GET' });
  } catch {
    throw new SafeTargetError(
      'hosted-dev',
      path === '/auth/me' ? 'target_admin_required' : 'target_env_not_dev',
    );
  }
  const status = statusOf(response);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = null;
  }
  return { status, body: objectBody(value) };
}

export async function verifyHostedTarget(deps: {
  baseUrl: string;
  headed: boolean;
  dashboardRequest: DashboardRequest;
  profilerCommit: string | null;
}): Promise<TargetMetadata> {
  normalizeTargetBaseUrl('hosted-dev', deps.baseUrl);
  if (!deps.headed) throw new SafeTargetError('hosted-dev', 'target_headed_required');
  const me = await dashboardJson(deps.dashboardRequest, '/auth/me');
  if (me.status !== 200 || me.body?.['role'] !== 'admin') {
    throw new SafeTargetError('hosted-dev', 'target_admin_required', me.status);
  }
  const flags = await dashboardJson(deps.dashboardRequest, '/api/system/flags');
  if (flags.status !== 200 || flags.body?.['env'] !== 'dev') {
    throw new SafeTargetError('hosted-dev', 'target_env_not_dev', flags.status);
  }
  return metadata('hosted-dev', 'hosted_dev', deps.profilerCommit, null, 'unverified');
}

export interface RawAppPortTransport {
  ping: () => Promise<JsonResponse>;
  performanceReseed: (body: unknown) => Promise<JsonResponse>;
}

export function createRawAppPortTransport(deps: {
  appBaseUrl: string;
  rawFetch: RawFetch;
}): RawAppPortTransport {
  const pingUrl = `${deps.appBaseUrl}/__dev/ping`;
  const reseedUrl = `${deps.appBaseUrl}/__dev/performance/reseed`;
  return Object.freeze({
    ping: async () => {
      try {
        return await deps.rawFetch(pingUrl, { method: 'GET' });
      } catch {
        throw new SafeTargetError('hermetic', 'target_ping_failed');
      }
    },
    performanceReseed: async (body: unknown) => {
      try {
        return await deps.rawFetch(reseedUrl, { method: 'POST', body: JSON.stringify(body) });
      } catch {
        throw new SafeTargetError('hermetic', 'target_reseed_failed');
      }
    },
  });
}
