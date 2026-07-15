// Deep string-trim for JSON request bodies (founder decision 2026-07-14):
// EVERY string field an operator or public form submits is trimmed at the
// edge, so a "firstName" can never persist as "Cameron   " and joins can
// never render "Cameron   Abt". One seam instead of per-field parse fixes —
// new routes and new fields inherit the guarantee automatically.
//
// Scope is deliberate:
//   - JSON bodies ONLY (the dashboard + public intake surfaces). Twilio
//     webhooks post application/x-www-form-urlencoded and are NOT touched —
//     provider payloads (an inbound SMS body, exact keyword bytes) keep full
//     fidelity, and their HMAC validation reads req.rawBody anyway.
//   - VALUES only, never object keys (customFields labels are values).
//   - Ends only (String.prototype.trim) — interior whitespace is the user's.
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** JSON.parse output is acyclic, but cap the walk anyway (defense vs a
 *  pathological nesting bomb — express's body limit makes this moot). */
const MAX_DEPTH = 64;

/** Recursively trim every string VALUE in a JSON-shaped structure. Arrays and
 *  plain objects are walked in place; every other type passes through. */
export function deepTrimStrings(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.trim();
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = deepTrimStrings(value[i], depth + 1);
    }
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    obj[key] = deepTrimStrings(obj[key], depth + 1);
  }
  return obj;
}

/**
 * Express middleware: trim all string values in an application/json body.
 * Mount AFTER express.json() (it mutates the parsed body; the raw-body capture
 * for webhook HMACs happened in the parser's verify hook, before this runs).
 */
export function trimJsonBody(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.is('application/json') && typeof req.body === 'object' && req.body !== null) {
      deepTrimStrings(req.body);
    }
    next();
  };
}
