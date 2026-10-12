// The contacts PATCH type-change refusal (spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 3,
// D2; plan S2). A PATCH whose `type` differs from the stored type answers 409
// { error: 'type_change_refused', refusals } while the contact is the tenant
// of an open placement or open tour and the result is not `tenant` (I2), or
// the landlord of record of a LIVE unit and the result is not `landlord` (I3).
// Soft-deleted units and contact-list seats never refuse, a role-only change
// is not checked, the caseworker 409 still wins (W6), and a refusal writes
// nothing. FakeWorld routes.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem, ContactType } from '../src/repos/contactsRepo.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const ID = 'c-tc-1';
const OTHER = 'c-tc-other';
const STAMP = '2026-10-01T00:00:00.000Z';
const DELETED = '2026-10-05T00:00:00.000Z';

const TYPES: ContactType[] = ['tenant', 'landlord', 'partner', 'unknown', 'team_member'];
/** Every (stored type, requested type) pair that is a type change. */
const PAIRS: Array<[ContactType, ContactType]> = TYPES.flatMap((from) =>
  TYPES.filter((to) => to !== from).map((to): [ContactType, ContactType] => [from, to]),
);

/** A status valid for each stored type. */
const SEED_STATUS: Record<ContactType, string> = {
  tenant: 'onboarding',
  landlord: 'interested',
  partner: 'active',
  unknown: 'needs_review',
  team_member: 'active',
};

function seed(world: FakeWorld, type: ContactType, over: Partial<ContactItem> = {}): void {
  world.contacts.push({
    contactId: ID,
    type,
    status: SEED_STATUS[type],
    phone: '+15550107601',
    firstName: 'Ana',
    lastName: 'Ruiz',
    created_at: STAMP,
    ...over,
  } as ContactItem);
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

/** A seat on another landlord's unit - never a landlord of record. */
function seat(world: FakeWorld, unitId: string): void {
  unit(world, unitId, {
    landlordId: OTHER,
    contacts: [
      { contactId: OTHER, role: 'landlord', primaryContact: true },
      { contactId: ID, role: 'pm', primaryContact: false },
    ],
  });
}

function send(app: import('express').Express, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/contacts/${ID}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

function stored(world: FakeWorld): ContactItem | undefined {
  return world.contacts.find((c) => c.contactId === ID);
}

describe('the refusal matrix: every stored type to every other type', () => {
  for (const [from, to] of PAIRS) {
    it(`${from} -> ${to} holding an open placement, an open tour and a live unit: 409 naming what the result breaks; nothing written`, async () => {
      const { app, world } = makeWebhookHarness();
      seed(world, from);
      placement(world, 'pl-open', 'send_application');
      tour(world, 'tr-open', 'scheduled');
      unit(world, 'u-live', { landlordId: ID });
      const before = structuredClone(stored(world));
      const update = vi.spyOn(world.contactsRepo, 'update');
      const res = await send(app, { type: to });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'type_change_refused',
        refusals: [
          ...(to !== 'tenant'
            ? [
                { code: 'open_placement', placementId: 'pl-open' },
                { code: 'open_tour', tourId: 'tr-open' },
              ]
            : []),
          ...(to !== 'landlord' ? [{ code: 'landlord_of_record', unitId: 'u-live' }] : []),
        ],
      });
      expect(update).not.toHaveBeenCalled();
      expect(stored(world)).toEqual(before);
      expect(world.auditEvents.filter((e) => e.event_type === 'contact_updated')).toEqual([]);
      expect(world.emitted).toEqual([]);
    });
  }

  for (const [from] of PAIRS.filter(([, to]) => to === 'tenant')) {
    it(`(PIN) ${from} -> tenant holding an open placement and an open tour: allowed (I2 wants a tenant)`, async () => {
      const { app, world } = makeWebhookHarness();
      seed(world, from);
      placement(world, 'pl-open', 'send_application');
      tour(world, 'tr-open', 'scheduled');
      const res = await send(app, { type: 'tenant' });
      expect(res.status).toBe(200);
      expect(stored(world)?.type).toBe('tenant');
    });
  }

  for (const [from] of PAIRS.filter(([, to]) => to === 'landlord')) {
    it(`(PIN) ${from} -> landlord as the landlord of record of a live unit: allowed (I3 wants a landlord)`, async () => {
      const { app, world } = makeWebhookHarness();
      seed(world, from);
      unit(world, 'u-live', { landlordId: ID });
      const res = await send(app, { type: 'landlord' });
      expect(res.status).toBe(200);
      expect(stored(world)?.type).toBe('landlord');
    });
  }
});

