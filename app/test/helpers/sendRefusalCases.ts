// retry-send-window D3a: ONE table of one-to-one send-refusal cases.
//
// It drives BOTH halves of the drift guard: previewSendRefusal's unit test
// (sendRefusalPreview.test.ts) and the parity test that runs every row through
// the REAL send wrapper (sendMessage.test.ts, 'previewSendRefusal parity ...').
// The one-to-one retry decision's own test may run the same rows (spec test
// intention 4: "one table drives both tests").
//
// Every row is a one-to-one thread (the channel guards are the caller's, never
// the preview's), a fresh breaker (one send never trips it), the phone-matched
// contact, and an optional caller-resolved recipient on the SAME phone - the
// duplicate-contacts shape share-skip-fix I8 exists for.
import type { ContactItem } from '../../src/repos/contactsRepo.js';
import type { ConversationMode } from '../../src/repos/conversationsRepo.js';
import type { SendRefusalCode } from '../../src/services/sendRefusalPreview.js';

export interface SendRefusalCase {
  name: string;
  /** The A2P kill switch (config.smsSendingEnabled); false refuses everything. */
  smsSendingEnabled: boolean;
  conversation: { sms_opt_out?: boolean; ai_mode: ConversationMode };
  /** What contacts.findByPhone(participant_phone) returns; undefined = no record. */
  phoneContact: ContactItem | undefined;
  /** The caller-resolved recipient (sendMessage's `recipient`); undefined = none named. */
  recipient: ContactItem | undefined;
  automated: boolean;
  /** The refusal code both must produce; undefined = the send goes out. */
  expected: SendRefusalCode | undefined;
}

const PHONE = '+15550100001';
const DELETED_AT = '2026-09-01T00:00:00.000Z';

/** A live, consenting tenant - the phone-matched contact unless a row says otherwise. */
export const LIVE_CONTACT: ContactItem = {
  contactId: 'c-live',
  type: 'tenant',
  phone: PHONE,
  consent_method: 'inbound_text',
};
const NO_CONSENT: ContactItem = { contactId: 'c-nc', type: 'tenant', phone: PHONE };
const DELETED: ContactItem = { ...LIVE_CONTACT, contactId: 'c-del', deleted_at: DELETED_AT };
const OPTED_OUT: ContactItem = { ...LIVE_CONTACT, contactId: 'c-stop', sms_opt_out: true };
/** The caller-resolved recipient: a DIFFERENT contact on the same phone. */
const RECIPIENT: ContactItem = {
  contactId: 'c-real',
  type: 'tenant',
  phone: PHONE,
  consent_method: 'verbal_in_person',
};
const AUTO: SendRefusalCase['conversation'] = { ai_mode: 'auto' };
const MANUAL: SendRefusalCase['conversation'] = { ai_mode: 'manual' };

/** Defaults: kill switch on, an auto thread, a live phone-matched contact, no recipient, a person's send. */
function row(name: string, over: Partial<Omit<SendRefusalCase, 'name'>>): SendRefusalCase {
  return {
    name,
    smsSendingEnabled: true,
    conversation: AUTO,
    phoneContact: LIVE_CONTACT,
    recipient: undefined,
    automated: false,
    expected: undefined,
    ...over,
  };
}

