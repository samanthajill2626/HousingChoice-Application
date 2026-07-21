// Outbound send service — the ONE wrapper every outbound message goes
// through (doc §7.1 "send wrapper"). In order:
//   1. opt-out gate    — refuse sends to sms_opt_out contacts (typed error)
//   2. circuit breaker — automated sends are minute-capped per conversation;
//                        a trip flips the conversation to manual and ALARMS
//   3. provider send   — via the MessagingAdapter seam
//   4. persist-at-send — messagesRepo.append() under the provider SID, which
//                        is what makes the webhook echo a dedupe no-op
//   5. inbox touch     — conversation last-activity + preview
//
// M1.1 scope: a single 1:1 send runs synchronously through the adapter (no
// fan-out loops exist yet; the throttled worker queue is a later milestone).
// Anything scheduled/retried MUST go through jobs.enqueue() — never raw
// scheduler calls (binding guideline 3).
import { mergeContext } from '../lib/context.js';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { hasSmsConsent } from '../lib/smsCompliance.js';
import { createMessagingAdapter, type MessagingAdapter } from '../adapters/messaging.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createContactsRepo,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import {
  createConversationsRepo,
  minuteBucket,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  type DeliveryStatus,
  type MediaAttachment,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import { isKillSwitchOff, isManualMode, isOptedOut } from './scheduledSendSuppression.js';

// --- Typed errors (route maps these to HTTP statuses) ----------------------

/** Base class so callers can `instanceof` the whole refusal family. */
export class SendRefusedError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable refusal code. */
    readonly code:
      | 'conversation_not_found'
      | 'contact_opted_out'
      | 'contact_no_consent'
      | 'breaker_open'
      | 'manual_mode'
      | 'relay_not_supported'
      | 'sms_sending_disabled',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Outbound-SMS kill-switch is OFF (config.smsSendingEnabled false) — every SMS
 * send is refused before the provider call so a deployed stack emits no
 * unregistered-A2P traffic (Twilio 30034) before A2P approval. Operator flips
 * SMS_SENDING_ENABLED=true post-A2P. Voice is unaffected. Routes map this to 503.
 */
export class SmsSendingDisabledError extends SendRefusedError {
  constructor() {
    super('SMS sending is disabled (pre-A2P) — send refused', 'sms_sending_disabled');
  }
}

export class ConversationNotFoundError extends SendRefusedError {
  constructor(conversationId: string) {
    super(`conversation not found: ${conversationId}`, 'conversation_not_found');
  }
}

/** TCPA: STOP'd contacts are never messaged again (doc §7.1, 21610). */
export class ContactOptedOutError extends SendRefusedError {
  constructor(conversationId: string) {
    super(`contact for conversation ${conversationId} has sms_opt_out — send refused`, 'contact_opted_out');
  }
}

/**
 * A2P/CTIA JIT consent gate (spec §3.4): a HUMAN proactive first 1:1 text to a
 * contact with NO documented `consent_method` is blocked. The dashboard pops a
 * modal to record consent, then retries. Routes map this to HTTP 409
 * (`contact_no_consent`). NOT thrown for automated system sends (welcome /
 * missed-call / reminders — no human/modal) nor for a contact who started the
 * conversation (they carry `inbound_text` from auto-capture, so replies never
 * block).
 */
export class ContactNoConsentError extends SendRefusedError {
  constructor(conversationId: string) {
    super(
      `contact for conversation ${conversationId} has no recorded SMS consent — proactive human send blocked`,
      'contact_no_consent',
    );
  }
}

/** The per-conversation circuit breaker tripped on THIS send (doc §7.1). */
export class CircuitBreakerOpenError extends SendRefusedError {
  constructor(conversationId: string) {
    super(`circuit breaker tripped for conversation ${conversationId} — automated sends refused`, 'breaker_open');
  }
}

/** Conversation is in manual mode — automated sends are refused (humans only). */
export class ManualModeError extends SendRefusedError {
  constructor(conversationId: string) {
    super(`conversation ${conversationId} is in manual mode — automated send refused`, 'manual_mode');
  }
}

/**
 * FIX 2 — defense in depth: this 1:1 wrapper sends TO participant_phone, which
 * for a relay_group is the (synthetic) pool number — texting the thread's own
 * number, never the members. Relay sends MUST go through the fan-out job. Any
 * caller that hands a relay_group here is refused (mapped to HTTP 409).
 */
export class RelaySendNotSupportedError extends SendRefusedError {
  constructor(conversationId: string) {
    super(
      `conversation ${conversationId} is a relay_group — use the relay fan-out path, not the 1:1 send wrapper`,
      'relay_not_supported',
    );
  }
}

// --- Service ----------------------------------------------------------------

