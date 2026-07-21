// fake-twilio/src/routes/sesControl.ts
//
// The fake-SES CONTROL surface - the scripted-test / e2e seam that reads what the
// app "sent" through the fake-SES REST surface and clears it. Mirrors control.ts
// (route factory + the `400 {error}` bad-input convention).
//
// It shares the `/control` prefix with the SMS + voice control routers but owns
// DISJOINT subpaths (`/control/emails`, `/control/reset-mail`) so neither router
// shadows the other - Express matches the first router whose path matches, and the
// path sets are disjoint (the voiceControl.ts precedent). It deliberately does NOT
// reuse the SMS `/control/reset` (that clears the messaging engine): mail is a
// SEPARATE engine, and createControlRouter(engine) exposes no callback seam to fold
// mail-clearing into the main reset without changing a shared router outside this
// slice's scope. The e2e fixture (fakeEmail.resetMail) calls `/control/reset-mail`
// explicitly for a clean slate; see .superpowers/sdd/slice-A7-report.md.
import { Router } from 'express';
import type { MailEngine, SendInboundOptions } from '../engine/mailEngine.js';

export function createSesControlRouter(mailEngine: MailEngine): Router {
  const router = Router();

  // GET /control/emails - every email the app has "sent", newest first.
  router.get('/control/emails', (_req, res) => {
    res.status(200).json({ emails: mailEngine.list() });
  });

  // GET /control/inbound-emails - every inbound email the fake delivered, newest
  // first (email-channel B4; test observability).
  router.get('/control/inbound-emails', (_req, res) => {
    res.status(200).json({ emails: mailEngine.listInbound() });
  });

  // POST /control/send-inbound-email (email-channel B4) - deliver ONE inbound email:
  // hand-roll MIME -> write to MinIO INBOUND_MAIL_BUCKET -> POST the SNS-shaped
  // receipt to the app's /webhooks/ses/inbound (with x-origin-verify). Body:
  // { from, to?, cc?, subject, text, html?, attachments?[{filename,contentType,
  // base64}], spamVerdict?, virusVerdict?, messageId?, inReplyTo?, references? }.
  // 400 on bad input; 502 when the send fails downstream (MinIO / the app POST).
  router.post('/control/send-inbound-email', async (req, res) => {
    const body = (req.body ?? {}) as Partial<SendInboundOptions>;
    if (typeof body.from !== 'string' || body.from.trim().length === 0) {
      res.status(400).json({ error: 'from is required' });
      return;
    }
    if (typeof body.subject !== 'string') {
      res.status(400).json({ error: 'subject is required (may be empty)' });
      return;
    }
    try {
      const result = await mailEngine.sendInbound({
        from: body.from,
        ...(Array.isArray(body.to) && { to: body.to }),
        ...(Array.isArray(body.cc) && { cc: body.cc }),
        subject: body.subject,
        text: typeof body.text === 'string' ? body.text : '',
        ...(typeof body.html === 'string' && { html: body.html }),
        ...(Array.isArray(body.attachments) && { attachments: body.attachments }),
        ...(body.spamVerdict !== undefined && { spamVerdict: body.spamVerdict }),
        ...(body.virusVerdict !== undefined && { virusVerdict: body.virusVerdict }),
        ...(typeof body.messageId === 'string' && { messageId: body.messageId }),
        ...(typeof body.inReplyTo === 'string' && { inReplyTo: body.inReplyTo }),
        ...(Array.isArray(body.references) && { references: body.references }),
      });
      res.status(200).json({
        bucket: result.bucket,
        key: result.key,
        posted: result.posted,
        appStatus: result.appStatus,
        sesMessageId: result.sesMessageId,
      });
    } catch (err) {
      // Downstream failure (inbound not configured / MinIO put / the app POST).
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // POST /control/reset-mail - clear the captured emails (disjoint from the SMS
  // /control/reset, which this router must NOT collide with).
  router.post('/control/reset-mail', (_req, res) => {
    try {
      mailEngine.reset();
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
