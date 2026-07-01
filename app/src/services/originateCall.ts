// Outbound masked-call origination service (Voice Phase 1, spec §5). Fills the
// `initiateCall` adapter gap: a navigator places a masked call to a contact from
// the dashboard. This GENERALIZES the inbound founder-bridge to originate
// outbound — it rings the NAVIGATOR's verified cell first, then (behind the same
// whisper + press-1 gate) bridges to the target with the BUSINESS number as
// caller ID. The navigator's real cell is NEVER exposed to the target.
//
// PII (spec §9): NEVER a raw navigator/target phone in a log line, a TwiML URL,
// or a stored call label — opaque ids + a masked role/name label only. The
// bridge resolves the target SERVER-SIDE from the opaque conversationId; the raw
// phone never rides the TwiML URL.
import type { MessagingAdapter } from '../adapters/messaging.js';
import type { AppConfig } from '../lib/config.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { mergeContext } from '../lib/context.js';
import {
  contactPhones,
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import {
  conversationTypeFor,
  maskedCallerLabel,
} from '../lib/voiceMasking.js';
import {
  createConversationsRepo,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createMessagesRepo, type MessagesRepo } from '../repos/messagesRepo.js';
import { createUsersRepo, type UsersRepo } from '../repos/usersRepo.js';

/**
 * A machine-readable refusal from the originate service — the route maps each
 * `code` to the LOCKED HTTP status/JSON (contract 1). NO call is placed for any
 * of these; they are pre-dial guards.
 */
export class OriginateRefusedError extends Error {
  constructor(
    readonly code:
      | 'cell_not_verified'
      | 'contact_not_found'
      | 'invalid_phone'
      | 'contact_voice_opted_out'
      | 'voice_not_configured',
  ) {
    super(code);
    this.name = 'OriginateRefusedError';
  }
}

export interface OriginateCallInput {
  /** The calling navigator's userId (from the session). */
  navigatorUserId: string;
  contactId: string;
  /** Optional explicit E.164 target; must belong to the contact. Default = primary. */
  phone?: string;
}

export interface OriginateCallResult {
  callSid: string;
}

export type OriginateCallService = (input: OriginateCallInput) => Promise<OriginateCallResult>;

export interface OriginateCallServiceDeps {
  config: AppConfig;
  logger?: Logger;
  usersRepo?: UsersRepo;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  adapter: MessagingAdapter;
  events?: EventBus;
}

/** The contact's primary phone (the byPhone scalar), or the first roster number. */
function primaryPhoneOf(contact: ContactItem): string | undefined {
  const phones = contactPhones(contact);
  const primary = phones.find((p) => p.primary) ?? phones[0];
  return primary?.phone;
}

export function createOriginateCallService(deps: OriginateCallServiceDeps): OriginateCallService {
  const log = deps.logger ?? defaultLogger;
  const { config, adapter } = deps;
  const users = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const baseUrl = config.publicBaseUrl ?? '';
  // The masked caller ID for the OUTBOUND leg to the target: ALWAYS the first
  // business number we own, NEVER the navigator's cell (the masking invariant).
  const businessCallerId = config.ourPhoneNumbers[0];

  return async function originateCall(input): Promise<OriginateCallResult> {
    // (1) The calling navigator MUST have a verified cell — it is the leg we
    // ring first. Absent/unverified → refuse, NO call placed.
    const navigator = await users.findById(input.navigatorUserId);
    if (!navigator || typeof navigator.cell !== 'string' || navigator.cell.length === 0 ||
        typeof navigator.cell_verified_at !== 'string' || navigator.cell_verified_at.length === 0) {
      throw new OriginateRefusedError('cell_not_verified');
    }

    // (2) Resolve the target contact + the target phone.
    const contact = await contacts.getById(input.contactId);
    if (!contact || contact.phone_ref === true) {
      throw new OriginateRefusedError('contact_not_found');
    }
    mergeContext({ contactId: contact.contactId });

    // company do-not-call (spec §8): honored on EVERY originate path. NO call.
    // Must be checked BEFORE phone resolution so a DNC contact with no phone gets
    // 409 contact_voice_opted_out, not 400 invalid_phone (spec §5 step ordering).
    if (contact.voice_opt_out === true) {
      throw new OriginateRefusedError('contact_voice_opted_out');
    }

    let targetPhone: string | undefined;
    if (input.phone !== undefined) {
      // An explicit target must be one of the contact's OWN numbers (never an
      // arbitrary phone — that would bridge the navigator to a stranger).
      const owned = contactPhones(contact).some((p) => p.phone === input.phone);
      if (!owned) throw new OriginateRefusedError('invalid_phone');
      targetPhone = input.phone;
    } else {
      targetPhone = primaryPhoneOf(contact);
      if (targetPhone === undefined) throw new OriginateRefusedError('invalid_phone');
    }

    // No business number to mask behind → we cannot place a masked call without
    // leaking the navigator's cell to the target. Refuse (503-shaped).
    if (businessCallerId === undefined) {
      log.error({ contactId: contact.contactId }, 'originate: no business caller ID configured — cannot place a masked call');
      throw new OriginateRefusedError('voice_not_configured');
    }

    // (3) The 1:1 conversation is the OPAQUE key the outbound bridge resolves the
    // target from — the raw target phone is NEVER placed in the TwiML URL.
    const conversation = await conversations.createOrGetByParticipantPhone(
      targetPhone,
      conversationTypeFor(contact),
    );
    mergeContext({ conversationId: conversation.conversationId });

    // (4) The bridge TwiML URL carries ONLY the opaque conversationId.
    const twimlUrl =
      `${baseUrl}/webhooks/twilio/voice/outbound-bridge` +
      `?conversationId=${encodeURIComponent(conversation.conversationId)}`;

    // (5) Ring the NAVIGATOR's cell first, FROM the business number. A stable
    // idempotency key (the conversation + navigator) hints the console driver;
    // DB-level CallSid dedupe (append) is the real guard.
    const idempotencyKey = `outbound:${conversation.conversationId}:${navigator.userId}`;
    const { callSid } = await adapter.initiateCall({
      to: navigator.cell,
      from: businessCallerId,
      twimlUrl,
      idempotencyKey,
    });

    // (6) Persist the outbound `call` entry (CallSid-idempotent — the append
    // dedupes). masked:false (an outbound bridge RECORDS, like the founder-
    // bridge). author = 'teammate' (the navigator initiated). callPartyLabel is
    // the MASKED contact label (role/name) — NEVER the raw target phone.
    const startedAt = new Date().toISOString();
    const callPartyLabel = maskedCallerLabel(contact);
    try {
      const appended = await messages.append({
        conversationId: conversation.conversationId,
        providerSid: callSid,
        providerTs: startedAt,
        type: 'call',
        direction: 'outbound',
        author: 'teammate',
        deliveryStatus: 'delivered',
        callStatus: 'ringing',
        startedAt,
        masked: false,
        callPartyLabel,
      });
      if (!appended.deduped) {
        events.emit('message.persisted', {
          conversationId: conversation.conversationId,
          tsMsgId: appended.tsMsgId,
          direction: 'outbound',
          deliveryStatus: 'delivered',
        });
      }
    } catch (err) {
      // The call is already placed; a persist failure must not 5xx the caller
      // (a redelivered status callback would still find nothing — acceptable;
      // the call itself is live). Log IDs only.
      log.error({ err, callSid }, 'originate: persisting the outbound call entry failed — call is live regardless');
    }

    // IDs + masked booleans only — NEVER the navigator/target phone (PII, §9).
    log.info(
      { callSid, conversationId: conversation.conversationId, callerIdIsBusiness: true, masked: false, author: 'teammate' },
      'originate: ringing navigator cell, will bridge to target from the business number (whisper+gate)',
    );
    return { callSid };
  };
}
