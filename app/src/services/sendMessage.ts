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
//
// Failures (SOR spec D3): a refusal is a SendRefusedError and is never
// wrapped. Every other throw says WHERE the send failed: before the provider
// call (SendNotAttemptedError - nothing was sent), at the provider call
// (ProviderSendFailedError - classified; it may have been sent), or at the
// append after the provider accepted the text (SendAcceptedNotRecordedError -
// it WAS sent). Steps after the append are best-effort: the text is out and
// recorded, so they log at ERROR and the send returns its normal result.
import { mergeContext } from '../lib/context.js';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { hasSmsConsent } from '../lib/smsCompliance.js';
import {
  createMessagingAdapter,
  type CarrierMessageSender,
  type MessagingAdapter,
  type SendMessageResult,
} from '../adapters/messaging.js';
import { bodyFingerprint, recipientDigest } from '../lib/sendFingerprint.js';
import { pinnedSender } from '../lib/outboundSender.js';
import { classifySendFailure, type SendFailureClassification } from '../lib/sendOutcome.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  contactHoldsPhone,
  createContactsRepo,
  isDeleted,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import {
  createConversationsRepo,
  minuteBucket,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  type AppendResult,
  type DeliveryStatus,
  type MediaAttachment,
  type MessagesRepo,
  type NewMessage,
} from '../repos/messagesRepo.js';
// A TYPE import: this module stays a runtime leaf of the attempt-record repo.
import type { SendAttemptFacts } from '../repos/sendAttemptsRepo.js';
import { isKillSwitchOff, isManualMode, isOptedOut } from './scheduledSendSuppression.js';
import { TRANSPORT_SCHEMA_VERSION } from '../lib/messageTransport.js';

// --- Typed errors (route maps these to HTTP statuses) ----------------------

/** Base class so callers can `instanceof` the whole refusal family. */
export class SendRefusedError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable refusal code. */
    readonly code:
      | 'conversation_not_found'
      | 'contact_opted_out'
      | 'contact_deleted'
      | 'contact_no_consent'
      | 'breaker_open'
      | 'manual_mode'
      | 'relay_not_supported'
      | 'group_text_not_supported'
      // Native group texting (S5): the group send service's own refusals. They
      // live in this union so the ONE `instanceof SendRefusedError` catch in the
      // send route keeps mapping every refusal to a status code.
      | 'not_a_group_text'
      | 'group_roster_empty'
      | 'group_too_many_members'
      | 'group_member_deleted'
      | 'group_member_no_consent'
      | 'group_rail_unavailable'
      // A post that failed for a reason that says nothing about the rail
      // (network, 429, 5xx) and one the shared A2P meter could not admit inside
      // its wait bound. Both are RETRYABLE - deliberately distinct from
      // `group_rail_unavailable`, which means the thread has nowhere to post.
      | 'group_send_failed'
      | 'group_send_busy'
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

/** Soft-deleted contacts are unreachable (human OR automated) THROUGH THIS GATE
 *  until restored (deleted-contact resurfacing spec 2026-08-03). Two send paths
 *  bypass it and still reach a deleted contact — both pre-existing, both filed,
 *  neither in this feature's scope:
 *    - relay-group fan-out / announcements (deletion does nothing to group
 *      membership) — docs/issues/relay-groups-ignore-member-deletion.md
 *    - outbound voice (originateCall has no deleted check) —
 *      docs/issues/outbound-voice-ignores-deleted-contacts.md
 *  So "unreachable" is true of 1:1 SMS/email, not of the contact as a whole. */
