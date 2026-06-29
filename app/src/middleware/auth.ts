// Session + RBAC middleware (M1.3). These mount INSIDE the route stage of
// the locked chain (app.ts stage 4) — never ahead of the CloudFront
// origin-secret validator (binding guideline 2).
//
//   sessionMiddleware  cookie → req.user (or nothing; never rejects itself)
//   requireAuth        401 JSON when no session user
//   requireRole        403 JSON when the session user's role differs
//
// Rolling sessions: tokens carry iat/exp sealed inside (lib/sessionCookie).
// A valid session older than SESSION_REFRESH_AFTER_MS is re-issued so the
// sealed role/exp stay fresh. Server-side revocation: the user's
// session_epoch is sealed into every cookie and re-checked on EVERY request
// against the users table — through a tiny in-process TTL cache (60s, one
// GetItem per user per minute steady-state), so logout/role bumps revoke all
// of a user's sessions within ~60 seconds. A stale epoch (or a deleted user)
// is treated as unauthenticated and the cookie is cleared.
import type { Request, RequestHandler } from 'express';
import type { AppConfig } from '../lib/config.js';
import { mergeContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { open, parseCookies, seal, SESSION_COOKIE_NAME } from '../lib/sessionCookie.js';
import {
  createUsersRepo,
  isUserRole,
  sessionEpochOf,
  type UserRole,
  type UsersRepo,
} from '../repos/usersRepo.js';

/** 7-day rolling window (the locked session decision). */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Re-issue (refresh the sealed role/exp) once a day. */
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/** How stale the cached {epoch, role} may get — the revocation latency bound. */
export const SESSION_EPOCH_CACHE_TTL_MS = 60 * 1000;

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
  opts: { epoch: number; now?: number },
): string {
  const { epoch, ...sealOpts } = opts;
  return seal(
    { userId: user.userId, email: user.email, role: user.role, epoch },
    { secret: config.sessionSecret, purpose: 'session', ttlMs: SESSION_TTL_MS, ...sealOpts },
  );
}

function toSessionClaims(
  data: Record<string, unknown>,
): { user: SessionUser; epoch: number } | undefined {
  const { userId, email, role, epoch } = data;
  if (typeof userId !== 'string' || userId.length === 0) return undefined;
  if (typeof email !== 'string' || email.length === 0) return undefined;
  if (!isUserRole(role)) return undefined;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) return undefined;
  return { user: { userId, email, role }, epoch };
}

/**
 * The in-process {epoch, role} cache the epoch check reads through. One per
 * buildApp() (shared by the /auth and /api mounts) so a logout's eviction is
 * process-wide — and the deployed stack runs exactly one app process, so
 * eviction there is total. Map keyed by userId; team-sized, never pruned.
 */
export interface SessionEpochCache {
  get(userId: string): { epoch: number; role: UserRole } | undefined;
  set(userId: string, entry: { epoch: number; role: UserRole }): void;
  /** Evict — the next request re-reads the users table (logout uses this). */
  delete(userId: string): void;
  /** Drop ALL entries — the next request re-reads for every user. Used after a
   *  dev reseed wipes + reseeds the users table, so no stale epoch (e.g. one
   *  bumped by a prior sign-out) rejects a freshly-minted post-reseed session. */
  clear(): void;
}

export function createSessionEpochCache(
  ttlMs: number = SESSION_EPOCH_CACHE_TTL_MS,
): SessionEpochCache {
  const entries = new Map<string, { epoch: number; role: UserRole; expiresAt: number }>();
  return {
    get(userId) {
      const entry = entries.get(userId);
      if (entry === undefined) return undefined;
      if (Date.now() >= entry.expiresAt) {
        entries.delete(userId);
        return undefined;
      }
      return entry;
    },
    set(userId, entry) {
      entries.set(userId, { ...entry, expiresAt: Date.now() + ttlMs });
    },
    delete(userId) {
      entries.delete(userId);
    },
    clear() {
      entries.clear();
    },
  };
}

export interface SessionMiddlewareOptions {
  config: AppConfig;
  logger?: Logger;
  /** Injected in tests; defaults to the real users repo. */
  usersRepo?: UsersRepo;
  /** Injected in tests (0-TTL forces a read per request); defaults to a fresh 60s cache. */
  epochCache?: SessionEpochCache;
}

/**
 * Parse + verify the session cookie, then check the sealed session epoch
 * against the users table (through the 60s epoch cache — the revocation
 * kill switch). On success: req.user is set (role ≤60s fresh) and the
 * correlation context carries userId (so every log line of an authenticated
 * request is attributable). On ANY failure the request simply proceeds
 * unauthenticated — requireAuth decides whether that matters.
 */
export function sessionMiddleware(opts: SessionMiddlewareOptions): RequestHandler {
  const log = opts.logger ?? defaultLogger;
  const { config } = opts;
  const users = opts.usersRepo ?? createUsersRepo({ logger: opts.logger });
  const epochCache = opts.epochCache ?? createSessionEpochCache();

  return async (req: AuthedRequest, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (token === undefined) {
      next();
      return;
    }

    const opened = open(token, config.sessionSecret, 'session');
    const claims = opened !== undefined ? toSessionClaims(opened.data) : undefined;
    if (opened === undefined || claims === undefined) {
      // Tampered/expired/garbage — drop it so the browser stops sending it.
      // Never log the token itself.
      log.info({ reason: opened === undefined ? 'invalid' : 'bad-shape' }, 'session cookie rejected');
      res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      next();
      return;
    }
    const { user, epoch } = claims;

    // The kill switch: the sealed epoch must match the user's CURRENT epoch.
    // Cache hit = allocation-free fast path; miss = one GetItem per user per
    // TTL window, which also catches deleted users within the same ≤60s.
    let entry = epochCache.get(user.userId);
    if (entry === undefined) {
      const current = await users.findById(user.userId);
      if (!current) {
        log.warn({ userId: user.userId }, 'session user no longer exists — session revoked');
        res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        next();
        return;
      }
      entry = { epoch: sessionEpochOf(current), role: current.role };
      epochCache.set(user.userId, entry);
    }
    if (epoch !== entry.epoch) {
      log.info({ userId: user.userId }, 'session epoch stale — session revoked');
      res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      next();
      return;
    }
    // The cached role is ≤60s fresh — strictly newer than the sealed one.
    user.role = entry.role;

    // Rolling refresh: once a day, re-issue so the sealed role/exp catch up.
    if (Date.now() - opened.issuedAt > SESSION_REFRESH_AFTER_MS) {
      res.cookie(
        SESSION_COOKIE_NAME,
        sealSession(user, config, { epoch: entry.epoch }),
        sessionCookieOptions(config),
      );
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