export interface SendMessageInput {
  conversationId: string;
  body?: string;
  mediaUrls?: string[];
  /**
   * Outbound MMS attachments (design Sec 4): the durable {s3Key, contentType}
   * pairs for this send. The ROUTE presigns each s3Key fresh (TTL 1h) and passes
   * the presigned GET URLs in `mediaUrls` (for the adapter/Twilio fetch) AND
   * these attachments here (for persistence). Persisted as media_attachments so
   * sent media renders through the authed serve endpoint. Absent on text-only /
   * legacy raw-mediaUrls sends.
   */
  attachments?: MediaAttachment[];
  /**
   * True for machine-initiated sends (reminders, AI in Phase 2) — these are
   * what the circuit breaker meters and what manual mode refuses. M1.1's
   * dashboard route sends are human (false): always allowed, never counted.
   */
  automated?: boolean;
  /**
   * Who authored this outbound message (persisted + audited). Defaults to
   * `teammate`; Phase 2's AI passes `ai`, and retries carry the ORIGINAL
   * message's author through.
   */
  author?: 'teammate' | 'ai';
  /**
   * Explicit sender number, E.164 (M1.7): the pool number a relay-group
   * message must originate FROM. Threaded straight to the adapter; the
   * opt-out gate, breaker, persist-at-send, and audit are unchanged.
   * Unset for the 1:1 path (the messaging service picks the sender).
   */
  from?: string;
  /**
   * Broadcast id (M1.8a "Share Properties"): when set, the persisted message is
   * STAMPED with `broadcast_id = broadcastId` so the delivery-status callback
   * rollup (webhooks/twilio.ts) can find this broadcast's recipient slot by the
   * SID alone and roll delivered/failed into the broadcast stats. ADDITIVE: the
   * 1:1 send path (opt-out gate → breaker → persist-at-send → audit) is
   * otherwise UNCHANGED — absent on every non-broadcast send (relay + 1:1).
   */
  broadcastId?: string;
  /**
   * Manual retry (dashboard Retry button): the tsMsgId of the FAILED message this
   * send supersedes. Persisted as `retry_of` on the new message so the contact
   * timeline collapses the stale failed bubble. ADDITIVE — absent on a normal
   * send. (The 30003 auto-retry annotates retry_of itself; it doesn't use this.)
   */
  retryOf?: string;
}

export interface SendMessageOutcome {
  conversationId: string;
  providerSid: string;
  tsMsgId: string;
  status: DeliveryStatus;
}

export interface SendMessageServiceDeps {
  config?: AppConfig;
  logger?: Logger;
  adapter?: MessagingAdapter;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  contactsRepo?: ContactsRepo;
  auditRepo?: AuditRepo;
  /** SSE live-update bus (M1.2); the process singleton by default. */
  events?: EventBus;
}

export type SendMessageService = (input: SendMessageInput) => Promise<SendMessageOutcome>;

