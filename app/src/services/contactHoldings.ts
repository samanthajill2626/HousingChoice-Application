// What a contact HOLDS that a change of its kind must not orphan (spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 3
// "Shared reads"; extracted from caseworkerConversion.ts collectRefusals):
// its open placements and open tours as the tenant (I2), the units it is the
// landlord of record for (I3) and its contact-list seats (I4). Each reader
// walks every page of its index or scan and returns ids ascending by UTF-16
// code unit (never localeCompare - the conversion's order, W2). Two callers:
// the caseworker conversion (all four kinds, soft-deleted units included,
// codes caseworker_*) and the contacts PATCH type change (typeChangeRefusals:
// only the kinds its rule needs, LIVE units only, never the roster Scan).
// Reads only. The index reads are never strongly consistent, so a caller's
// check is not atomic with its write (spec L1).
import { TERMINAL_STAGES } from '../lib/statusModel.js';
import type { PlacementsRepo } from '../repos/placementsRepo.js';
import type { ToursRepo } from '../repos/toursRepo.js';
import { unitContacts, type UnitsRepo } from '../repos/unitsRepo.js';

/** I2 (D19): requested, scheduled, toured or no_show; canceled and closed are resolved. */
export const OPEN_TOUR_STATUSES: ReadonlySet<string> = new Set(['requested', 'scheduled', 'toured', 'no_show']);

/**
 * The repos the readers query. Callers pass the repo objects themselves, and
 * every read looks its method up at call time, so a test that swaps a repo
 * method after setup still reaches it.
 */
export interface ContactHoldingsDeps {
  placements: Pick<PlacementsRepo, 'listByTenant'>;
  tours: Pick<ToursRepo, 'listByTenant'>;
  units: Pick<UnitsRepo, 'listByLandlord' | 'list'>;
}

/** One entry of the contacts PATCH's 409 type_change_refused (spec D2). */
export type TypeChangeRefusal =
  | { code: 'open_placement'; placementId: string }
  | { code: 'open_tour'; tourId: string }
  | { code: 'landlord_of_record'; unitId: string };

/** Ascending by UTF-16 code unit - the conversion's order. */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The contact's placements as the tenant whose stage is not terminal (moved_in, lost). */
export async function openPlacementIds(deps: ContactHoldingsDeps, contactId: string): Promise<string[]> {
  const ids: string[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const page = await deps.placements.listByTenant(contactId, {
      ...(key !== undefined && { exclusiveStartKey: key }),
    });
    for (const p of page.items) if (!TERMINAL_STAGES.has(p.stage)) ids.push(p.placementId);
    key = page.lastEvaluatedKey;
  } while (key !== undefined);
  return ids.sort(byId);
}

/** The contact's tours as the tenant whose status is open (OPEN_TOUR_STATUSES). */
export async function openTourIds(deps: ContactHoldingsDeps, contactId: string): Promise<string[]> {
  return (await deps.tours.listByTenant(contactId))
    .filter((t) => OPEN_TOUR_STATUSES.has(t.status))
    .map((t) => t.tourId)
    .sort(byId);
}

/**
 * The units whose landlordId is the contact: LIVE units only (deleted: false,
 * the type change - a soft-deleted unit is fenced at restore instead), or
 * live and soft-deleted (deleted: 'any', the conversion, D22).
 */
export async function landlordUnitIds(
  deps: ContactHoldingsDeps,
  contactId: string,
  opts: { deleted: false | 'any' },
): Promise<string[]> {
  const ids = new Set<string>();
  let key: Record<string, unknown> | undefined;
  do {
    const page = await deps.units.listByLandlord(contactId, {
      deleted: opts.deleted,
      ...(key !== undefined && { exclusiveStartKey: key }),
    });
    for (const u of page.items) ids.add(u.unitId);
    key = page.lastEvaluatedKey;
  } while (key !== undefined);
  return [...ids].sort(byId);
}

/**
 * The units, live and soft-deleted, whose contact list (unitContacts - a
 * landlordId with no contacts[] derives a landlord row) seats the contact,
 * minus `exclude`. ONE Scan of every unit: there is no roster index (the
 * conversion accepts the cost at today's unit count; filed in the 2026-10-06
 * design section 12). The type change never calls this.
 */
export async function rosterUnitIds(
  deps: ContactHoldingsDeps,
  contactId: string,
  exclude: ReadonlySet<string>,
): Promise<string[]> {
  const ids: string[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const page = await deps.units.list({
      deleted: 'any',
      ...(key !== undefined && { exclusiveStartKey: key }),
    });
    for (const u of page.items) {
      if (exclude.has(u.unitId)) continue;
      if (unitContacts(u).some((seat) => seat.contactId === contactId)) ids.push(u.unitId);
    }
    key = page.lastEvaluatedKey;
  } while (key !== undefined);
  return ids.sort(byId);
}

/**
 * The contacts PATCH type-change refusal (spec 2026-10-12 D2), for a PATCH
 * whose resulting type `toType` differs from the stored type. A result that is
 * not `tenant` is refused by every open placement and open tour (I2); a result
 * that is not `landlord` by every LIVE unit the contact is the landlord of
 * record for (I3). Soft-deleted units are fenced at restore instead, and
 * contact-list seats never refuse, so the roster Scan is never run. Ordered by
 * kind (placement, tour, landlord), then id ascending.
 */
export async function typeChangeRefusals(
  deps: ContactHoldingsDeps,
  contactId: string,
  toType: string,
): Promise<TypeChangeRefusal[]> {
  const refusals: TypeChangeRefusal[] = [];
  if (toType !== 'tenant') {
    for (const placementId of await openPlacementIds(deps, contactId)) {
      refusals.push({ code: 'open_placement', placementId });
    }
    for (const tourId of await openTourIds(deps, contactId)) {
      refusals.push({ code: 'open_tour', tourId });
    }
  }
  if (toType !== 'landlord') {
    for (const unitId of await landlordUnitIds(deps, contactId, { deleted: false })) {
      refusals.push({ code: 'landlord_of_record', unitId });
    }
  }
  return refusals;
}
