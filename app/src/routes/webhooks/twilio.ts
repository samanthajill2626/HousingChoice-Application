// Twilio Programmable Messaging webhooks (M1.1 Builder B, doc §7.1):
//   POST /webhooks/twilio/sms     — the Messaging Service's inbound webhook
//   POST /webhooks/twilio/status  — its delivery status callback
// Both arrive as application/x-www-form-urlencoded (parsed by the locked
// chain's urlencoded parser, raw bytes on req.rawBody) and are signature-
// verified by twilioSignatureMiddleware before any handler runs.
//
// PII (doc §9): message bodies and media URLs are NEVER logged — log lines
// carry SIDs/IDs/lengths only, correlated via the pino mixin.
import { setTimeout as delay } from 'node:timers/promises';
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
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../../lib/events.js';
// FIX 4: the relay roster fields now live in toConversationUpdatedEvent — the
// inbound relay path uses the one shared builder (no separate relay builder).
import { logger as defaultLogger, type Logger } from '../../lib/logger.js';
import { twilioSignatureMiddleware } from '../../middleware/twilioSignature.js';
import { createAuditRepo, type AuditRepo } from '../../repos/auditRepo.js';
import {
  createBroadcastsRepo,
  type BroadcastRecipient,
  type BroadcastsRepo,
} from '../../repos/broadcastsRepo.js';
import { createContactsRepo, type ContactItem, type ContactsRepo } from '../../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
  type ConversationType,
} from '../../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  relayMemberKey,
  type DeliveryStatus,
  type MessagesRepo,
} from '../../repos/messagesRepo.js';
import { createContactCapture } from '../../services/contactCapture.js';
import {
  enqueueSendRetry,
  MAX_SEND_RETRY_ATTEMPTS,
} from '../../jobs/retrySend.js';
import { enqueueImmediate } from '../../jobs/jobs.js';
import { RELAY_FANOUT_JOB } from '../../jobs/relayFanOut.js';

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

/**
 * Conversation typing is as honest as contact typing (operator mandate,
 * 2026-06-12): only a RESOLVED contact type yields a typed thread. No contact
 * yet, or a contact whose type is 'unknown'/'pm'/'team_member', is
 * `unknown_1to1` — never a guess.
 *
 * TODO(M1.5): when the team sets a contact's real type, the records CRUD must
 * propagate the conversation type (unknown_1to1 → tenant_1to1/landlord_1to1).
 * Seam only — nothing is built here yet.
 */
function conversationTypeFor(contact: ContactItem | undefined): ConversationType {
  switch (contact?.type) {
    case 'landlord':
      return 'landlord_1to1';
    case 'tenant':
      return 'tenant_1to1';
    default:
      return 'unknown_1to1';
  }
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
  /** Share-broadcast results rollup (M1.8a); the real repo by default. */
  broadcastsRepo?: BroadcastsRepo;
  /** SSE live-update bus (M1.2); the process singleton by default. */
  events?: EventBus;
  /**
   * How long the status callback waits before retrying an unknown-SID lookup
   * once (the send/append race window). Injectable for tests; default 2500ms.
   */
  statusUnknownSidRetryDelayMs?: number;
}

/** Default wait before the one unknown-SID retry in /status (see above). */
const STATUS_UNKNOWN_SID_RETRY_DELAY_MS = 2_500;

