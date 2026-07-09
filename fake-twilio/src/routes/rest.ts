// fake-twilio/src/routes/rest.ts
import { Router } from 'express';
import type { FakeTwilioEngine } from '../engine/engine.js';

/** First value of a param that may arrive as a string or (repeated) string[]. */
function firstString(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.find((x) => typeof x === 'string');
  return undefined;
}

/**
 * Normalize the MediaUrl param to a string[]. The Twilio SDK sends ONE MediaUrl
 * param per attachment; Express's urlencoded parser surfaces a single value as a
 * string and repeated values as a string[]. Accept both so a multi-attachment
 * send records every URL faithfully (single string still works). Returns
 * undefined when there is no media so num_media stays '0'.
 */
export function normalizeMediaUrls(v: string | string[] | undefined): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) {
    const urls = v.filter((x): x is string => typeof x === 'string');
    return urls.length > 0 ? urls : undefined;
  }
  return undefined;
}

/** Twilio REST impersonation: only the subset the app's driver calls today. */
export function createRestRouter(engine: FakeTwilioEngine): Router {
  const router = Router();

  // POST /2010-04-01/Accounts/:accountSid/Messages.json  (messages.create)
  router.post('/2010-04-01/Accounts/:accountSid/Messages.json', (req, res) => {
    // Body values are usually strings, but a MULTI-attachment send repeats the
    // MediaUrl param, which Express's urlencoded parser collapses into an array.
    const body = (req.body ?? {}) as Record<string, string | string[]>;
    const to = firstString(body['To']);
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
    const from = firstString(body['From']);
    const messageBody = firstString(body['Body']);
    const messagingServiceSid = firstString(body['MessagingServiceSid']);
    const mediaUrls = normalizeMediaUrls(body['MediaUrl']);
    const sid = engine.recordOutboundFromApp({
      to,
      ...(from !== undefined && { from }),
      ...(messageBody !== undefined && { body: messageBody }),
      ...(mediaUrls !== undefined && { mediaUrls }),
    });
    // Twilio-shaped Message resource (snake_case JSON, as the SDK expects).
    res.status(201).json({
      sid,
      status: 'queued',
      to,
      from: from ?? null,
      body: messageBody ?? null,
      messaging_service_sid: messagingServiceSid ?? null,
      date_created: new Date().toUTCString(),
      num_media: mediaUrls ? String(mediaUrls.length) : '0',
    });
  });

  // Voice + number-provisioning (Calls.json, AvailablePhoneNumbers,
  // IncomingPhoneNumbers) are handled by the voiceRest router (Phase 6) - the
  // former 501 stubs here are gone now that those routes are real.

  return router;
}
