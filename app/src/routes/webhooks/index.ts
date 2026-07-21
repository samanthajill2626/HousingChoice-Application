// Webhooks router — Twilio Programmable Messaging lives at /webhooks/twilio/*
// (M1.1); Twilio Programmable Voice (masked calling) at /webhooks/twilio/voice/*
// (M1.9a); other providers (DocuSign, Stripe, SES) mount here in later phases.
// Anything unmatched stays a 404 seam.
import { Router } from 'express';
import { loadConfig } from '../../lib/config.js';
import { createTwilioWebhookRouter, type TwilioWebhookDeps } from './twilio.js';
import { createTwilioVoiceRouter, type TwilioVoiceWebhookDeps } from './voice.js';
import { createSesWebhookRouter, type SesWebhookDeps } from './ses.js';

export type WebhooksRouterDeps = TwilioWebhookDeps & TwilioVoiceWebhookDeps & SesWebhookDeps;

export function createWebhooksRouter(deps: WebhooksRouterDeps = {}): Router {
  const router = Router();
  // Voice (M1.9a) mounts FIRST so /twilio/voice/* is owned by the voice router;
  // the messaging router owns /twilio/sms + /twilio/status (distinct segments,
  // no collision with /twilio/voice/status).
  router.use('/twilio/voice', createTwilioVoiceRouter(deps));
  router.use('/twilio', createTwilioWebhookRouter(deps));
  // SES inbound (email-channel B4): DEV-GATED. There is NO existing conditional-
  // mount precedent - both twilio routers are ALWAYS mounted (review F15). We
  // mount /ses ONLY when config.sesApiBaseUrl is set, because prod inbound is
  // SQS-only (the worker's second SqsJobConsumer). The route's PROD SAFETY rests
  // ENTIRELY on: (1) A3's loadConfig boot-throw rejecting SES_API_BASE_URL under
  // NODE_ENV=production (so sesApiBaseUrl is never set in prod -> this branch
  // never mounts), plus (2) the x-origin-verify origin-secret middleware that
  // gates all /webhooks/*. The ses.ts handler ALSO refuses at request time in
  // production (m6 belt+braces). Mounted BEFORE the 404 seam.
  const config = deps.config ?? loadConfig();
  if (config.sesApiBaseUrl !== undefined) {
    router.use('/ses', createSesWebhookRouter(deps));
  }
  // Seam: future provider webhooks mount above; everything else is a 404.
  router.use((_req, res) => {
    res.status(404).json({ error: 'not implemented' });
  });
  return router;
}
