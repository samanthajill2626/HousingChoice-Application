// M1.2 contact auto-capture (doc §5 / §11.3 "contacts auto-captured"): every
// inbound conversation ends up linked to a contact record. Unknown phones get
// a stub contact (type 'unknown', status 'needs_review' — auto-capture never
// records guessed identity as fact; humans resolve the real type in the
// M1.4/M1.5 review flows); known phones get the conversation's participants
// link backfilled. The "First Last - N Bed" naming of stubs is later work
// (lib/contactName.ts is the one true parser for it).
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
 * Which inbound channel triggered the capture. Drives the stub's
 * `capture_source`, its automatic consent stamp (spec §3.2: a customer-initiated
 * inbound SMS or CALL each confer consent — `inbound_text` / `inbound_call`
 * respectively), and the audit entry's `source`.
 */
export type CaptureSource = 'inbound_sms' | 'inbound_call';

/**
 * Resolve (creating/linking as needed) the contact for a conversation's
 * external participant. `knownContact` is the caller's already-resolved
 * findByPhone result, passed through so the steady state (contact exists and
 * is linked) costs ZERO extra DynamoDB calls. `source` defaults to
 * 'inbound_sms' (the original SMS-webhook caller).
 */
export type ContactCaptureService = (
  conversation: ConversationItem,
  knownContact?: ContactItem,
  source?: CaptureSource,
) => Promise<ContactItem>;

export function createContactCapture(deps: ContactCaptureDeps = {}): ContactCaptureService {
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const log = deps.logger ?? defaultLogger;

  function stubFor(contactId: string, phone: string, source: CaptureSource): ContactItem {
    const now = new Date().toISOString();
    return {
      contactId,
      // NEVER guess identity (operator mandate, 2026-06-12): an inbound from
      // an unknown phone could be a tenant, landlord, PM, … — recording a
      // guess as fact poisons the records. On the byTypeStatus GSI,
      // (type=unknown, status=needs_review) IS the human triage queue;
      // the M1.4/M1.5 review flows resolve the real type.
      type: 'unknown',
      status: 'needs_review',
      phone,
      capture_source: source,
      captured_at: now,
      created_at: now,
      // A2P/CTIA consent (spec §3.2): a first inbound text OR CALL is the
      // consent basis — customer-initiated contact for an INFORMATIONAL/
      // transactional program. Stamp the channel-matched automatic method
      // (`inbound_text` / `inbound_call` — the same basis the voice webhook
      // stamps on EXISTING contacts) so replies never hit the JIT gate.
      // hasSmsConsent() reads `consent_method`; this is the automatic
      // (non-human) stamp.
      consent_method: source === 'inbound_call' ? 'inbound_call' : 'inbound_text',
      consent_at: now,
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
    source: CaptureSource,
  ): Promise<ContactItem> {
    const existing = await contacts.getById(contactId);
    if (existing) return existing;
    const stub = stubFor(contactId, phone, source);
    const created = await contacts.createIfAbsent(stub);
    if (created) {
      await audit.append(`contacts#${contactId}`, 'contact_auto_captured', {
        conversationId,
        source,
      });
      log.info({ contactId, conversationId }, 'contact auto-captured (stub created)');
      return stub;
    }
    // Lost a same-id create race — the row exists now; read it back.
    return (await contacts.getById(contactId)) ?? stub;
  }

  return async function captureContact(conversation, knownContact, source = 'inbound_sms') {
    const { conversationId, participant_phone: phone } = conversation;
    // contactCapture is the PHONE auto-capture path only (plan Decision 4: email
    // ingestion never creates contacts). An email-only conversation carries
    // participant_email and NO phone - it must never reach here. Guard so `phone`
    // narrows to a definite string for the claim + findByPhone calls below.
    if (phone === undefined) {
      throw new Error(
        `contact capture: conversation ${conversationId} has no participant_phone (email threads never auto-capture)`,
      );
    }

    // (1) Already linked? The link is the race anchor — trust it over the
    // (possibly lagging) byPhone GSI. Heal the crash window where the link
    // committed but the contact row never did. Match by PHONE only: a
    // participants array with no entry for this phone (relay-group seam /
    // bad data) is treated as UNLINKED — adopting participants[0] blindly
    // would link the WRONG contact.
    const linked = conversation.participants?.find((p) => p.phone === phone);
    if (linked) {
      if (knownContact && knownContact.contactId === linked.contactId) return knownContact;
      return ensureContact(linked.contactId, phone, conversationId, source);
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
        return ensureContact(adopted.contactId, phone, conversationId, source);
      }
      return existing;
    }

    // (3) Unknown phone → claim the link under a FRESH contactId; create the
    // stub only under whichever contactId actually won the claim.
    const contactId = `contact-${randomUUID()}`;
    const claimed = await conversations.setParticipantsIfAbsent(conversationId, [
      { contactId, phone },
    ]);
    if (claimed) return ensureContact(contactId, phone, conversationId, source);
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
    return ensureContact(winner.contactId, phone, conversationId, source);
  };
}
