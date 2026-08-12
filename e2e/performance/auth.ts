import { normalizeTargetBaseUrl, type JsonResponse } from './targets.js';

export type AuthFailureReason =
  | 'local_tty_required'
  | 'local_confirmation_mismatch'
  | 'local_user_not_found'
  | 'dev_login_failed'
  | 'admin_session_required'
  | 'hosted_headed_required'
  | 'hosted_auth_timeout'
  | 'hosted_admin_required'
  | 'hosted_env_not_dev'
  | 'auth_storage_failed';

export class SafeAuthError extends Error {
  readonly reason: AuthFailureReason;
  readonly statusCode?: number;
  readonly timeoutMs?: number;

  constructor(reason: AuthFailureReason, facts: { statusCode?: number; timeoutMs?: number } = {}) {
    super(reason);
    this.name = 'SafeAuthError';
    this.stack = undefined;
    this.reason = reason;
    if (facts.statusCode !== undefined) this.statusCode = facts.statusCode;
    if (facts.timeoutMs !== undefined) this.timeoutMs = facts.timeoutMs;
  }

  toJSON(): { reason: AuthFailureReason; statusCode?: number; timeoutMs?: number } {
    return {
      reason: this.reason,
      ...(this.statusCode !== undefined && { statusCode: this.statusCode }),
      ...(this.timeoutMs !== undefined && { timeoutMs: this.timeoutMs }),
    };
  }
}

export interface InMemoryStorageState {
  cookies: unknown[];
  origins: unknown[];
}

export interface DashboardRequestOptions {
  method: 'GET' | 'POST';
  data?: Record<string, unknown>;
}

export type AuthDashboardRequest = (
  path: '/auth/dev-login' | '/auth/me' | '/api/system/flags',
  options: DashboardRequestOptions,
) => Promise<JsonResponse>;

export interface AuthResult {
  storageState: InMemoryStorageState;
}

