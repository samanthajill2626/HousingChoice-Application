// M1.5 unit tests: the units CRUD endpoints —
//   GET   /api/units?status=&jurisdiction=&landlordId=&limit=&cursor=
//   POST  /api/units
//   GET   /api/units/:unitId
//   PATCH /api/units/:unitId
// Validation (field allowlist, number/status checks), 404s, the audit trail,
// the no-overwrite merge, and the requireAuth gate.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

function seedUnit(
  world: ReturnType<typeof createFakeWorld>,
  unitId: string,
  overrides: Partial<UnitItem> = {},
): UnitItem {
  const item: UnitItem = {
    unitId,
    landlordId: 'contact-ll-1',
    status: 'available',
    jurisdiction: 'DCA',
    beds: 2,
    baths: 1,
    rent_min: 1400,
    created_at: '2026-06-12T09:00:00.000Z',
    updated_at: '2026-06-12T09:00:00.000Z',
    ...overrides,
  };
  world.units.set(unitId, item);
  return item;
}

describe('POST /api/units — create', () => {
  it('creates a unit, defaults status to available, returns 201 + audits unit_created', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        landlordId: 'contact-ll-9',
        jurisdiction: 'Fulton',
        beds: 3,
        rent_min: 1700,
        address: { line1: '12 Peachtree St', line2: 'Apt 4', city: 'Atlanta', state: 'GA', zip: '30303' },
      });

    expect(res.status).toBe(201);
    expect(res.body.unit).toMatchObject({
      landlordId: 'contact-ll-9',
      status: 'available',
      jurisdiction: 'Fulton',
      beds: 3,
      rent_min: 1700,
      address: { line1: '12 Peachtree St', line2: 'Apt 4', city: 'Atlanta', state: 'GA', zip: '30303' },
    });
    expect(res.body.unit.unitId).toBeDefined();
    expect(world.units.get(res.body.unit.unitId)).toBeDefined();
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({
        entityKey: `units#${res.body.unit.unitId}`,
        event_type: 'unit_created',
      }),
    );
  });

  it('rejects a missing landlordId, unknown fields, bad numbers, and bad status', async () => {
    const { app, world } = makeWebhookHarness();
    const bodies = [
      {}, // no landlordId
      { jurisdiction: 'DCA' }, // still no landlordId
      { landlordId: 'c', nope: 'x' }, // unknown field
      { landlordId: 'c', beds: 'three' }, // beds not a number
      { landlordId: 'c', rent_min: -5 }, // negative
      { landlordId: 'c', status: 'sold' }, // not an allowed status
      { landlordId: 'c', accepted_programs: [1, 2] }, // not string[]
      { landlordId: 'c', address: 'just a string' }, // address must be an object now
      { landlordId: 'c', address: { line1: '1 Main', country: 'US' } }, // unknown address key
      { landlordId: 'c', address: { zip: 30303 } }, // address sub-field not a string
    ];
    for (const body of bodies) {
      const res = await request(app)
        .post('/api/units')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(world.units.size).toBe(0);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('accepts the per-unit internal fields incl. primary_voice_contact (CO1)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        landlordId: 'contact-ll-1',
        tour_process: 'lockbox 1234',
        application_process: 'online portal',
        primary_voice_contact: 'contact-ll-agent-7',
        pets: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.unit.primary_voice_contact).toBe('contact-ll-agent-7');
    expect(res.body.unit.pets).toBe(true);
  });
});

describe('structured address (lib/address.ts)', () => {
  it('accepts a PARTIAL address and stores only the supplied fields', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ landlordId: 'contact-ll-1', address: { city: 'Decatur', state: 'GA' } });
    expect(res.status).toBe(201);
    expect(res.body.unit.address).toEqual({ city: 'Decatur', state: 'GA' });
  });

  it('trims values and drops empty/whitespace-only sub-fields', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        landlordId: 'contact-ll-1',
        address: { line1: '  88 Sycamore St  ', line2: '   ', city: '', zip: '30030' },
      });
    expect(res.status).toBe(201);
    expect(res.body.unit.address).toEqual({ line1: '88 Sycamore St', zip: '30030' });
  });

  it('PATCH replaces the address object with the supplied structured value', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-addr', { address: { line1: '1 Old Rd', city: 'Atlanta' } });
    const res = await request(app)
      .patch('/api/units/unit-addr')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ address: { line1: '2 New Ave', city: 'Marietta', state: 'GA' } });
    expect(res.status).toBe(200);
    expect(res.body.unit.address).toEqual({ line1: '2 New Ave', city: 'Marietta', state: 'GA' });
  });

  it('rejects a non-object, unknown keys, and non-string sub-fields with 400', async () => {
    const { app } = makeWebhookHarness();
    for (const address of ['123 Main St', ['123 Main St'], { line1: '1 Main', foo: 'x' }, { zip: 30303 }]) {
      const res = await request(app)
        .post('/api/units')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ landlordId: 'contact-ll-1', address });
      expect(res.status, JSON.stringify(address)).toBe(400);
    }
  });
});

