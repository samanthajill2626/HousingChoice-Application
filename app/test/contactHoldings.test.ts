// The shared holding reads (spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 3
// "Shared reads"; plan S2): what a contact holds that a type change or the
// caseworker conversion must not orphan - its open placements and open tours
// as the tenant, the units it is the landlord of record for, and its
// contact-list seats. Extracted from caseworkerConversion.ts collectRefusals;
// the conversion's own tests (caseworkerConversion.test.ts) prove its behavior
// did not move. FakeWorld repos.
import { describe, expect, it, vi } from 'vitest';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import {
  OPEN_TOUR_STATUSES,
  landlordUnitIds,
  openPlacementIds,
  openTourIds,
  rosterUnitIds,
  type ContactHoldingsDeps,
} from '../src/services/contactHoldings.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const ID = 'c-hold-1';
const OTHER = 'c-hold-other';
const STAMP = '2026-10-01T00:00:00.000Z';
const DELETED = '2026-10-05T00:00:00.000Z';

function setup(): { world: FakeWorld; deps: ContactHoldingsDeps } {
  const world = createFakeWorld();
  return {
    world,
    deps: { placements: world.placementsRepo, tours: world.toursRepo, units: world.unitsRepo },
  };
}

function placement(world: FakeWorld, placementId: string, stage: string, tenantId = ID): void {
  world.placements.set(placementId, {
    placementId, tenantId, unitId: 'u-pl', stage, created_at: STAMP, updated_at: STAMP,
  } as PlacementItem);
}

function tour(world: FakeWorld, tourId: string, status: string, tenantId = ID): void {
  world.toursMap.set(tourId, {
    tourId, tenantId, unitId: 'u-tr', tourType: 'self_guided', status, createdAt: STAMP, updatedAt: STAMP,
  } as TourItem);
}

function unit(world: FakeWorld, unitId: string, over: Partial<UnitItem> = {}): void {
  world.units.set(unitId, { unitId, status: 'available', ...over } as UnitItem);
}

describe('OPEN_TOUR_STATUSES (spec I2; moved from the conversion)', () => {
  it('is requested, scheduled, toured and no_show - canceled and closed are resolved', () => {
    expect([...OPEN_TOUR_STATUSES].sort()).toEqual(['no_show', 'requested', 'scheduled', 'toured']);
  });
});

describe('openPlacementIds', () => {
  it("the contact's non-terminal placements as the tenant, ids ascending by code unit", async () => {
    const { world, deps } = setup();
    placement(world, 'pl-b', 'send_application');
    placement(world, 'pl-a', 'awaiting_inspection');
    placement(world, 'PL-c', 'schedule_inspection');
    placement(world, 'pl-moved', 'moved_in');
    placement(world, 'pl-lost', 'lost');
    placement(world, 'pl-other', 'send_application', OTHER);
    expect(await openPlacementIds(deps, ID)).toEqual(['PL-c', 'pl-a', 'pl-b']);
  });

  it('follows the index cursor past its first page', async () => {
    const { world, deps } = setup();
    placement(world, 'pl-1', 'send_application');
    placement(world, 'pl-2', 'send_application');
    const original = world.placementsRepo.listByTenant.bind(world.placementsRepo);
    const cursors: unknown[] = [];
    world.placementsRepo.listByTenant = async (tenantId, opts = {}) => {
      cursors.push(opts.exclusiveStartKey);
      return original(tenantId, { ...opts, limit: 1 });
    };
    expect(await openPlacementIds(deps, ID)).toEqual(['pl-1', 'pl-2']);
    expect(cursors).toEqual([undefined, { placementId: 'pl-1' }]);
  });
});

describe('openTourIds', () => {
  it("the contact's requested, scheduled, toured and no_show tours, ids ascending", async () => {
    const { world, deps } = setup();
    tour(world, 'tr-sch', 'scheduled');
    tour(world, 'tr-req', 'requested');
    tour(world, 'tr-tou', 'toured');
    tour(world, 'tr-ns', 'no_show');
    tour(world, 'tr-can', 'canceled');
    tour(world, 'tr-clo', 'closed');
    tour(world, 'tr-other', 'scheduled', OTHER);
    expect(await openTourIds(deps, ID)).toEqual(['tr-ns', 'tr-req', 'tr-sch', 'tr-tou']);
  });
});

