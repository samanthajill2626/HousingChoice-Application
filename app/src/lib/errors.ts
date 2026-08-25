// Errors are first-class logs (binding guideline 4): process-level handlers
// and the Express error middleware all log full stack + correlation context.
import type { ErrorRequestHandler } from 'express';
import {
  getContext,
  newBootId,
  runWithContext,
  type CorrelationContext,
} from './context.js';
import { logger as defaultLogger, type Logger } from './logger.js';

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  // `String(value)` THROWS for a symbol and for a null-prototype object (fix
  // wave 2, adversarial 32). This helper runs inside catch blocks, so a throw
  // here REPLACES the error being reported - on the boot fingerprint guard and
  // on the group send path, the two places that most need to say what failed.
  try {
    return new Error(String(value));
  } catch {
    return new Error('unstringifiable thrown value');
  }
}

/**
 * The safe fields of an error summary. See `summarizeError`.
 *
 * NO `message` (fix wave 2, adversarial 10 / conformance F7). The adjudicated
 * allowlist is (name, code, status). `message` is the one field the vendor
 * authors freely - Twilio's address/validation family echoes the offending
 * parameter into it ("The 'To' number +1555... is not a valid phone number") -
 * so a summary that carried it could not honestly claim nothing raw leaves.
 */
export interface ErrorSummary {
  name: string;
  code?: string;
  status?: number;
}

/**
 * THE SAFE SHAPE FOR LOGGING A VENDOR SDK ERROR (fix wave 5, adversarial 4).
 *
 * pino's default `err` serializer copies EVERY enumerable key of the error it
 * is handed. A Twilio SDK network failure is a raw `AxiosError`, and axios sets
 * `this.config = config` as an own enumerable property - so `log.warn({ err })`
 * writes `config.headers.Authorization` (Basic base64 of the API key sid and
 * secret) and `config.data` (the form-encoded request body: every member's
 * phone number, and the full message text) straight into CloudWatch. The
 * logger's `redact` list cannot save us there: the paths do not match and
 * pino's redact is case-sensitive.
 *
 * So a call site that can receive a vendor error logs THIS instead of the error
 * object: a name and the two vendor discriminators worth having. It copies
 * nothing it was not asked for - not even `message` - so neither a future SDK
 * adding an enumerable property nor a vendor writing PII into its own error text
 * can smuggle anything into a log line.
 *
 * NUMERIC CODES COUNT (fix wave 2, adversarial 9). Twilio's `RestException`
 * sets `code` as a NUMBER and never sets `name`, so a string-only check dropped
 * the single most identifying field and reported every rail failure as a bare
 * `Error`. The name falls back to the CONSTRUCTOR's name for exactly that case,
 * while a real `TypeError` keeps its own.
 */
export function summarizeError(value: unknown): ErrorSummary {
  const err = toError(value);
  const raw = err as unknown as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const code =
    typeof raw.code === 'string' && raw.code.length > 0
      ? raw.code
      : typeof raw.code === 'number'
        ? String(raw.code)
        : undefined;
  const status =
    typeof raw.status === 'number'
      ? raw.status
      : typeof raw.response?.status === 'number'
        ? raw.response.status
        : undefined;
  const declared = typeof err.name === 'string' && err.name.length > 0 ? err.name : 'Error';
  const constructed = err.constructor?.name;
  const name =
    declared === 'Error' && typeof constructed === 'string' && constructed.length > 0
      ? constructed
      : declared;
  return {
    name,
    ...(code !== undefined && { code }),
    ...(status !== undefined && { status }),
  };
}

/**
 * Install uncaughtException / unhandledRejection handlers.
 * uncaughtException: log fatal (full stack), flush, exit 1.
 * unhandledRejection: log error (full stack) and keep running.
 *
 * Process-level events don't reliably inherit AsyncLocalStorage context, so a
 * fallback context (the entrypoint's boot context) keeps these lines from
 * being orphans: when the throwing code's context survived, it wins; otherwise
 * the error is attributed to the process lifecycle.
 */
