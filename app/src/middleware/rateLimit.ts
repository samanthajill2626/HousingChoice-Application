// Reusable in-memory rate limiters. TWO fences live here:
//
//   createRateLimit (M1.5)      — fixed-window, per-IP: the abuse fence on the
//     PUBLIC, unauthenticated /public surface (housing-fair intake + flyer).
//   createUserRateLimit (2026-07-02) — sliding-window, per-USER: the spend
//     fence on the AUTHENTICATED send/call-cost routes (manual send, broadcast
//     send, call originate, cell verify-start). See the section below.
//
// Public routes are money-spending (the housing-fair form sends an SMS) and
// authentication can't gate them, so a per-IP request cap is the first line of
// defense.
//
// Algorithm: a FIXED-WINDOW counter per client key. Each key holds a count and
// a window-reset timestamp; the (windowCount + 1)th request inside one window
// is rejected with 429 until the window rolls. Fixed-window is chosen over a
// token bucket for auditability — the limit reads exactly as "N requests per
// window per IP".
//
// *** SINGLE-INSTANCE ASSUMPTION (load-bearing, on purpose) ***
// The counter map lives in this one app process's memory — valid because the
// whole platform runs as one app process on one t4g.small (the same assumption
// the SSE event bus documents in lib/events.ts). A multi-instance future would
// let a client get N requests PER instance; the upgrade path is a shared store
// (DynamoDB conditional ADD with a TTL, or ElastiCache). Until then this is the
// right amount of machinery for the scale. Idle entries are swept lazily on
// access plus by a periodic sweep so the map can't grow unbounded.
//
// CLIENT IP: in production CloudFront is the only origin client, so the socket
// address is always CloudFront — the real client is the FIRST entry of
// X-Forwarded-For (CloudFront appends the viewer IP). We do NOT set Express
// `trust proxy` (it would also affect req.ip elsewhere); the resolver here is
// local to rate limiting. XFF is attacker-spoofable in general, but behind
// CloudFront the viewer IP CloudFront stamps is trustworthy; the socket
// fallback covers local/dev where there is no proxy.
import type { Request, RequestHandler } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { AuthedRequest } from './auth.js';

export interface RateLimitOptions {
  /** Max requests allowed per window per client key. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  logger?: Logger;
  /**
   * Client-key resolver (default: client IP). Overridable in tests so a single
   * supertest client can simulate distinct IPs.
   */
  keyOf?: (req: Request) => string;
}

interface WindowState {
  count: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
}

/**
 * Resolve the real client IP for rate limiting. Behind CloudFront the socket
 * peer is CloudFront, so prefer the FIRST X-Forwarded-For entry (the viewer);
 * fall back to the socket address locally/in dev. Never throws — an
 * unresolvable client collapses to a constant key (still rate limited as one
 * bucket, fail-closed-ish, never fail-open per-request).
 */
export function clientIpOf(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Build a rate-limit middleware over a private in-memory window map. Each
 * createRateLimit() call owns its OWN map, so different route groups can carry
 * independent limits without sharing state.
 */
export function createRateLimit(opts: RateLimitOptions): RequestHandler {
  const { max, windowMs } = opts;
  const log = opts.logger ?? defaultLogger;
  const keyOf = opts.keyOf ?? clientIpOf;
  const windows = new Map<string, WindowState>();

  // Periodic sweep of expired windows so the map never grows unbounded under a
  // churn of distinct IPs. unref() so this timer never holds the process open.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, state] of windows) {
      if (state.resetAt <= now) windows.delete(key);
    }
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const key = keyOf(req);
    const now = Date.now();
    let state = windows.get(key);
    if (state === undefined || state.resetAt <= now) {
      // New window (first request, or the previous window expired).
      state = { count: 1, resetAt: now + windowMs };
      windows.set(key, state);
      next();
      return;
    }

    if (state.count >= max) {
      const retryAfterSec = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      // NEVER log PII: the key is an IP (network identifier, not PII per se),
      // but we log it truncated and never log any request body.
      log.warn(
        { path: req.path, method: req.method, max, windowMs, retryAfterSec },
        'rate limit exceeded on public surface',
      );
      res.status(429).json({ error: 'rate_limited' });
      return;
    }

    state.count += 1;
    next();
  };
}

