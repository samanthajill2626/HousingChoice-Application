// Contact-type guards (caseworker integrity, spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md, sections 1
// and 4). The reads behind two invariants:
//   I2 - the tenant of an open tour or an open placement is a contact typed
//        `tenant` (requireTenantContact: tour create / revive / reopen,
//        placement create / from-tour, a placement leaving a terminal stage);
//   I3 - a live unit's landlord of record is a contact typed `landlord` (a
//        property manager is a landlord with a role) (requireLandlordContact:
//        the unit routes);
// and the ONE mapping from their four errors to HTTP answers
// (sendContactTypeError), so every route answers the same bodies.
//
// Every read here is CONSISTENT, so a type change that just committed is seen.
// "Exists" keeps getById's meaning: a soft-deleted contact still exists (this
// branch adds no deleted-contact refusal, spec section 10). The checks are
// reads before writes, not atomic with them (spec section 6, L1).
//
// PII (doc section 9): the errors carry no ids and no names. contactKind is a
// type word: `caseworker` when isCaseworker holds, else the stored type.
import type { Response } from 'express';
import { contactKind as kindOf } from '../lib/caseworkers.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';

/** The named tenant contact does not exist -> 404 { error: 'tenant_not_found' }. */
export class TenantNotFoundError extends Error {
  constructor() {
    super('tenant_not_found');
    this.name = 'TenantNotFoundError';
  }
}

/** The named tenant is not typed `tenant` -> 409 { error: 'contact_not_tenant', contactKind }. */
export class ContactNotTenantError extends Error {
  constructor(readonly contactKind: string) {
    super('contact_not_tenant');
    this.name = 'ContactNotTenantError';
  }
}

/** The named landlord contact does not exist -> 404 { error: 'landlord_not_found' }. */
export class LandlordNotFoundError extends Error {
  constructor() {
    super('landlord_not_found');
    this.name = 'LandlordNotFoundError';
  }
}

/** The named landlord is not typed `landlord` -> 409 { error: 'landlord_not_landlord' }. */
export class LandlordNotLandlordError extends Error {
  constructor() {
    super('landlord_not_landlord');
    this.name = 'LandlordNotLandlordError';
  }
}

/**
 * I2: the contact a tour or placement names as its tenant, read CONSISTENTLY.
 * Throws TenantNotFoundError when it does not exist and ContactNotTenantError
 * (carrying contactKind) when it is not typed `tenant`. `unknown` is NOT a
 * tenant (Cameron, 2026-10-12).
 */
export async function requireTenantContact(
  contacts: Pick<ContactsRepo, 'getById'>,
  contactId: string,
): Promise<ContactItem> {
  const contact = await contacts.getById(contactId, { consistentRead: true });
  if (contact === undefined) throw new TenantNotFoundError();
  if (contact.type !== 'tenant') throw new ContactNotTenantError(kindOf(contact));
  return contact;
}

/**
 * I3: the contact a unit names as its landlord of record, read CONSISTENTLY.
 * Throws LandlordNotFoundError when it does not exist and
 * LandlordNotLandlordError when it is not typed `landlord`.
 */
export async function requireLandlordContact(
  contacts: Pick<ContactsRepo, 'getById'>,
  contactId: string,
): Promise<ContactItem> {
  const contact = await contacts.getById(contactId, { consistentRead: true });
  if (contact === undefined) throw new LandlordNotFoundError();
  if (contact.type !== 'landlord') throw new LandlordNotLandlordError();
  return contact;
}

/**
 * Write the HTTP answer for one of the four errors above and return true;
 * return false (writing nothing) for anything else, so the caller rethrows.
 */
export function sendContactTypeError(err: unknown, res: Response): boolean {
  if (err instanceof TenantNotFoundError) {
    res.status(404).json({ error: 'tenant_not_found' });
    return true;
  }
  if (err instanceof ContactNotTenantError) {
    res.status(409).json({ error: 'contact_not_tenant', contactKind: err.contactKind });
    return true;
  }
  if (err instanceof LandlordNotFoundError) {
    res.status(404).json({ error: 'landlord_not_found' });
    return true;
  }
  if (err instanceof LandlordNotLandlordError) {
    res.status(409).json({ error: 'landlord_not_landlord' });
    return true;
  }
  return false;
}