describe('what counts as a holding', () => {
  it('(PIN) terminal placements and resolved tours never refuse', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'tenant');
    placement(world, 'pl-moved', 'moved_in');
    placement(world, 'pl-lost', 'lost');
    tour(world, 'tr-can', 'canceled');
    tour(world, 'tr-clo', 'closed');
    expect((await send(app, { type: 'partner' })).status).toBe(200);
  });

  it("(PIN) another contact's placements, tours and units never refuse", async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'tenant');
    placement(world, 'pl-x', 'send_application', OTHER);
    tour(world, 'tr-x', 'scheduled', OTHER);
    unit(world, 'u-x', { landlordId: OTHER });
    expect((await send(app, { type: 'partner' })).status).toBe(200);
  });

  it('a soft-deleted unit does not count: only the live unit is named', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'landlord');
    unit(world, 'u-live', { landlordId: ID });
    unit(world, 'u-gone', { landlordId: ID, deleted_at: DELETED });
    const res = await send(app, { type: 'partner' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'type_change_refused',
      refusals: [{ code: 'landlord_of_record', unitId: 'u-live' }],
    });
  });

  it('(PIN) the landlord of record of only a soft-deleted unit may change type (restore fences it, spec section 4)', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'landlord');
    unit(world, 'u-gone', { landlordId: ID, deleted_at: DELETED });
    const res = await send(app, { type: 'partner' });
    expect(res.status).toBe(200);
    expect(stored(world)?.type).toBe('partner');
  });

  it('(PIN) a contact-list seat never refuses a type change', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'tenant');
    seat(world, 'u-seat');
    expect((await send(app, { type: 'partner' })).status).toBe(200);
  });

  it('names placements, then tours, then units, each id ascending', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'unknown');
    placement(world, 'pl-b', 'send_application');
    placement(world, 'pl-a', 'awaiting_inspection');
    tour(world, 'tr-b', 'scheduled');
    tour(world, 'tr-a', 'requested');
    unit(world, 'u-b', { landlordId: ID });
    unit(world, 'u-a', { landlordId: ID });
    const res = await send(app, { type: 'partner' });
    expect(res.status).toBe(409);
    expect(res.body.refusals).toEqual([
      { code: 'open_placement', placementId: 'pl-a' },
      { code: 'open_placement', placementId: 'pl-b' },
      { code: 'open_tour', tourId: 'tr-a' },
      { code: 'open_tour', tourId: 'tr-b' },
      { code: 'landlord_of_record', unitId: 'u-a' },
      { code: 'landlord_of_record', unitId: 'u-b' },
    ]);
  });
});

describe('what is not checked', () => {
  it('(PIN) a role-only change is not checked', async () => {
    const tenant = makeWebhookHarness();
    seed(tenant.world, 'tenant');
    placement(tenant.world, 'pl-open', 'send_application');
    expect((await send(tenant.app, { role: 'Inspector' })).status).toBe(200);

    const landlord = makeWebhookHarness();
    seed(landlord.world, 'landlord');
    unit(landlord.world, 'u-live', { landlordId: ID });
    expect((await send(landlord.app, { role: 'Property Manager' })).status).toBe(200);
  });

  it('(PIN) the stored type re-sent is not a type change', async () => {
    const tenant = makeWebhookHarness();
    seed(tenant.world, 'tenant');
    placement(tenant.world, 'pl-open', 'send_application');
    expect((await send(tenant.app, { type: 'tenant', firstName: 'Pat' })).status).toBe(200);

    const landlord = makeWebhookHarness();
    seed(landlord.world, 'landlord');
    unit(landlord.world, 'u-live', { landlordId: ID });
    expect((await send(landlord.app, { type: 'landlord', role: 'Property Manager' })).status).toBe(200);
  });

  it('(PIN) the caseworker 409 still wins over the type-change refusal (W6)', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'tenant');
    placement(world, 'pl-open', 'send_application');
    const res = await send(app, { type: 'partner', role: 'Caseworker' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'caseworker_use_conversion' });
  });
});

describe('the reads', () => {
  it('reads live landlord units only and never runs the roster Scan', async () => {
    const { app, world } = makeWebhookHarness();
    seed(world, 'partner');
    seat(world, 'u-seat');
    const landlordRead = vi.spyOn(world.unitsRepo, 'listByLandlord');
    const scan = vi.spyOn(world.unitsRepo, 'list');
    expect((await send(app, { type: 'unknown' })).status).toBe(200);
    expect(landlordRead).toHaveBeenCalledWith(ID, { deleted: false });
    expect(scan).not.toHaveBeenCalled();
  });
});
