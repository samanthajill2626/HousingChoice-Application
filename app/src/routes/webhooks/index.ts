// Webhooks router — Twilio Programmable Messaging lives at /webhooks/twilio/*
// (M1.1); other providers (DocuSign, Stripe, SES) mount here in later phases.
// Anything unmatched stays a 404 seam.
import { Router } from 'express';
import { createTwilioWebhookRouter, type TwilioWebhookDeps } from './twilio.js';

export type WebhooksRouterDeps = TwilioWebhookDeps;

export function createWebhooksRouter(deps: WebhooksRouterDeps = {}): Router {
  const router = Router();
  router.use('/twilio', createTwilioWebhookRouter(deps));
  // Seam: future provider webhooks mount above; everything else is a 404.
  router.use((_req, res) => {
    res.status(404).json({ error: 'not implemented' });
  });
  return router;
}
