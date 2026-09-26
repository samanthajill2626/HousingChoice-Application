// retry-send-window D3a step 2: a PURE preview of the refusals the one-to-one
// send wrapper (services/sendMessage.ts) would make right now for a given
// automated flag and recipient. The status webhook's 30003 decision asks it
// before promising a retry, so the screen never says "will retry" for a text
// the send path is certain to refuse, and says it at once when one will go.
//
// It mirrors the wrapper's gates IN ORDER - (0a) kill switch, (1) opt-out,
// (1b) soft-deleted, (1.5) JIT consent for a person's send, (2) manual mode for
// an automated send - through the SAME predicates the wrapper calls
// (isKillSwitchOff / isOptedOut / isManualMode, isDeleted, hasSmsConsent). A
// parity test (sendMessage.test.ts) runs one case table through this function
// AND the real wrapper and requires the same code, so the two cannot drift
// silently.
//
// Deliberately NOT previewed:
//   - the channel guards (relay_group, group_text, no participant_phone): the
//     caller decides those first, with its own reasons (D11);
//   - the circuit breaker: live per-minute state that meters automated sends
//     only - an automated retry it refuses at send time keeps its promise until
//     the promise expires (spec section 9);
//   - `conversation_not_found`: the caller already holds the conversation.
import { hasSmsConsent } from '../lib/smsCompliance.js';
import { isDeleted, type ContactItem } from '../repos/contactsRepo.js';
import type { ConversationItem } from '../repos/conversationsRepo.js';
import { isKillSwitchOff, isManualMode, isOptedOut } from './scheduledSendSuppression.js';

/** The SendRefusedError codes sendMessage's previewable gates throw. */
export type SendRefusalCode =
  | 'sms_sending_disabled'
  | 'contact_opted_out'
  | 'contact_deleted'
  | 'contact_no_consent'
  | 'manual_mode';

/**
 * Pure: what sendMessage's gates ((0a) through (2), in that order) would refuse
 * for this conversation, phone-matched contact, optional recipient and
 * automated flag. Excludes the channel guards (the caller handles relay_group /
 * group_text / no participant_phone) and the breaker (live state). Codes equal
 * the SendRefusedError codes sendMessage throws; undefined = the send goes out.
 */
export function previewSendRefusal(args: {
  smsSendingEnabled: boolean | undefined;
  conversation: Pick<ConversationItem, 'sms_opt_out' | 'ai_mode'>;
  phoneContact: ContactItem | undefined;
  recipient: ContactItem | undefined;
  automated: boolean;
}): SendRefusalCode | undefined {
  const { smsSendingEnabled, conversation, phoneContact, recipient, automated } = args;
  // (0a) The A2P kill switch, ahead of everything (explicit false only).
  if (isKillSwitchOff(smsSendingEnabled)) return 'sms_sending_disabled';
  // (1) Opt-out: the conversation's flag, the phone-matched contact's, OR the
  // recipient's - either contact's flag refuses (duplicate contacts on one phone).
  if (
    isOptedOut(conversation.sms_opt_out, phoneContact?.sms_opt_out) ||
    recipient?.sms_opt_out === true
  ) {
    return 'contact_opted_out';
  }
  // The contact the deleted and consent gates judge: the recipient when the
  // caller named one, else the phone-matched contact (share-skip-fix I8).
  const judged = recipient ?? phoneContact;
  // (1b) Soft-deleted - harder than no-consent, softer than opt-out.
  if (judged !== undefined && isDeleted(judged)) return 'contact_deleted';
  // (1.5) JIT consent - a PERSON'S send only; no contact record means no gate.
  if (!automated && judged !== undefined && !hasSmsConsent(judged)) return 'contact_no_consent';
  // (2) Manual mode - an AUTOMATED send only. The breaker that follows it in
  // the wrapper is live state and is not previewed.
  if (automated && isManualMode(conversation.ai_mode)) return 'manual_mode';
  return undefined;
}