export const SEND_REFUSAL_CASES: readonly SendRefusalCase[] = [
  // --- the send goes out -----------------------------------------------------
  row('person send, all clear: sends', {}),
  row('automated send, all clear: sends', { automated: true }),
  row('no contact record at all: a person send to a raw phone sends', { phoneContact: undefined }),
  // --- (0a) the kill switch, ahead of everything -----------------------------
  row('kill switch off refuses a clean person send', {
    smsSendingEnabled: false,
    expected: 'sms_sending_disabled',
  }),
  row('kill switch off refuses before opt-out, deleted and manual mode', {
    smsSendingEnabled: false,
    conversation: { ...MANUAL, sms_opt_out: true },
    phoneContact: DELETED,
    automated: true,
    expected: 'sms_sending_disabled',
  }),
  // --- (1) opt-out: the conversation, the phone-matched contact OR the recipient
  row('conversation opted out with no contact record refuses', {
    conversation: { ...AUTO, sms_opt_out: true },
    phoneContact: undefined,
    expected: 'contact_opted_out',
  }),
  row('phone-matched contact opted out refuses an automated send', {
    phoneContact: OPTED_OUT,
    automated: true,
    expected: 'contact_opted_out',
  }),
  row('duplicate contacts: recipient opted out, phone-matched contact not: refuses', {
    recipient: { ...RECIPIENT, sms_opt_out: true },
    expected: 'contact_opted_out',
  }),
  row('duplicate contacts: phone-matched contact opted out, recipient clean: refuses (Do Not Contact)', {
    phoneContact: OPTED_OUT,
    recipient: RECIPIENT,
    expected: 'contact_opted_out',
  }),
  row('opted out AND deleted: opt-out wins', {
    phoneContact: { ...DELETED, sms_opt_out: true },
    expected: 'contact_opted_out',
  }),
  row('manual mode + opted out: opt-out wins over mode', {
    conversation: { ...MANUAL, sms_opt_out: true },
    automated: true,
    expected: 'contact_opted_out',
  }),
  // --- (1b) soft-deleted: the recipient when named, else the phone-matched one
  row('phone-matched contact soft-deleted refuses an automated send too', {
    phoneContact: DELETED,
    automated: true,
    expected: 'contact_deleted',
  }),
  row('duplicate contacts: phone-matched contact deleted, recipient live: sends', {
    phoneContact: DELETED,
    recipient: RECIPIENT,
  }),
  row('duplicate contacts: recipient deleted, phone-matched contact live: refuses', {
    recipient: { ...RECIPIENT, contactId: 'c-gone', deleted_at: DELETED_AT },
    expected: 'contact_deleted',
  }),
  row('deleted AND no consent: deleted wins', {
    phoneContact: { ...NO_CONSENT, deleted_at: DELETED_AT },
    expected: 'contact_deleted',
  }),
  row('manual mode + deleted: deleted wins over mode', {
    conversation: MANUAL,
    phoneContact: DELETED,
    automated: true,
    expected: 'contact_deleted',
  }),
  // --- (1.5) JIT consent: a PERSON's send only -------------------------------
  row('person send to a no-consent contact refuses (JIT gate)', {
    phoneContact: NO_CONSENT,
    expected: 'contact_no_consent',
  }),
  row('automated send to a no-consent contact sends (the JIT gate is for a person send)', {
    phoneContact: NO_CONSENT,
    automated: true,
  }),
  row('duplicate contacts: no-consent phone contact, consenting recipient: a person send sends', {
    phoneContact: NO_CONSENT,
    recipient: RECIPIENT,
  }),
  row('duplicate contacts: consenting phone contact, no-consent recipient: a person send refuses', {
    recipient: { ...NO_CONSENT, contactId: 'c-real-nc' },
    expected: 'contact_no_consent',
  }),
  row('manual mode + no consent: a person send refuses on consent, not on mode', {
    conversation: MANUAL,
    phoneContact: NO_CONSENT,
    expected: 'contact_no_consent',
  }),
  // --- (2) manual mode: an AUTOMATED send only -------------------------------
  row('manual mode refuses an automated send', {
    conversation: MANUAL,
    automated: true,
    expected: 'manual_mode',
  }),
  row('manual mode (a breaker-tripped thread) lets a person send go out', { conversation: MANUAL }),
  row('manual mode + no consent: an automated send refuses on mode', {
    conversation: MANUAL,
    phoneContact: NO_CONSENT,
    automated: true,
    expected: 'manual_mode',
  }),
];
