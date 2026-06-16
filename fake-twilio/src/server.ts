import express, { type Express } from 'express';
import type { FakeTwilioConfig } from './config.js';
import { FakeTwilioEngine } from './engine/engine.js';
import { RealClock } from './engine/clock.js';
import { WebhookDispatcher } from './engine/dispatcher.js';
import { createRestRouter } from './routes/rest.js';
import { createControlRouter } from './routes/control.js';

export interface FakeTwilioAppDeps {
  config: FakeTwilioConfig;
  /** Injectable for tests; defaults to a real-clock engine with a real dispatcher. */
  engine?: FakeTwilioEngine;
}

export function buildFakeTwilioApp(deps: FakeTwilioAppDeps): Express {
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
  return app;
}
