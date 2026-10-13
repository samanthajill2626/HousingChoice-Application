// The two too-thin DIAGNOSTICS in services/rosterProvision.ts read the
// property contact through the shared lookup (primary-contact-integrity spec
// 4.1) and keep, per state, the code and text they answered before:
//   tour:      none -> 'unit has no landlord (cannot resolve landlord)';
//              deleted / no record -> 'landlord contact not found';
//              is_tenant -> 'this tour roster has fewer than two reachable members';
//   placement: none / deleted -> landlord_unreachable;
//              is_tenant -> relay_member_unresolvable;
//   a read that throws -> thrown out as the same error, as the inline getById
//   threw it.
// Driven through the exported deferral pre-checks (tourOpenDeferralRefusal /
// placementOpenDeferralRefusal): they run exactly the immediate path's
// resolution and refusal ladder and provision nothing. PURE - in-memory
// repos, no DynamoDB, no HTTP.
import { describe, expect, it } from 'vitest';
import {
  placementOpenDeferralRefusal,
  tourOpenDeferralRefusal,
  type OpenPlacementGroupDeps,
  type OpenTourGroupDeps,
} from '../src/services/rosterProvision.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';
const TENANT: ContactItem = { contactId: 'c-tenant', type: 'tenant', firstName: 'Tina', phone: '+15550100001' };
const LANDLORD: ContactItem = { contactId: 'c-ll', type: 'landlord', firstName: 'Lee', phone: '+15550100002' };
const PM: ContactItem = { contactId: 'c-pm', type: 'landlord', firstName: 'Pat', phone: '+15550100003' };
const PM_NO_PHONE: ContactItem = { contactId: 'c-pm', type: 'landlord', firstName: 'Pat' };

interface World {
  unit?: UnitItem;
  contacts: Record<string, ContactItem>;
  /** contactId -> the error its read THROWS. */
  throwing?: Record<string, Error>;
}

function depsFor(world: World): OpenTourGroupDeps & OpenPlacementGroupDeps {
  return {
    conversations: { getById: async () => undefined },
    units: { getById: async () => world.unit },
    contacts: {
      getById: async (contactId: string) => {
        const boom = world.throwing?.[contactId];
        if (boom !== undefined) throw boom;
        return world.contacts[contactId];
      },
    },
    log: createLogger({ destination: createLogCapture().stream }),
  } as unknown as OpenTourGroupDeps & OpenPlacementGroupDeps;
}

const TOUR = {
  tourId: 'tour-1',
  tenantId: 'c-tenant',
  unitId: 'unit-1',
  status: 'scheduled',
  tourType: 'landlord_led',
} as unknown as TourItem;
const PLACEMENT = {
  placementId: 'plc-1',
  tenantId: 'c-tenant',
  unitId: 'unit-1',
  stage: 'awaiting_approval',
} as unknown as PlacementItem;

function unitOf(over: Record<string, unknown>): UnitItem {
  return { unitId: 'unit-1', status: 'available', ...over } as unknown as UnitItem;
}
/** A PM flagged primary next to the landlord of record. */
const PM_PRIMARY = {
  landlordId: 'c-ll',
  contacts: [
    { contactId: 'c-ll', role: 'landlord', primaryContact: false },
    { contactId: 'c-pm', role: 'pm', primaryContact: true },
  ],
};

const tourRefusal = (world: World) => tourOpenDeferralRefusal(depsFor(world), TOUR, true);
const placementRefusal = (world: World) => placementOpenDeferralRefusal(depsFor(world), PLACEMENT, true);
const tourDetail = (detail: string) => ({ status: 400, body: { error: 'relay_member_unresolvable', detail } });
const LANDLORD_UNREACHABLE = {
  status: 400,
  body: { error: 'landlord_unreachable', message: 'the unit landlord has no phone on file' },
};
const PLACEMENT_TOO_THIN = {
  status: 400,
  body: {
    error: 'relay_member_unresolvable',
    detail: 'this placement roster has fewer than two reachable members',
  },
};

