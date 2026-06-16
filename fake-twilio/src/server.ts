import path from 'node:path';
import express, { type Express } from 'express';
import type { FakeTwilioConfig } from './config.js';
import { FakeTwilioEngine } from './engine/engine.js';
import { RealClock } from './engine/clock.js';
import { WebhookDispatcher } from './engine/dispatcher.js';
import { createRestRouter } from './routes/rest.js';
import { createControlRouter } from './routes/control.js';
import { createEventsRouter } from './routes/events.js';

export interface FakeTwilioAppDeps {
  config: FakeTwilioConfig;
  /** Injectable for tests; defaults to a real-clock engine with a real dispatcher. */
  engine?: FakeTwilioEngine;
}

export function buildFakeTwilioApp(deps: FakeTwilioAppDeps): Express {
  // Defense in depth: refuse to construct the fake locally if NODE_ENV=production,
  // independent of the loadFakeConfig guard — it impersonates Twilio and must never
  // run in a deployed environment.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'fake-twilio refuses to start while NODE_ENV=production — it impersonates Twilio and must ' +
        'never run in a deployed environment.',
    );
  }

  // One engine per process — shared by the REST router (here) and, in a later
  // phase, the control router. Construct it once and pass it to every router.
  const engine =
    deps.engine ??
    new FakeTwilioEngine({
      clock: new RealClock(),
      dispatcher: new WebhookDispatcher({
        appBaseUrl: deps.config.appBaseUrl,
        appPublicBaseUrl: deps.config.appPublicBaseUrl,
        authToken: deps.config.authToken,
        // The app's origin-secret validator gates /webhooks/* (it runs BEFORE the
        // webhook routes in the locked chain), so signed webhook POSTs also need
        // the x-origin-verify header — pass the configured secret through.
        originSecret: deps.config.originSecret,
      }),
    });

  const app = express();
  // Twilio posts application/x-www-form-urlencoded; the control API uses JSON.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'fake-twilio' });
  });

  app.use(createRestRouter(engine));
  // The control router mounts here with the same `engine` instance.
  app.use(createControlRouter(engine));
  // SSE stream of engine events for the fake-phones UI (Plan 2).
  app.use(createEventsRouter(engine));

  // Static-serve the built fake-phones UI + SPA fallback, AFTER all API routers so
  // reserved prefixes are matched by their routers first; the fallback only catches
  // the remainder. Inert when uiDistDir is unset (no UI in plain test/scripted runs).
  if (deps.config.uiDistDir) {
    const distDir = path.resolve(deps.config.uiDistDir);
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    });
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      const reserved = ['/control', '/health', '/2010-04-01', '/webhooks'].some(
        (p) => req.path === p || req.path.startsWith(`${p}/`),
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

  return app;
}
