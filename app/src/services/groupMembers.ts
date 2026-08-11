// Group-text member resolution (native group texting, spec 5.3 / plan T3.4).
//
// A detected carrier group needs a ConversationParticipant per outside member,
// and every participant carries a REQUIRED contactId - so detection must be
// able to mint a contact for a phone it has never seen.
//
// WHY THIS IS NOT `captureContact` (adjudication A7): the auto-capture service
// stamps `consent_method: 'inbound_text'` on every stub (contactCapture.ts:92).
// `consent_method` is the single predicate `hasSmsConsent` reads, and six
// consumers gate on it - the JIT 1:1 gate, tour reminders, placement nudges,
// the broadcast fan-out fence, and both staff has-consent displays. Stamping it
// would make a SILENT group member - somebody who has never messaged us,
// merely appeared on a group envelope - proactively sendable. That is the exact
// outcome Cameron's ruling forbids. `captureContact` is also structurally
// unusable here: it reads `conversation.participant_phone` (a group thread has
// none) and claims the whole `participants` array, colliding with the group
// creation's single conditional roster claim.
//
// The consent BASIS is recorded in the DISTINCT contact field
// `group_participation_at`. It leaves every hasSmsConsent consumer untouched by
// construction and cannot mask a later genuine basis, because the two fields
// are independent.
//
// PII (doc 9): phones are DATA. Log lines carry ids and counts only.
import { contactIdForPhone } from '../lib/import/ids.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationParticipant } from '../repos/conversationsRepo.js';

/**
 * The member key for a `group_text` delivery/attribution slot (spec 15.6,
 * plan T3.4a): ALWAYS `phone#<E164>`, NEVER `relayMemberKey`.
 *
 * `relayMemberKey` prefers the contactId, so one contact owning TWO member
 * numbers would collapse into a single slot - one delivery outcome for two
 * handsets, and one sender chip for two people's messages. The contactId still
 * travels, as roster DISPLAY metadata on the participant.
 *
 * S3 declared this inside the webhook router; it moved here in S5 so the send
 * service and the receipts route can use it without importing a route module.
 */
export function groupMemberKey(e164: string): string {
  return `phone#${e164}`;
}

/**
 * `contacts.origin` on a stub minted by group detection. The import's
 * `retractImported` refuses to delete a contact carrying this marker (T7.2
 * reads exactly this string), so the founder's workbook `drop` column can never
 * orphan a live group roster.
 */
export const GROUP_DETECTION_ORIGIN = 'group_detection';

/** The subset of the contacts repo this module needs (keeps test fakes small). */
export type GroupMemberContactsRepo = Pick<
  ContactsRepo,
  'findByPhone' | 'getById' | 'createIfAbsent' | 'stampGroupParticipation'
>;

export interface GroupMemberDeps {
  contactsRepo: GroupMemberContactsRepo;
  logger?: Logger;
}

export interface GroupMemberResolution {
  /** One participant per roster phone, in roster order. Never shorter than the roster. */
  members: ConversationParticipant[];
  /** contactIds this call actually minted. */
  created: string[];
  /** contactIds that gained `group_participation_at` on this call. */
  stamped: string[];
  /** Roster phones whose contact could not be read or written (still on the roster). */
  failed: string[];
  /**
   * contactIds whose `group_participation_at` stamp came back `'missing'` - the
   * contact row VANISHED between our read and our write.
   *
   * `stampGroupParticipation` distinguishes this outcome deliberately ("an
   * absent contact is a hole in the roster"), and the other caller
   * (groupConvert.converge) already reports it, so dropping it here made two
   * consumers of one signal disagree. The producing interleaving is real: the
   * import's `retractImported` guard is ONE-DIRECTIONAL - its atomic
   * `attribute_not_exists(group_participation_at)` stops a contact being
   * deleted AFTER it joins a group, but not a group being formed around a
   * contact that is being deleted right now. The member KEEPS its roster slot
   * either way (a short roster is a different id, i.e. a forked thread).
   */
  missing: string[];
}

