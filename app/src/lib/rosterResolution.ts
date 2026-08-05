// The ONE shared tour/placement roster resolver (contact-rosters spec D1/D3/5.2).
//
// PLAN vs FACT. A roster has exactly one source of truth at any moment, and
// WHICH source is decided by one question: does a relay thread exist for this
// owner?
//
//   NO THREAD  -> the roster is a PLAN: the `roster` override when the operator
//                 materialized one, else the property default (the tenant plus
//                 the unit's primary contact, falling back to the landlord of
//                 record when no roster row is primary).
//   A THREAD   -> the roster is a FACT: `relay.participants` on that
//                 conversation, in ANY status - open, connecting, or CLOSED.
//                 Reopen is a pure status flip, so a close-edit-reopen sequence
//                 must land on the participants, not on a plan reopen ignores.
//
// THE CARDINAL RULE - do not "improve" this into a fallback: WHEN THE POINTER
// IS SET BUT THE CONVERSATION READ FAILS OR RETURNS NOTHING, the answer is
// source 'unavailable' with NO members. It never falls through to the plan or
// the default. By the time a pointer exists the plan was CONSUMED at provision,
// so the fallback would serve exactly the roster the operator edited away from:
// the People card would silently show the wrong people, and the D11 reminder
// check could text a removed tenant on a Dynamo blip. "Never 500 a page" is
// right; "never be wrong about who gets texted" outranks it. Callers handle
// 'unavailable' explicitly (card: an unavailable state with a retry; reminders:
// leave the rung unclaimed).
//
// Every repo read here is try/caught for the same reason - resolution feeds
// page loads, so a repo hiccup degrades the answer, never the response.
//
// PHONES ARE NORMALIZED TO E.164 ON EVERY PLAN/DEFAULT PATH (the storage
// convention). Participants are returned with the phone STORED ON THE ROW: in
// fact mode the fan-out sends to that stored number, so deliverability and the
// recipient count must be derived from it and never from the contact's current
// phone.
//
// PII (doc section 9): ids and counts only - never phones or names in logs.
import type { Logger } from './logger.js';
import { normalizeToE164 } from './phone.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationsRepo } from '../repos/conversationsRepo.js';
import { unitContacts, type UnitsRepo } from '../repos/unitsRepo.js';

/** One PLAN entry: exactly one of contactId / phone (validated at write time). */
export interface RosterEntry {
  contactId?: string;
  phone?: string;
}

/**
 * A conditional plan write lost its race: either a concurrent MATERIALIZE won
 * (`attribute_not_exists(roster)` failed) or the caller's `expectedVersion` is
 * stale. Both repos throw this on ConditionalCheckFailedException so callers
 * re-read and continue onto the EXISTING override rather than overwriting it.
 */
export class RosterPlanConflictError extends Error {
  constructor(message = 'roster plan changed under this write; re-read and retry') {
    super(message);
    this.name = 'RosterPlanConflictError';
  }
}

/** The tour or placement whose roster is being resolved. */
export interface RosterOwner {
  type: 'tour' | 'placement';
  id: string;
  tenantId: string;
  unitId: string;
  /** tours: `groupThreadId`; placements: `group_thread`. Presence = a thread exists. */
  groupThreadId?: string;
  /** The plan override; absent means "resolve from the property". */
  roster?: RosterEntry[];
}

/** Which of the three sources answered - plus the unreadable-thread outcome. */
export type RosterSource = 'participants' | 'plan' | 'default' | 'unavailable';

export interface ResolvedMember {
  /** Absent for bare-phone participants / plan entries. */
  contactId?: string;
  /** participants: the STORED row phone (fact mode). plan/default: E.164 from the contact. */
  phone?: string;
  name?: string;
}

export interface ResolvedRoster {
  source: RosterSource;
  members: ResolvedMember[];
}

/** Narrow structural views - every caller already holds these three repos. */
export interface RosterResolutionDeps {
  conversations: Pick<ConversationsRepo, 'getById'>;
  units: Pick<UnitsRepo, 'getById'>;
  contacts: Pick<ContactsRepo, 'getById'>;
  log: Logger;
}

