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

/**
 * Trim, and STRIP `{` / `}` so a resolved name can never re-open a token.
 *
 * WHY: a contact name is USER-SUPPLIED - through staff free text, through AI
 * extraction, and through the UNAUTHENTICATED public intake route
 * (`POST /public/housing-fair` in routes/public.ts takes `firstName` as an
 * arbitrary trimmed, length-capped string). The shared interpolate()
 * (messages/resolve.ts) substitutes the DECLARED tokens in sequence, so a value
 * put in early that itself contains `{anotherDeclaredToken}` is re-expanded by
 * a later pass - and every tour entry declares six to eight tokens (the six of
 * TOUR_NAME_VARS plus `where` / `addressLine`), with the NAME tokens ahead of
 * the rest, so there is plenty to leak into: a tenant naming themselves
 * `{propertyContactFirstName}` would be texted the landlord's first name.
 * Sanitizing at THIS source closes the NAME vector without touching the shared
 * interpolator, which every message in the app runs through. The general
 * single-pass fix is filed as `message-interpolate-token-reexpansion`.
 *
 * SCOPE, stated precisely because an earlier revision of this docblock
 * overclaimed: this closes the NAME tokens, NOT the whole tour path. The unit
 * ADDRESS lands in the same sentence as `{addressLine}` / `{where}` and is not
 * sanitized here. That one is order-SAFE - the address is substituted after
 * every name token, so nothing re-expands it - so it is not the vulnerability
 * above; the residue is only that a braced address would emit a literal
 * `{token}` into a tenant SMS. Recorded on the filed issue rather than fixed,
 * because sanitizing the address is a change to address RENDERING and belongs
 * with that issue's single-pass fix.
 *
 * A name that is nothing BUT braces collapses to '' and is therefore read as
 * absence by the callers below - which is right; it was never a name.
 */
function inertName(raw: string): string {
  return raw.replace(/[{}]/g, '').trim();
}

// Local first/full-name derivations. lib/contactName.ts carries an explicit
// scope guard ("consumed by PUSH-COPY sites only ... do not re-point them
// here as a drive-by"), so this module keeps its own copy - deliberately,
// spec 6.2. firstName/lastName ride ContactItem's index signature, so both
// reads are defensive: a non-string must never reach inertName().
// Deliberately NO surname fallback for the first name: greeting a tenant
// "Hey Chen," is worse than the composer's "Hey there," fallback.
// TODO(consolidate-contact-display-name-helpers): fold into the shared
// helper when that issue is worked.
function firstNameOf(c: ContactItem | undefined): string | undefined {
  if (c === undefined) return undefined;
  const first = typeof c['firstName'] === 'string' ? inertName(c['firstName']) : '';
  return first.length > 0 ? first : undefined;
}
function fullNameOf(c: ContactItem | undefined): string | undefined {
  if (c === undefined) return undefined;
  const first = typeof c['firstName'] === 'string' ? inertName(c['firstName']) : '';
  const last = typeof c['lastName'] === 'string' ? inertName(c['lastName']) : '';
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
    // DE-DUPE the degenerate case where the tenant IS the property contact -
    // the guard rosterResolution.ts:279-281 carries one line below the rule
    // spec 6.1 told us to reuse, and which an earlier revision of this module
    // copied the rule without. Without it a unit whose landlordId is the tour's
    // own tenant composes "Hey Alice, Alice will be headed that way shortly."
    // and sends it to Alice. Treating it as NO property contact is the right
    // outcome rather than a special case: idFor() then degrades the rung to the
    // self-guided entry, which is exactly spec 6.3's absence fallback.
    const usablePropertyContactId =
      propertyContactId === args.tenantId ? undefined : propertyContactId;
    if (typeof usablePropertyContactId === 'string' && usablePropertyContactId.length > 0) {
      try {
        propertyContact = await args.contactsRepo.getById(usablePropertyContactId);
      } catch (err) {
        propertyReadFailed = true;
        log.warn(
          { err, unitId: args.unit.unitId, propertyContactId: usablePropertyContactId },
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
