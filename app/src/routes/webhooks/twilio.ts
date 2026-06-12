// Twilio Programmable Messaging webhooks (M1.1 Builder B, doc §7.1):
//   POST /webhooks/twilio/sms     — the Messaging Service's inbound webhook
//   POST /webhooks/twilio/status  — its delivery status callback
// Both arrive as application/x-www-form-urlencoded (parsed by the locked
// chain's urlencoded parser, raw bytes on req.rawBody) and are signature-
// verified by twilioSignatureMiddleware before any handler runs.
//
// PII (doc §9): message bodies and media URLs are NEVER logged — log lines
// carry SIDs/IDs/lengths only, correlated via the pino mixin.
import { Router } from 'express';
import type { MediaStore } from '../../adapters/mediaStore.js';
import { createMediaStore } from '../../adapters/mediaStore.js';
import {
  createMessagingAdapter,
  mapTwilioStatus,
  type MessagingAdapter,
} from '../../adapters/messaging.js';
import { mergeContext } from '../../lib/context.js';
import { loadConfig, type AppConfig } from '../../lib/config.js';
import { logger as defaultLogger, type Logger } from '../../lib/logger.js';
import { twilioSignatureMiddleware } from '../../middleware/twilioSignature.js';
import { createAuditRepo, type AuditRepo } from '../../repos/auditRepo.js';
import { createContactsRepo, type ContactsRepo } from '../../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationsRepo,
} from '../../repos/conversationsRepo.js';
import { createMessagesRepo, type MessagesRepo } from '../../repos/messagesRepo.js';
import {
  enqueueSendRetry,
  MAX_SEND_RETRY_ATTEMPTS,
} from '../../jobs/retrySend.js';

/** Empty TwiML acknowledgment — "received, no reply instructions". */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

// Standard stop/start keywords (Twilio Advanced Opt-Out's defaults). Twilio
// auto-replies at the provider; OUR job is recording the suppression state.
const STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_KEYWORDS = new Set(['START', 'UNSTOP', 'YES']);

/** The webhook form fields this module reads (all optional strings). */
type WebhookParams = Record<string, string | undefined>;

function asParams(body: unknown): WebhookParams {
  return (typeof body === 'object' && body !== null ? body : {}) as WebhookParams;
}

export interface TwilioWebhookDeps {
  config?: AppConfig;
  logger?: Logger;
  adapter?: MessagingAdapter;
  mediaStore?: MediaStore;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  contactsRepo?: ContactsRepo;
  auditRepo?: AuditRepo;
}

