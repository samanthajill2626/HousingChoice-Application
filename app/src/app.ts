// buildApp() — assembles the Express app in the LOCKED middleware order
// (binding guideline 2 / README guideline 2). Do not reorder or insert ahead
// of the chain:
//   (0) correlation-ID injection
//   (1) light request logger (redacted; safe header allowlist only)
//   (2) CloudFront origin-secret validator (GET /health exempt; BEFORE body
//       parsers so rejected requests are never parsed)
//   (3) body parsers — express.json() AND express.urlencoded() (Twilio posts
//       application/x-www-form-urlencoded), both with raw-body capture onto
//       req.rawBody (Twilio HMAC validation needs the exact bytes)
//   (4) routes
//   (last) expressErrorHandler
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import express, { type Express, type Request } from 'express';
import { loadConfig, type AppConfig } from './lib/config.js';
import { createExpressErrorHandler } from './lib/errors.js';
import { logger as defaultLogger, type Logger } from './lib/logger.js';
import { requireAuth, sessionMiddleware } from './middleware/auth.js';
import { correlationMiddleware } from './middleware/correlation.js';
import { originSecretMiddleware } from './middleware/originSecret.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { createApiRouter, type ApiRouterDeps } from './routes/api.js';
import { createAuthRouter, type AuthRouterDeps } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { createWebhooksRouter, type WebhooksRouterDeps } from './routes/webhooks/index.js';

/** Request with the raw body buffer captured by the JSON parser's verify hook. */
export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

export interface BuildAppDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Test seam: injected /api dependencies (fake send service/repos/bus, no DynamoDB). */
  api?: Omit<ApiRouterDeps, 'config' | 'logger'>;
  /** Test seam: injected /webhooks dependencies (fake repos/adapter/media store). */
  webhooks?: Omit<WebhooksRouterDeps, 'config' | 'logger'>;
  /** Test seam: injected /auth dependencies (fake provider/repos — no Google, no DynamoDB). */
  auth?: Omit<AuthRouterDeps, 'config' | 'logger'>;
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
  // (3) body parsers, capturing the raw body for webhook HMAC validation.
  // Twilio webhooks post application/x-www-form-urlencoded, the dashboard
  // posts JSON — both parsers share the same raw-body-capture verify hook.
  const captureRawBody = (req: IncomingMessage, _res: ServerResponse, buf: Buffer): void => {
    (req as RequestWithRawBody).rawBody = buf;
  };
  app.use(express.json({ verify: captureRawBody }));
  app.use(express.urlencoded({ extended: false, verify: captureRawBody }));

  // (4) routes
  app.use(healthRouter);
  app.use('/webhooks', createWebhooksRouter({ config, logger: log, ...deps.webhooks }));
  // M1.3 auth — mounted HERE in the route stage, never ahead of the
  // origin-secret validator (locked chain). /auth itself is public by
  // design (login/callback/logout/me); EVERY /api route including the SSE
  // stream sits behind requireAuth (closing the accepted H4 exposure —
  // EventSource carries the session cookie fine). Webhooks keep their own
  // HMAC validation; GET /health stays public for the deploy gate.
  app.use('/auth', createAuthRouter({ config, logger: log, ...deps.auth }));
  app.use(
    '/api',
    sessionMiddleware({ config, logger: log, usersRepo: deps.auth?.usersRepo }),
    requireAuth(),
    createApiRouter({ config, logger: log, ...deps.api }),
  );
  deps.configureRoutes?.(app);

  // Dashboard static serving (M1.3): active only when DASHBOARD_DIST_DIR is
  // set — the Docker image points it at the built dashboard (/srv/app/public);
  // locally it stays unset (the Vite dev server owns the UI, proxying
  // /api + /auth here). SPA fallback: unmatched GETs outside the
  // api/webhooks/auth namespaces stream index.html (express.static/sendFile
  // stream from disk — guideline 1 holds).
  if (config.dashboardDistDir) {
    const distDir = path.resolve(config.dashboardDistDir);
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      const reserved = ['/api', '/webhooks', '/auth'].some(
        (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`),
      );
      if ((req.method !== 'GET' && req.method !== 'HEAD') || reserved) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
  }

  // (last) error handler
  app.use(createExpressErrorHandler(log));

  return app;
}
