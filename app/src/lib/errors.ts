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
  return value instanceof Error ? value : new Error(String(value));
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
    withFallback(() => log.fatal({ err }, 'uncaughtException — exiting'));
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
 * Express error-handling middleware (mounted LAST). Logs the error with full
 * stack — the pino mixin attaches the request's correlation context — and
 * responds 500 JSON. If headers were already sent, delegates to Express's
 * default handler.
 */
export function createExpressErrorHandler(log: Logger = defaultLogger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      log.error(
        { err: toError(err), method: req.method, path: req.path },
        'unhandled error while handling request',
      );
      next(err);
      return;
    }
    // A malformed %-escape in the URL path/params makes Express's route matcher
    // throw URIError (decodeURIComponent) BEFORE any handler runs. That is a
    // client error (a bad request), NOT a server fault — respond 400 and WARN
    // (not ERROR), so it never trips the hc-<env>-error-logs alarm.
    if (err instanceof URIError) {
      log.warn(
        { err: toError(err), method: req.method, path: req.path },
        'malformed URI in request — rejected as 400',
      );
      res.status(400).json({ error: 'bad request' });
      return;
    }
    log.error(
      { err: toError(err), method: req.method, path: req.path },
      'unhandled error while handling request',
    );
    res.status(500).json({ error: 'internal server error' });
  };
}

/** Default error handler bound to the process-wide logger. */
export const expressErrorHandler: ErrorRequestHandler = createExpressErrorHandler();
