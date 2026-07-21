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
  type MediaAttachment,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import {
  contactEmails,
  contactPhones,
  createContactsRepo,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
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
      | 'conversation_not_found'
      | 'conversation_contact_mismatch',
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

/**
 * The URL conversation does not belong to the To-derived contact (m5): its
 * participants roster lacks the contact, and neither its participant_phone nor its
 * participant_email is on that contact's file. Refused before attaching so a
 * hand-crafted authed POST cannot stamp contact A's address onto contact B's
 * thread. Route maps to 409.
 */
export class ConversationContactMismatchError extends EmailSendRefusedError {
  constructor() {
    super('conversation does not belong to the recipient contact - send refused', 'conversation_contact_mismatch');
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
  /**
   * Attachments to send: each an email-media/<userId>/<uuid> key (from the A5
   * presign/confirm pair) plus the original client filename. The filename rides
   * the outbound MIME part and is persisted on the message so the timeline gallery
   * shows the real document name.
   */
  attachments?: { key: string; filename?: string }[];
  /**
   * @deprecated Back-compat: bare keys with no filenames (the pre-filename route
   * body). Normalized to `attachments` with a derived name. Prefer `attachments`.
   */
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
    // Default no-op keeps unit tests hermetic. B5 shipped the real applier
    // (services/emailEvents.createApplyParkedEmailEvents); the production
    // composition root (routes/api.ts createApiRouter) injects it over THIS
    // router's repos, so a fast parked bounce is applied right after the
    // post-send alias write (ADJ-7).
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

    // (3) Suppression: B5's SES event pipeline sets email_opt_out (Complaint) /
    // email_unreachable (permanent Bounce) on the contact (typed ContactItem
    // fields since B5). Either refuses the send. Absent flags = allowed.
    if (contact.email_opt_out === true || contact.email_unreachable === true) {
      log.warn({ conversationId, contactId }, 'email send refused: contact suppressed');
      throw new EmailSuppressedError();
    }

    // (4) Attachments: normalize {key, filename?}, validate each key (own prefix +
    // the key's <userId> segment MUST be this sender), HEAD it, sum <= cap, fetch
    // bytes. Stored object is used VERBATIM (no transcode). The original filename
    // rides the outbound MIME part AND is persisted on the message.
    const attachmentInputs: { key: string; filename?: string }[] =
      input.attachments ?? (input.attachmentKeys ?? []).map((key) => ({ key }));
    const attachments: { filename: string; contentType: string; content: Buffer }[] = [];
    const persistedAttachments: MediaAttachment[] = [];
    if (attachmentInputs.length > 0) {
      if (!mediaStore) throw new Error('email attachments require media storage (MEDIA_BUCKET unset)');
      let totalBytes = 0;
      for (let i = 0; i < attachmentInputs.length; i++) {
        const { key, filename } = attachmentInputs[i]!;
        if (!EMAIL_MEDIA_KEY_RE.test(key)) throw new InvalidAttachmentError(key);
        // The key's user segment (email-media/<userId>/<uuid>) MUST be this sender -
        // never let an authed user attach another user's uploaded object by key.
        if (key.split('/')[1] !== input.sentByUserId) throw new InvalidAttachmentError(key);
        const meta = await mediaStore.head(key);
        if (!meta) throw new InvalidAttachmentError(key);
        const contentType = (meta.contentType ?? '').trim().toLowerCase();
        if (!isEmailAttachmentType(contentType)) throw new InvalidAttachmentError(key);
        totalBytes += meta.size ?? 0;
        if (totalBytes > EMAIL_MAX_TOTAL_BYTES) throw new EmailAttachmentsTooLargeError();
        const bytes = await mediaStore.getBytes(key);
        if (!bytes) throw new InvalidAttachmentError(key);
        // Prefer the client's original filename (CR/LF stripped); else a stable
        // synthesized name so the recipient still gets a typed file.
        const cleanName = filename?.replace(/[\r\n]+/g, ' ').trim();
        const outName =
          cleanName && cleanName.length > 0
            ? cleanName
            : `attachment-${i + 1}${EMAIL_EXTENSIONS[contentType] ?? '.bin'}`;
        attachments.push({ filename: outName, contentType, content: bytes });
        persistedAttachments.push({
          s3Key: key,
          contentType,
          ...(cleanName && cleanName.length > 0 && { filename: cleanName }),
        });
      }
    }

    // (5) Resolve the conversation (must exist + not relay_group).
    const conversation = await conversations.getById(conversationId);
    if (!conversation || conversation.type === 'relay_group') {
      throw new EmailConversationNotFoundError(conversationId);
    }
    // (5a) The URL conversation MUST belong to the To-derived contact (m5). It does
    // when: its participants roster names the contact (an email-only thread just
    // created for this contact carries the roster), OR its participant_phone is on
    // the contact's file, OR its participant_email is one of the contact's
    // addresses. Otherwise refuse BEFORE attaching - a hand-crafted authed POST
    // with a mismatched (conversationId, to) pair must never stamp this address
    // onto a foreign thread.
    const rosterHasContact = (conversation.participants ?? []).some((p) => p.contactId === contactId);
    const phoneOnFile =
      conversation.participant_phone !== undefined &&
      contactPhones(contact).some((p) => p.phone === conversation.participant_phone);
    const emailOnFile =
      conversation.participant_email !== undefined && onFile.includes(conversation.participant_email);
    if (!rosterHasContact && !phoneOnFile && !emailOnFile) {
      log.warn({ conversationId, contactId }, 'email send refused: conversation does not belong to contact');
      throw new ConversationContactMismatchError();
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
      ...(persistedAttachments.length > 0 && { mediaAttachments: persistedAttachments }),
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
