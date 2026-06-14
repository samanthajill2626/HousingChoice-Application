// Webhooks router — Twilio Programmable Messaging lives at /webhooks/twilio/*
// (M1.1); Twilio Programmable Voice (masked calling) at /webhooks/twilio/voice/*
// (M1.9a); other providers (DocuSign, Stripe, SES) mount here in later phases.
// Anything unmatched stays a 404 seam.
import { Router } from 'express';
import { createTwilioWebhookRouter, type TwilioWebhookDeps } from './twilio.js';
import { createTwilioVoiceRouter, type TwilioVoiceWebhookDeps } from './voice.js';

export type WebhooksRouterDeps = TwilioWebhookDeps & TwilioVoiceWebhookDeps;

export function createWebhooksRouter(deps: WebhooksRouterDeps = {}): Router {
  const router = Router();
  // Voice (M1.9a) mounts FIRST so /twilio/voice/* is owned by the voice router;
  // the messaging router owns /twilio/sms + /twilio/status (distinct segments,
  // no collision with /twilio/voice/status).
  router.use('/twilio/voice', createTwilioVoiceRouter(deps));
  router.use('/twilio', createTwilioWebhookRouter(deps));
  // Seam: future provider webhooks mount above; everything else is a 404.
  router.use((_req, res) => {
    res.status(404).json({ error: 'not implemented' });
  });
  return router;
}
