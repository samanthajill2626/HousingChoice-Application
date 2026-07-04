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
  it('creates a unit, defaults status to setup, returns 201 + audits unit_created', async () => {
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
      status: 'setup',
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

  // Coverage (#6): a freshly-created listing must NOT be pinned with a
  // non-derived source on its precedence-gated status field. The initial
  // 'setup' is a baseline DERIVED status (§6/§7), so it is stamped source
  // 'derived' (a derivation-permitting value) — never 'manual', which would
  // block the first placement from ever driving the listing forward (§7/§8).
  it('stamps status_source to a derivation-PERMITTING value (derived, not manual)', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ landlordId: 'contact-ll-1' });
    expect(res.status).toBe(201);
    expect(res.body.unit.status).toBe('setup');
    expect(res.body.unit.status_source).toBe('derived');
    // And the stored item agrees (not just the response).
    expect(world.units.get(res.body.unit.unitId)!.status_source).toBe('derived');
  });

  it('rejects a missing landlordId, unknown fields, bad numbers, and bad status', async () => {
    const { app, world } = makeWebhookHarness();
    const bodies = [
      {}, // no landlordId
      { jurisdiction: 'DCA' }, // still no landlordId
      { landlordId: 'c', nope: 'x' }, // unknown field
      { landlordId: 'c', beds: 'three' }, // beds not a number
      { landlordId: 'c', rent_min: -5 }, // negative
      { landlordId: 'c', status: 'sold' }, // status is NOT CRUD-writable (§8) → unknown field 400
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

  it('accepts voucher_size_accepted (a stored number, distinct from beds) and GET returns it', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      // A 3bd unit that accepts a 2BR voucher — voucher_size_accepted ≠ beds.
      .send({ landlordId: 'contact-ll-1', beds: 3, voucher_size_accepted: 2 });
    expect(res.status).toBe(201);
    expect(res.body.unit.voucher_size_accepted).toBe(2);

    const got = await request(app)
      .get(`/api/units/${res.body.unit.unitId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(got.status).toBe(200);
    expect(got.body.unit.voucher_size_accepted).toBe(2);
  });

  it('rejects a non-number voucher_size_accepted with 400', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/units')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ landlordId: 'contact-ll-1', voucher_size_accepted: 'two' });
    expect(res.status).toBe(400);
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
    seedUnit(world, 'unit-2', { landlordId: 'll-A', status: 'occupied', jurisdiction: 'Fulton' });
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
      .send({ rent_max: 1900, area: 'East Point' });

    expect(res.status).toBe(200);
    expect(res.body.unit).toMatchObject({
      rent_max: 1900,
      area: 'East Point',
      beds: 2, // untouched
      rent_min: 1400, // untouched
      tour_process: 'keep me', // untouched
    });
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({ entityKey: 'units#unit-1', event_type: 'unit_updated' }),
    );
  });

  it('PATCH accepts voucher_size_accepted; GET returns it; a non-number is 400', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-vsa', { beds: 3 });

    const ok = await request(app)
      .patch('/api/units/unit-vsa')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ voucher_size_accepted: 2 });
    expect(ok.status).toBe(200);
    expect(ok.body.unit.voucher_size_accepted).toBe(2);
    expect(ok.body.unit.beds).toBe(3); // untouched — distinct from beds

    const got = await request(app)
      .get('/api/units/unit-vsa')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(got.body.unit.voucher_size_accepted).toBe(2);

    const bad = await request(app)
      .patch('/api/units/unit-vsa')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ voucher_size_accepted: 'two' });
    expect(bad.status).toBe(400);
  });

  it('REFUSES status via CRUD PATCH (§8: status routes through listing-status)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { status: 'available' });
    // status is not CRUD-writable — listing-status changes go through
    // PATCH /api/units/:unitId/listing-status.
    const res = await request(app)
      .patch('/api/units/unit-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ status: 'occupied' });
    expect(res.status).toBe(400);
    // The status is untouched.
    expect(world.units.get('unit-1')!.status).toBe('available');
  });

  it('PATCH accepts final_rent — recordable in place at rent acceptance (still also written by the acceptance move)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-fr', { status: 'available' });
    const ok = await request(app)
      .patch('/api/units/unit-fr')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ final_rent: 1875 });
    expect(ok.status).toBe(200);
    expect(ok.body.unit.final_rent).toBe(1875);
    // The 'number' kind still enforces finite & >= 0, so a non-number is 400.
    const bad = await request(app)
      .patch('/api/units/unit-fr')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ final_rent: 'lots' });
    expect(bad.status).toBe(400);
  });

  it('404s an unknown unit and writes no audit event', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .patch('/api/units/nope')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ rent_max: 1900 });
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

// REGRESSION (§7): a unit created via the ROUTE must remain DERIVATION-DRIVABLE.
// A prior fix stamped unit-create with status_source 'manual', which under the
// OLD source-precedence rule PERMANENTLY blocked the first placement from
// driving the listing forward — the listing stayed 'available'/'setup'
// (publicly shareable) while a placement actively progressed. Derivation gating
// is now STATE-based (2026-06-19 decision), so the source stamp no longer
// matters here — what matters is that 'setup' is a BASELINE state and thus
// derivation-eligible. The existing derivation tests create units via the REPO;
// this one drives the full ROUTE create + a real placement transition to prove
// the route-created listing derives forward (to under_application).
describe('REGRESSION: route-created unit derives forward on a placement transition', () => {
  it('unit created via POST /api/units derives to under_application (tenant → placing) when a placement enters Application', async () => {
    const { app, world } = makeWebhookHarness();
    const authedPost = (path: string, body: object) =>
      request(app).post(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);

    // 1) Create the unit via the ROUTE (this is the code path that stamps
    //    status_source — the thing under test). Starts 'setup'.
    const unitRes = await authedPost('/api/units', { landlordId: 'contact-ll-reg' });
    expect(unitRes.status).toBe(201);
    const unitId = unitRes.body.unit.unitId as string;
    expect(unitRes.body.unit.status).toBe('setup');

    // 2) Create the tenant via the ROUTE.
    const tenantRes = await authedPost('/api/contacts', { type: 'tenant', firstName: 'Reg', lastName: 'Tester' });
    expect(tenantRes.status).toBe(201);
    const tenantId = tenantRes.body.contact.contactId as string;

    // 3) Open a placement on (tenant, unit) via the ROUTE, at the first stage.
    const placementRes = await authedPost('/api/placements', { tenantId, unitId, stage: 'send_application' });
    expect(placementRes.status).toBe(201);
    const placementId = placementRes.body.placement.placementId as string;

    // Precondition: §7 derive-on-create now stamps the coarse statuses at CREATE
    // (the create-time 'setup' baseline is derivation-eligible and was NOT pinned,
    // so the create's derived write drives the listing forward immediately). This
    // is the latent-bug fix — a freshly created placement no longer leaves its
    // listing publicly shareable while the deal progresses.
    expect(world.units.get(unitId)!.status).toBe('under_application');

    // 4) A later stage transition (still within the Application phase) re-derives
    //    the SAME coarse statuses (a no-op on the listing, already
    //    under_application) — proving the create-time source stamp did not pin it.
    const txRes = await authedPost(`/api/placements/${placementId}/transition`, {
      toStage: 'awaiting_approval',
      source: 'manual',
    });
    expect(txRes.status).toBe(200);

    // 5) The derivation holds (the create-time source did NOT block it).
    const unit = await request(app)
      .get(`/api/units/${unitId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(unit.body.unit.status).toBe('under_application'); // would stay at the create value on the old 'manual' stamp
    expect(unit.body.unit.status_source).toBe('derived');

    const tenant = await request(app)
      .get(`/api/contacts/${tenantId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(tenant.body.contact.status).toBe('placing');
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
