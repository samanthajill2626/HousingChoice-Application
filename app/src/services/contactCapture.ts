// M1.2 contact auto-capture (doc §5 / §11.3 "contacts auto-captured"): every
// inbound conversation ends up linked to a contact record. Unknown phones get
// a stub contact (type 'tenant' — the default for unknown inbound; landlords
// get typed at intake/import, M1.5/M1.6); known phones get the conversation's
// participants link backfilled. The "First Last - N Bed" naming of stubs is
// later work (lib/contactName.ts is the one true parser for it).
//
// RACE HANDLING — the disclosed byPhone-GSI eventual-consistency race: two
// concurrent first-messages can BOTH miss findByPhone (the GSI lags writes)
// and both try to create a contact. The CONVERSATION row is already
// race-deduped (one active row per phone), so it is the anchor:
//
//   1. Whoever wins the conditional claim on the conversation
//      (setParticipantsIfAbsent: attribute_not_exists(participants)) owns
//      the contactId for this phone.
//   2. The loser re-reads the link and ADOPTS the winner's contactId.
//   3. Contact creation itself is a conditional put on that agreed contactId
//      (createIfAbsent), so at most ONE contact row ever exists per race —
//      and a crash between claim and create self-heals on the next inbound
//      delivery (the linked contactId is recreated deterministically).
//
// NEVER overwrites existing contact fields: the only contact write anywhere
// in this service is the conditional create; backfill touches the
// conversation alone. (Enforced at the write by createIfAbsent's condition.)
import { randomUUID } from 'node:crypto';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createContactsRepo, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';

export interface ContactCaptureDeps {
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  auditRepo?: AuditRepo;
  logger?: Logger;
}

/**
 * Resolve (creating/linking as needed) the contact for a conversation's
 * external participant. `knownContact` is the caller's already-resolved
 * findByPhone result, passed through so the steady state (contact exists and
 * is linked) costs ZERO extra DynamoDB calls.
 */
export type ContactCaptureService = (
  conversation: ConversationItem,
  knownContact?: ContactItem,
) => Promise<ContactItem>;

export function createContactCapture(deps: ContactCaptureDeps = {}): ContactCaptureService {
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const log = deps.logger ?? defaultLogger;

  function stubFor(contactId: string, phone: string): ContactItem {
    const now = new Date().toISOString();
    return {
      contactId,
      // Default for unknown inbound: tenants text first; landlords get typed
      // at intake/import (M1.5/M1.6).
      type: 'tenant',
      // 'new' marks an unreviewed auto-captured stub (byTypeStatus GSI).
      status: 'new',
      phone,
      capture_source: 'inbound_sms',
      captured_at: now,
      created_at: now,
    };
  }

  /**
   * Make sure a contact row exists under an agreed contactId. Audits
   * contact_auto_captured ONLY when this call actually created the row, so
   * a race/redelivery never double-audits.
   */
  async function ensureContact(
    contactId: string,
    phone: string,
    conversationId: string,
  ): Promise<ContactItem> {
    const existing = await contacts.getById(contactId);
    if (existing) return existing;
    const stub = stubFor(contactId, phone);
    const created = await contacts.createIfAbsent(stub);
    if (created) {
      await audit.append(`contacts#${contactId}`, 'contact_auto_captured', {
        conversationId,
        source: 'inbound_sms',
      });
      log.info({ contactId, conversationId }, 'contact auto-captured (stub created)');
      return stub;
    }
    // Lost a same-id create race — the row exists now; read it back.
    return (await contacts.getById(contactId)) ?? stub;
  }

  return async function captureContact(conversation, knownContact) {
    const { conversationId, participant_phone: phone } = conversation;

    // (1) Already linked? The link is the race anchor — trust it over the
    // (possibly lagging) byPhone GSI. Heal the crash window where the link
    // committed but the contact row never did. Match by PHONE only: a
    // participants array with no entry for this phone (relay-group seam /
    // bad data) is treated as UNLINKED — adopting participants[0] blindly
    // would link the WRONG contact.
    const linked = conversation.participants?.find((p) => p.phone === phone);
    if (linked) {
      if (knownContact && knownContact.contactId === linked.contactId) return knownContact;
      return ensureContact(linked.contactId, phone, conversationId);
    }

    // (2) Known phone, missing link → backfill the link only. The contact
    // record itself is never written here (no-overwrite guarantee).
    const existing = knownContact ?? (await contacts.findByPhone(phone));
    if (existing) {
      const claimed = await conversations.setParticipantsIfAbsent(conversationId, [
        { contactId: existing.contactId, phone },
      ]);
      if (claimed) {
        log.info(
          { conversationId, contactId: existing.contactId },
          'conversation participants link backfilled for existing contact',
        );
        return existing;
      }
      // A concurrent capture linked first (or our conversation snapshot was a
      // stale GSI projection) — adopt what the authoritative row links FOR
      // THIS PHONE (never participants[0]: an entry for another phone is
      // someone else's contact).
      const fresh = await conversations.getById(conversationId);
      const adopted = fresh?.participants?.find((p) => p.phone === phone);
      if (adopted && adopted.contactId !== existing.contactId) {
        return ensureContact(adopted.contactId, phone, conversationId);
      }
      return existing;
    }

    // (3) Unknown phone → claim the link under a FRESH contactId; create the
    // stub only under whichever contactId actually won the claim.
    const contactId = `contact-${randomUUID()}`;
    const claimed = await conversations.setParticipantsIfAbsent(conversationId, [
      { contactId, phone },
    ]);
    if (claimed) return ensureContact(contactId, phone, conversationId);
    const fresh = await conversations.getById(conversationId);
    const winner = fresh?.participants?.find((p) => p.phone === phone);
    if (!winner) {
      // The claim only fails when participants exists — no entry for THIS
      // phone (unreadable link, or a link to some other phone's contact) is
      // never expected and must not be adopted. Surface it; the webhook
      // turns this into a correlated ERROR without crashing the pipeline.
      throw new Error(
        `contact capture: participants claim failed but no link for this phone is readable on ${conversationId}`,
      );
    }
    return ensureContact(winner.contactId, phone, conversationId);
  };
}