describe('GET /api/units — list/filter', () => {
  it('filters by landlordId, status, and jurisdiction, else lists all', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { landlordId: 'll-A', status: 'available', jurisdiction: 'DCA' });
    seedUnit(world, 'unit-2', { landlordId: 'll-A', status: 'placed', jurisdiction: 'Fulton' });
    seedUnit(world, 'unit-3', { landlordId: 'll-B', status: 'available', jurisdiction: 'DCA' });

    const byLandlord = await request(app)
      .get('/api/units?landlordId=ll-A')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(byLandlord.status).toBe(200);
    expect(byLandlord.body.units.map((u: UnitItem) => u.unitId).sort()).toEqual(['unit-1', 'unit-2']);

    const byStatus = await request(app)
      .get('/api/units?status=available')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(byStatus.body.units.map((u: UnitItem) => u.unitId).sort()).toEqual(['unit-1', 'unit-3']);

    const byJur = await request(app)
      .get('/api/units?jurisdiction=Fulton')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(byJur.body.units.map((u: UnitItem) => u.unitId)).toEqual(['unit-2']);

    const all = await request(app)
      .get('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(all.body.units).toHaveLength(3);
    expect(all.body.nextCursor).toBeNull();
  });

  it('rejects bad limits and garbage cursors with 400', async () => {
    const { app } = makeWebhookHarness();
    for (const qs of ['limit=0', 'limit=101', 'limit=abc']) {
      const res = await request(app)
        .get(`/api/units?${qs}`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE);
      expect(res.status, qs).toBe(400);
    }
    const garbage = Buffer.from('[1,2]', 'utf8').toString('base64url');
    const res = await request(app)
      .get(`/api/units?cursor=${garbage}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid cursor' });
  });
});

describe('GET /api/units/:unitId', () => {
  it('returns the unit, 404 when unknown', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const ok = await request(app)
      .get('/api/units/unit-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(ok.status).toBe(200);
    expect(ok.body.unit).toMatchObject({ unitId: 'unit-1', beds: 2 });

    const missing = await request(app)
      .get('/api/units/nope')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'unit_not_found' });
  });

  it('back-compat: reads a legacy plain-string address through untouched', async () => {
    const { app, world } = makeWebhookHarness();
    // A dev unit created before the structured-address change still has a string
    // here. The validator only runs on WRITE; reads must not crash or migrate.
    seedUnit(world, 'unit-legacy', { address: '123 Legacy St' as unknown as UnitItem['address'] });
    const res = await request(app)
      .get('/api/units/unit-legacy')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.unit.address).toBe('123 Legacy St');
  });
});

describe('PATCH /api/units/:unitId', () => {
  it('merges supplied fields, leaves the rest, audits unit_updated', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { beds: 2, rent_min: 1400, tour_process: 'keep me' });

    const res = await request(app)
      .patch('/api/units/unit-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ status: 'placed', rent_max: 1900 });

    expect(res.status).toBe(200);
    expect(res.body.unit).toMatchObject({
      status: 'placed',
      rent_max: 1900,
      beds: 2, // untouched
      rent_min: 1400, // untouched
      tour_process: 'keep me', // untouched
    });
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({ entityKey: 'units#unit-1', event_type: 'unit_updated' }),
    );
  });

  it('404s an unknown unit and writes no audit event', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .patch('/api/units/nope')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ status: 'placed' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unit_not_found' });
    expect(world.auditEvents).toHaveLength(0);
  });

  it('rejects an empty patch and unknown fields with 400', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    for (const body of [{}, { bogus: 1 }, { beds: -1 }]) {
      const res = await request(app)
        .patch('/api/units/unit-1')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('units routes stay behind requireAuth', () => {
  it('403s without the origin secret and 401s without a session', async () => {
    const { app } = makeWebhookHarness();
    // No origin secret → origin-secret validator 403 (locked chain stage 2).
    expect((await request(app).get('/api/units')).status).toBe(403);
    // Origin secret but no session cookie → requireAuth rejects.
    const noSession = await request(app).get('/api/units').set('x-origin-verify', SECRET);
    expect(noSession.status).toBe(401);
  });
});