describe('the TOUR too-thin diagnostic reads the property contact through the shared lookup (spec 4.1)', () => {
  it('none -> "unit has no landlord (cannot resolve landlord)"', async () => {
    expect(
      await tourRefusal({
        unit: unitOf({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: false }] }),
        contacts: { 'c-tenant': TENANT, 'c-pm': PM },
      }),
    ).toEqual(tourDetail('unit has no landlord (cannot resolve landlord)'));
  });

  it('deleted -> "landlord contact not found": a soft-deleted SOLE primary reads like a missing contact', async () => {
    expect(
      await tourRefusal({
        unit: unitOf({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }] }),
        contacts: { 'c-tenant': TENANT, 'c-pm': { ...PM, deleted_at: DELETED_AT } },
      }),
    ).toEqual(tourDetail('landlord contact not found'));
  });

  it('deleted -> "landlord contact not found": a deleted primary AND a deleted landlord of record', async () => {
    expect(
      await tourRefusal({
        unit: unitOf(PM_PRIMARY),
        contacts: {
          'c-tenant': TENANT,
          'c-pm': { ...PM, deleted_at: DELETED_AT },
          'c-ll': { ...LANDLORD, deleted_at: DELETED_AT },
        },
      }),
    ).toEqual(tourDetail('landlord contact not found'));
  });

  it('a deleted primary resolves PAST it to the live landlord of record: no refusal', async () => {
    // Before the shared lookup the phone-less deleted PM made the default
    // roster too thin, and the diagnostic blamed it ("landlord contact has no
    // phone").
    expect(
      await tourRefusal({
        unit: unitOf(PM_PRIMARY),
        contacts: { 'c-tenant': TENANT, 'c-pm': { ...PM_NO_PHONE, deleted_at: DELETED_AT }, 'c-ll': LANDLORD },
      }),
    ).toBeUndefined();
  });

  it('(PIN) a LIVE primary without a phone is not skipped: "landlord contact has no phone"', async () => {
    expect(
      await tourRefusal({
        unit: unitOf(PM_PRIMARY),
        contacts: { 'c-tenant': TENANT, 'c-pm': PM_NO_PHONE, 'c-ll': LANDLORD },
      }),
    ).toEqual(tourDetail('landlord contact has no phone'));
  });

  it('(PIN) is_tenant -> the too-thin text: the tenant IS the property contact', async () => {
    expect(
      await tourRefusal({ unit: unitOf({ landlordId: 'c-tenant' }), contacts: { 'c-tenant': TENANT } }),
    ).toEqual(tourDetail('this tour roster has fewer than two reachable members'));
  });

  it('(PIN) a property-contact read that THROWS is thrown out as the SAME error - never a fall-through', async () => {
    const boom = new Error('dynamodb: ProvisionedThroughputExceededException');
    await expect(
      tourRefusal({
        unit: unitOf(PM_PRIMARY),
        contacts: { 'c-tenant': TENANT, 'c-ll': LANDLORD },
        throwing: { 'c-pm': boom },
      }),
    ).rejects.toBe(boom);
  });
});

describe('the PLACEMENT too-thin diagnostic keeps its codes per state (spec 4.1)', () => {
  it('(PIN) none -> landlord_unreachable', async () => {
    expect(
      await placementRefusal({
        unit: unitOf({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: false }] }),
        contacts: { 'c-tenant': TENANT, 'c-pm': PM },
      }),
    ).toEqual(LANDLORD_UNREACHABLE);
  });

  it('deleted -> landlord_unreachable: a soft-deleted SOLE primary is no longer put on the group', async () => {
    expect(
      await placementRefusal({
        unit: unitOf({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }] }),
        contacts: { 'c-tenant': TENANT, 'c-pm': { ...PM, deleted_at: DELETED_AT } },
      }),
    ).toEqual(LANDLORD_UNREACHABLE);
  });

  it('a deleted primary resolves PAST it to the live landlord of record: no refusal', async () => {
    expect(
      await placementRefusal({
        unit: unitOf(PM_PRIMARY),
        contacts: { 'c-tenant': TENANT, 'c-pm': { ...PM_NO_PHONE, deleted_at: DELETED_AT }, 'c-ll': LANDLORD },
      }),
    ).toBeUndefined();
  });

  it('(PIN) is_tenant -> relay_member_unresolvable', async () => {
    expect(
      await placementRefusal({ unit: unitOf({ landlordId: 'c-tenant' }), contacts: { 'c-tenant': TENANT } }),
    ).toEqual(PLACEMENT_TOO_THIN);
  });

  it('(PIN) a property-contact read that THROWS is thrown out as the SAME error', async () => {
    const boom = new Error('dynamodb: ProvisionedThroughputExceededException');
    await expect(
      placementRefusal({
        unit: unitOf(PM_PRIMARY),
        contacts: { 'c-tenant': TENANT, 'c-ll': LANDLORD },
        throwing: { 'c-pm': boom },
      }),
    ).rejects.toBe(boom);
  });
});
