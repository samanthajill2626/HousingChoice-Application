// Session + RBAC middleware (M1.3). These mount INSIDE the route stage of
// the locked chain (app.ts stage 4) — never ahead of the CloudFront
// origin-secret validator (binding guideline 2).
//
//   sessionMiddleware  cookie → req.user (or nothing; never rejects itself)
//   requireAuth        401 JSON when no session user
//   requireRole        403 JSON when the session user's role differs
//
// Rolling sessions: tokens carry iat/exp sealed inside (lib/sessionCookie).
// A valid session older than SESSION_REFRESH_AFTER_MS is re-issued — after
// re-reading the user from the users table, so npm run user:role changes
// (and user deletions) take effect within a day, not only at the 7-day
// expiry. Fresh cookies skip the read: steady-state requests cost zero
// DynamoDB.
import type { Request, RequestHandler } from 'express';
import type { AppConfig } from '../lib/config.js';
import { mergeContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { open, parseCookies, seal, SESSION_COOKIE_NAME } from '../lib/sessionCookie.js';
import { createUsersRepo, isUserRole, type UserRole, type UsersRepo } from '../repos/usersRepo.js';

/** 7-day rolling window (the locked session decision). */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Re-issue (and re-validate against the users table) once a day. */
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SessionUser {
  userId: string;
  email: string;
  role: UserRole;
}

/** Request augmented by sessionMiddleware. */
export interface AuthedRequest extends Request {
  user?: SessionUser;
}

/** Session-cookie attributes (HttpOnly + SameSite=Lax always; Secure when deployed). */
export function sessionCookieOptions(config: AppConfig): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    // Secure is unconditionally right behind CloudFront (https). Locally the
    // app is plain http://localhost:8080 — older browsers refuse Secure
    // cookies there, so dev/test omit it.
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

/** Seal a session token for a user (shared by callback + rolling refresh + tests). */
export function sealSession(
  user: SessionUser,
  config: AppConfig,
  opts: { now?: number } = {},
): string {
  return seal(
    { userId: user.userId, email: user.email, role: user.role },
    { secret: config.sessionSecret, ttlMs: SESSION_TTL_MS, ...opts },
  );
}

function toSessionUser(data: Record<string, unknown>): SessionUser | undefined {
  const { userId, email, role } = data;
  if (typeof userId !== 'string' || userId.length === 0) return undefined;
  if (typeof email !== 'string' || email.length === 0) return undefined;
  if (!isUserRole(role)) return undefined;
  return { userId, email, role };
}

export interface SessionMiddlewareOptions {
  config: AppConfig;
  logger?: Logger;
  /** Injected in tests; defaults to the real users repo (refresh re-reads only). */
  usersRepo?: UsersRepo;
}

/**
 * Parse + verify the session cookie. On success: req.user is set and the
 * correlation context carries userId (so every log line of an authenticated
 * request is attributable). On ANY failure the request simply proceeds
 * unauthenticated — requireAuth decides whether that matters.
 */
export function sessionMiddleware(opts: SessionMiddlewareOptions): RequestHandler {
  const log = opts.logger ?? defaultLogger;
  const { config } = opts;
  const users = opts.usersRepo ?? createUsersRepo({ logger: opts.logger });

  return async (req: AuthedRequest, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (token === undefined) {
      next();
      return;
    }

    const opened = open(token, config.sessionSecret);
    const user = opened !== undefined ? toSessionUser(opened.data) : undefined;
    if (opened === undefined || user === undefined) {
      // Tampered/expired/garbage — drop it so the browser stops sending it.
      // Never log the token itself.
      log.info({ reason: opened === undefined ? 'invalid' : 'bad-shape' }, 'session cookie rejected');
      res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      next();
      return;
    }

    // Rolling refresh: once a day, re-read the user so role changes and
    // deletions propagate without waiting out the 7-day window.
    if (Date.now() - opened.issuedAt > SESSION_REFRESH_AFTER_MS) {
      const current = await users.findById(user.userId);
      if (!current) {
        log.warn({ userId: user.userId }, 'session user no longer exists — session revoked');
        res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        next();
        return;
      }
      user.role = current.role;
      user.email = current.email;
      res.cookie(SESSION_COOKIE_NAME, sealSession(user, config), sessionCookieOptions(config));
    }

    req.user = user;
    mergeContext({ userId: user.userId });
    next();
  };
}

/** 401 unless sessionMiddleware attached a user. Closes the H4 exposure: EVERY /api route sits behind this. */
export function requireAuth(): RequestHandler {
  return (req: AuthedRequest, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

/**
 * 403 unless the session user's role matches. Built for M1.3 but applied
 * NOWHERE yet (deliberate): VAs run the day-to-day — assignment included —
 * so every /api route is requireAuth-only until a genuinely admin-only
 * surface exists (e.g. user management UI). Gate such routes with
 * requireRole('admin') then.
 */
export function requireRole(role: UserRole): RequestHandler {
  return (req: AuthedRequest, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (req.user.role !== role) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}
