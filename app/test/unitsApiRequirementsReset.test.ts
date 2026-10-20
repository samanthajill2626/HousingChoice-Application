// property requirements (spec 2026-10-20 D5): whenever a property's landlord
// of record CHANGES outside a PATCH - a restore onto another landlord or onto
// none (POST /api/units/:id/restore), or a roster claim of the vacant landlord
// slot (POST /api/units/:id/contacts) - its requirement_sources map is REMOVEd
// in the same write, so every item is never touched against the new
// landlord. A roster write that keeps the landlord leaves the map alone.
// Asserted on the HTTP response and on the stored unit.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { REQ_STAMP, seedContact, seedLandlord, seedUnit } from './helpers/requirementsFixtures.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const sources = (): Record<string, 'copied' | 'set_here'> => ({ pets: 'set_here', credit_requirements: 'copied' });

/** The unitsRestoreLandlord.test.ts shape: SOFT-DELETED, owned by c-old (the primary), c-pm a second row. */
const DELETED = {
  landlordId: 'c-old',
  primary_contact: 'c-old',
  contacts: [
    { contactId: 'c-old', role: 'landlord', primaryContact: true },
    { contactId: 'c-pm', role: 'pm', primaryContact: false },
  ],
  deleted_at: REQ_STAMP,
};

function post(app: import('express').Express, path: string, body?: Record<string, unknown>) {
  const req = request(app).post(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
  return body === undefined ? req : req.send(body);
}

describe('POST /api/units/:id/restore - a landlord change REMOVEs requirement_sources (D5)', () => {
  it('a restore onto another landlord REMOVEs the map - response and stored unit', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1', { ...DELETED, requirement_sources: sources() });
    seedContact(world, 'c-old', { type: 'tenant' });
    seedLandlord(world, 'c-new');
    const res = await post(app, '/api/units/u-1/restore', { landlordId: 'c-new' });
    expect(res.status).toBe(200);
    expect(res.body.unit.landlordId).toBe('c-new');
    expect(res.body.unit).not.toHaveProperty('requirement_sources');
    expect(world.units.get('u-1')).not.toHaveProperty('requirement_sources');
  });

  it('a restore onto NO landlord REMOVEs the map', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1', { ...DELETED, requirement_sources: sources() });
    seedContact(world, 'c-old', { type: 'tenant' });
    const res = await post(app, '/api/units/u-1/restore', { landlordId: null });
    expect(res.status).toBe(200);
    expect(res.body.unit).not.toHaveProperty('landlordId');
    expect(res.body.unit).not.toHaveProperty('requirement_sources');
    expect(world.units.get('u-1')).not.toHaveProperty('requirement_sources');
  });

  it('(PIN) a plain restore keeps the landlord and the map', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1', { ...DELETED, requirement_sources: sources() });
    seedLandlord(world, 'c-old');
    const res = await post(app, '/api/units/u-1/restore');
    expect(res.status).toBe(200);
    expect(res.body.unit.requirement_sources).toEqual(sources());
  });
});

describe('POST /api/units/:id/contacts - a landlord claim REMOVEs requirement_sources (D5)', () => {
  it('a roster claim of the vacant landlord slot REMOVEs the map - response and stored unit', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1', {
      landlordId: undefined,
      contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }],
      primary_contact: 'c-pm',
      requirement_sources: sources(),
    });
    seedLandlord(world, 'c-pm');
    seedLandlord(world, 'c-new');
    const res = await post(app, '/api/units/u-1/contacts', { contactId: 'c-new', role: 'landlord' });
    expect(res.status).toBe(200);
    expect(res.body.unit.landlordId).toBe('c-new');
    expect(res.body.unit).not.toHaveProperty('requirement_sources');
    expect(world.units.get('u-1')).not.toHaveProperty('requirement_sources');
  });

  it('(PIN) adding a row that is not a claim keeps the map', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1', {
      contacts: [{ contactId: 'c-ll', role: 'landlord', primaryContact: true }],
      primary_contact: 'c-ll',
      requirement_sources: sources(),
    });
    seedLandlord(world, 'c-ll');
    seedLandlord(world, 'c-pm');
    const res = await post(app, '/api/units/u-1/contacts', { contactId: 'c-pm', role: 'pm' });
    expect(res.status).toBe(200);
    expect(res.body.unit.requirement_sources).toEqual(sources());
  });
});