export function createTwilioWebhookRouter(deps: TwilioWebhookDeps = {}): Router {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const adapter = deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger });
  const mediaStore = deps.mediaStore ?? createMediaStore({ config });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const broadcasts = deps.broadcastsRepo ?? createBroadcastsRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const captureContact = createContactCapture({
    contactsRepo: contacts,
    conversationsRepo: conversations,
    auditRepo: audit,
    logger: deps.logger,
  });
  const ourNumbers = new Set(config.ourPhoneNumbers);
  const statusRetryDelayMs = deps.statusUnknownSidRetryDelayMs ?? STATUS_UNKNOWN_SID_RETRY_DELAY_MS;

  const router = Router();
  const verifySignature = twilioSignatureMiddleware({
    authToken: config.twilioAuthToken,
    publicBaseUrl: config.publicBaseUrl,
    nodeEnv: config.nodeEnv,
    logger: log,
  });

  // ---------------------------------------------------------------------
  // Relay-group inbound (M1.7): To is a pool number → persist ONCE on the
  // relay thread + enqueue fan-out to the OTHER members. Never the 1:1 path.
  // Side-effect failures NEVER 5xx (a redelivery dedupes at the append and
  // re-runs the idempotent steps); failures are ERROR-logged + alarmed.
  // ---------------------------------------------------------------------
  async function handleRelayInbound(
    relay: ConversationItem,
    msg: {
      MessageSid: string;
      From: string;
      To: string;
      Body: string | undefined;
      params: WebhookParams;
    },
  ): Promise<void> {
    const { MessageSid, From, Body } = msg;
    mergeContext({ conversationId: relay.conversationId });

    // Identify the sender = the member whose phone == From. A former member
    // (removed mid-thread) is NOT found here — we still persist for the audit
    // trail but do NOT fan out (the message reached a number they were once
    // on). The member key is contactId-or-phone (relayMemberKey).
    const roster = relay.participants ?? [];
    const sender = roster.find((m) => m.phone === From);
    const senderKey = sender ? relayMemberKey(sender) : `phone#${From}`;

    // Author honesty: only a reviewed contact type claims tenant/landlord;
    // a stub/unknown sender is `unknown` (same rule as the 1:1 path).
    const senderContact = sender?.contactId ? await contacts.getById(sender.contactId) : undefined;
    const author =
      senderContact?.type === 'landlord' || senderContact?.type === 'tenant'
        ? senderContact.type
        : 'unknown';

    const isClosed = relay.status !== 'open';
    const providerTs = new Date().toISOString();
    // Persist the relay message ONCE on the relay thread (idempotent MessageSid
    // append). Direction inbound; relay_sender_key records who sent it.
    const appended = await messages.append({
      conversationId: relay.conversationId,
      providerSid: MessageSid,
      providerTs,
      type: 'sms',
      direction: 'inbound',
      author,
      deliveryStatus: 'delivered',
      relaySenderKey: senderKey,
      ...(isClosed && { receivedOnClosedThread: true }),
      ...(Body !== undefined && Body.length > 0 && { body: Body }),
    });

    // Closed-thread reply: flagged (receivedOnClosedThread above), NEVER fanned
    // out — the conversation is over; the reply is kept for the record only.
    if (isClosed) {
      log.info({ providerSid: MessageSid }, 'relay inbound on a CLOSED thread — persisted, no fan-out');
    } else if (!sender) {
      // Removed-member reply: persisted for the audit trail, no fan-out (they
      // are no longer a current participant).
      log.info({ providerSid: MessageSid }, 'relay inbound from a non-member — persisted, no fan-out');
    } else if (!appended.deduped) {
      // Current member, open thread, fresh message → fan out immediately
      // (skips EventBridge's 60s floor). A redelivery (deduped) does NOT
      // re-enqueue: the original fan-out is guarded by its own job marker +
      // per-recipient terminal skips.
      try {
        await enqueueImmediate(RELAY_FANOUT_JOB, {
          relayConversationId: relay.conversationId,
          sourceTsMsgId: appended.tsMsgId,
          senderKey,
        });
      } catch (err) {
        log.error({ err, providerSid: MessageSid }, 'relay fan-out enqueue failed — message persisted, not relayed');
      }
    }

    // Inbox touch + unread + SSE — reuse the shared helpers (fresh-append only,
    // same as the 1:1 path: a redelivery must not double-count/re-emit).
    let touched: ConversationItem | undefined;
    try {
      if (!appended.deduped) await conversations.incrementUnread(relay.conversationId);
      touched = await conversations.touchLastActivity(relay.conversationId, Body || undefined, providerTs);
    } catch (err) {
      log.error({ err, providerSid: MessageSid }, 'relay touchLastActivity/unread failed — message persisted, inbox stale');
    }
    if (!appended.deduped) {
      events.emit('message.persisted', {
        conversationId: relay.conversationId,
        tsMsgId: appended.tsMsgId,
        direction: 'inbound',
        deliveryStatus: 'delivered',
      });
      if (touched) events.emit('conversation.updated', toConversationUpdatedEvent(touched));
    }
    log.info(
      { providerSid: MessageSid, direction: 'inbound', bodyLength: Body?.length ?? 0, closed: isClosed, fannedOut: !isClosed && Boolean(sender) && !appended.deduped },
      'twilio relay inbound message processed',
    );
  }

  // ---------------------------------------------------------------------
  // Inbound message webhook — pipeline order per doc §7.1.
  // ---------------------------------------------------------------------
  router.post('/sms', verifySignature, async (req, res) => {
    const params = asParams(req.body);
    const { MessageSid, From, To, Body, OptOutType } = params;
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
    // M1.7: pool numbers are ALSO "ours" — a relay fan-out (From = pool
    // number) projected back must drop here too, before any relay routing.
    if (ourNumbers.has(From)) {
      log.info({ providerSid: MessageSid }, 'twilio webhook echo (From is our number) — acknowledged, dropped');
      res.type('text/xml').send(EMPTY_TWIML);
      return;
    }
    if (await conversations.getByPoolNumber(From)) {
      log.info({ providerSid: MessageSid }, 'twilio webhook echo (From is a pool number) — acknowledged, dropped');
      res.type('text/xml').send(EMPTY_TWIML);
      return;
    }

    // (1.5) Relay routing (M1.7): if To is one of our pool numbers, this is an
    // inbound to a relay group — route it to the relay path (fan-out to the
    // other members), NOT the 1:1 path. The byPoolNumber GSI read is the cheap
    // lookup (never a scan); "found" means "To is a pool number".
    if (To !== undefined && To.length > 0) {
      const relay = await conversations.getByPoolNumber(To);
      if (relay) {
        await handleRelayInbound(relay, { MessageSid, From, To, Body, params });
        res.type('text/xml').send(EMPTY_TWIML);
        return;
      }
    }

    // (2) Resolve contact + conversation. Unknown phones still get a
    // conversation (auto-capture of contacts is M1.2).
    const contact = await contacts.findByPhone(From);
    const conversation = await conversations.createOrGetByParticipantPhone(
      From,
      conversationTypeFor(contact),
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
      // Same honesty rule as conversation typing: only a reviewed contact
      // type may claim tenant/landlord authorship; everything else is
      // `unknown` until a human types the contact (M1.4/M1.5).
      author:
        contact?.type === 'landlord' || contact?.type === 'tenant' ? contact.type : 'unknown',
      // Inbound messages are received by definition; the outbound delivery
      // machine never transitions them.
      deliveryStatus: 'delivered',
      ...(Body !== undefined && Body.length > 0 && { body: Body }),
      ...(mediaUrls.length > 0 && { mediaUrls }),
    });
    // Where the persisted message actually lives (== the fresh append unless
    // deduped, where the FIRST delivery's keys win) + whether media was
    // already mirrored.
    let persistedConversationId = conversation.conversationId;
    let persistedTsMsgId = appended.tsMsgId;
    let mediaAlreadyMirrored = false;
    if (appended.deduped) {
      // Dedupe must NOT skip the side effects below: a redelivery usually
      // means the FIRST delivery 5xx'd/crashed AFTER the append but before
      // finishing this pipeline. Every remaining step is idempotent — STOP
      // recording re-sets the same flags, media mirroring is skipped when the
      // persisted message already has its keys, touchLastActivity re-stamps —
      // so re-running them completes the crashed delivery. (For the
      // echo-of-our-own-send dedupe these are harmless no-ops by design; the
      // From-check above stays the true first gate for echoes.)
      const persisted = await messages.getByProviderSid(MessageSid);
      if (!persisted) {
        // The append deduped, so the SID pointer exists — failing to read the
        // message back is never expected. ERROR (alarmed) + ack so Twilio
        // stops redelivering into a broken read path.
        log.error(
          { providerSid: MessageSid },
          'twilio inbound webhook deduped but the persisted message could not be read back — acknowledged',
        );
        res.type('text/xml').send(EMPTY_TWIML);
        return;
      }
      persistedConversationId = persisted.conversationId;
      persistedTsMsgId = persisted.tsMsgId;
      mediaAlreadyMirrored = (persisted.media_s3_keys?.length ?? 0) > 0;
      mergeContext({ conversationId: persistedConversationId });
      log.info(
        { providerSid: MessageSid },
        'twilio inbound webhook deduped (redelivery or send-time copy) — re-running idempotent side effects',
      );
    }

    // From here on the message is persisted: side-effect failures must never
    // crash the webhook — a 5xx would trigger a redelivery, which dedupes at
    // the append and RE-RUNS these idempotent steps. Failures are still
    // ERROR-logged + alarmed (Twilio's redelivery is best-effort backup, not
    // the recovery plan).

    // (3.5) Contact auto-capture (M1.2): every inbound conversation ends up
    // linked to a contact — a stub is created for unknown phones (race-safe
    // via the conversation's participants claim; see
    // services/contactCapture.ts) and the link is backfilled for known ones.
    // Idempotent, so the dedupe path re-runs it harmlessly (no double
    // capture). The captured contact also serves the STOP recording below,
    // so an opt-out from a previously unknown phone flags the contact too.
    let effectiveContact = contact;
    try {
      effectiveContact = await captureContact(conversation, contact);
    } catch (err) {
      log.error(
        { err, providerSid: MessageSid },
        'contact auto-capture failed — message persisted, conversation not linked',
      );
    }

    // (4) STOP/opt-out recording (doc §7.1; Twilio Advanced Opt-Out already
    // auto-replied at the provider). The message itself stays on the
    // timeline either way (persisted above).
    try {
      const keyword = (Body ?? '').trim().toUpperCase();
      const optedOut = OptOutType === 'STOP' || STOP_KEYWORDS.has(keyword);
      const optedIn = !optedOut && (OptOutType === 'START' || START_KEYWORDS.has(keyword));
      if (optedOut || optedIn) {
        // The CONVERSATION flag is always written — a STOP from a phone with
        // no contact record yet (auto-capture is M1.2) must still suppress
        // every later send. The send wrapper gates on either flag.
        await conversations.setSmsOptOut(conversation.conversationId, optedOut);
        const eventType = optedOut ? 'sms_opt_out_recorded' : 'sms_opt_out_cleared';
        const source =
          OptOutType === 'STOP' || OptOutType === 'START' ? 'OptOutType' : 'keyword';
        if (effectiveContact) {
          if (optedOut) await contacts.setFlag(effectiveContact.contactId, 'sms_opt_out');
          else await contacts.clearFlag(effectiveContact.contactId, 'sms_opt_out');
          await audit.append(`contacts#${effectiveContact.contactId}`, eventType, {
            providerSid: MessageSid,
            conversationId: conversation.conversationId,
            source,
          });
        } else {
          // Only reachable when auto-capture itself failed above — the
          // conversation flag still suppresses every later send.
          log.warn(
            { providerSid: MessageSid, optOut: optedOut },
            'opt-out/in from a phone with no contact record — conversation flagged, no contact to flag (auto-capture failed)',
          );
          await audit.append(`conversations#${conversation.conversationId}`, eventType, {
            providerSid: MessageSid,
            conversationId: conversation.conversationId,
            source,
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
    if (mediaUrls.length > 0 && !mediaAlreadyMirrored) {
      if (!mediaStore) {
        const line = 'inbound MMS media NOT mirrored — MEDIA_BUCKET is not configured';
        if (config.nodeEnv === 'production') log.error({ providerSid: MessageSid, mediaCount: mediaUrls.length }, line);
        else log.warn({ providerSid: MessageSid, mediaCount: mediaUrls.length }, line);
      } else {
        const keys: string[] = [];
        for (const [i, url] of mediaUrls.entries()) {
          const key = `media/${persistedConversationId}/${MessageSid}/${i}`;
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
            await messages.annotateMessage(persistedConversationId, persistedTsMsgId, { mediaS3Keys: keys });
          } catch (err) {
            log.error({ err, providerSid: MessageSid }, 'failed to record mirrored media keys on the message');
          }
        }
      }
    }

    // (6) Inbox touch + unread + SSE live updates, then acknowledge with
    // empty TwiML. unread_count increments ONLY on a fresh append — a
    // redelivered webhook (dedupe) must never double-count the same message.
    // The increment runs BEFORE the touch so the touch's ALL_NEW snapshot
    // carries the new count into the conversation.updated event.
    let touched: ConversationItem | undefined;
    try {
      // Accepted risk (M1.2): the increment is skipped on dedupe re-runs, so
      // a crash between append and increment permanently undercounts by one
      // (per-message increment markers would fix it if it ever matters).
      if (!appended.deduped) await conversations.incrementUnread(persistedConversationId);
      touched = await conversations.touchLastActivity(
        persistedConversationId,
        Body || undefined,
        providerTs,
      );
    } catch (err) {
      log.error({ err, providerSid: MessageSid }, 'touchLastActivity/unread failed — message persisted, inbox stale');
    }
    if (!appended.deduped) {
      // SSE emits are fresh-append-only: a redelivery would push a duplicate
      // UI event for a message the dashboard already rendered (clients
      // reconcile via GET /api/conversations anyway).
      events.emit('message.persisted', {
        conversationId: persistedConversationId,
        tsMsgId: persistedTsMsgId,
        direction: 'inbound',
        deliveryStatus: 'delivered',
      });
      if (touched) {
        events.emit('conversation.updated', toConversationUpdatedEvent(touched));
      }
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
    let message = await messages.getByProviderSid(MessageSid);
    if (!message) {
      // (M1.7) Before the slow send/append-race retry: the SID may belong to a
      // relay-group fan-out, which sends N outbound provider messages but
      // persists NONE as their own message — they live as delivery_recipients
      // slots on the source message, found via the relaysid pointer (written
      // synchronously at fan-out send time, so no race window to wait out).
      const ptr = await messages.getRelaySidPointer(MessageSid);
      if (ptr) {
        mergeContext({ conversationId: ptr.conversationId });
        const mapped = mapTwilioStatus(MessageStatus);
        const transitioned = await messages.updateRecipientDeliveryStatus(
          ptr.conversationId,
          ptr.tsMsgId,
          ptr.memberKey,
          mapped,
          ErrorCode,
        );
        log.info(
          { providerSid: MessageSid, providerStatus: MessageStatus, errorCode: ErrorCode, transitioned, relay: true },
          'twilio relay-recipient delivery status callback processed',
        );
        if (transitioned) {
          // Refresh the UI: a per-recipient delivery move re-renders the relay
          // thread (the source message's delivery_recipients changed).
          events.emit('message.persisted', {
            conversationId: ptr.conversationId,
            tsMsgId: ptr.tsMsgId,
            direction: 'inbound',
            deliveryStatus: mapped,
          });
        }
        res.status(200).end();
        return;
      }
      // Unknown SID and not a relay recipient: usually the callback outran the
      // send wrapper's persist-at-send (Twilio can fire the first status before
      // messages.append commits). Wait once and retry the lookup before
      // declaring the message lost.
      await delay(statusRetryDelayMs);
      message = await messages.getByProviderSid(MessageSid);
    }
    if (!message) {
      // Still unknown after the retry: either the send/append race lasted
      // longer than the window, or the process crashed between provider send
      // and append (the crash-orphan window) — a delivery outcome we cannot
      // attach to any message. ERROR on purpose (feeds the
      // hc-<env>-error-logs alarm): this is the §7.1 "closing the loop"
      // backstop — a silently dropped status would otherwise hide a failed
      // send forever. Still ack 200 so Twilio doesn't redeliver into the
      // same gap.
      log.error(
        { providerSid: MessageSid, providerStatus: MessageStatus },
        'status callback for unknown provider SID after retry — delivery outcome dropped',
      );
      res.status(200).end();
      return;
    }
    mergeContext({ conversationId: message.conversationId });

    // Forward-only transition; false = regression/duplicate → side effects
    // are SKIPPED, which also makes redelivered failure callbacks enqueue
    // exactly one retry.
    const mappedStatus = mapTwilioStatus(MessageStatus);
    const transitioned = await messages.updateDeliveryStatus(MessageSid, mappedStatus, ErrorCode);
    log.info(
      { providerSid: MessageSid, providerStatus: MessageStatus, errorCode: ErrorCode, transitioned },
      'twilio delivery status callback processed',
    );

    if (transitioned) {
      // SSE (M1.2): a REAL transition updates delivery badges live.
      // Regressions/duplicates were no-ops above and emit nothing — so a
      // redelivered callback never re-fires the dashboard.
      events.emit('message.persisted', {
        conversationId: message.conversationId,
        tsMsgId: message.tsMsgId,
        direction: message.direction,
        deliveryStatus: mappedStatus,
      });

      // (M1.8a) Share-broadcast rollup: when THIS message belongs to a
      // broadcast, fold its delivered/failed terminal status into the
      // broadcast's recipient slot (forward-only) + stats, and emit the
      // broadcast.updated SSE event. O(1): the message carries broadcast_id +
      // its own conversationId/tsMsgId, so we load the broadcast by id and
      // find the matching recipient slot by those keys (no new GSI). Only
      // terminal transitions move the rollup — a sent→delivered (no failed)
      // bumps `delivered`; *→failed bumps `failed`. Never 5xx the callback.
      if (typeof message.broadcast_id === 'string' && message.broadcast_id.length > 0) {
        try {
          await rollIntoBroadcast(
            broadcasts,
            events,
            log,
            message.broadcast_id,
            message.conversationId,
            message.tsMsgId,
            mappedStatus,
            ErrorCode,
          );
        } catch (err) {
          log.error({ err, providerSid: MessageSid, broadcastId: message.broadcast_id }, 'broadcast delivery rollup failed — message status recorded, broadcast stats stale');
        }
      }
    }

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

/**
 * Forward-only terminal transitions for a broadcast recipient slot — mirrors
 * the messages delivery-status machine but over the broadcast slot's smaller
 * state set ('queued'|'sent'|'delivered'|'failed'|'skipped'). Only `delivered`
 * and `failed` are reachable here (delivery callbacks), and a terminal slot
 * (delivered/failed/skipped) never regresses.
 */
function broadcastSlotMayTransition(current: BroadcastRecipient['status'] | undefined): boolean {
  // A terminal slot (delivered/failed/skipped) never regresses; queued or sent
  // → delivered/failed are both forward moves.
  return current !== 'delivered' && current !== 'failed' && current !== 'skipped';
}

/**
 * (M1.8a) Roll a 1:1 delivery-status transition into the owning broadcast: find
 * the recipient slot whose persisted conversationId+tsMsgId match this message,
 * apply the forward-only terminal status, bump the broadcast's delivered/failed
 * counter, and emit broadcast.updated. O(1) load-by-id; the slot is found by
 * scanning the broadcast's (bounded) recipients map for the matching keys.
 */
async function rollIntoBroadcast(
  broadcasts: BroadcastsRepo,
  events: EventBus,
  log: Logger,
  broadcastId: string,
  conversationId: string,
  tsMsgId: string,
  deliveryStatus: DeliveryStatus,
  errorCode: string | undefined,
): Promise<void> {
  // Only terminal delivery outcomes roll up; intermediate (sent/queued)
  // callbacks for a broadcast message are already reflected by the send job.
  const next: 'delivered' | 'failed' | undefined =
    deliveryStatus === 'delivered'
      ? 'delivered'
      : deliveryStatus === 'failed' || deliveryStatus === 'undelivered'
        ? 'failed'
        : undefined;
  if (next === undefined) return;

  const broadcast = await broadcasts.getById(broadcastId);
  if (!broadcast) {
    log.warn({ broadcastId }, 'broadcast delivery rollup: broadcast not found — ignored');
    return;
  }
  // Find the recipient slot for THIS message (matched by the persisted
  // conversationId + tsMsgId stamped at send time).
  const entry = Object.entries(broadcast.recipients ?? {}).find(
    ([, r]) => r.conversationId === conversationId && r.tsMsgId === tsMsgId,
  );
  if (!entry) {
    log.warn({ broadcastId, conversationId }, 'broadcast delivery rollup: no matching recipient slot — ignored');
    return;
  }
  const [contactKey, slot] = entry;
  if (!broadcastSlotMayTransition(slot.status)) {
    // Forward-only: a terminal slot never regresses (out-of-order/duplicate
    // callbacks). No stat change, no emit.
    return;
  }

  // Atomic forward-only transition: condition the slot write on the slot still
  // being in a non-terminal predecessor state (queued|sent). Two concurrent
  // callbacks for the same SID both read the same `slot` above and both pass the
  // in-memory check — but only ONE wins this conditional write; the other
  // returns false and is skipped, so `delivered`/`failed` is bumped exactly
  // once per recipient transition (no double-increment race).
  const applied = await broadcasts.setRecipient(
    broadcastId,
    contactKey,
    {
      ...slot,
      status: next,
      ...(errorCode !== undefined && { errorCode }),
    },
    ['queued', 'sent'],
  );
  if (!applied) {
    // Another callback already transitioned this slot — do NOT bump stats.
    return;
  }
  // Stats: a sent→delivered move bumps `delivered` (the recipient was counted
  // in `sent` at send time — delivered is a refinement, not a re-count). A
  // *→failed move bumps `failed`; if the slot was 'sent', decrement `sent` so
  // the totals reconcile (a sent that ultimately failed is a failure).
  const fromSent = slot.status === 'sent';
  const delta =
    next === 'delivered'
      ? { delivered: 1 }
      : { failed: 1, ...(fromSent && { sent: -1 }) };
  const updated = await broadcasts.bumpStats(broadcastId, delta);
  events.emit('broadcast.updated', {
    broadcastId,
    status: updated.status,
    stats: updated.stats,
  });
  log.info({ broadcastId, deliveryStatus: next }, 'broadcast delivery rolled into stats');
}
