// Twilio Event Streams sink webhook (relay-number-buying T3):
//   POST /webhooks/twilio/events - the A2P 10DLC number-registration signal.
// Twilio delivers a CloudEvents batch (a JSON ARRAY, D3) to a configured webhook
// Sink (T10). For each number-registration.successful event we correlate the
// bought+attached `warming` pool number by its PN SID (D2) and promote it to
// `active` so relay sends may originate from it. All other event types (pending /
// failed / de-registration) are logged only.
//
// Field names in the CloudEvents `data` object are concatenated-lowercase (D1),
// NOT snake_case: `phonenumbersid`, `phonenumber`, `messagingservicesid`.
//
// Delivery contract (D5): return HTTP 200 for EVERY handled / ignored / unknown /
// poison outcome so Twilio (which retries 5xx/429 with backoff up to 4h) does not
// hot-loop a poison event; return 5xx ONLY for a genuinely transient store error
// we want redelivered (promoteToActive is idempotent, so redelivery is safe).
//
// Auth (D4, pragmatic form): a shared secret carried in the Authorization header
// (Basic-auth-in-URL, Twilio's native webhook-sink mechanism), constant-time
// compared to config.twilioEventsWebhookSecret - NOT X-Twilio-Signature (that
// raw-body scheme has SDK nuance). UNSET secret => the check is SKIPPED (mirrors
// twilioSignatureMiddleware's `configured` flag) so the hermetic fake-twilio sink
// can POST without it; a deployed env sets the secret to enforce. The endpoint is
// also fronted by originSecretMiddleware in deployed envs (app.ts).
//
// PII (doc section 9): a phone number is PII - log outcomes / event markers only,
// never the number or the PN SID.
import express from 'express';
import type { RequestHandler, Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig, type AppConfig } from '../../lib/config.js';
import { logger as defaultLogger, type Logger } from '../../lib/logger.js';
import { createPoolNumbersService, type PoolNumbersService } from '../../services/poolNumbers.js';

/** CloudEvents `type` strings (schema v1) the sink delivers (D3). */
const REGISTRATION_SUCCESS_TYPE = 'com.twilio.messaging.compliance.number-registration.successful';
const DEREGISTRATION_SUCCESS_TYPE =
  'com.twilio.messaging.compliance.number-deregistration.successful';

/**
 * Pull the shared secret out of an Authorization header. Primary form is HTTP
 * Basic (Basic-auth-in-URL): `Basic base64(user:secret)` - the username is
 * ignored, the secret is the password (everything after the first colon). Falls
 * back to `Bearer <secret>` or a bare token so a non-Basic sink config still
 * works. undefined when there is no usable credential.
 */