describe('landlordUnitIds', () => {
  function landlordWorld(): { world: FakeWorld; deps: ContactHoldingsDeps } {
    const s = setup();
    unit(s.world, 'u-live-b', { landlordId: ID });
    unit(s.world, 'u-live-a', { landlordId: ID });
    unit(s.world, 'u-gone', { landlordId: ID, deleted_at: DELETED });
    unit(s.world, 'u-other', { landlordId: OTHER });
    return s;
  }

  it("deleted: false - the LIVE units the contact is the landlord of record for (the type change's rule)", async () => {
    const { deps } = landlordWorld();
    expect(await landlordUnitIds(deps, ID, { deleted: false })).toEqual(['u-live-a', 'u-live-b']);
  });

  it("deleted: 'any' - live and soft-deleted units (the conversion's rule, D22)", async () => {
    const { deps } = landlordWorld();
    expect(await landlordUnitIds(deps, ID, { deleted: 'any' })).toEqual(['u-gone', 'u-live-a', 'u-live-b']);
  });

  it('passes the scope on every page and follows the cursor', async () => {
    const { world, deps } = landlordWorld();
    const original = world.unitsRepo.listByLandlord.bind(world.unitsRepo);
    const seen: Array<{ deleted: unknown; cursor: unknown }> = [];
    world.unitsRepo.listByLandlord = async (landlordId, opts = {}) => {
      seen.push({ deleted: opts.deleted, cursor: opts.exclusiveStartKey });
      return original(landlordId, { ...opts, limit: 1 });
    };
    expect(await landlordUnitIds(deps, ID, { deleted: false })).toEqual(['u-live-a', 'u-live-b']);
    expect(seen).toEqual([
      { deleted: false, cursor: undefined },
      { deleted: false, cursor: { unitId: 'u-live-b' } },
    ]);
  });
});

describe('rosterUnitIds', () => {
  it('every unit, live or deleted, whose contact list seats the contact, minus the excluded ids', async () => {
    const { world, deps } = setup();
    unit(world, 'u-seat-live', {
      landlordId: OTHER,
      contacts: [
        { contactId: OTHER, role: 'landlord', primaryContact: true },
        { contactId: ID, role: 'pm', primaryContact: false },
      ],
    });
    unit(world, 'u-seat-gone', {
      landlordId: OTHER,
      contacts: [{ contactId: ID, role: 'other', primaryContact: true }],
      deleted_at: DELETED,
    });
    // A landlord of record with no contacts[] still has a derived landlord row (unitContacts).
    unit(world, 'u-owned', { landlordId: ID });
    unit(world, 'u-none', { landlordId: OTHER });
    expect(await rosterUnitIds(deps, ID, new Set())).toEqual(['u-owned', 'u-seat-gone', 'u-seat-live']);
    expect(await rosterUnitIds(deps, ID, new Set(['u-owned']))).toEqual(['u-seat-gone', 'u-seat-live']);
  });

  it("scans with deleted: 'any' and follows the scan cursor", async () => {
    const { world, deps } = setup();
    for (let i = 0; i < 3; i += 1) unit(world, 'scan-' + String(i));
    unit(world, 'scan-last', {
      deleted_at: DELETED,
      contacts: [{ contactId: ID, role: 'other', primaryContact: false }],
    });
    const realList = world.unitsRepo.list.bind(world.unitsRepo);
    const scan = vi.spyOn(world.unitsRepo, 'list').mockImplementation((options) => realList({ ...options, limit: 2 }));
    expect(await rosterUnitIds(deps, ID, new Set())).toEqual(['scan-last']);
    expect(scan).toHaveBeenCalledTimes(2);
    for (const [options] of scan.mock.calls) expect(options).toMatchObject({ deleted: 'any' });
  });
});
