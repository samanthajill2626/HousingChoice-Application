// NUMBER-SCOPED SMS suppression - one shared reader/writer (group-texting T3.5).
//
// Suppression in this app has always been per-NUMBER, expressed across two
// existing stores (the BE1 rule, twilio.ts:664-671):
//
//   - a contact's PRIMARY number   -> the CONTACT-level `sms_opt_out` flag,
//     which suppresses that number across broadcasts, nudges and 1:1 sends;
//   - a SECONDARY (attached) number -> that number's OWN 1:1 conversation flag,
//     because contaminating the contact flag would silence their good primary.
//
// That rule was previously re-implemented at four sites (the inbound keyword
// path plus three /status branches), two of which derive the number from
// `conversation.participant_phone` - a field a `group_text` thread does not
// have, so they degrade to "no contact record to flag". This module takes an
// EXPLICIT E.164 instead and is the one place the rule lives. Bound by:
//   - the inbound keyword path (T3.5, 1:1 + group),
//   - the 21610 receipts path (T5.3),
//   - the group roster suppression chips (T4.3).
//
// LAZY TARGET. The write takes a conversation THUNK, never an item: a group
// inbound must not materialize the sender's 1:1 thread until a keyword actually
// needs one. Eagerly resolving would mint an empty needs-triage inbox row per
// group sender - a product regression.
//
// PII (doc 9): the phone is DATA. Log lines carry ids and flags only.
import { logger as defaultLogger } from '../lib/logger.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../repos/conversationsRepo.js';

/**
 * Where a number sits relative to its contact record - which decides WHICH
 * store carries its suppression.
 */
export type NumberSuppressionScope = 'primary' | 'secondary' | 'no_contact';

export interface NumberSuppressionReadDeps {
  contactsRepo: Pick<ContactsRepo, 'findByPhone'>;
  conversationsRepo: Pick<ConversationsRepo, 'findByParticipantPhone'>;
}

/** The two log levels this module emits - narrow so a test fake is four lines. */
export interface SuppressionLogSink {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface NumberSuppressionWriteDeps {
  contactsRepo: Pick<ContactsRepo, 'setFlag' | 'clearFlag'>;
  conversationsRepo: Pick<ConversationsRepo, 'setSmsOptOut'>;
  auditRepo: Pick<AuditRepo, 'append'>;
  logger?: SuppressionLogSink;
}

export interface NumberSuppressionState {
  suppressed: boolean;
  scope: NumberSuppressionScope;
  contactId?: string;
}

export interface NumberSuppressionInput {
  /** The E.164 the STOP / START / 21610 applies to. */
  phone: string;
  /** true = suppress (STOP, 21610); false = restore (START). */
  suppressed: boolean;
  /**
   * The contact owning `phone`, ALREADY RESOLVED by the caller - pass
   * `undefined` when there is none. Required (not optional) so this seam can
   * never add a repo read to a caller that already did one: the 1:1 inbound
   * path must gain no I/O (invariant 13.2).
   */
  contact: ContactItem | undefined;
  /**
   * Resolves - and, on the group path, MATERIALIZES - the phone's own 1:1
   * conversation. Called at most once, and only because a suppression write
   * genuinely needs a target.
   */
  conversation: () => Promise<ConversationItem>;
  /** Audit `source` tag: 'keyword' | 'OptOutType' | 'twilio_21610' | ... */
  source: string;
  /** Correlation id for the audit payload. */
  providerSid?: string;
  /** Extra audit detail merged into the payload (e.g. group provenance, spec 4.4). */
  auditContext?: Record<string, unknown>;
}

export interface NumberSuppressionResult {
  scope: NumberSuppressionScope;
  /** The conversation whose flag was written (the thunk's result). */
  conversationId: string;
  /** Present when a contact owns the number, whatever the scope. */
  contactId?: string;
}

/** Which store carries this number's suppression. */
export function numberSuppressionScope(
  phone: string,
  contact: ContactItem | undefined,
): NumberSuppressionScope {
  if (contact === undefined) return 'no_contact';
  return contact.phone === phone ? 'primary' : 'secondary';
}

/**
 * Is this number suppressed for SMS? READ-ONLY - it must never mint a
 * conversation (the roster-chip caller renders many members per page).
 */
export async function readNumberSuppression(
  deps: NumberSuppressionReadDeps,
  phone: string,
  opts: { contact?: ContactItem | undefined } = {},
): Promise<NumberSuppressionState> {
  const contact =
    'contact' in opts ? opts.contact : await deps.contactsRepo.findByPhone(phone);
  const scope = numberSuppressionScope(phone, contact);
  const contactId = contact?.contactId;
  // The CONTACT flag is authoritative for the PRIMARY number only. On a
  // secondary number it says nothing about this number (BE1 per-number scope).
  if (scope === 'primary' && contact?.sms_opt_out === true) {
    return { suppressed: true, scope, ...(contactId !== undefined && { contactId }) };
  }
  const threads = await deps.conversationsRepo.findByParticipantPhone(phone);
  // MULTI-PARTY THREADS ARE NOT PER-NUMBER RECORDS (invariant 13.6). Neither a
  // relay_group nor a group_text can legitimately appear here (neither carries
  // participant_phone), and spec 4.4 forbids sms_opt_out on a group thread at
  // all - naming them keeps a future GSI change from silently reinterpreting a
  // multi-party flag as this number's opt-out.
  const suppressed = threads.some(
    (c) => c.type !== 'relay_group' && c.type !== 'group_text' && c.sms_opt_out === true,
  );
  return { suppressed, scope, ...(contactId !== undefined && { contactId }) };
}

/**
 * Apply (or lift) suppression for one number, at the correct scope.
 *
 * The CONVERSATION flag is ALWAYS written - a STOP from a phone with no contact
 * record must still suppress every later send. The CONTACT flag is written only
 * for the primary number.
 */
export async function applyNumberSuppression(
  deps: NumberSuppressionWriteDeps,
  input: NumberSuppressionInput,
): Promise<NumberSuppressionResult> {
  const log = deps.logger ?? defaultLogger;
  const { phone, suppressed, contact, source, providerSid, auditContext } = input;

  const target = await input.conversation();
  await deps.conversationsRepo.setSmsOptOut(target.conversationId, suppressed);

  const eventType = suppressed ? 'sms_opt_out_recorded' : 'sms_opt_out_cleared';
  const payload = {
    ...(providerSid !== undefined && { providerSid }),
    conversationId: target.conversationId,
    source,
    ...auditContext,
  };
  const scope = numberSuppressionScope(phone, contact);

  if (contact !== undefined && scope === 'primary') {
    if (suppressed) await deps.contactsRepo.setFlag(contact.contactId, 'sms_opt_out');
    else await deps.contactsRepo.clearFlag(contact.contactId, 'sms_opt_out');
    await deps.auditRepo.append(`contacts#${contact.contactId}`, eventType, payload);
  } else if (contact !== undefined) {
    log.info(
      { providerSid, optOut: suppressed, contactId: contact.contactId },
      'opt-out/in on a non-primary attached number - conversation suppressed, contact flag NOT changed (number-scoped)',
    );
    await deps.auditRepo.append(`conversations#${target.conversationId}`, eventType, payload);
  } else {
    log.warn(
      { providerSid, optOut: suppressed },
      'opt-out/in from a phone with no contact record - conversation flagged, no contact to flag (auto-capture failed)',
    );
    await deps.auditRepo.append(`conversations#${target.conversationId}`, eventType, payload);
  }

  return {
    scope,
    conversationId: target.conversationId,
    ...(contact !== undefined && { contactId: contact.contactId }),
  };
}