function statusOf(response: JsonResponse): number {
  return typeof response.status === 'function' ? response.status() : response.status;
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function responseBody(response: JsonResponse): Promise<Record<string, unknown> | null> {
  try {
    return objectBody(await response.json());
  } catch {
    return null;
  }
}

async function requestSafely(
  dashboardRequest: AuthDashboardRequest,
  path: '/auth/dev-login' | '/auth/me' | '/api/system/flags',
  options: DashboardRequestOptions,
  failure: AuthFailureReason,
): Promise<JsonResponse> {
  try {
    return await dashboardRequest(path, options);
  } catch {
    throw new SafeAuthError(failure);
  }
}

async function captureStorageState(storageState: () => Promise<InMemoryStorageState>): Promise<AuthResult> {
  try {
    const value = await storageState();
    if (!value || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
      throw new SafeAuthError('auth_storage_failed');
    }
    return { storageState: value };
  } catch (error) {
    if (error instanceof SafeAuthError) throw error;
    throw new SafeAuthError('auth_storage_failed');
  }
}

async function devLogin(deps: {
  email: string;
  dashboardRequest: AuthDashboardRequest;
  storageState: () => Promise<InMemoryStorageState>;
}): Promise<AuthResult> {
  const login = await requestSafely(
    deps.dashboardRequest,
    '/auth/dev-login',
    { method: 'POST', data: { email: deps.email, requireExisting: true } },
    'dev_login_failed',
  );
  const loginStatus = statusOf(login);
  if (loginStatus === 404) throw new SafeAuthError('local_user_not_found', { statusCode: loginStatus });
  if (loginStatus !== 200) throw new SafeAuthError('dev_login_failed', { statusCode: loginStatus });

  const me = await requestSafely(deps.dashboardRequest, '/auth/me', { method: 'GET' }, 'admin_session_required');
  const meStatus = statusOf(me);
  const meBody = await responseBody(me);
  if (meStatus !== 200 || meBody?.['role'] !== 'admin') {
    throw new SafeAuthError('admin_session_required', { statusCode: meStatus });
  }
  return captureStorageState(deps.storageState);
}

export async function authenticateLocal(deps: {
  baseUrl: string;
  email?: string;
  stdinIsTTY: boolean;
  readConfirmation: () => Promise<string>;
  dashboardRequest: AuthDashboardRequest;
  storageState: () => Promise<InMemoryStorageState>;
}): Promise<AuthResult> {
  const baseUrl = normalizeTargetBaseUrl('local', deps.baseUrl);
  if (!deps.stdinIsTTY) throw new SafeAuthError('local_tty_required');
  let confirmation: string;
  try {
    confirmation = await deps.readConfirmation();
  } catch {
    throw new SafeAuthError('local_confirmation_mismatch');
  }
  if (confirmation !== `PROFILE ${baseUrl}`) {
    throw new SafeAuthError('local_confirmation_mismatch');
  }
  return devLogin({
    email: deps.email ?? 'founder@example.com',
    dashboardRequest: deps.dashboardRequest,
    storageState: deps.storageState,
  });
}

export async function authenticateHermetic(deps: {
  dashboardRequest: AuthDashboardRequest;
  storageState: () => Promise<InMemoryStorageState>;
  email?: string;
}): Promise<AuthResult> {
  return devLogin({
    email: deps.email ?? 'founder@example.com',
    dashboardRequest: deps.dashboardRequest,
    storageState: deps.storageState,
  });
}

export interface HostedLoginPage {
  close: () => Promise<void>;
}

async function closeQuietly(page: HostedLoginPage): Promise<void> {
  try {
    await page.close();
  } catch {
    // Page cleanup failure is deliberately discarded at this auth boundary.
  }
}

export async function authenticateHosted(deps: {
  headed: boolean;
  openLoginPage: (path?: '/') => Promise<HostedLoginPage>;
  dashboardRequest: AuthDashboardRequest;
  storageState: () => Promise<InMemoryStorageState>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
  pollMs: number;
}): Promise<AuthResult> {
  if (!deps.headed) throw new SafeAuthError('hosted_headed_required');
  let page: HostedLoginPage;
  try {
    page = await deps.openLoginPage('/');
  } catch {
    throw new SafeAuthError('hosted_auth_timeout', { timeoutMs: deps.timeoutMs });
  }

  try {
    const startedAt = deps.now();
    for (;;) {
      let me: JsonResponse | null = null;
      try {
        me = await deps.dashboardRequest('/auth/me', { method: 'GET' });
      } catch {
        // OAuth navigation can make the probe transiently unreachable; the
        // closed timeout below is the only retained failure state.
      }
      if (me === null) {
        if (deps.now() - startedAt >= deps.timeoutMs) {
          throw new SafeAuthError('hosted_auth_timeout', { timeoutMs: deps.timeoutMs });
        }
        try {
          await deps.sleep(deps.pollMs);
        } catch {
          throw new SafeAuthError('hosted_auth_timeout', { timeoutMs: deps.timeoutMs });
        }
        continue;
      }
      const meStatus = statusOf(me);
      const meBody = await responseBody(me);
      if (meStatus === 200 && meBody?.['role'] === 'admin') break;
      if (meStatus === 200) throw new SafeAuthError('hosted_admin_required', { statusCode: meStatus });
      if (deps.now() - startedAt >= deps.timeoutMs) {
        throw new SafeAuthError('hosted_auth_timeout', { timeoutMs: deps.timeoutMs });
      }
      try {
        await deps.sleep(deps.pollMs);
      } catch {
        throw new SafeAuthError('hosted_auth_timeout', { timeoutMs: deps.timeoutMs });
      }
    }

    const flags = await requestSafely(
      deps.dashboardRequest,
      '/api/system/flags',
      { method: 'GET' },
      'hosted_env_not_dev',
    );
    const flagsStatus = statusOf(flags);
    const flagsBody = await responseBody(flags);
    if (flagsStatus !== 200 || flagsBody?.['env'] !== 'dev') {
      throw new SafeAuthError('hosted_env_not_dev', { statusCode: flagsStatus });
    }
    return await captureStorageState(deps.storageState);
  } finally {
    await closeQuietly(page);
  }
}
