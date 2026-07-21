// Email channel v1 - the "invariant rule" reader primitive.
//
// The system keeps one conversation PER PARTICIPANT KEY (per phone, and now per
// email). A multi-key contact therefore owns SEVERAL conversations merged at
// READ time. Every reader that used to iterate a contact's PHONES to find their
// threads (inbox aggregation, contact timeline, media panel, triage propagation,
// presence fan-out) MUST also iterate their EMAILS, or email-only threads
// silently drop out. This helper is that iteration, once, so the readers don't
// each re-implement (and drift on) the phones-and-emails union.
//
// It returns the RAW union (deduped by conversationId); callers keep their own
// status/type filters (an inbox reader wants open non-relay threads, a mark-read
// fan-out wants all of them). relay_group threads front a pool number and carry
// no participant_email, so an email query never returns them; a phone query can,
// which is why callers still filter on type where they need to.
import {
  contactEmails,
  contactPhones,
  type ContactItem,
} from '../repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../repos/conversationsRepo.js';

/**
 * All conversations a contact participates in, resolved across BOTH their phone
 * numbers AND their email addresses, deduped by conversationId (phone threads
 * first, then email threads; the first-seen item wins a dedupe). Takes a narrow
 * structural view of the conversations repo so any fake with just the two
 * finders satisfies it.
 */
export async function conversationsForContact(
  contact: ContactItem,
  conversations: Pick<ConversationsRepo, 'findByParticipantPhone' | 'findByParticipantEmail'>,
): Promise<ConversationItem[]> {
  const byId = new Map<string, ConversationItem>();
  for (const p of contactPhones(contact)) {
    for (const c of await conversations.findByParticipantPhone(p.phone)) {
      if (!byId.has(c.conversationId)) byId.set(c.conversationId, c);
    }
  }
  for (const e of contactEmails(contact)) {
    for (const c of await conversations.findByParticipantEmail(e.email)) {
      if (!byId.has(c.conversationId)) byId.set(c.conversationId, c);
    }
  }
  return [...byId.values()];
}
