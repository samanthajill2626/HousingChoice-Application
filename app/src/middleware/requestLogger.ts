// Middleware (1) in the LOCKED chain: light request logger.
// Logs method, path, socket remote IP, and the raw X-Forwarded-For header
// (labeled untrusted-until-validated — CloudFront/XFF validation is a later
// concern). Headers are logged from a SAFE ALLOWLIST only; credential headers
// (authorization, cookie, x-origin-verify) are never logged. The pino redact
// config in lib/logger.ts is defense-in-depth on top of this allowlist.
import type { RequestHandler } from 'express';
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
  return (req, _res, next) => {
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
    next();
  };
}
