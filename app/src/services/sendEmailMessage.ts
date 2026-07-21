// Outbound EMAIL send service (email-channel v1, Task A5) - the email analog of
// services/sendMessage.ts, mirroring its shape (typed refusal family + fully
// injectable deps) with TWO DELIBERATE divergences (worklist ADJ-6), which
// reviewers must NOT "fix":
//   1. the kill-switch refusal maps to 409 (SMS uses 503) - route concern.
//   2. the message persists 'queued' BEFORE adapter.send, then advances to
//      'sent' (or 'failed' on throw) - SMS persists AFTER send. SES can throw,
//      so a pre-send optimistic persist is what makes a failed send VISIBLE.
//
// Provider-id convention (adjudicated): we do NOT know the SES MessageId until
// adapter.send returns, so the pre-send persist uses our OWN RFC Message-ID as
// provider_sid (bare, no angle brackets) and writes the emailmsgid#<bareId>
// pointer too (rfcMessageIdPointer). AFTER send, recordProviderSidAlias maps the
// SES MessageId -> this message (a second sid# pointer) + stamps ses_message_id,
// so B5 delivery/bounce/complaint events (keyed on the SES id) resolve it and
// run the same forward-only delivery machine. The post-send pointer write then
// checks the B5 parking lot (ADJ-7) for an already-arrived event.
//
// PII (doc Sec 9): log ids/counts only - never addresses, subject, or body.
import { randomUUID } from 'node:crypto';
import { mergeContext } from '../lib/context.js';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { EMAIL_MAX_TOTAL_BYTES, isEmailAttachmentType } from '../lib/mediaTypes.js';
import { isValidEmailAddress, normalizeEmailAddress } from '../lib/email.js';
import { createEmailAdapter, type EmailAdapter, type OutboundEmail } from '../adapters/email.js';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  type DeliveryStatus,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import { contactEmails, createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { isKillSwitchOff } from './scheduledSendSuppression.js';

// --- Typed refusals (route maps these to HTTP statuses) --------------------

/** Base class so callers can `instanceof` the whole email-refusal family. */
export class EmailSendRefusedError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable refusal code. */
    readonly code:
      | 'email_sending_disabled'
      | 'email_suppressed'
      | 'email_attachments_too_large'
      | 'contact_email_missing'
      | 'invalid_cc'
      | 'invalid_attachment'
      | 'conversation_not_found',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The email kill-switch is OFF (config.emailSendingEnabled false) OR the sender
 * identity is not configured (no EMAIL_FROM_ADDRESS / EMAIL_SENDER_DOMAIN to
 * compose a From/Reply-To/Message-ID) - either way this stack cannot send email
 * right now, refused before any persistence. Route maps to 409 (ADJ-6, not 503).
 */
export class EmailSendingDisabledError extends EmailSendRefusedError {
  constructor() {
    super('email sending is disabled - send refused', 'email_sending_disabled');
  }
}

/** getById miss OR a relay_group (a pool-number thread is never email-able). */
export class EmailConversationNotFoundError extends EmailSendRefusedError {
  constructor(conversationId: string) {
    super(`conversation not found or not email-capable: ${conversationId}`, 'conversation_not_found');
  }
}

/** The To address is not one of the contact's emails on file (normalize first). */
export class ContactEmailMissingError extends EmailSendRefusedError {
  constructor() {
    super('the To address is not a contact email on file - send refused', 'contact_email_missing');
  }
}

/** A CC address failed isValidEmailAddress (400-class validation refusal). */
export class InvalidCcError extends EmailSendRefusedError {
  constructor(cc: string) {
    super(`invalid CC address: ${cc}`, 'invalid_cc');
  }
}

/** An attachment key is not our email-media/ key, is missing/expired, or its
 *  stored type is not allowlisted (400-class validation refusal). */
export class InvalidAttachmentError extends EmailSendRefusedError {
  constructor(key: string) {
    super(`invalid attachment: ${key}`, 'invalid_attachment');
  }
}

/** The summed attachment bytes exceed the 25 MB per-message cap. */
export class EmailAttachmentsTooLargeError extends EmailSendRefusedError {
  constructor() {
    super('email attachments exceed the 25 MB total cap - send refused', 'email_attachments_too_large');
  }
}

/** The contact is suppressed for email (B5 flags email_opt_out / email_unreachable). */
export class EmailSuppressedError extends EmailSendRefusedError {
  constructor() {
    super('contact is suppressed for email - send refused', 'email_suppressed');
  }
}

// --- Service ----------------------------------------------------------------

export interface SendEmailInput {
  conversationId: string;
  contactId: string;
  /** The To address (validated against the contact's emails, normalized). */
  to: string;
  cc?: string[];
  subject: string;
  body: string;
  /** email-media/<userId>/<uuid> keys from the A5 presign/confirm pair. */
  attachmentKeys?: string[];
  sentByUserId: string;
  sentByName: string;
}

export interface SendEmailOutcome {
  /** The EFFECTIVE conversation the message landed in (see `redirected`). */
  conversationId: string;
  tsMsgId: string;
  /** Our own RFC Message-ID, bare (== message.provider_sid). */
  providerSid: string;
  /** The SES MessageId returned by adapter.send. */
  sesMessageId: string;
  /** The RFC Message-ID header, WITH angle brackets. */
  emailMessageId: string;
  status: DeliveryStatus;
  /** True when the claim arbiter threaded the message into a DIFFERENT
   *  conversation than the one requested (the address was already claimed). */
  redirected: boolean;
}

export interface SendEmailServiceDeps {
  config?: AppConfig;
  logger?: Logger;
  adapter?: EmailAdapter;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  contactsRepo?: ContactsRepo;
  /** Undefined when MEDIA_BUCKET is unset; only needed when attachments present. */
  mediaStore?: MediaStore;
  /** SSE live-update bus (the process singleton by default). */
  events?: EventBus;
  /**
   * ADJ-7 seam: after the post-send SES-id alias is written, apply any B5-parked
   * bounce/complaint for that SES MessageId immediately (a fast bounce can arrive
   * before the pointer exists). Defaults to an async no-op in Phase A; B5
   * implements the parking lot and injects the real applier.
   */
  applyParkedEmailEvents?: (sesMessageId: string) => Promise<void>;
  /** Injected clock (tests). */
  now?: () => Date;
}

export type SendEmailService = (input: SendEmailInput) => Promise<SendEmailOutcome>;

// email-media/<userId>/<uuid> - the same shape routes/emailMedia.ts mints. Kept
// local (a service must not import from routes/) so the key guard is self-contained.
const EMAIL_MEDIA_KEY_RE = /^email-media\/[^/]+\/[0-9a-f-]+$/;

/** Content-Type -> attachment filename extension. The confirm contract returns
 *  no original filename, so the send derives a stable, safe name per attachment. */
const EMAIL_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

export function createSendEmailMessageService(deps: SendEmailServiceDeps = {}): SendEmailService {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const adapter = deps.adapter ?? createEmailAdapter({ config, logger: log });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const mediaStore = deps.mediaStore ?? createMediaStore({ config });
  const events = deps.events ?? appEvents;
  const applyParkedEmailEvents =
    deps.applyParkedEmailEvents ??
    // TODO(B5): default no-op. B5 implements the orphan-event parking lot + the
    // real applier and injects it here; A5 only guarantees it is CALLED with the
    // SES MessageId right after the post-send pointer write (ADJ-7).
    (async () => {});
  const now = deps.now ?? (() => new Date());

  return async function sendEmail(input) {
    const { conversationId, contactId, to, subject, body, sentByName } = input;
    mergeContext({ conversationId });

    // (1) Kill-switch FIRST - refuse before ANY persistence (parity with SMS).
    if (isKillSwitchOff(config.emailSendingEnabled)) {
      log.warn({ conversationId }, 'email send refused: sending disabled (kill-switch)');
      throw new EmailSendingDisabledError();
    }
    // Sender identity is required to compose valid headers. Treated as "sending
    // disabled" (this stack is not configured to send) - refused pre-persist.
    if (!config.emailFromAddress || !config.emailSenderDomain) {
      log.warn({ conversationId }, 'email send refused: sender identity not configured');
      throw new EmailSendingDisabledError();
    }
    const fromAddress = config.emailFromAddress;
    const senderDomain = config.emailSenderDomain;

    // (2) The To address must be one of the contact's emails (normalize first).
    const contact = await contacts.getById(contactId);
    const toNormalized = normalizeEmailAddress(to);
    const onFile = contact ? contactEmails(contact).map((e) => e.email) : [];
    if (!contact || !onFile.includes(toNormalized)) {
      log.warn({ conversationId, contactId }, 'email send refused: To not a contact email on file');
      throw new ContactEmailMissingError();
    }
    // CC is free-form but each must be a valid address (normalized for send).
    const ccNormalized: string[] = [];
    for (const raw of input.cc ?? []) {
      if (!isValidEmailAddress(raw)) throw new InvalidCcError(raw);
      ccNormalized.push(normalizeEmailAddress(raw));
    }

    // (3) Suppression: B5 sets email_opt_out / email_unreachable on the contact.
    // Read them off the item DIRECTLY - they are not yet in the ContactFlag union
    // (do NOT widen it here). Absent flags = allowed.
    const flags = contact as { email_opt_out?: boolean; email_unreachable?: boolean };
    if (flags.email_opt_out === true || flags.email_unreachable === true) {
      log.warn({ conversationId, contactId }, 'email send refused: contact suppressed');
      throw new EmailSuppressedError();
    }

    // (4) Attachments: validate each key, HEAD it, sum <= cap, fetch bytes. The
    // stored object is used VERBATIM (no transcode).
    const attachmentKeys = input.attachmentKeys ?? [];
    const attachments: { filename: string; contentType: string; content: Buffer }[] = [];
    if (attachmentKeys.length > 0) {
      if (!mediaStore) throw new Error('email attachments require media storage (MEDIA_BUCKET unset)');
      let totalBytes = 0;
      for (let i = 0; i < attachmentKeys.length; i++) {
        const key = attachmentKeys[i]!;
        if (!EMAIL_MEDIA_KEY_RE.test(key)) throw new InvalidAttachmentError(key);
        const meta = await mediaStore.head(key);
        if (!meta) throw new InvalidAttachmentError(key);
        const contentType = (meta.contentType ?? '').trim().toLowerCase();
        if (!isEmailAttachmentType(contentType)) throw new InvalidAttachmentError(key);
        totalBytes += meta.size ?? 0;
        if (totalBytes > EMAIL_MAX_TOTAL_BYTES) throw new EmailAttachmentsTooLargeError();
        const bytes = await mediaStore.getBytes(key);
        if (!bytes) throw new InvalidAttachmentError(key);
        attachments.push({
          filename: `attachment-${i + 1}${EMAIL_EXTENSIONS[contentType] ?? '.bin'}`,
          contentType,
          content: bytes,
        });
      }
    }

    // (5) Resolve the conversation (must exist + not relay_group).
    const conversation = await conversations.getById(conversationId);
    if (!conversation || conversation.type === 'relay_group') {
      throw new EmailConversationNotFoundError(conversationId);
    }
    // The claim arbiter (A4): claim the To address for this conversation. If it is
    // already claimed ELSEWHERE, thread into THAT conversation instead.
    const attached = await conversations.attachEmailToConversation(conversationId, toNormalized);
    const effectiveConversationId = attached.conversationId;
    const redirected = effectiveConversationId !== conversationId;
    if (redirected) mergeContext({ conversationId: effectiveConversationId });

    // Mint the reply token (idempotent) + our own RFC Message-ID.
    const replyToken = await conversations.getReplyToken(effectiveConversationId);
    const bareId = `hc-${randomUUID()}@${senderDomain}`; // provider_sid + pointer key (no brackets)
    const messageIdHeader = `<${bareId}>`; // the RFC header value (with brackets)
    const replyTo = `relay+${replyToken}@${senderDomain}`;
    const nowIso = now().toISOString();

    // Persist 'queued' FIRST under our own RFC id (ADJ-6). rfcMessageIdPointer =
    // bareId also writes the emailmsgid#<bareId> pointer for inbound-reply threading.
    const appended = await messages.append({
      conversationId: effectiveConversationId,
      providerSid: bareId,
      providerTs: nowIso,
      type: 'email',
      direction: 'outbound',
      author: 'teammate',
      body,
      deliveryStatus: 'queued',
      subject,
      email_from: fromAddress,
      email_to: [toNormalized],
      ...(ccNormalized.length > 0 && { email_cc: ccNormalized }),
      email_message_id: messageIdHeader,
      rfcMessageIdPointer: bareId,
    });

    // Touch + SSE, reused by both the failed and sent paths so a failed send is
    // still surfaced live (the dashboard flips its optimistic bubble to failed).
    const emitPersisted = async (status: DeliveryStatus) => {
      const touched = await conversations.touchLastActivity(effectiveConversationId, body, nowIso);
      events.emit('message.persisted', {
        conversationId: effectiveConversationId,
        tsMsgId: appended.tsMsgId,
        direction: 'outbound',
        deliveryStatus: status,
      });
      events.emit('conversation.updated', toConversationUpdatedEvent(touched));
      return touched;
    };

    const mail: OutboundEmail = {
      from: { name: `${sentByName} at Housing Choice`, address: fromAddress },
      to: [toNormalized],
      ...(ccNormalized.length > 0 && { cc: ccNormalized }),
      replyTo,
      subject,
      text: body,
      messageIdHeader,
      ...(attachments.length > 0 && { attachments }),
    };

    let sesMessageId: string;
    try {
      const result = await adapter.send(mail);
      sesMessageId = result.providerMessageId;
      // Post-send pointer write (ADJ-7): alias the SES id -> this message so B5
      // events resolve it, advance queued->sent, THEN apply any parked event.
      await messages.recordProviderSidAlias(sesMessageId, {
        conversationId: effectiveConversationId,
        tsMsgId: appended.tsMsgId,
      });
      await messages.updateDeliveryStatus(bareId, 'sent');
      await applyParkedEmailEvents(sesMessageId);
    } catch (err) {
      // Adapter threw: advance queued->failed (the message REMAINS, visible as a
      // failed send), surface it live, then rethrow so the caller knows.
      const errorCode = err instanceof Error ? err.message.slice(0, 200) : 'send_failed';
      await messages.updateDeliveryStatus(bareId, 'failed', errorCode);
      await emitPersisted('failed');
      log.error({ conversationId: effectiveConversationId, providerSid: bareId }, 'email send failed at adapter');
      throw err;
    }

    // Success: best-effort lastSeen bump + SSE + inbox touch.
    await contacts.touchEmailLastSeen(contactId, toNormalized, nowIso).catch(() => {});
    await emitPersisted('sent');
    log.info(
      { conversationId: effectiveConversationId, providerSid: bareId, sesMessageId, redirected },
      'outbound email sent',
    );
    return {
      conversationId: effectiveConversationId,
      tsMsgId: appended.tsMsgId,
      providerSid: bareId,
      sesMessageId,
      emailMessageId: messageIdHeader,
      status: 'sent',
      redirected,
    };
  };
}
