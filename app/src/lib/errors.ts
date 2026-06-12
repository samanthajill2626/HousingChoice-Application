// Errors are first-class logs (binding guideline 4): process-level handlers
// and the Express error middleware all log full stack + correlation context.
import type { ErrorRequestHandler } from 'express';
import { logger as defaultLogger, type Logger } from './logger.js';

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Install uncaughtException / unhandledRejection handlers.
 * uncaughtException: log fatal (full stack), flush, exit 1.
 * unhandledRejection: log error (full stack) and keep running.
 */
export function installProcessErrorHandlers(log: Logger = defaultLogger): void {
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaughtException — exiting');
    // Flush pino's buffer before exiting; fall back to a hard exit if the
    // flush callback never fires.
    const forceExit = setTimeout(() => process.exit(1), 2000);
    forceExit.unref();
    log.flush(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason, promise) => {
    log.error({ err: toError(reason), promise: String(promise) }, 'unhandledRejection');
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
    log.error(
      { err: toError(err), method: req.method, path: req.path },
      'unhandled error while handling request',
    );
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: 'internal server error' });
  };
}

/** Default error handler bound to the process-wide logger. */
export const expressErrorHandler: ErrorRequestHandler = createExpressErrorHandler();
