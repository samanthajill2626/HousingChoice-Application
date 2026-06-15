// Middleware (2) in the LOCKED chain: CloudFront origin-secret validator.
// Compares the x-origin-verify header to config CF_ORIGIN_SECRET. Mismatch or
// missing => WARN log (offender IP + path, correlation ID via the pino mixin)
// and an immediate 403 {"error":"forbidden"}.
//
// This middleware sits BEFORE the body parsers on purpose: rejected requests
// must never have their bodies parsed.
//
// GET /health is EXEMPT — deploy health-checks arrive via localhost without
// the header. The exemption is path-based, never environment-based.
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../lib/logger.js';

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface OriginSecretOptions {
  secret: string;
  logger: Logger;
}

export function originSecretMiddleware(opts: OriginSecretOptions): RequestHandler {
  const { secret, logger } = opts;
  return (req, res, next) => {
    if (req.method === 'GET' && req.path === '/health') {
      next();
      return;
    }
    // Dev-only endpoints are exempt — they sit before this validator in the
    // middleware chain when the devRouter is present, and must be reachable
    // (returning 404) even when it is absent so tests can assert the gate.
    // NOTE: Exempting the whole /__dev/ prefix means every current AND future
    // /__dev/* endpoint relies solely on the structural absent-in-prod gate (no
    // origin-secret fence). The blast radius grows as later phases add dev
    // routes — keep this in mind before adding anything sensitive under /__dev.
    if (req.path.startsWith('/__dev/')) {
      next();
      return;
    }

    const provided = req.headers['x-origin-verify'];
    if (typeof provided !== 'string' || !secretsMatch(provided, secret)) {
      // NEVER log the provided value or the expected secret.
      logger.warn(
        {
          remoteIp: req.socket.remoteAddress ?? null,
          method: req.method,
          path: req.path,
          reason: typeof provided === 'string' ? 'origin secret mismatch' : 'origin secret missing',
        },
        'request rejected by origin-secret validator',
      );
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    next();
  };
}
