// The ONE property-contact lookup, the ONE heir function, and the liveness
// read and eligibility rule they share (primary-contact-integrity spec
// 2026-10-12, sections 4.1-4.3; plan contract 2.1).
//
// WHY ONE MODULE. "Who is this property's contact?" was answered by four
// inline copies of one ladder - the roster row flagged primary, else the
// landlord of record - in lib/tourContacts.ts, lib/rosterResolution.ts and
// both services/rosterProvision.ts diagnostics. None checked `deleted_at`, and
// contactsRepo.getById returns a soft-deleted contact, so a deleted primary
// was named in intro and reminder copy, put on the default people list,
// provisioned onto the relay group and texted. Every reader now walks the
// candidates here, and every AUTOMATIC primary choice (auto-primary, the
// handoffs, the backfill script) goes through chooseHeir.
//
// PURE where it can be: isAutoRoutingEligible, rosterContactIds,
// decidePropertyContact, chooseHeir and applyPrimary do no I/O. The two async
// functions NEVER throw: a failed read is an ANSWER (read_failed / ok:false),
// never "deleted" or "missing" (spec 4.2).
//
// PII (doc section 9): log lines carry ids and counts only - never a name or
// a phone.
import { isDeleted, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import { unitContacts, type UnitItem } from '../repos/unitsRepo.js';
import { logger as defaultLogger, type Logger } from './logger.js';

/** A non-empty string id, else undefined: a legacy landlordId of '' is "none". */
function nonEmptyId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Spec section 3 "live contact": a record exists and carries no deleted_at. */
function isLive(contact: ContactItem | undefined): contact is ContactItem {
  return contact !== undefined && !isDeleted(contact);
}

/**
 * The ONE eligibility rule for an AUTOMATIC routing choice - moved here
 * VERBATIM from routes/units.ts `autoRoutingEligible` (caseworker-integrity
 * spec revision 6 section 4 "Contact list (I4)" and "Restore"; final review
 * A4, fix wave FWF-3), so the contact-list route's auto-primary and the heir
 * function below share one definition (primary-contact-integrity spec 4.3).
 * The contact exists, is typed `landlord`, is NOT soft-deleted (the contacts
 * repo's own test - deleting a contact keeps its seats, and a deleted contact
 * is unusable for routing everywhere else) and is NOT a phone or email routing
 * pointer (a routing record, never a contact). A deliberate choice - the I3
 * claim of a vacant landlord slot, a landlord picked for a restore, an
 * explicit "Make primary" - asks only the type.
 */
export function isAutoRoutingEligible(contact: ContactItem | undefined): boolean {
  return (
    contact !== undefined &&
    contact.phone_ref !== true &&
    contact.email_ref !== true &&
    !isDeleted(contact) &&
    contact.type === 'landlord'
  );
}

/** A contact read for automatic decisions (spec 4.2). */
export type RosterContactsRead =
  | { ok: true; byId: Map<string, ContactItem> }
  | { ok: false };

/**
 * The liveness read every automatic decision makes (spec 4.2): ONE batch read
 * with `requireComplete`. That option fails in TWO shapes - a thrown chunk
 * rethrows the raw error, unprocessed keys throw IncompleteBatchReadError -
 * and ANY throw here means liveness UNKNOWN (`{ ok: false }`), never
 * "deleted": catching only the error class would turn a throttled read into a
 * 500.
 *
 * On `{ ok: true }` an id absent from `byId` is a contact that does NOT exist
 * (a complete read of an absent key), which spec section 3 treats exactly like
 * a deleted one. So a caller must read the ids of the SAME unit snapshot it
 * decides on (rosterContactIds) and read again on every retry.
 *
 * De-duplicates ids (BatchGetItem rejects duplicate keys), drops empty strings
 * and undefined, and reads nothing at all for an empty list. Never throws.
 */
export async function readRosterContacts(
  contacts: Pick<ContactsRepo, 'getManyByIds'>,
  ids: Iterable<string | undefined>,
  logger?: Logger,
): Promise<RosterContactsRead> {
  const unique = [
    ...new Set([...ids].filter((id): id is string => nonEmptyId(id) !== undefined)),
  ];
  if (unique.length === 0) return { ok: true, byId: new Map() };
  try {
    return { ok: true, byId: await contacts.getManyByIds(unique, { requireComplete: true }) };
  } catch (err) {
    (logger ?? defaultLogger).warn(
      { err, requested: unique.length },
      'property contact: roster liveness read failed - liveness unknown',
    );
    return { ok: false };
  }
}

/**
 * The ids the spec 4.2 read covers for one unit: every unitContacts() row (so
 * a landlord-only unit's DERIVED row counts) plus `landlordId` - an off-roster
 * landlord of record (an API PATCH reassign or an importer re-import can leave
 * one, spec 9.1) must not read as missing. Roster order first, then the
 * landlord; de-duplicated; empty ids dropped.
 */
export function rosterContactIds(unit: Pick<UnitItem, 'contacts' | 'landlordId'>): string[] {
  const ids: string[] = [];
  for (const id of [...unitContacts(unit).map((row) => row.contactId), unit.landlordId]) {
    const usable = nonEmptyId(id);
    if (usable !== undefined && !ids.includes(usable)) ids.push(usable);
  }
  return ids;
}