/** Display name from a contact (mirrors lib/rosterResolution.displayName). */
function displayName(contact: ContactItem): string | undefined {
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}

/**
 * The stub. Note what is ABSENT: `consent_method`, `consent_at`, and
 * `capture_source`. `capture_source` is deliberately left alone because
 * `consentMethodFromCaptureSource` MAPS it back to a consent method for a
 * legacy backfill - overloading it would smuggle consent in by the back door.
 */
function stubFor(contactId: string, phone: string, at: string): ContactItem {
  return {
    contactId,
    // Detection NEVER guesses identity (operator mandate): seeing somebody on a
    // group envelope says nothing about whether they are a tenant, a landlord,
    // or a wrong number. (unknown, needs_review) IS the human triage queue.
    type: 'unknown',
    status: 'needs_review',
    phone,
    origin: GROUP_DETECTION_ORIGIN,
    /** The consent BASIS - never a ConsentMethod (see the module header). */
    group_participation_at: at,
    created_at: at,
  };
}

/**
 * Resolve every roster phone to a `ConversationParticipant`, minting contacts
 * for the ones we have never seen and stamping the group consent basis on the
 * ones we have.
 *
 * NEVER DROPS A MEMBER. A contact read/write failure leaves the member on the
 * roster under its DERIVED id and is reported in `failed`: the derived id is
 * what the importer and every later detection will converge on anyway, and a
 * short roster would be a DIFFERENT conversationId - i.e. a forked thread.
 */
export async function resolveGroupMembers(
  roster: readonly string[],
  deps: GroupMemberDeps,
  opts: { at?: string } = {},
): Promise<GroupMemberResolution> {
  const contacts = deps.contactsRepo;
  const log = deps.logger ?? defaultLogger;
  const at = opts.at ?? new Date().toISOString();

  const members: ConversationParticipant[] = [];
  const created: string[] = [];
  const stamped: string[] = [];
  const failed: string[] = [];
  const missing: string[] = [];

  for (const phone of roster) {
    const derivedId = contactIdForPhone(phone);
    try {
      // Pointer-aware lookup FIRST: a member may already exist under a
      // hand-made id (contact form) or as an attached second number of somebody
      // else. Minting the derived id anyway would duplicate a real person.
      let contact = await contacts.findByPhone(phone);
      if (!contact) {
        const stub = stubFor(derivedId, phone, at);
        const didCreate = await contacts.createIfAbsent(stub);
        if (didCreate) {
          created.push(derivedId);
          contact = stub;
        } else {
          // Lost a same-id race (two members' first inbounds land together).
          contact = (await contacts.getById(derivedId)) ?? stub;
        }
      }
      if (contact.group_participation_at === undefined) {
        const outcome = await contacts.stampGroupParticipation(contact.contactId, at);
        if (outcome === 'stamped') stamped.push(contact.contactId);
        else if (outcome === 'missing') missing.push(contact.contactId);
      }
      const name = displayName(contact);
      members.push({
        contactId: contact.contactId,
        phone,
        ...(name !== undefined && { name }),
      });
    } catch (err) {
      failed.push(phone);
      members.push({ contactId: derivedId, phone });
      log.error(
        { err, contactId: derivedId },
        'group member contact resolution failed - the member KEEPS its roster slot under the derived id',
      );
    }
  }

  if (created.length > 0 || stamped.length > 0) {
    log.info(
      { memberCount: members.length, createdCount: created.length, stampedCount: stamped.length },
      'group text members resolved (stubs minted with group_participation_at, never consent_method)',
    );
  }
  if (missing.length > 0) {
    // WARN, matching groupConvert.converge's treatment of the same signal. The
    // roster now points at a contactId with no row behind it: the member chip
    // renders from the phone alone until something re-mints the stub.
    log.warn(
      { memberCount: members.length, missingCount: missing.length },
      'group member contact VANISHED between the read and the group_participation_at stamp - the roster slot points at a contact record that no longer exists',
    );
  }
  return { members, created, stamped, failed, missing };
}
