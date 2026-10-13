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
// provisioned onto the relay group and texted. Every reader of the PROPERTY
// CONTACT now walks the candidates here. The readers that mean the landlord
// of RECORD (the owner) - placement nudges, person events, related-property
// and landlord timelines, the dashboard's landlord tabs - stay on
// `unit.landlordId`, unchanged on purpose (spec 9.2). Every AUTOMATIC
// hand-off (remove, contact delete, landlord restore, the backfill script)
// goes through chooseHeir; auto-primary on a roster write promotes only the
// contact being written (unitsRepo.decideAutoPrimary) and shares just the
// eligibility rule, isAutoRoutingEligible.
//
// PURE where it can be: isAutoRoutingEligible, rosterContactIds,
// decidePropertyContact, chooseHeir and applyPrimary do no I/O. The two async
// functions NEVER throw: a failed read is an ANSWER (read_failed / ok:false),
// never "deleted" or "missing" (spec 4.2).
//
// PII (doc section 9): log lines carry ids and counts only - never a name or
// a phone.
import { isDeleted, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import { unitContacts, type UnitContact, type UnitItem } from '../repos/unitsRepo.js';
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

// ---------------------------------------------------------------------------
// P1 - the property-contact lookup (spec 4.1, plan C1)
// ---------------------------------------------------------------------------

/**
 * Who the app uses as a property's contact (spec 4.1), or why nobody:
 *   found       - the first live candidate;
 *   nobody      - `none` (no candidate at all), `deleted` (every candidate was
 *                 soft-deleted or has no record), `is_tenant` (a candidate IS
 *                 the given tenant - the walk STOPS there, no fall-through);
 *   read_failed - a candidate's read THREW. The walk stops: a failed read is
 *                 not absence, and falling through would name the wrong
 *                 person (the reminders fail closed on it, and the default
 *                 people list keeps a bare row for `candidateId`).
 */
export type PropertyContactResult =
  | { kind: 'found'; contactId: string; contact: ContactItem }
  | { kind: 'nobody'; reason: 'none' | 'deleted' | 'is_tenant' }
  | { kind: 'read_failed'; candidateId: string };

/** One candidate's read: `contact` undefined = no record; `{ ok: false }` = the read threw. */
type CandidateRead = { ok: true; contact: ContactItem | undefined } | { ok: false };

/**
 * The candidates, in order: the flagged primary row's contact (through
 * unitContacts, so a landlord-only unit's DERIVED row counts), then the
 * landlord of record when it is non-empty and a different id. A flagged row
 * with an empty contactId names nobody and is no candidate.
 */
function propertyContactCandidates(unit: Pick<UnitItem, 'contacts' | 'landlordId'>): string[] {
  const primary = nonEmptyId(unitContacts(unit).find((row) => row.primaryContact === true)?.contactId);
  const landlordId = nonEmptyId(unit.landlordId);
  const candidates: string[] = [];
  if (primary !== undefined) candidates.push(primary);
  if (landlordId !== undefined && landlordId !== primary) candidates.push(landlordId);
  return candidates;
}

/** The tenant test (spec 4.1): an id comparison made BEFORE any read. */
function isTheTenant(candidateId: string, tenantId: string | undefined): boolean {
  const tenant = nonEmptyId(tenantId);
  return tenant !== undefined && candidateId === tenant;
}

/**
 * The per-candidate rule (spec 4.1), shared by both walks below so the sync
 * and async lookups cannot drift. Returns the walk's answer, or 'skip' for a
 * candidate that is soft-deleted or has no record.
 */
function judgeCandidate(candidateId: string, read: CandidateRead): PropertyContactResult | 'skip' {
  if (!read.ok) return { kind: 'read_failed', candidateId };
  const contact = read.contact;
  if (!isLive(contact)) return 'skip';
  return { kind: 'found', contactId: candidateId, contact };
}

/** The walk ran out of candidates: `deleted` if any was skipped, else `none`. */
function exhausted(skippedAny: boolean): PropertyContactResult {
  return { kind: 'nobody', reason: skippedAny ? 'deleted' : 'none' };
}

/**
 * C1, PURE (spec 4.1): decide the property contact from reads the caller
 * already holds. `lookup` answers per id `{ ok: true, contact }` (`contact`
 * undefined = no record) or `{ ok: false }` (the read threw), and is asked
 * only about the candidates the walk actually reaches. Never throws unless
 * `lookup` itself throws.
 */
export function decidePropertyContact(args: {
  unit: Pick<UnitItem, 'contacts' | 'landlordId'>;
  tenantId?: string;
  lookup: (contactId: string) => { ok: true; contact: ContactItem | undefined } | { ok: false };
}): PropertyContactResult {
  let skippedAny = false;
  for (const candidateId of propertyContactCandidates(args.unit)) {
    if (isTheTenant(candidateId, args.tenantId)) return { kind: 'nobody', reason: 'is_tenant' };
    const verdict = judgeCandidate(candidateId, args.lookup(candidateId));
    if (verdict === 'skip') {
      skippedAny = true;
      continue;
    }
    return verdict;
  }
  return exhausted(skippedAny);
}

/** Read one candidate for the async walk: a throw is logged (ids only) and answered `{ ok: false }`. */
async function readCandidate(
  contactsRepo: Pick<ContactsRepo, 'getById'>,
  candidateId: string,
  log: Logger,
): Promise<CandidateRead> {
  try {
    return { ok: true, contact: await contactsRepo.getById(candidateId) };
  } catch (err) {
    log.warn({ err, candidateId }, 'property contact: candidate read failed - lookup stops');
    return { ok: false };
  }
}

/**
 * C1, async (spec 4.1): the same walk, reading each candidate LAZILY with
 * getById - the landlord of record is read only when the flagged primary was
 * skipped, so a healthy property costs the one read it always did. Never
 * throws.
 */
export async function resolvePropertyContact(args: {
  unit: Pick<UnitItem, 'contacts' | 'landlordId'>;
  tenantId?: string;
  contactsRepo: Pick<ContactsRepo, 'getById'>;
  logger?: Logger;
}): Promise<PropertyContactResult> {
  const log = args.logger ?? defaultLogger;
  let skippedAny = false;
  for (const candidateId of propertyContactCandidates(args.unit)) {
    if (isTheTenant(candidateId, args.tenantId)) return { kind: 'nobody', reason: 'is_tenant' };
    const verdict = judgeCandidate(candidateId, await readCandidate(args.contactsRepo, candidateId, log));
    if (verdict === 'skip') {
      skippedAny = true;
      continue;
    }
    return verdict;
  }
  return exhausted(skippedAny);
}

// ---------------------------------------------------------------------------
// The heir function (spec 4.3, plan C4)
// ---------------------------------------------------------------------------

/**
 * Who takes over as primary (spec 4.3):
 *   heir    - `contactId` becomes primary; `addLandlordRow` says the heir is
 *             the landlord of record with NO roster row, which the write must
 *             add (`role: 'landlord'`);
 *   none    - `no_live_candidate` (no live, non-excluded roster contact at
 *             all) or `no_eligible_candidate` (live ones exist, none eligible
 *             for automatic routing). The backfill script's noHeir /
 *             noEligible counts read this - nothing re-derives the rule;
 *   unknown - the liveness read failed (the caller's path rule applies).
 */
export type HeirResult =
  | { kind: 'heir'; contactId: string; addLandlordRow: boolean }
  | { kind: 'none'; why: 'no_live_candidate' | 'no_eligible_candidate' }
  | { kind: 'unknown' };

/**
 * The heir function, PURE (spec 4.3) - used by the real units repo AND the
 * API-test fake, so the two cannot drift:
 *
 *   1. the landlord of record, if live and not excluded - NO type test (the
 *      owner by definition, and P1's own fallback);
 *   2. else the EARLIEST-ADDED roster contact (array order = add order) that
 *      is eligible for automatic routing (isAutoRoutingEligible: typed
 *      landlord, live, not a routing pointer) and not excluded - a tenant or a
 *      caseworker added by accident is never promoted automatically;
 *   3. else none, with why.
 *
 * `roster` is unitContacts(unit). `read` is readRosterContacts over
 * rosterContactIds(unit) of the SAME unit snapshot; `{ ok: false }` answers
 * unknown. The `exclude`d contact counts as NOT live at every step, whatever
 * `read` says: the delete fan-out never picks the contact it just deleted
 * (whose eventually consistent read can still say live), and the heir "if the
 * primary were removed" never names that primary.
 */
export function chooseHeir(args: {
  roster: readonly UnitContact[];
  landlordId: string | undefined;
  exclude?: string;
  read: RosterContactsRead;
}): HeirResult {
  const read = args.read;
  if (!read.ok) return { kind: 'unknown' };
  const exclude = nonEmptyId(args.exclude);
  /** The live, non-excluded record for an id - else undefined. */
  const usable = (contactId: string): ContactItem | undefined => {
    if (contactId === exclude) return undefined;
    const contact = read.byId.get(contactId);
    return isLive(contact) ? contact : undefined;
  };

  const landlordId = nonEmptyId(args.landlordId);
  if (landlordId !== undefined && usable(landlordId) !== undefined) {
    return {
      kind: 'heir',
      contactId: landlordId,
      addLandlordRow: !args.roster.some((row) => row.contactId === landlordId),
    };
  }

  let anyLive = false;
  for (const row of args.roster) {
    const contactId = nonEmptyId(row.contactId);
    if (contactId === undefined) continue;
    const contact = usable(contactId);
    if (contact === undefined) continue;
    anyLive = true;
    if (isAutoRoutingEligible(contact)) return { kind: 'heir', contactId, addLandlordRow: false };
  }
  return { kind: 'none', why: anyLive ? 'no_eligible_candidate' : 'no_live_candidate' };
}

/**
 * Apply an heir to a COPY of the roster (PURE; the input is never mutated):
 * flag exactly the heir and demote every other row - APPENDING the landlord's
 * row (`role: 'landlord'`, primary) when `addLandlordRow` and the roster has
 * none - or, for `null`, clear every flag. Returns the new roster and the
 * `primary_contact` scalar the same write must store: the heir's id, or null =
 * REMOVE the attribute (spec 4.7: every write that sets or moves the primary
 * sets the scalar to it or removes it). The appended row carries no
 * name/company - read-time enrichment names it.
 *
 * An heir with no roster row and `addLandlordRow: false` cannot be flagged -
 * chooseHeir never produces one - and THROWS rather than return a scalar no
 * row agrees with.
 */
export function applyPrimary(
  roster: readonly UnitContact[],
  heir: { contactId: string; addLandlordRow: boolean } | null,
): { contacts: UnitContact[]; primaryContactScalar: string | null } {
  if (heir === null) {
    return {
      contacts: roster.map((row) => ({ ...row, primaryContact: false })),
      primaryContactScalar: null,
    };
  }
  const contacts = roster.map((row) => ({ ...row, primaryContact: row.contactId === heir.contactId }));
  if (!contacts.some((row) => row.contactId === heir.contactId)) {
    if (!heir.addLandlordRow) {
      throw new Error(`applyPrimary: heir ${heir.contactId} has no roster row and addLandlordRow is false`);
    }
    contacts.push({ contactId: heir.contactId, role: 'landlord', primaryContact: true });
  }
  return { contacts, primaryContactScalar: heir.contactId };
}
