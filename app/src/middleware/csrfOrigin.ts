// CSRF origin check for the mutating /api surface (M1.3 hardening). Mounted
// INSIDE the route stage (app.ts /api mount) — never ahead of the locked
// chain (binding guideline 2).
//
// TWO independent CSRF controls protect /api, by design:
//   1. SameSite=Lax on the session cookie (middleware/auth.ts) — browsers
//      don't attach it to cross-site POST/PATCH/PUT/DELETE at all, so a
//      forged request normally arrives unauthenticated and 401s.
//   2. THIS check — on mutating methods, a present Origin header must match
//      PUBLIC_BASE_URL's origin (or a localhost dev origin). It backstops
//      Lax: an explicit control that holds even if cookie semantics regress
//      (browser quirks, future SameSite changes, subdomain surprises).
//
// An ABSENT Origin is allowed on purpose: non-browser clients (curl, health
// tooling) send none, and every modern browser sends Origin on cross-site
// mutating requests — the forgery case this exists for always carries it.
import type { RequestHandler } from 'express';
import type { AppConfig } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Vite dev server / local dashboard origins (any port). */
function isLocalDevOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1');
  } catch {
    return false; // includes the literal "null" origin — reject
  }
}

export interface CsrfOriginOptions {
  config: AppConfig;
  logger: Logger;
}

export function csrfOriginMiddleware(opts: CsrfOriginOptions): RequestHandler {
  const { logger } = opts;
  // PUBLIC_BASE_URL is operator config — a malformed value should fail at
  // boot, not per-request, so derive the origin once here.
  const publicOrigin =
    opts.config.publicBaseUrl !== undefined ? new URL(opts.config.publicBaseUrl).origin : undefined;

  return (req, res, next) => {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (origin === undefined) {
      next(); // non-browser client — SameSite=Lax remains the backstop
      return;
    }
    if (origin === publicOrigin || isLocalDevOrigin(origin)) {
      next();
      return;
    }
    // Origin values are attacker-chosen but not PII — log them.
    logger.warn(
      { origin, method: req.method, path: req.path },
      'cross-origin mutating request rejected (CSRF origin check)',
    );
    res.status(403).json({ error: 'forbidden' });
  };
}
