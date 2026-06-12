// buildApp() — assembles the Express app in the LOCKED middleware order
// (binding guideline 2 / README guideline 2). Do not reorder or insert ahead
// of the chain:
//   (0) correlation-ID injection
//   (1) light request logger (redacted; safe header allowlist only)
//   (2) CloudFront origin-secret validator (GET /health exempt; BEFORE body
//       parsers so rejected requests are never parsed)
//   (3) body parsers — express.json() with raw-body capture onto req.rawBody
//       (Twilio HMAC validation needs the exact bytes in Phase 1)
//   (4) routes
//   (last) expressErrorHandler
import express, { type Express, type Request } from 'express';
import { loadConfig, type AppConfig } from './lib/config.js';
import { createExpressErrorHandler } from './lib/errors.js';
import { logger as defaultLogger, type Logger } from './lib/logger.js';
import { correlationMiddleware } from './middleware/correlation.js';
import { originSecretMiddleware } from './middleware/originSecret.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { createApiRouter, type ApiRouterDeps } from './routes/api.js';
import { healthRouter } from './routes/health.js';
import { webhooksRouter } from './routes/webhooks/index.js';

/** Request with the raw body buffer captured by the JSON parser's verify hook. */
export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

export interface BuildAppDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Test seam: injected /api dependencies (fake send service, no DynamoDB). */
  api?: Pick<ApiRouterDeps, 'sendMessageService'>;
  /** Test seam: register extra routes after the built-ins, before the error handler. */
  configureRoutes?: (app: Express) => void;
}

export function buildApp(deps: BuildAppDeps = {}): Express {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;

  const app = express();
  app.disable('x-powered-by');

  // (0) correlation-ID injection
  app.use(correlationMiddleware());
  // (1) light request logger
  app.use(requestLoggerMiddleware(log));
  // (2) CloudFront origin-secret validator — BEFORE body parsers
  app.use(originSecretMiddleware({ secret: config.cfOriginSecret, logger: log }));
  // (3) body parsers, capturing the raw body for webhook HMAC validation
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = buf;
      },
    }),
  );

  // (4) routes
  app.use(healthRouter);
  app.use('/webhooks', webhooksRouter);
  app.use('/api', createApiRouter({ config, logger: log, ...deps.api }));
  deps.configureRoutes?.(app);

  // (last) error handler
  app.use(createExpressErrorHandler(log));

  return app;
}
