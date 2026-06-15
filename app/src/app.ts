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
import express, { type Express, type Request, type Router } from 'express';
import { loadConfig, type AppConfig } from './lib/config.js';
import { createExpressErrorHandler } from './lib/errors.js';
import { logger as defaultLogger, type Logger } from './lib/logger.js';
import { createSessionEpochCache, requireAuth, sessionMiddleware } from './middleware/auth.js';
import { correlationMiddleware } from './middleware/correlation.js';
import { csrfOriginMiddleware } from './middleware/csrfOrigin.js';
import { originSecretMiddleware } from './middleware/originSecret.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { createRateLimit } from './middleware/rateLimit.js';
import { createApiRouter, type ApiRouterDeps } from './routes/api.js';
import { createAuthRouter, type AuthRouterDeps } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { createPublicRouter, type PublicRouterDeps } from './routes/public.js';
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
  /** Test seam: injected /public dependencies (fake repos/send service — no DynamoDB). */
  public?: Omit<PublicRouterDeps, 'logger'>;
  /** Test seam: register extra routes after the built-ins, before the error handler. */
  configureRoutes?: (app: Express) => void;
  /** Pre-built dev-only router, supplied by the composition root when gated on.
   *  Mounted at the same trust level as /health (exempt from the origin-secret
   *  validator). Undefined in normal runs. */
  devRouter?: Router;
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
  // Every response carries nosniff — applied globally here so /health and the
  // dev router (both exempt from the origin-secret validator below) inherit it
  // too. The dashboard static/SPA block below adds the full browser-hardening
  // set on top of this.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  // Health — exempt from the origin-secret validator (deploy health-checks
  // arrive via localhost without the header).
  app.use(healthRouter);
  // Dev-only endpoints, gated at the composition root. Mounted here (before the
  // origin-secret validator, like /health) so the e2e harness and tests can
  // reach them without the CloudFront header. Absent in normal runs.
  if (deps.devRouter) app.use(deps.devRouter);
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
  app.use('/webhooks', createWebhooksRouter({ config, logger: log, ...deps.webhooks }));
  // M1.5 PUBLIC, UNAUTHENTICATED intake surface — the ONE place requireAuth is
  // intentionally absent (housing-fair form + flyer have no session). Mounted
  // HERE in the route stage, so the locked chain is intact: it still sits
  // BEHIND the origin-secret validator (stage 2 — applies to everything but
  // /health) and the body parsers (stage 3), and it is NEVER placed behind the
  // /api requireAuth gate below. A per-IP rate limiter fronts ALL /public
  // routes (the abuse fence on an unauthenticated, SMS-spending surface); the
  // router itself re-validates everything and never logs PII.
  app.use(
    '/public',
    createRateLimit({
      max: config.publicRateLimitMax,
      windowMs: config.publicRateLimitWindowMs,
      logger: log,
    }),
    createPublicRouter({ logger: log, ...deps.public }),
  );
  // M1.3 auth — mounted HERE in the route stage, never ahead of the
  // origin-secret validator (locked chain). /auth itself is public by
  // design (login/callback/logout/me); EVERY /api route including the SSE
  // stream sits behind requireAuth (closing the accepted H4 exposure —
  // EventSource carries the session cookie fine). Webhooks keep their own
  // HMAC validation; GET /health stays public for the deploy gate.
  //
  // ONE session-epoch cache shared by the /auth and /api mounts, so a
  // logout's eviction revokes on both immediately (middleware/auth.ts).
  const sessionEpochCache = deps.auth?.sessionEpochCache ?? createSessionEpochCache();
  app.use('/auth', createAuthRouter({ config, logger: log, ...deps.auth, sessionEpochCache }));
  app.use(
    '/api',
    // CSRF origin check FIRST (a cheap header compare — no point opening
    // session crypto for a request we refuse). See middleware/csrfOrigin.ts
    // for the two-control design (this + SameSite=Lax).
    csrfOriginMiddleware({ config, logger: log }),
    sessionMiddleware({
      config,
      logger: log,
      usersRepo: deps.auth?.usersRepo,
      epochCache: sessionEpochCache,
    }),
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
    // Browser-hardening headers on everything the dashboard surface serves
    // (assets + the SPA fallback — /api, /auth and /webhooks were routed
    // above and never reach here). The CSP is the tightest one the Vite
    // build output actually satisfies — verified against dashboard/dist:
    // index.html loads only external /assets/*.js + *.css (no inline
    // <script>/<style>), so script-src stays 'self'; the ONE allowance is
    // style-src 'unsafe-inline', required because the React shell styles via
    // inline style={} attributes (dashboard/src/App.tsx), which CSP governs
    // as inline styles. frame-ancestors 'none' + X-Frame-Options DENY
    // (legacy UAs) forbid framing; Referrer-Policy keeps paths out of
    // cross-origin referrers; nosniff is already set app-wide above.
    const spaCsp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', spaCsp);
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      next();
    });
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      const reserved = ['/api', '/webhooks', '/auth', '/public'].some(
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
