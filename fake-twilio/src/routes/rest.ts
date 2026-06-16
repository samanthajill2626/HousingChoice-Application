// fake-twilio/src/routes/rest.ts
import { Router } from 'express';
import type { FakeTwilioEngine } from '../engine/engine.js';

/** Twilio REST impersonation: only the subset the app's driver calls today. */
export function createRestRouter(engine: FakeTwilioEngine): Router {
  const router = Router();

  // POST /2010-04-01/Accounts/:accountSid/Messages.json  (messages.create)
  router.post('/2010-04-01/Accounts/:accountSid/Messages.json', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const to = body['To'];
    if (!to) {
      // Twilio-shaped error: the real SDK builds a RestException from { code,
      // message, more_info, status } on non-2xx. `more_info` keeps its parser happy.
      res.status(400).json({
        code: 21604,
        message: "A 'To' phone number is required.",
        more_info: 'https://www.twilio.com/docs/errors/21604',
        status: 400,
      });
      return;
    }
    const mediaUrls = typeof body['MediaUrl'] === 'string' ? [body['MediaUrl']] : undefined;
    const sid = engine.recordOutboundFromApp({
      to,
      ...(body['From'] !== undefined && { from: body['From'] }),
      ...(body['Body'] !== undefined && { body: body['Body'] }),
      ...(mediaUrls !== undefined && { mediaUrls }),
    });
    // Twilio-shaped Message resource (snake_case JSON, as the SDK expects).
    res.status(201).json({
      sid,
      status: 'queued',
      to,
      from: body['From'] ?? null,
      body: body['Body'] ?? null,
      messaging_service_sid: body['MessagingServiceSid'] ?? null,
      date_created: new Date().toUTCString(),
      num_media: mediaUrls ? String(mediaUrls.length) : '0',
    });
  });

  // Deferred channels — visible 501 seams (voice, number provisioning).
  const notImplemented = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(501).json({
      code: 0,
      message: 'not-implemented-in-v1 (fake-twilio: SMS/MMS only)',
      more_info: '',
      status: 501,
    });
  router.post('/2010-04-01/Accounts/:accountSid/Calls.json', notImplemented as never);
  router.get('/2010-04-01/Accounts/:accountSid/AvailablePhoneNumbers/:country/Local.json', notImplemented as never);
  router.post('/2010-04-01/Accounts/:accountSid/IncomingPhoneNumbers.json', notImplemented as never);

  return router;
}