/** Display name from a contact (mirrors relayGroups.nameFromContact, no import cycle). */
function displayName(contact: ContactItem): string | undefined {
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Build a member from a contactId. A contact that cannot be read - deleted,
 * dangling, or a repo throw - KEEPS ITS ROW (spec 5.2 DANGLING IDS): the row
 * renders as "removed contact", is excluded from every send and from call
 * routing, and stays removable like any other member. Dropping it would hide a
 * member the operator can still see on the thread.
 */
async function memberFromContact(
  deps: RosterResolutionDeps,
  contactId: string,
): Promise<ResolvedMember> {
  let contact: ContactItem | undefined;
  try {
    contact = await deps.contacts.getById(contactId);
  } catch (err) {
    deps.log.warn({ err, contactId }, 'roster resolution: contact read failed - bare row kept');
  }
  if (!contact) return { contactId };
  const phone = nonEmpty(contact.phone);
  const normalized = phone !== undefined ? normalizeToE164(phone) : undefined;
  const name = displayName(contact);
  return {
    contactId,
    ...(normalized !== undefined && { phone: normalized }),
    ...(name !== undefined && { name }),
  };
}

/**
 * Resolve who is on this tour's / placement's roster, right now.
 *
 * Precedence: participants (a thread exists, any status) > plan override >
 * property default. Never throws.
 */
export async function resolveRoster(
  deps: RosterResolutionDeps,
  owner: RosterOwner,
): Promise<ResolvedRoster> {
  // --- FACT: a thread exists -------------------------------------------------
  const threadId = nonEmpty(owner.groupThreadId);
  if (threadId !== undefined) {
    let conversation;
    try {
      conversation = await deps.conversations.getById(threadId);
    } catch (err) {
      deps.log.warn(
        { err, ownerType: owner.type, ownerId: owner.id },
        'roster resolution: thread read failed - roster unavailable',
      );
      return { source: 'unavailable', members: [] };
    }
    if (!conversation) {
      // A dangling pointer (or the tours `provisioning:<tourId>` claim sentinel,
      // which nothing loads under). Unavailable, NOT the plan/default - see the
      // cardinal rule at the top of this file.
      deps.log.warn(
        { ownerType: owner.type, ownerId: owner.id },
        'roster resolution: thread pointer resolves to nothing - roster unavailable',
      );
      return { source: 'unavailable', members: [] };
    }
    const participants = Array.isArray(conversation.participants) ? conversation.participants : [];
    return {
      source: 'participants',
      members: participants.map((p) => {
        const contactId = nonEmpty(p.contactId);
        const name = nonEmpty(p.name);
        return {
          ...(contactId !== undefined && { contactId }),
          // The STORED phone, verbatim: it is what the fan-out will dial/text.
          ...(nonEmpty(p.phone) !== undefined && { phone: p.phone }),
          ...(name !== undefined && { name }),
        };
      }),
    };
  }

  // --- PLAN: the override, verbatim and in stored order ----------------------
  // A PRESENT array wins even when empty: the override materialized on a human
  // edit and persists until "Reset to property default" - it must never
  // silently re-resolve to the people who were edited away.
  if (Array.isArray(owner.roster)) {
    const members: ResolvedMember[] = [];
    for (const entry of owner.roster) {
      const contactId = nonEmpty(entry.contactId);
      if (contactId !== undefined) {
        members.push(await memberFromContact(deps, contactId));
        continue;
      }
      const raw = nonEmpty(entry.phone);
      if (raw === undefined) continue; // `{}` is rejected at write time; ignore here.
      // Normalize; keep the raw value when it will not parse so the row still
      // renders (and stays removable) rather than vanishing.
      members.push({ phone: normalizeToE164(raw) ?? raw });
    }
    return { source: 'plan', members };
  }

  // --- DEFAULT: the tenant + the property's primary contact ------------------
  const members: ResolvedMember[] = [];
  const tenantId = nonEmpty(owner.tenantId);
  if (tenantId !== undefined) members.push(await memberFromContact(deps, tenantId));

  let unit;
  try {
    unit = await deps.units.getById(owner.unitId);
  } catch (err) {
    deps.log.warn(
      { err, ownerType: owner.type, ownerId: owner.id, unitId: owner.unitId },
      'roster resolution: unit read failed - property contact omitted',
    );
  }
  if (!unit) return { source: 'default', members };

  // The property's default contact, with the D3 fallback: when NO roster row
  // carries primaryContact (zero-primary is legal and reachable, spec 5.1) fall
  // back to the LANDLORD OF RECORD - exactly the pre-roster behavior, so no
  // working property regresses to a too-thin roster.
  const roster = unitContacts(unit);
  const primary = roster.find((c) => c.primaryContact === true);
  const propertyContactId = primary?.contactId ?? nonEmpty(unit.landlordId);
  if (propertyContactId === undefined || propertyContactId.length === 0) {
    return { source: 'default', members };
  }
  // De-dupe the degenerate case where the tenant IS the property contact.
  if (propertyContactId !== tenantId) {
    members.push(await memberFromContact(deps, propertyContactId));
  }
  return { source: 'default', members };
}

/**
 * Is this contact on the resolved roster? Bare-phone members have no contactId
 * to match. An 'unavailable' roster answers false because it carries no
 * members - callers that CARE (D11's reminder suppression) must branch on
 * `source === 'unavailable'` themselves rather than reading a false here as
 * "not a member".
 */
export function isOnRoster(roster: ResolvedRoster, contactId: string): boolean {
  if (contactId.length === 0) return false;
  return roster.members.some((m) => m.contactId === contactId);
}

/**
 * Customized-note equality (spec 5.2), used for PLAN and FACT comparisons
 * alike: an order-insensitive SET comparison where contact-backed entries
 * compare by contactId and bare-phone entries by E.164 phone. A contact whose
 * number was corrected after they joined still matches; a legacy thread with
 * bare-phone participants never matches the property default (so it reads
 * "Customized" indefinitely - accurate, and expected in dev).
 */
export function rosterEquals(a: ResolvedMember[], b: ResolvedMember[]): boolean {
  const keys = (members: ResolvedMember[]): Set<string> => {
    const set = new Set<string>();
    for (const m of members) {
      const contactId = nonEmpty(m.contactId);
      if (contactId !== undefined) {
        set.add(`c:${contactId}`);
        continue;
      }
      const phone = nonEmpty(m.phone);
      // A row carrying neither field is degenerate (write-time validation
      // rejects it); collapse every such row onto one slot.
      set.add(phone === undefined ? 'x:' : `p:${normalizeToE164(phone) ?? phone}`);
    }
    return set;
  };
  const setA = keys(a);
  const setB = keys(b);
  if (setA.size !== setB.size) return false;
  for (const key of setA) if (!setB.has(key)) return false;
  return true;
}
