// Test session-cookie factory (M1.3). Mints REAL sealed session cookies with
// the dev placeholder secret loadConfig() resolves for non-production
// NODE_ENVs — exactly what harness-built apps verify against, so the /api
// auth gate is exercised for real (never bypassed) at one header per request.
import { DEV_SESSION_SECRET_DEFAULT } from '../../src/lib/config.js';
import { seal, SESSION_COOKIE_NAME } from '../../src/lib/sessionCookie.js';
import { SESSION_TTL_MS, type SessionUser } from '../../src/middleware/auth.js';

export const TEST_SESSION_USER: SessionUser = {
  userId: 'usr_testva00000000000000000',
  email: 'test-va@housingchoice.org',
  role: 'va',
};

export interface SessionCookieOptions {
  /** Defaults to the dev placeholder every non-production loadConfig() uses. */
  secret?: string;
  ttlMs?: number;
  /** Clock override (epoch ms) — e.g. backdate iat to trigger the rolling refresh. */
  now?: number;
}

/** A `hc_session=<sealed token>` Cookie-header value for the given user. */
export function sessionCookieFor(
  user: Partial<SessionUser> = {},
  opts: SessionCookieOptions = {},
): string {
  const token = seal(
    { ...TEST_SESSION_USER, ...user },
    {
      secret: opts.secret ?? DEV_SESSION_SECRET_DEFAULT,
      ttlMs: opts.ttlMs ?? SESSION_TTL_MS,
      ...(opts.now !== undefined && { now: opts.now }),
    },
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/** The shared authed Cookie header for the /api suites (a fresh 'va' session). */
export const TEST_SESSION_COOKIE = sessionCookieFor();