export class ContactDeletedError extends SendRefusedError {
  constructor(conversationId: string) {
    super(`contact for conversation ${conversationId} is soft-deleted — send refused`, 'contact_deleted');
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

/**
 * A NATIVE group text handed to the 1:1 send wrapper. It gets its OWN error, not
 * relay's: the two failures have different causes and different fixes, and a
 * group thread reported as `relay_not_supported` would send whoever reads the
 * log or the 409 hunting through relay code that is not involved.
 *
 * Without this case a group thread fell through to the phone check below and
 * threw the RELAY error simply because it has no participant_phone - a
 * misleading message from an accidental code path (invariant 13.6: no "not
 * relay_group" reader may silently treat a group text as a 1:1). The group send
 * path itself lands in S5.
 */
export class GroupTextSendNotSupportedError extends SendRefusedError {
  constructor(conversationId: string) {
    super(
      `conversation ${conversationId} is a native group_text - use the group send path, not the 1:1 send wrapper`,
      'group_text_not_supported',
    );
  }
}

/**
 * SOR spec D3. The three NON-refusal failure classes of a send, typed so an
 * adopter can act on WHERE the send failed. None extends SendRefusedError, and
 * a refusal is never wrapped in one (every caller and the refusal parity test
 * key on `instanceof SendRefusedError`).
 */

/** A failure BEFORE the provider call (a read, the breaker, the transport classification): nothing was sent. */
export class SendNotAttemptedError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The provider call threw. Carries the D1 classification, the cause, the
 * reconcile facts and the attempt start. The message carries the cause's
 * message.
 */
export class ProviderSendFailedError extends Error {
  readonly classification: SendFailureClassification;
  readonly cause: unknown;
  readonly facts: SendAttemptFacts;
  readonly attemptedAt: string;
  /** Mirrors of the cause's own `code` / `status`, so a reader of `err.code` keeps seeing the Twilio code. */
  readonly code?: string | number;
  readonly status?: number;
  constructor(args: {
    classification: SendFailureClassification;
    cause: unknown;
    facts: SendAttemptFacts;
    attemptedAt: string;
  }) {
    const causeMessage = args.cause instanceof Error ? args.cause.message : String(args.cause);
    super(`provider send failed (${args.classification.kind}): ${causeMessage}`);
    this.name = new.target.name;
    this.classification = args.classification;
    this.cause = args.cause;
    this.facts = args.facts;
    this.attemptedAt = args.attemptedAt;
    const c = args.cause as { code?: unknown; status?: unknown } | null;
    if (c !== null && typeof c === 'object') {
      if (typeof c.code === 'string' || typeof c.code === 'number') this.code = c.code;
      if (typeof c.status === 'number') this.status = c.status;
    }
  }
}

/**
 * The provider ACCEPTED the message and the row write (the append) failed:
 * the text went out and is not recorded. Carries the provider SID, timestamp
 * and status (accepted-send-lost-when-append-fails, piece 1).
 */
export class SendAcceptedNotRecordedError extends Error {
  readonly providerSid: string;
  readonly providerTs: string;
  readonly status: DeliveryStatus;
  readonly cause: unknown;
  readonly facts: SendAttemptFacts;
  constructor(args: {
    providerSid: string;
    providerTs: string;
    status: DeliveryStatus;
    cause: unknown;
    facts: SendAttemptFacts;
  }) {
    super(`send accepted by the provider but not recorded (${args.providerSid})`);
    this.name = new.target.name;
    this.providerSid = args.providerSid;
    this.providerTs = args.providerTs;
    this.status = args.status;
    this.cause = args.cause;
    this.facts = args.facts;
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
   * True for a send GATED like a machine's: the circuit breaker meters it and
   * manual mode refuses it (reminders, the missed-call and welcome texts, AI in
   * Phase 2). A person's send is false: never metered and never refused by
   * manual mode, but judged by the just-in-time consent gate. The
   * automatic 30003 retry passes the ORIGINAL send's value (retry-send-window
   * D14), so a person's text is retried as a person's send - the flag says how
   * a send is gated, not who initiated it. Persisted on every row this wrapper
   * appends as `automated` (false included - the default is a person's send).
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
   * Retry lineage: the tsMsgId of the FAILED message this send supersedes,
   * persisted as `retry_of` on the new message AT APPEND so the contact
   * timeline collapses the stale failed bubble. The manual Retry route passes
   * it alone; the automatic 30003 retry (messaging.retrySend) passes it with
   * retryAttempt and retryWindowStart (retry-send-window D6). Absent on a
   * normal send.
   */
  retryOf?: string;
  /**
   * retry-send-window D6: the 1-based attempt number of an automatic 30003
   * retry, persisted as `retry_attempt` AT APPEND so a fast 30003 on the new
   * message reads the chain's depth (the cap) with no annotate-after race.
   * Absent on every other send, the manual Retry included.
   */
  retryAttempt?: number;
  /**
   * retry-send-window D2/D6: the ORIGIN of the automatic retry chain - the
   * first send's provider_ts - persisted as `retry_window_start`, so attempts 2
   * and 3 measure the 15-minute window from the first send. A manual Retry
   * never passes it: a human chose to send now.
   */
  retryWindowStart?: string;
  /**
   * share-skip-fix I8: the contact the CALLER already resolved as the
   * recipient (the broadcast fan-out's fenced tenant), handed over as the
   * item so this path does no second read. When set, the deleted and
   * JIT-consent gates judge THIS contact rather than whichever contact the
   * phone lookup returns first (duplicate contacts on one phone), and the
   * opt-out gate refuses on EITHER contact's flag - all of this only while the
   * recipient still holds the thread's number (see the D14 note below).
   * Absent on every other send. So the deleted and consent gates judge the
   * caller's already-resolved snapshot (redundant with the fan-out's own
   * fence); opt-out stays fresh.
   * retry-send-window D14: its id is persisted as `recipient_contact_id`, so a
   * retry of the row can judge the SAME contact (read back by id) - but ONLY
   * while that contact still holds this thread's number (contactHoldsPhone): a
   * recipient that moved off it is ignored for every gate, the phone-matched
   * contact is judged, no id is recorded, and a WARN names it.
   */
  recipient?: ContactItem;
  /**
   * Code review ADV-1: the caller's last word before the provider call - run
   * after every gate and pre-provider step, immediately before the send. The
   * broadcast fan-out re-arms its send-attempt claim here. `false` means the
   * caller's attempt was taken over: nothing is sent, and the send throws
   * SendNotAttemptedError. A throw is a SendNotAttemptedError too (nothing was
   * sent). Absent on every other send.
   */
  beforeProviderSend?: () => Promise<boolean>;
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
  adapter?: MessagingAdapter & CarrierMessageSender;
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

  /**
   * SOR D3: a NON-refusal throw from a step before the provider call is a
   * SendNotAttemptedError (nothing was sent). A refusal passes through
   * untouched - never wrap one.
   */
  async function notAttempted<T>(run: () => Promise<T> | T, step: string): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof SendRefusedError) throw err;
      throw new SendNotAttemptedError(`send not attempted: ${step} failed`, err);
    }
  }

