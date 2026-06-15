// Middleware (1) in the LOCKED chain: light request logger.
// Logs method, path, socket remote IP, and the raw X-Forwarded-For header
// (labeled untrusted-until-validated — CloudFront/XFF validation is a later
// concern). Headers are logged from a SAFE ALLOWLIST only; credential headers
// (authorization, cookie, x-origin-verify) are never logged. The pino redact
// config in lib/logger.ts is defense-in-depth on top of this allowlist.
import type { RequestHandler } from 'express';
import { getContext, runWithContext } from '../lib/context.js';
import type { Logger } from '../lib/logger.js';

const SAFE_HEADER_ALLOWLIST = [
  'host',
  'user-agent',
  'content-type',
  'content-length',
  'traceparent',
  'x-forwarded-for',
] as const;

export function requestLoggerMiddleware(log: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    const headers: Record<string, string> = {};
    for (const name of SAFE_HEADER_ALLOWLIST) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
      else if (Array.isArray(value)) headers[name] = value.join(', ');
    }

    const xff = req.headers['x-forwarded-for'];
    log.info(
      {
        method: req.method,
        path: req.path,
        remoteIp: req.socket.remoteAddress ?? null,
        // Raw header value — spoofable until validated against CloudFront.
        xff: typeof xff === 'string' ? xff : Array.isArray(xff) ? xff.join(', ') : null,
        xffTrust: 'untrusted-until-validated',
        headers,
      },
      'request received',
    );

    // Completion line: status + latency (doc §9 "every HTTP request/response
    // (status, latency)"). Fires once when the response finishes. The 'finish'
    // event can emit OUTSIDE the correlation AsyncLocalStorage context, so we
    // re-run the log inside the captured context — which is the LIVE store, so
    // by finish time it carries everything merged during the request (requestId,
    // userId, …). Without this the line would be an ORPHAN log (binding
    // guideline 4 / the orphan-logs alarm). Monotonic hrtime so a wall-clock
    // adjustment can't produce a negative duration.
    const ctx = getContext() ?? {};
    res.on('finish', () => {
      runWithContext(ctx, () => {
        log.info(
          {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
          },
          'request completed',
        );
      });
    });

    next();
  };
}