export function createSendMessageService(deps: SendMessageServiceDeps = {}): SendMessageService {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const adapter = deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;

  return async function sendMessage(input) {
    const { conversationId, body, mediaUrls, attachments, automated = false, author = 'teammate', from, broadcastId, retryOf } = input;
    mergeContext({ conversationId });

    const conversation = await conversations.getById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    // (0a) A2P kill-switch: when SMS sending is disabled (deployed pre-A2P),
    // refuse BEFORE the opt-out/breaker work and the provider call — no real
    // Twilio send → no 30034 → no reputation damage. Explicit === false so a
    // hand-built test config without the field is treated as enabled. The
    // Twilio driver enforces the same backstop for any direct-adapter caller.
    if (isKillSwitchOff(config.smsSendingEnabled)) {
      log.warn({ conversationId }, 'send refused: SMS sending disabled (pre-A2P kill-switch)');
      throw new SmsSendingDisabledError();
    }

    // (0) Channel guard (FIX 2): this 1:1 wrapper texts participant_phone.
    // Refuse a relay_group (participant_phone is the pool number) AND any thread
    // with no phone participant - an email-channel thread carries
    // participant_email and NO phone, and sends via the dedicated email service,
    // never this SMS path. Both misroutes throw so no caller can misuse it; the
    // guard also narrows participant_phone to a definite string below.
    if (conversation.type === 'relay_group') throw new RelaySendNotSupportedError(conversationId);
    const participantPhone = conversation.participant_phone;
    if (participantPhone === undefined) throw new RelaySendNotSupportedError(conversationId);

    // (1) Opt-out gate — suppression beats everything (doc §7.1 / 21610).
    // EITHER flag refuses: the conversation-level flag covers STOPs from
    // phones with no contact record yet (auto-capture is M1.2).
    const contact = await contacts.findByPhone(participantPhone);
    if (isOptedOut(conversation.sms_opt_out, contact?.sms_opt_out)) {
      log.warn(
        {
          conversationId,
          contactId: contact?.contactId,
          conversationOptOut: conversation.sms_opt_out === true,
        },
        'send refused: sms_opt_out is set (conversation and/or contact)',
      );
      throw new ContactOptedOutError(conversationId);
    }

    // (1.5) JIT consent gate (A2P/CTIA, spec §3.4) — AFTER the opt-out gate
    // (opt-out is the firmer refusal) and ONLY for a HUMAN proactive send
    // (automated === false). A contact who STARTED the conversation carries
    // `inbound_text` from auto-capture, so hasSmsConsent is true and replies
    // never block. Automated system sends (welcome / missed-call / reminders)
    // are NOT gated here — there is no human/modal to capture consent, and those
    // paths are covered by their own opt-in basis. A send with no contact record
    // (a proactive send to a raw phone) is left to the opt-out gate above; the
    // gate fires only when a contact EXISTS and lacks consent.
    if (automated === false && contact && !hasSmsConsent(contact)) {
      log.warn(
        { conversationId, contactId: contact.contactId },
        'send refused: contact has no recorded SMS consent (JIT gate)',
      );
      throw new ContactNoConsentError(conversationId);
    }

    // (2) Circuit breaker — automated sends only; manual human sends are
    // always allowed (even in manual mode) and never counted.
    if (automated) {
      if (isManualMode(conversation.ai_mode)) throw new ManualModeError(conversationId);
      const count = await conversations.incrementAutomatedSendCount(conversationId, minuteBucket());
      if (count > config.sendBreakerMaxPerMinute) {
        await conversations.setMode(conversationId, 'manual');
        // §5 mandate: mode flips are audit-trail events.
        await audit.append(`conversations#${conversationId}`, 'mode_changed', {
          from: 'auto',
          to: 'manual',
          reason: 'breaker_trip',
        });
        // ERROR on purpose: the hc-<env>-error-logs metric alarm (pino level
        // >= 50) is what pages on breaker trips — this line IS the alarm.
        log.error(
          { conversationId, count, capPerMinute: config.sendBreakerMaxPerMinute },
          'circuit breaker TRIPPED: automated outbound cap exceeded — conversation flipped to manual',
        );
        throw new CircuitBreakerOpenError(conversationId);
      }
    }

    // (3) Provider send — synchronous single send (M1.1; no fan-out exists).
    // M1.7: an explicit `from` pins the sender to a pool number (relay path).
    const result = await adapter.sendMessage({
      to: participantPhone,
      ...(body !== undefined && { body }),
      ...(mediaUrls !== undefined && { mediaUrls }),
      ...(from !== undefined && { from }),
    });

    // (4) Persist at send time under the provider SID/timestamp — the
    // webhook echo of this same message dedupes against this item.
    const appended = await messages.append({
      conversationId,
      providerSid: result.providerSid,
      providerTs: result.providerTs,
      type: mediaUrls !== undefined && mediaUrls.length > 0 ? 'mms' : 'sms',
      direction: 'outbound',
      author,
      ...(body !== undefined && { body }),
      // The persisted mediaUrls are the PRESIGNED provider-fetch URLs: a
      // historical record of exactly what was sent. They are EXPECTED to expire
      // (1h TTL) and are NEVER reused - a resend/retry re-presigns FRESH from
      // media_attachments (the durable truth). Presigned URLs are bearer tokens:
      // never logged (see the send log line below - s3Key/count only).
      ...(mediaUrls !== undefined && { mediaUrls }),
      // Outbound MMS gap #3: persist the durable attachment keys so sent media
      // renders through the authed serve endpoint + timeline (same pipeline the
      // inbound mirror feeds). Absent on text-only / legacy raw-mediaUrls sends.
      ...(attachments !== undefined && attachments.length > 0 && { mediaAttachments: attachments }),
      deliveryStatus: result.status,
      // M1.8a: stamp the broadcast id so the delivery-callback rollup can find
      // this recipient's broadcast slot by the SID alone (additive — absent on
      // 1:1 / relay sends).
      ...(broadcastId !== undefined && { broadcastId }),
      // Manual-retry lineage (additive — absent on a normal send).
      ...(retryOf !== undefined && { retryOf }),
    });

    // (5) Inbox touch — denormalized last-activity + preview (doc §5) — and
    // the §5 audit-trail entry for the send (IDs only, never the body).
    const touched = await conversations.touchLastActivity(conversationId, body, result.providerTs);
    await audit.append(`conversations#${conversationId}`, 'message_sent', {
      providerSid: result.providerSid,
      automated,
      author,
    });

    // (6) SSE live updates (M1.2): dashboards see this send (their own and
    // other operators') without polling. Outbound NEVER touches unread_count
    // — the event just carries the current value from the touch's ALL_NEW.
    events.emit('message.persisted', {
      conversationId,
      tsMsgId: appended.tsMsgId,
      direction: 'outbound',
      deliveryStatus: result.status,
    });
    events.emit('conversation.updated', toConversationUpdatedEvent(touched));

    log.info(
      { conversationId, providerSid: result.providerSid, status: result.status, automated },
      'outbound message sent',
    );
    return {
      conversationId,
      providerSid: result.providerSid,
      tsMsgId: appended.tsMsgId,
      status: result.status,
    };
  };
}