function extractAuthCredential(authHeader: string | undefined): string | undefined {
  if (typeof authHeader !== 'string') return undefined;
  const trimmed = authHeader.trim();
  if (trimmed.length === 0) return undefined;
  const basic = /^Basic\s+(.+)$/i.exec(trimmed);
  if (basic?.[1] !== undefined) {
    let decoded: string;
    try {
      decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    } catch {
      return undefined;
    }
    const colon = decoded.indexOf(':');
    return colon >= 0 ? decoded.slice(colon + 1) : decoded;
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (bearer?.[1] !== undefined) return bearer[1];
  return trimmed;
}

/**
 * True when the request may proceed. When `secret` is unset (hermetic / local /
 * test) the check is SKIPPED (returns true) - a deployed env sets the secret to
 * enforce. Otherwise the header credential must constant-time match the secret.
 * Exported for direct unit testing.
 */
export function eventsRequestAuthorized(
  authHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (secret === undefined || secret.length === 0) return true; // unconfigured -> skip
  const provided = extractAuthCredential(authHeader);
  if (provided === undefined) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  // timingSafeEqual requires equal lengths; a length mismatch is a definite
  // non-match (the tiny length leak is irrelevant for a fixed shared secret).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface TwilioEventsWebhookDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Injectable for tests; the real service (promote + connect-when-ready) otherwise. */
  poolNumbersService?: PoolNumbersService;
}

export function createTwilioEventsRouter(deps: TwilioEventsWebhookDeps = {}): Router {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const poolNumbersService =
    deps.poolNumbersService ?? createPoolNumbersService({ config, logger: deps.logger });

  const router = express.Router();

  // Auth first: reject a bad/missing shared secret before parsing the body.
  const requireSharedSecret: RequestHandler = (req, res, next) => {
    if (eventsRequestAuthorized(req.headers.authorization, config.twilioEventsWebhookSecret)) {
      next();
      return;
    }
    log.warn(
      {
        event: 'twilio_events_auth_rejected',
        remoteIp: req.socket.remoteAddress ?? null,
        reason:
          req.headers.authorization === undefined
            ? 'authorization header missing'
            : 'shared secret mismatch',
      },
      'twilio events webhook rejected: bad or missing shared secret',
    );
    res.status(403).json({ error: 'forbidden' });
  };

  // Parse the CloudEvents batch regardless of content-type. When the app-level
  // express.json (app.ts) already parsed an application/json body this is a no-op
  // (body-parser short-circuits on req._body); type:()=>true additionally covers a
  // CloudEvents-batch content-type the app-level parser would skip. Shared-secret
  // auth needs no raw body (D4), so there is no verify hook here.
  const parseBatch = express.json({ type: () => true });

  // Base endpoint. The router mounts at /twilio/events (index.ts), so '/' here
  // resolves to POST /webhooks/twilio/events (mirrors the voice router's POST '/'
  // under its /twilio/voice mount).
  router.post('/', requireSharedSecret, parseBatch, async (req, res) => {
    const batch = req.body as unknown;
    if (!Array.isArray(batch)) {
      // Not a CloudEvents array (poison / unexpected shape). 200 so Twilio does
      // not hot-loop-retry a body that will not fix on redelivery (D5).
      log.warn(
        { event: 'twilio_events_bad_shape' },
        'twilio events webhook: body is not a CloudEvents array - ignoring',
      );
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    // LOOP the batch (D3 - do NOT index [0]); currently 1 element but the schema
    // is a batch. A store error on ANY element flags the whole batch for retry.
    let transientStoreError = false;
    for (const rawEvent of batch as unknown[]) {
      const ev = (rawEvent ?? {}) as { type?: unknown; data?: unknown };
      const type = typeof ev.type === 'string' ? ev.type : undefined;

      if (type === REGISTRATION_SUCCESS_TYPE) {
        const data = (ev.data ?? {}) as Record<string, unknown>;
        const phoneNumberSid = data.phonenumbersid; // D1: concatenated-lowercase
        if (typeof phoneNumberSid !== 'string' || phoneNumberSid.length === 0) {
          log.warn(
            { event: 'twilio_events_missing_sid' },
            'twilio events: registration event missing phonenumbersid - skipping',
          );
          continue;
        }
        const phoneNumber = typeof data.phonenumber === 'string' ? data.phonenumber : undefined;
        const messagingServiceSid =
          typeof data.messagingservicesid === 'string' ? data.messagingservicesid : undefined;
        try {
          await poolNumbersService.onNumberRegistered({
            phoneNumberSid,
            ...(phoneNumber !== undefined && { phoneNumber }),
            ...(messagingServiceSid !== undefined && { messagingServiceSid }),
          });
        } catch (err) {
          // The ONLY 5xx path (D5): a genuine store error - flag for retry.
          transientStoreError = true;
          log.error(
            { err, event: 'twilio_events_process_error' },
            'twilio events: onNumberRegistered failed - will retry (transient)',
          );
        }
      } else if (type === DEREGISTRATION_SUCCESS_TYPE) {
        // Future retirement signal (T8+). Log only for now.
        log.info(
          { event: 'twilio_events_deregistration', eventType: type },
          'twilio events: number de-registration - logged only',
        );
      } else {
        log.info(
          { event: 'twilio_events_ignored', eventType: type ?? null },
          'twilio events: ignored event type',
        );
      }
    }

    if (transientStoreError) {
      // 5xx ONLY for a transient store error we want redelivered (D5).
      res.status(500).json({ error: 'retry' });
      return;
    }
    res.status(200).json({ ok: true });
  });

  return router;
}
