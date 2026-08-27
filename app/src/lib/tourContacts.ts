// Name resolution for tour-reminder copy (spec section 6). The composer
// (messages/tourCopy.ts) stays pure and synchronous; every caller resolves
// names through THIS module before composing. NEVER throws: a throwing repo
// read is reported on a per-read failure flag - what a given failure MEANS
// for a given rung is not decided here but by assessNamesReadFailure in
// messages/tourCopy.ts, which derives it from the catalog templates.
//
// PII: log IDs only - never a name or phone.
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import { unitContacts, type UnitItem } from '../repos/unitsRepo.js';
import { logger as defaultLogger, type Logger } from './logger.js';

export interface TourContactNames {
  tenantFirstName?: string;
  tenantName?: string;
  propertyContactFirstName?: string;
  propertyContactName?: string;
}

export interface ResolvedTourNames {
  names: TourContactNames;
  /** true only when the TENANT contact read THREW. Absence (no such contact,
   *  or no name on it) is undefined fields with both flags false - failure
   *  and absence must never be conflated (spec 6.3b). */
  tenantReadFailed: boolean;
  /** true only when the PROPERTY-CONTACT read threw. */
  propertyReadFailed: boolean;
}

// Local first/full-name derivations. lib/contactName.ts carries an explicit
// scope guard ("consumed by PUSH-COPY sites only ... do not re-point them
// here as a drive-by"), so this module keeps its own copy - deliberately,
// spec 6.2. firstName/lastName ride ContactItem's index signature, so both
// reads are defensive: a non-string must never reach .trim().
// Deliberately NO surname fallback for the first name: greeting a tenant
// "Hey Chen," is worse than the composer's "Hey there," fallback.
// TODO(consolidate-contact-display-name-helpers): fold into the shared
// helper when that issue is worked.
function firstNameOf(c: ContactItem | undefined): string | undefined {
  if (c === undefined) return undefined;
  const first = typeof c['firstName'] === 'string' ? c['firstName'].trim() : '';
  return first.length > 0 ? first : undefined;
}
function fullNameOf(c: ContactItem | undefined): string | undefined {
  if (c === undefined) return undefined;
  const first = typeof c['firstName'] === 'string' ? c['firstName'].trim() : '';
  const last = typeof c['lastName'] === 'string' ? c['lastName'].trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}

/**
 * Resolve the two names tour-reminder copy interpolates: the TENANT, and the
 * unit's PRIMARY CONTACT falling back to the landlord of record - the
 * established rule (lib/rosterResolution.ts:273-275). Reads the LIVE contact
 * for names; roster rows carry a denormalized name that goes stale.
 *
 * The UNIT is passed in, not read here: every caller already holds (or has
 * already failed) its own unit read, and that failure is the caller's to
 * fold into the send/read failure split.
 */
export async function resolveTourContactNames(args: {
  tenantId: string;
  unit: UnitItem | undefined;
  /** Skip the tenant read when the caller already fetched the contact (the
   *  poll's 1:1 route has it as resolveReminderTarget's target.contact). */
  tenantContact?: ContactItem;
  contactsRepo: Pick<ContactsRepo, 'getById'>;
  logger?: Logger;
}): Promise<ResolvedTourNames> {
  const log = args.logger ?? defaultLogger;
  let tenantReadFailed = false;
  let propertyReadFailed = false;

  let tenant = args.tenantContact;
  if (tenant === undefined) {
    try {
      tenant = await args.contactsRepo.getById(args.tenantId);
    } catch (err) {
      tenantReadFailed = true;
      log.warn({ err, tenantId: args.tenantId }, 'tour names: tenant contact read failed');
    }
  }

  // Primary-contact rule, with the inline empty-string guard replacing
  // rosterResolution's module-private nonEmpty() (spec 6.1): a legacy
  // landlordId of '' must read as "no property contact", never as an id.
  let propertyContact: ContactItem | undefined;
  if (args.unit !== undefined) {
    const primary = unitContacts(args.unit).find((c) => c.primaryContact === true);
    const landlordId =
      typeof args.unit.landlordId === 'string' && args.unit.landlordId.length > 0
        ? args.unit.landlordId
        : undefined;
    const propertyContactId = primary?.contactId ?? landlordId;
    if (typeof propertyContactId === 'string' && propertyContactId.length > 0) {
      try {
        propertyContact = await args.contactsRepo.getById(propertyContactId);
      } catch (err) {
        propertyReadFailed = true;
        log.warn(
          { err, unitId: args.unit.unitId, propertyContactId },
          'tour names: property contact read failed',
        );
      }
    }
  }

  const tenantFirst = firstNameOf(tenant);
  const tenantFull = fullNameOf(tenant);
  const propFirst = firstNameOf(propertyContact);
  const propFull = fullNameOf(propertyContact);
  return {
    names: {
      ...(tenantFirst !== undefined && { tenantFirstName: tenantFirst }),
      ...(tenantFull !== undefined && { tenantName: tenantFull }),
      ...(propFirst !== undefined && { propertyContactFirstName: propFirst }),
      ...(propFull !== undefined && { propertyContactName: propFull }),
    },
    tenantReadFailed,
    propertyReadFailed,
  };
}
