// Reusable in-memory rate limiter (M1.5) — the abuse fence on the PUBLIC,
// unauthenticated /public surface (housing-fair intake + flyer). Public routes
// are money-spending (the housing-fair form sends an SMS) and authentication
// can't gate them, so a per-IP request cap is the first line of defense.
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
