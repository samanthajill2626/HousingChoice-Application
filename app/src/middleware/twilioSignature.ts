// Twilio webhook signature validator (doc §7.1 / §9 "every webhook received
// (verified/rejected)") — mounted on the /webhooks/twilio/* routes only,
// AFTER the locked chain's body parsers (it validates the PARSED form params).
//
// Twilio signs every webhook: X-Twilio-Signature =
// base64(HMAC-SHA1(authToken, fullUrl + sorted-concatenated POST params)).
// Verification uses the twilio package's validateRequest (never hand-rolled).
// The full URL is reconstructed as config.publicBaseUrl + req.originalUrl —
// the app sits behind CloudFront, so the Host header is NOT reliable.
//
// Unconfigured (no auth token / no public base URL):
//   production  -> fail CLOSED: 403 + ERROR log (the error-logs alarm fires —
//                  a misconfigured prod stack must never accept unsigned
//                  webhooks).
//   development -> allow with a WARN: the console-driver local loop has no
//                  real Twilio signatures to verify.
//
// Rejections: 403, WARN log with correlation — NEVER the body (PII, doc §9) —
// and nothing persisted (this runs before any handler touches a repo).
import type { RequestHandler } from 'express';
import twilio from 'twilio';
import type { RequestWithRawBody } from '../app.js';
import type { Logger } from '../lib/logger.js';

export interface TwilioSignatureOptions {
  /** TWILIO_AUTH_TOKEN — reserved for webhook HMAC validation (never REST). */
  authToken?: string | undefined;
  /** PUBLIC_BASE_URL — `https://<cloudfront domain>`, no trailing slash. */
  publicBaseUrl?: string | undefined;
  nodeEnv: string;
  logger: Logger;
}

export function twilioSignatureMiddleware(opts: TwilioSignatureOptions): RequestHandler {
  const { authToken, publicBaseUrl, nodeEnv, logger } = opts;
  const configured = Boolean(authToken) && Boolean(publicBaseUrl);

  return (req, res, next) => {
    if (!configured) {
      if (nodeEnv === 'production') {
        // Fail closed: in production a missing token/base URL is an outage,
        // not a bypass. ERROR level on purpose — this IS the alarm.
        logger.error(
          { path: req.path, missing: { twilioAuthToken: !authToken, publicBaseUrl: !publicBaseUrl } },
          'twilio webhook REJECTED: signature validation unconfigured in production (fail closed)',
        );
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      logger.warn(
        { path: req.path },
        'twilio webhook accepted WITHOUT signature validation (unconfigured — local dev only)',
      );
      next();
      return;
    }

    const signature = req.headers['x-twilio-signature'];
    // The exact public URL Twilio signed — never trust the Host header.
    const url = `${publicBaseUrl}${req.originalUrl}`;
    // Parsed application/x-www-form-urlencoded params (locked-chain stage 3).
    const params = (req.body ?? {}) as Record<string, string>;

    const valid =
      typeof signature === 'string' && twilio.validateRequest(authToken as string, signature, url, params);
    if (!valid) {
      // Correlation rides the pino mixin; the body is NEVER logged. The
      // `event` marker is the stable field the observability module's
      // WebhookSignatureRejections metric filter keys on (doc §9 "Webhook
      // failures") — behind CloudFront+origin-secret a sustained rejection
      // means an auth-token misconfig after rotation = every inbound lost.
      logger.warn(
        {
          event: 'webhook_signature_rejected',
          path: req.path,
          remoteIp: req.socket.remoteAddress ?? null,
          reason: typeof signature === 'string' ? 'signature mismatch' : 'signature header missing',
        },
        'twilio webhook rejected: invalid X-Twilio-Signature',
      );
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    next();
  };
}

/**
 * JSON-body sibling of twilioSignatureMiddleware for Twilio webhooks that POST
 * application/json (Voice Intelligence completion events, voice-transcription
 * spec 3.3). Twilio signs these with the bodySHA256 scheme: the webhook URL
 * carries a `?bodySHA256=<sha256hex(rawBody)>` query param, and
 * X-Twilio-Signature = base64(HMAC-SHA1(authToken, fullUrl)) over that full URL
 * with NO form params. Validation therefore runs over req.rawBody (the exact
 * bytes app.ts captured via the json parser's verify hook) and the full
 * originalUrl (which carries the bodySHA256 param). Unconfigured behavior and
 * rejection posture mirror the form middleware above exactly.
 */
export function twilioJsonSignatureMiddleware(opts: TwilioSignatureOptions): RequestHandler {
  const { authToken, publicBaseUrl, nodeEnv, logger } = opts;
  const configured = Boolean(authToken) && Boolean(publicBaseUrl);

  return (req, res, next) => {
    if (!configured) {
      if (nodeEnv === 'production') {
        // Fail closed: same posture as the form middleware - a missing
        // token/base URL in production is an outage, not a bypass.
        logger.error(
          { path: req.path, missing: { twilioAuthToken: !authToken, publicBaseUrl: !publicBaseUrl } },
          'twilio JSON webhook REJECTED: signature validation unconfigured in production (fail closed)',
        );
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      logger.warn(
        { path: req.path },
        'twilio JSON webhook accepted WITHOUT signature validation (unconfigured - local dev only)',
      );
      next();
      return;
    }

    const signature = req.headers['x-twilio-signature'];
    // The exact public URL Twilio signed, INCLUDING the ?bodySHA256=... query.
    const url = `${publicBaseUrl}${req.originalUrl}`;
    // The raw request bytes app.ts captured (json parser verify hook) -
    // validateRequestWithBody re-hashes these and checks them against the
    // bodySHA256 query param, then validates the URL signature with no params.
    const rawBody = (req as RequestWithRawBody).rawBody?.toString('utf8') ?? '';

    const valid =
      typeof signature === 'string' &&
      twilio.validateRequestWithBody(authToken as string, signature, url, rawBody);
    if (!valid) {
      // Same rejection shape/marker as the form middleware (the webhook-failure
      // metric keys on `event`); the body is NEVER logged (PII).
      logger.warn(
        {
          event: 'webhook_signature_rejected',
          path: req.path,
          remoteIp: req.socket.remoteAddress ?? null,
          reason: typeof signature === 'string' ? 'signature mismatch' : 'signature header missing',
        },
        'twilio JSON webhook rejected: invalid X-Twilio-Signature',
      );
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    next();
  };
}
