// fake-twilio/src/routes/sesRest.ts
//
// The fake AWS SESv2 SendEmail REST surface the app's @aws-sdk/client-sesv2 hits
// when EMAIL_DRIVER=ses + SES_API_BASE_URL points at this host (e2e/dev). The SDK
// serializes SendEmailCommand (raw content) to:
//   POST /v2/email/outbound-emails
//     body { Content: { Raw: { Data: <base64 MIME> } }, FromEmailAddress?, Destination? }
//   200 -> { MessageId }
// We accept the Raw.Data base64, hand it to the MailEngine (decode -> string-scan
// headers -> store -> emit), and echo the minted sesMessageId back as MessageId.
// FromEmailAddress / Destination may be present but are UNUSED - the raw MIME is
// authoritative. Mirrors intelligenceRest.ts conventions (route factory + a
// service-shaped 400 body the SDK surfaces as an error).
import { Router } from 'express';
import type { MailEngine } from '../engine/mailEngine.js';

export function createSesRestRouter(mailEngine: MailEngine): Router {
  const router = Router();

  // POST /v2/email/outbound-emails - SESv2 SendEmail with raw MIME content.
  router.post('/v2/email/outbound-emails', (req, res) => {
    const body = (req.body ?? {}) as { Content?: { Raw?: { Data?: unknown } } };
    const data = body.Content?.Raw?.Data;
    if (typeof data !== 'string' || data.length === 0) {
      // SESv2 surfaces service faults as { message, type }; the SDK maps a 400 to a
      // BadRequestException. Enough shape for the app's adapter to see a clean error.
      res.status(400).json({
        message: 'Content.Raw.Data (base64-encoded MIME) is required.',
        type: 'BadRequestException',
      });
      return;
    }
    const email = mailEngine.recordOutbound(data);
    res.status(200).json({ MessageId: email.sesMessageId });
  });

  return router;
}