export function installProcessErrorHandlers(
  log: Logger = defaultLogger,
  fallbackContext: CorrelationContext = { bootId: newBootId() },
): void {
  const withFallback = (fn: () => void): void => {
    if (getContext()) fn();
    else runWithContext(fallbackContext, fn);
  };

  process.on('uncaughtException', (err) => {
    withFallback(() => log.fatal({ err }, 'uncaughtException - exiting'));
    // Flush pino's buffer before exiting; fall back to a hard exit if the
    // flush callback never fires.
    const forceExit = setTimeout(() => process.exit(1), 2000);
    forceExit.unref();
    log.flush(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason, promise) => {
    withFallback(() =>
      log.error({ err: toError(reason), promise: String(promise) }, 'unhandledRejection'),
    );
  });
}

/**
 * A STABLE, low-cardinality route label for a log message.
 *
 * DELIBERATELY NOT `req.path`: three routes mount a raw E.164 as a path segment
 * (routes/contacts.ts `/:contactId/phones/:phone`, routes/relayGroups.ts
 * `/conversations/:conversationId/members/:phone`), so a concrete path would put
 * a tenant's phone number into `msg` - a field operators are taught to grep and
 * that must stay groupable. `path` remains a structured FIELD on the line.
 *
 * `req.route.path` alone is MOUNT-RELATIVE, so it is prefixed with `req.baseUrl`.
 * `req.route` is unset for middleware, body-parser and URIError failures, which
 * take the literal `(unrouted)` token.
 *
 * INVARIANT THE baseUrl HALF RESTS ON: every router in app/src mounts on a
 * LITERAL prefix (swept 2026-08-25: zero parameterised mounts). Express sets
 * `baseUrl` to the matched prefix with ACTUAL VALUES SUBSTITUTED, so a router
 * mounted at, say, `/:contactId/phones` would put the concrete id straight back
 * into `msg` - the very outcome the paragraph above refuses. Keep mounts
 * literal, or template `req.baseUrl` here before a parameterised one lands.
 */
function routeLabel(req: { baseUrl?: string; route?: { path?: string } }): string {
  const path = req.route?.path;
  if (typeof path !== 'string' || path.length === 0) return '(unrouted)';
  return `${req.baseUrl ?? ''}${path}`;
}

/**
 * Express error-handling middleware (mounted LAST). Logs the error with full
 * stack - the pino mixin attaches the request's correlation context - and
 * responds 500 JSON. If headers were already sent, delegates to Express's
 * default handler.
 *
 * Each of the three branches names the METHOD and the ROUTE TEMPLATE in its
 * message, and the three messages are DISTINCT, so a reader of the error panel
 * can tell which request failed and which branch produced the line.
 */
export function createExpressErrorHandler(log: Logger = defaultLogger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      log.error(
        { err: toError(err), method: req.method, path: req.path },
        `unhandled error after response started: ${req.method} ${routeLabel(req)}`,
      );
      next(err);
      return;
    }
    // A malformed %-escape in the URL path/params makes Express's route matcher
    // throw URIError (decodeURIComponent) BEFORE any handler runs. That is a
    // client error (a bad request), NOT a server fault - respond 400 and WARN
    // (not ERROR), so it never trips the hc-<env>-error-logs alarm.
    if (err instanceof URIError) {
      log.warn(
        { err: toError(err), method: req.method, path: req.path },
        `malformed URI in request - rejected as 400: ${req.method} ${routeLabel(req)}`,
      );
      res.status(400).json({ error: 'bad request' });
      return;
    }
    log.error(
      { err: toError(err), method: req.method, path: req.path },
      `unhandled error while handling request: ${req.method} ${routeLabel(req)}`,
    );
    res.status(500).json({ error: 'internal server error' });
  };
}

/** Default error handler bound to the process-wide logger. */
export const expressErrorHandler: ErrorRequestHandler = createExpressErrorHandler();