// ---------------------------------------------------------------------------
// Per-USER limiter for the AUTHENTICATED send/call-cost routes (2026-07-02
// hardening — docs/superpowers/specs/2026-07-02-api-rate-limiting-design.md).
// Keyed (routeKey, userId), NOT per IP: staff share office IPs, and every wired
// route sits behind requireAuth, so the session user is the meaningful actor.
//
// Algorithm: a SLIDING-WINDOW counter — per key we keep the in-window request
// timestamps; each request first evicts entries older than windowMs, then
// admits iff fewer than `max` remain. Sliding (vs the fixed window above) so a
// burst can never double the ceiling by straddling a window boundary — these
// routes spend real money (SMS sends, ringing calls), so the bound must hold
// over ANY windowMs-long span.
//
// *** SINGLE-INSTANCE ASSUMPTION (load-bearing, on purpose) ***
// Same as createRateLimit above: the map lives in this one app process's
// memory, which is correct because the whole platform deploys as a single app
// process. Multi-instance scaling would let a user get N requests PER instance
// — the upgrade path is a shared store (Redis, or DynamoDB conditional
// updates); note it, don't build it.
// ---------------------------------------------------------------------------

export interface UserRateLimitOptions {
  /**
   * Constant per wiring (e.g. 'manual_send') — names the bucket in logs and
   * keeps two limiters on different routes from ever sharing quota (each
   * createUserRateLimit() call also owns its OWN map, like createRateLimit).
   */
  routeKey: string;
  /** Max requests allowed per sliding window per user. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  logger?: Logger;
}

/**
 * Build a per-user sliding-window rate-limit middleware. Mount AFTER
 * requireAuth and BEFORE the route handler, so a limited request performs NO
 * side effect (no SMS dispatched, no state touched).
 *
 * On limit (the LOCKED contract the dashboard builds to): HTTP 429, body
 * `{ error: 'rate_limited' }`, and a `Retry-After` header carrying the integer
 * seconds until the OLDEST in-window request ages out (when the window admits
 * again). Never a silent drop.
 *
 * A request with NO session user answers 401 — it must NEVER fall back to an
 * IP or a shared bucket (sessions would share/steal each other's quota).
 * Unreachable behind requireAuth; belt-and-braces.
 */
export function createUserRateLimit(opts: UserRateLimitOptions): RequestHandler {
  const { routeKey, max, windowMs } = opts;
  const log = opts.logger ?? defaultLogger;
  // userId → in-window request timestamps, oldest first. (routeKey needs no
  // place in the key: this map is private to ONE limiter on ONE route.)
  const hits = new Map<string, number[]>();

  // Periodic sweep: users who stop calling leave their last window's
  // timestamps behind — evict aged entries and PRUNE EMPTY KEYS so the map
  // never grows unbounded across users. unref() so the timer never holds the
  // process open. (The request path below also evicts + prunes on access.)
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, stamps] of hits) {
      const live = stamps.filter((t) => t > cutoff);
      if (live.length === 0) hits.delete(key);
      else if (live.length !== stamps.length) hits.set(key, live);
    }
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const userId = (req as AuthedRequest).user?.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const now = Date.now();
    const cutoff = now - windowMs;
    // Evict expired timestamps (sliding window). Stamps are appended in time
    // order, so everything from the first in-window index onward survives.
    const prior = hits.get(userId) ?? [];
    let firstLive = 0;
    while (firstLive < prior.length && (prior[firstLive] as number) <= cutoff) firstLive += 1;
    const live = firstLive > 0 ? prior.slice(firstLive) : prior;

    if (live.length >= max) {
      // Retry-After = seconds until the OLDEST in-window request expires (the
      // earliest instant a new request can be admitted).
      const oldest = live[0] as number;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      // PII: IDs and numbers ONLY — never a phone or a request body.
      log.warn({ routeKey, userId, max, windowMs }, 'per-user rate limit exceeded');
      if (firstLive > 0) hits.set(userId, live); // persist the eviction
      res.status(429).json({ error: 'rate_limited' });
      return;
    }

    live.push(now);
    hits.set(userId, live);
    next();
  };
}
