import express, { type Express } from 'express';
import type { FakeTwilioConfig } from './config.js';

export interface FakeTwilioAppDeps {
  config: FakeTwilioConfig;
}

export function buildFakeTwilioApp(deps: FakeTwilioAppDeps): Express {
  const app = express();
  // Twilio posts application/x-www-form-urlencoded; the control API uses JSON.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'fake-twilio' });
  });

  // Routes are mounted in later phases.
  void deps;
  return app;
}
