// Typed endpoint functions — one per route. Every function returns a typed
// result and throws ApiError on non-2xx (see api/client.ts). Components import
// these (via api/index.ts) and never construct fetch calls by hand.
import { request } from './client.js';
import type {
  CasesPage,
  ConversationsPage,
  DevLoginResult,
  Me,
  TodayResponse,
} from './types.js';

// --- Auth (/auth) -----------------------------------------------------------

/** GET /auth/me — the current principal, or throws ApiError(401) when anonymous. */
export function getMe(signal?: AbortSignal): Promise<Me> {
  return request<Me>('/auth/me', { ...(signal !== undefined && { signal }) });
}

/** POST /auth/logout — global session revocation (204). */
export function logout(): Promise<void> {
  return request<void>('/auth/logout', { method: 'POST' });
}

/** The login URL — a plain navigation (the server drives the OAuth dance).
 *  Not a fetch: use it as an <a href> / window.location.assign(loginUrl()). */
export function loginUrl(): string {
  return '/auth/login';
}

// --- Today (/api) -----------------------------------------------------------
// The server-assembled action queue (§API Contract C7). When the backend slice
// isn't live yet this 404s; useToday catches ApiError(404) and assembles the
// same shape client-side from getCases() + getConversations().

/** GET /api/today — the server-assembled Today queue, or throws ApiError(404)
 *  until the backend slice lands (the caller falls back to the client build). */
export function getToday(signal?: AbortSignal): Promise<TodayResponse> {
  return request<TodayResponse>('/api/today', { ...(signal !== undefined && { signal }) });
}

/** GET /api/cases — the case board (the Today fallback's deadline/tour/attention
 *  source). The server pages; the Today fallback reads the first page. */
export function getCases(signal?: AbortSignal): Promise<CasesPage> {
  return request<CasesPage>('/api/cases', { ...(signal !== undefined && { signal }) });
}

/** GET /api/conversations — the inbox rows (the Today fallback's unread +
 *  untriaged source). */
export function getConversations(signal?: AbortSignal): Promise<ConversationsPage> {
  return request<ConversationsPage>('/api/conversations', {
    ...(signal !== undefined && { signal }),
  });
}

// --- Dev-only auth (/__dev, /auth/dev-login) --------------------------------
// These reach the hermetic-LOCAL dev router, mounted ONLY in the local dev/e2e
// stack and 404 (router absent) in every deployed env. The UI uses devPing() to
// decide whether to surface the dev-login affordance at all; it MUST fail closed
// (any non-200 / non-{dev:true} / error → unavailable).

/** GET /__dev/ping — availability probe for the hermetic dev router. Resolves
 *  `true` only on 200 with a `{ dev: true }` body; resolves `false` for any
 *  non-200, network/transport error, or malformed body (never throws). */
export async function devPing(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await request<{ dev?: unknown }>('/__dev/ping', {
      ...(signal !== undefined && { signal }),
    });
    return res !== null && typeof res === 'object' && res.dev === true;
  } catch {
    return false;
  }
}

/** POST /auth/dev-login — log in as a dev user (sets the session cookie). The
 *  server auto-provisions the user if missing, so this works on an unseeded
 *  local DB too (known personas keep their role; others default to admin). */
export function devLogin(email = 'va@example.com'): Promise<DevLoginResult> {
  return request<DevLoginResult>('/auth/dev-login', { method: 'POST', body: { email } });
}