  return async function sendMessage(input) {
    const {
      conversationId,
      body,
      mediaUrls,
      attachments,
      automated = false,
      author = 'teammate',
      from,
      broadcastId,
      retryOf,
      retryAttempt,
      retryWindowStart,
      recipient,
      beforeProviderSend,
    } = input;
    mergeContext({ conversationId });

    const conversation = await notAttempted(() => conversations.getById(conversationId), 'conversation read');
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
    if (conversation.type === 'group_text') {
      throw new GroupTextSendNotSupportedError(conversationId);
    }
    const participantPhone = conversation.participant_phone;
    if (participantPhone === undefined) throw new RelaySendNotSupportedError(conversationId);

    // (1) Opt-out gate — suppression beats everything (doc §7.1 / 21610).
    // EITHER flag refuses: the conversation-level flag covers STOPs from
    // phones with no contact record yet (auto-capture is M1.2).
    const phoneContact = await notAttempted(() => contacts.findByPhone(participantPhone), 'contact read');
    // A named recipient (share-skip-fix I8) stands for this thread only while it
    // still HOLDS the thread's number. A retry (messaging.retrySend, the manual
    // Retry route) replays the recipient recorded at the original send, and that
    // contact may have moved off the number since; the text still goes to the
    // number, so the gates then judge whoever holds it now, like any other send
    // (retry-send-window planner review).
    const heldRecipient =
      recipient !== undefined && contactHoldsPhone(recipient, participantPhone) ? recipient : undefined;
    if (recipient !== undefined && heldRecipient === undefined) {
      log.warn(
        { conversationId, recipientContactId: recipient.contactId, phoneContactId: phoneContact?.contactId },
        'send: the named recipient no longer holds this thread number - judging the phone-matched contact',
      );
    }
    // The contact the deleted + consent gates judge: the caller's resolved
    // recipient when it still holds the number (share-skip-fix I8), else the
    // phone-matched one.
    const contact = heldRecipient ?? phoneContact;
    if (
      isOptedOut(conversation.sms_opt_out, phoneContact?.sms_opt_out) ||
      heldRecipient?.sms_opt_out === true
    ) {
      log.warn(
        {
          conversationId,
          contactId: contact?.contactId,
          // Which record carried the flag: the phone-matched contact and the
          // caller's recipient can differ (duplicate contacts on one phone).
          phoneContactId: phoneContact?.contactId,
          phoneContactOptOut: phoneContact?.sms_opt_out === true,
          recipientContactId: heldRecipient?.contactId,
          recipientOptOut: heldRecipient?.sms_opt_out === true,
          conversationOptOut: conversation.sms_opt_out === true,
        },
        'send refused: sms_opt_out is set (conversation and/or contact)',
      );
      throw new ContactOptedOutError(conversationId);
    }

    // (1b) Deleted gate — a soft-deleted contact is unreachable until restored
    // (deleted-contact resurfacing spec 2026-08-03). Sits between opt-out and
    // consent: harder than no-consent (the dashboard must show "restore to
    // reply", never open the consent modal), softer than opt-out (TCPA wins).
    if (contact !== undefined && isDeleted(contact)) {
      log.warn({ conversationId, contactId: contact.contactId }, 'send refused: contact is soft-deleted');
      throw new ContactDeletedError(conversationId);
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
      const count = await notAttempted(
        () => conversations.incrementAutomatedSendCount(conversationId, minuteBucket()),
        'breaker increment',
      );
      if (count > config.sendBreakerMaxPerMinute) {
        await notAttempted(async () => {
          await conversations.setMode(conversationId, 'manual');
          // Sec 5 mandate: mode flips are audit-trail events.
          await audit.append(`conversations#${conversationId}`, 'mode_changed', {
            from: 'auto',
            to: 'manual',
            reason: 'breaker_trip',
          });
        }, 'breaker trip write');
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
    //
    // Otherwise pin the business number (config.businessPhoneNumber) — the same
    // number that is already the outbound voice caller ID and the public
    // flyer's "text us" CTA. Without a pin the Messaging Service chooses from
    // its whole sender pool, which holds the relay pool numbers too, so a 1:1
    // text could arrive from a number the tenant has never seen (Sticky Sender
    // has nothing to stick to for a contact we have never messaged). Both stay
    // INSIDE the service — `from` selects WHICH pooled sender, it does not
    // bypass A2P registration. See
    // docs/issues/one-to-one-sender-not-pinned-to-ported-number.md.
    // An unconfigured BUSINESS_PHONE_NUMBER (dev/test only — prod+twilio
    // fail-fasts at boot) degrades to the previous service-picks behavior.
    const sender = pinnedSender(config, from);
    const { transportIntent, prepared } = await notAttempted(() => {
      const intent = adapter.classifyMessageTransport({
        hasForwardableMedia:
          (attachments?.length ?? 0) > 0 || (mediaUrls?.length ?? 0) > 0,
      });
      return {
        transportIntent: intent,
        prepared: adapter.prepareMessageSend(intent, {
          to: participantPhone,
          ...(body !== undefined && { body }),
          ...(mediaUrls !== undefined && { mediaUrls }),
          ...(sender !== undefined && { from: sender }),
        }),
      };
    }, 'transport preparation');

    // SOR D3/D13: the facts a reconcile matches this attempt on, and its start.
    const fp = bodyFingerprint(body);
    const facts: SendAttemptFacts = {
      recipientDigest: recipientDigest(sender, participantPhone),
      ...(sender !== undefined && { sender }),
      bodyHash: fp.hash,
      bodyShort: fp.short,
      mediaCount: mediaUrls?.length ?? attachments?.length ?? 0,
    };
    if (beforeProviderSend !== undefined && !(await notAttempted(beforeProviderSend, 'pre-send hook'))) {
      throw new SendNotAttemptedError('send not attempted: the attempt was taken over', undefined);
    }
    const attemptedAt = new Date().toISOString();
    let result: SendMessageResult;
    try {
      result = await adapter.sendPreparedMessage(prepared);
    } catch (err) {
      if (err instanceof SendRefusedError) throw err;
      throw new ProviderSendFailedError({ classification: classifySendFailure(err), cause: err, facts, attemptedAt });
    }

    // (4) Persist at send time under the provider SID/timestamp - the
    // webhook echo of this same message dedupes against this item. The
    // provider has ACCEPTED the text: a failure here is
    // SendAcceptedNotRecordedError, carrying the SID (SOR D3).
    const appendInput: NewMessage = {
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
      transportSchemaVersion: TRANSPORT_SCHEMA_VERSION,
      requestedTransport: transportIntent.requestedTransport,
      ...(result.actualTransport !== undefined && {
        actualTransport: result.actualTransport,
      }),
      // M1.8a: stamp the broadcast id so the delivery-callback rollup can find
      // this recipient's broadcast slot by the SID alone (additive — absent on
      // 1:1 / relay sends).
      ...(broadcastId !== undefined && { broadcastId }),
      // Retry lineage, stamped AT APPEND (retry-send-window D6): the manual
      // Retry passes retryOf alone; the automatic 30003 retry passes all three,
      // so a fast 30003 on the retry can never read a row without its attempt
      // number or its chain's window origin. Absent on a normal send.
      ...(retryOf !== undefined && { retryOf }),
      ...(retryAttempt !== undefined && { retryAttempt }),
      ...(retryWindowStart !== undefined && { retryWindowStart }),
      // retry-send-window D14: the send's own flags, so its automatic retry is
      // sent the same way - `automated` on EVERY row (false included: the
      // input's default is a person's send) and the caller's recipient by id.
      automated,
      ...(heldRecipient !== undefined && { recipientContactId: heldRecipient.contactId }),
    };
    let appended: AppendResult;
    try {
      appended = await messages.append(appendInput);
    } catch (err) {
      throw new SendAcceptedNotRecordedError({
        providerSid: result.providerSid,
        providerTs: result.providerTs,
        status: result.status,
        cause: err,
        facts,
      });
    }

    // (5) Inbox touch - denormalized last-activity + preview (doc Sec 5) - and
    // the Sec 5 audit-trail entry for the send (IDs only, never the body).
    // BEST-EFFORT from here on (SOR D3): the text is out and its row is
    // written, so a failure below is logged at ERROR and the send still
    // returns its normal result - reporting it as failed was the falsehood
    // (the staff send route now answers 201 where it answered 500).
    let touched: ConversationItem | undefined;
    try {
      touched = await conversations.touchLastActivity(conversationId, body, result.providerTs);
    } catch (err) {
      log.error(
        { err, conversationId, providerSid: result.providerSid, step: 'touchLastActivity' },
        'outbound message sent but a post-append step failed (best-effort)',
      );
    }
    try {
      await audit.append(`conversations#${conversationId}`, 'message_sent', {
        providerSid: result.providerSid,
        automated,
        author,
      });
    } catch (err) {
      log.error(
        { err, conversationId, providerSid: result.providerSid, step: 'audit' },
        'outbound message sent but a post-append step failed (best-effort)',
      );
    }

    // (6) SSE live updates (M1.2): dashboards see this send (their own and
    // other operators') without polling. Outbound NEVER touches unread_count
    // - the event just carries the current value from the touch's ALL_NEW,
    // so it is skipped (never built from nothing) when the touch failed.
    events.emit('message.persisted', {
      conversationId,
      tsMsgId: appended.tsMsgId,
      direction: 'outbound',
      deliveryStatus: result.status,
    });
    if (touched !== undefined) events.emit('conversation.updated', toConversationUpdatedEvent(touched));

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
