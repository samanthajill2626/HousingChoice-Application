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
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { createMessagingAdapter, type MessagingAdapter } from '../adapters/messaging.js';
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
  type MessagesRepo,
} from '../repos/messagesRepo.js';

// --- Typed errors (route maps these to HTTP statuses) ----------------------

/** Base class so callers can `instanceof` the whole refusal family. */
export class SendRefusedError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable refusal code. */
    readonly code: 'conversation_not_found' | 'contact_opted_out' | 'breaker_open' | 'manual_mode',
  ) {
    super(message);
    this.name = new.target.name;
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

// --- Service ----------------------------------------------------------------

export interface SendMessageInput {
  conversationId: string;
  body?: string;
  mediaUrls?: string[];
  /**
   * True for machine-initiated sends (reminders, AI in Phase 2) — these are
   * what the circuit breaker meters and what manual mode refuses. M1.1's
   * dashboard route sends are human (false): always allowed, never counted.
   */
  automated?: boolean;
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
}

export type SendMessageService = (input: SendMessageInput) => Promise<SendMessageOutcome>;

export function createSendMessageService(deps: SendMessageServiceDeps = {}): SendMessageService {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const adapter = deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });

  return async function sendMessage(input) {
    const { conversationId, body, mediaUrls, automated = false } = input;
    mergeContext({ conversationId });

    const conversation = await conversations.getById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    // (1) Opt-out gate — suppression beats everything (doc §7.1 / 21610).
    const contact = await contacts.findByPhone(conversation.participant_phone);
    if (contact?.sms_opt_out === true) {
      log.warn({ conversationId, contactId: contact.contactId }, 'send refused: contact has sms_opt_out');
      throw new ContactOptedOutError(conversationId);
    }

    // (2) Circuit breaker — automated sends only; manual human sends are
    // always allowed (even in manual mode) and never counted.
    if (automated) {
      if (conversation.ai_mode === 'manual') throw new ManualModeError(conversationId);
      const count = await conversations.incrementAutomatedSendCount(conversationId, minuteBucket());
      if (count > config.sendBreakerMaxPerMinute) {
        await conversations.setMode(conversationId, 'manual');
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
    const result = await adapter.sendMessage({
      to: conversation.participant_phone,
      ...(body !== undefined && { body }),
      ...(mediaUrls !== undefined && { mediaUrls }),
    });

    // (4) Persist at send time under the provider SID/timestamp — the
    // webhook echo of this same message dedupes against this item.
    const appended = await messages.append({
      conversationId,
      providerSid: result.providerSid,
      providerTs: result.providerTs,
      type: mediaUrls !== undefined && mediaUrls.length > 0 ? 'mms' : 'sms',
      direction: 'outbound',
      author: 'teammate',
      ...(body !== undefined && { body }),
      ...(mediaUrls !== undefined && { mediaUrls }),
      deliveryStatus: result.status,
    });

    // (5) Inbox touch — denormalized last-activity + preview (doc §5).
    await conversations.touchLastActivity(conversationId, body, result.providerTs);

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