export function createTwilioWebhookRouter(deps: TwilioWebhookDeps = {}): Router {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const adapter = deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger });
  const mediaStore = deps.mediaStore ?? createMediaStore({ config });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const ourNumbers = new Set(config.ourPhoneNumbers);

  const router = Router();
  const verifySignature = twilioSignatureMiddleware({
    authToken: config.twilioAuthToken,
    publicBaseUrl: config.publicBaseUrl,
    nodeEnv: config.nodeEnv,
    logger: log,
  });

  // ---------------------------------------------------------------------
  // Inbound message webhook — pipeline order per doc §7.1.
  // ---------------------------------------------------------------------
  router.post('/sms', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    const { MessageSid, From, Body, OptOutType } = params;
    if (!MessageSid || !From) {
      log.warn(
        { hasMessageSid: Boolean(MessageSid), hasFrom: Boolean(From) },
        'twilio inbound webhook missing MessageSid/From — rejected',
      );
      res.status(400).json({ error: 'bad request' });
      return;
    }

    // (1) Echo/author check FIRST (doc §7.1 defense 1): From matching one of
    // OUR numbers means this is our own outbound projected back — acknowledge
    // and STOP, no side-effect pipeline. From-match is the deterministic
    // core; Direction/SmsStatus params can corroborate but are not relied on.
    if (ourNumbers.has(From)) {
      log.info({ providerSid: MessageSid }, 'twilio webhook echo (From is our number) — acknowledged, dropped');
      res.type('text/xml').send(EMPTY_TWIML);
      return;
    }

    // (2) Resolve contact + conversation. Unknown phones still get a
    // conversation (auto-capture of contacts is M1.2).
    const contact = await contacts.findByPhone(From);
    const conversation = await conversations.createOrGetByParticipantPhone(
      From,
      contact?.type === 'landlord' ? 'landlord_1to1' : 'tenant_1to1',
    );
    mergeContext({ conversationId: conversation.conversationId });

    const numMedia = Number(params['NumMedia'] ?? 0) || 0;
    const mediaUrls: string[] = [];
    for (let i = 0; i < numMedia; i++) {
      const url = params[`MediaUrl${i}`];
      if (typeof url === 'string' && url.length > 0) mediaUrls.push(url);
    }

    // (3) Idempotency by MessageSid (doc §7.1 defense 2): the conditional
    // append dedupes Twilio redeliveries AND the webhook copy of our own
    // sends (persisted at send time by the send wrapper) — layer 2 behind
    // the From-match. Inbound webhooks carry no provider timestamp, so
    // provider_ts is first-seen receipt time; dedupe stays exact regardless
    // because the SID-pointer write in the same transaction collides.
    const providerTs = new Date().toISOString();
    const appended = await messages.append({
      conversationId: conversation.conversationId,
      providerSid: MessageSid,
      providerTs,
      type: mediaUrls.length > 0 ? 'mms' : 'sms',
      direction: 'inbound',
      author: contact?.type === 'landlord' ? 'landlord' : 'tenant',
      // Inbound messages are received by definition; the outbound delivery
      // machine never transitions them.
      deliveryStatus: 'delivered',
      ...(Body !== undefined && Body.length > 0 && { body: Body }),
      ...(mediaUrls.length > 0 && { mediaUrls }),
    });
    if (appended.deduped) {
      log.info({ providerSid: MessageSid }, 'twilio inbound webhook deduped (redelivery or send-time copy) — acknowledged');
      res.type('text/xml').send(EMPTY_TWIML);
      return;
    }

    // From here on the message is persisted: side-effect failures must never
    // crash the webhook (a 5xx would trigger a redelivery that dedupes at the
    // append and SKIPS these steps — so failures are ERROR-logged + alarmed,
    // not retried-by-Twilio).

    // (4) STOP/opt-out recording (doc §7.1; Twilio Advanced Opt-Out already
    // auto-replied at the provider). The message itself stays on the
    // timeline either way (persisted above).
    try {
      const keyword = (Body ?? '').trim().toUpperCase();
      const optedOut = OptOutType === 'STOP' || STOP_KEYWORDS.has(keyword);
      const optedIn = !optedOut && (OptOutType === 'START' || START_KEYWORDS.has(keyword));
      if (optedOut || optedIn) {
        if (!contact) {
          log.warn(
            { providerSid: MessageSid, optOut: optedOut },
            'opt-out/in received from a phone with no contact record — nothing to flag (auto-capture is M1.2)',
          );
        } else if (optedOut) {
          await contacts.setFlag(contact.contactId, 'sms_opt_out');
          await audit.append(`contacts#${contact.contactId}`, 'sms_opt_out_recorded', {
            providerSid: MessageSid,
            conversationId: conversation.conversationId,
            source: OptOutType === 'STOP' ? 'OptOutType' : 'keyword',
          });
        } else {
          await contacts.clearFlag(contact.contactId, 'sms_opt_out');
          await audit.append(`contacts#${contact.contactId}`, 'sms_opt_out_cleared', {
            providerSid: MessageSid,
            conversationId: conversation.conversationId,
            source: OptOutType === 'START' ? 'OptOutType' : 'keyword',
          });
        }
      }
    } catch (err) {
      log.error({ err, providerSid: MessageSid }, 'opt-out recording failed — message persisted, flag NOT updated');
    }

    // (5) MMS media — mirror each MediaUrl{i} into S3 under
    // media/<conversationId>/<MessageSid>/<i>, streams only. Mirroring runs
    // before the ack on purpose (decision): counts are tiny (<=10) and well
    // inside Twilio's 15s webhook window, and a failure here must leave a
    // usable message record (the provider mediaUrls stay on the item) plus a
    // correlated ERROR — never a crash, never a dropped message.
    if (mediaUrls.length > 0) {
      if (!mediaStore) {
        const line = 'inbound MMS media NOT mirrored — MEDIA_BUCKET is not configured';
        if (config.nodeEnv === 'production') log.error({ providerSid: MessageSid, mediaCount: mediaUrls.length }, line);
        else log.warn({ providerSid: MessageSid, mediaCount: mediaUrls.length }, line);
      } else {
        const keys: string[] = [];
        for (const [i, url] of mediaUrls.entries()) {
          const key = `media/${conversation.conversationId}/${MessageSid}/${i}`;
          try {
            const stream = await adapter.getMediaStream(url);
            await mediaStore.put(key, stream, params[`MediaContentType${i}`]);
            keys.push(key);
          } catch (err) {
            log.error(
              { err, providerSid: MessageSid, mediaIndex: i },
              'media mirror failed — message record keeps the provider URL',
            );
          }
        }
        if (keys.length > 0) {
          try {
            await messages.annotateMessage(conversation.conversationId, appended.tsMsgId, { mediaS3Keys: keys });
          } catch (err) {
            log.error({ err, providerSid: MessageSid }, 'failed to record mirrored media keys on the message');
          }
        }
      }
    }

    // (6) Inbox touch, then acknowledge with empty TwiML.
    try {
      await conversations.touchLastActivity(conversation.conversationId, Body || undefined, providerTs);
    } catch (err) {
      log.error({ err, providerSid: MessageSid }, 'touchLastActivity failed — message persisted, inbox stale');
    }
    log.info(
      {
        providerSid: MessageSid,
        direction: 'inbound',
        bodyLength: Body?.length ?? 0,
        mediaCount: mediaUrls.length,
      },
      'twilio inbound message processed',
    );
    res.type('text/xml').send(EMPTY_TWIML);
  });

  // ---------------------------------------------------------------------
  // Delivery status callback — error-class-aware handling (doc §7.1).
  // ---------------------------------------------------------------------
  router.post('/status', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    const { MessageSid, MessageStatus, ErrorCode } = params;
    if (!MessageSid || !MessageStatus) {
      log.warn(
        { hasMessageSid: Boolean(MessageSid), hasMessageStatus: Boolean(MessageStatus) },
        'twilio status callback missing MessageSid/MessageStatus — rejected',
      );
      res.status(400).json({ error: 'bad request' });
      return;
    }

    // Context recovery by lookup (doc §9): status callbacks cannot carry the
    // correlation envelope — MessageSid → message → conversation.
    const message = await messages.getByProviderSid(MessageSid);
    if (!message) {
      // Unknown SID is a WARN + 200, never a 500 (e.g. a message sent
      // outside the platform, or a race with the send-time persist).
      log.warn({ providerSid: MessageSid, providerStatus: MessageStatus }, 'status callback for unknown provider SID — ignored');
      res.status(200).end();
      return;
    }
    mergeContext({ conversationId: message.conversationId });

    // Forward-only transition; false = regression/duplicate → side effects
    // are SKIPPED, which also makes redelivered failure callbacks enqueue
    // exactly one retry.
    const transitioned = await messages.updateDeliveryStatus(
      MessageSid,
      mapTwilioStatus(MessageStatus),
      ErrorCode,
    );
    log.info(
      { providerSid: MessageSid, providerStatus: MessageStatus, errorCode: ErrorCode, transitioned },
      'twilio delivery status callback processed',
    );

    if (transitioned && ErrorCode) {
      // TODO(M1.10) escalation-queue seam: a failed send on an ACTIVE CASE
      // must also drop an escalation item so a human calls (doc §7.1).
      // Cases do not exist until M1.10 — nothing is built here yet.
      try {
        switch (ErrorCode) {
          case '30003': {
            // Transient (handset unreachable): ONE scheduled retry with
            // backoff, capped chain (attempt count rides the job payload).
            const priorAttempt = message.retry_attempt ?? 0;
            if (priorAttempt >= MAX_SEND_RETRY_ATTEMPTS) {
              log.warn(
                { providerSid: MessageSid, attempt: priorAttempt },
                'transient delivery failure but retry cap reached — giving up',
              );
              break;
            }
            await enqueueSendRetry({
              providerSid: MessageSid,
              conversationId: message.conversationId,
              attempt: priorAttempt + 1,
            });
            break;
          }
          case '30005':
          case '30006': {
            // Permanent (invalid number / landline): flag the CONTACT, not
            // the message — prompt voice instead. Never retry.
            const conversation = await conversations.getById(message.conversationId);
            const contact = conversation ? await contacts.findByPhone(conversation.participant_phone) : undefined;
            if (contact) {
              await contacts.setFlag(contact.contactId, 'sms_unreachable');
            } else {
              log.warn({ providerSid: MessageSid, errorCode: ErrorCode }, 'sms_unreachable: no contact record to flag');
            }
            break;
          }
          case '30007': {
            // Carrier filtering: NEVER retry (re-sending filtered content
            // compounds reputation damage). ERROR feeds the
            // hc-<env>-error-logs alarm; a dedicated deliverability alarm
            // (filtered-rate metric) is future work.
            log.error(
              { providerSid: MessageSid, errorCode: ErrorCode },
              'carrier filtering (30007) — message suppressed by carrier, not retried',
            );
            break;
          }
          case '21610': {
            // Provider-side opt-out suppression: confirm our suppression
            // state + audit. Never retry.
            const conversation = await conversations.getById(message.conversationId);
            const contact = conversation ? await contacts.findByPhone(conversation.participant_phone) : undefined;
            if (contact) {
              await contacts.setFlag(contact.contactId, 'sms_opt_out');
              await audit.append(`contacts#${contact.contactId}`, 'sms_opt_out_recorded', {
                providerSid: MessageSid,
                conversationId: message.conversationId,
                source: 'twilio_21610',
              });
            } else {
              log.warn({ providerSid: MessageSid, errorCode: ErrorCode }, '21610 suppression: no contact record to flag');
            }
            break;
          }
          default:
            log.warn(
              { providerSid: MessageSid, errorCode: ErrorCode },
              'unhandled delivery error code — recorded on the message, no automated action',
            );
        }
      } catch (err) {
        // Side-effect failures never 5xx the callback: Twilio's redelivery
        // would no-op at the status transition anyway. ERROR = alarmed.
        log.error({ err, providerSid: MessageSid, errorCode: ErrorCode }, 'delivery-error side effect failed');
      }
    }

    res.status(200).end();
  });

  return router;
}
