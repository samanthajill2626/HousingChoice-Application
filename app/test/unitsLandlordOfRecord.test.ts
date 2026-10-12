// caseworker-integrity I3 (spec 2026-10-12 section 4, "Landlord of record"):
// POST /api/units, and a PATCH that CHANGES landlordId, need the landlordId to
// name a contact typed `landlord` (a property manager is a landlord with a
// role) - 404 landlord_not_found when the contact is missing, 409
// landlord_not_landlord otherwise. Runs on the shared in-memory world.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { phoneRefId, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId, ...fields } as ContactItem);
}

function postUnit(app: import('express').Express, body: Record<string, unknown>) {
  return request(app)
    .post('/api/units')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

/** Every contact kind that is NOT a landlord (a caseworker is a partner with the role). */
const NON_LANDLORDS: Array<[string, Partial<ContactItem>]> = [
  ['tenant', { type: 'tenant' }],
  ['partner', { type: 'partner', role: 'Navigator' }],
  ['caseworker', { type: 'partner', role: 'Caseworker' }],
  ['unknown', { type: 'unknown' }],
  ['team member', { type: 'team_member' }],
];

describe('POST /api/units - the landlordId must name a landlord (I3)', () => {
  it('(PIN) creates the unit when landlordId names a landlord, a property manager included', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-ll', { type: 'landlord' });
    seedContact(world, 'c-pm', { type: 'landlord', role: 'Property manager' });
    for (const landlordId of ['c-ll', 'c-pm']) {
      const res = await postUnit(app, { landlordId });
      expect(res.status, landlordId).toBe(201);
      expect(res.body.unit.landlordId).toBe(landlordId);
    }
  });

  it('404s landlord_not_found when no such contact exists - nothing created, no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await postUnit(app, { landlordId: 'c-ghost' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'landlord_not_found' });
    expect(world.units.size).toBe(0);
    expect(world.auditEvents).toHaveLength(0);
  });

  it.each(NON_LANDLORDS)(
    '409s landlord_not_landlord for a %s - nothing created, no audit row',
    async (_kind, fields) => {
      const { app, world } = makeWebhookHarness();
      seedContact(world, 'c-other', fields);
      const res = await postUnit(app, { landlordId: 'c-other' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'landlord_not_landlord' });
      expect(world.units.size).toBe(0);
      expect(world.auditEvents).toHaveLength(0);
    },
  );

  // R1 code review, backend finding 6: a contacts ROUTING POINTER row (here a
  // phone pointer, stored with no type) is a routing record, never a contact -
  // naming one as the landlord is not found, not landlord_not_landlord.
  it('404s landlord_not_found for a phone pointer row - nothing created, no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-ll', { type: 'landlord', phone: '+15550001111' });
    const pointerId = phoneRefId('+15550001111');
    world.contacts.push({
      contactId: pointerId,
      phone: '+15550001111',
      phone_ref: true,
      phone_ref_owner: 'c-ll',
    } as unknown as ContactItem);
    const res = await postUnit(app, { landlordId: pointerId });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'landlord_not_found' });
    expect(world.units.size).toBe(0);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('(PIN) the validator 400 and the org-list 422 still come first', async () => {
    const { app } = makeWebhookHarness();
    const bad = await postUnit(app, { landlordId: 'c-ghost', beds: 'three' });
    expect(bad.status).toBe(400);
    const offList = await postUnit(app, { landlordId: 'c-ghost', accepted_authorities: ['Step Up'] });
    expect(offList.status).toBe(422);
    expect(offList.body.error).toBe('org_not_on_list');
  });
});

const STAMP = '2026-10-12T09:00:00.000Z';

function seedUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): void {
  world.units.set(unitId, {
    unitId,
    landlordId: 'c-ll',
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  });
}

function patchUnit(app: import('express').Express, unitId: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/units/${unitId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

describe('PATCH /api/units/:id - a CHANGED landlordId must name a landlord (I3)', () => {
  it('(PIN) moves the property to another landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    seedContact(world, 'c-ll', { type: 'landlord' });
    seedContact(world, 'c-ll-2', { type: 'landlord' });
    const res = await patchUnit(app, 'u-1', { landlordId: 'c-ll-2' });
    expect(res.status).toBe(200);
    expect(world.units.get('u-1')?.landlordId).toBe('c-ll-2');
  });

  it('404s landlord_not_found for a missing contact - unit unchanged, no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    const res = await patchUnit(app, 'u-1', { landlordId: 'c-ghost' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'landlord_not_found' });
    expect(world.units.get('u-1')?.landlordId).toBe('c-ll');
    expect(world.auditEvents).toHaveLength(0);
  });

  it.each(NON_LANDLORDS)(
    '409s landlord_not_landlord for a %s - unit unchanged, no audit row',
    async (_kind, fields) => {
      const { app, world } = makeWebhookHarness();
      seedUnit(world, 'u-1');
      seedContact(world, 'c-other', fields);
      const res = await patchUnit(app, 'u-1', { landlordId: 'c-other', beds: 3 });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'landlord_not_landlord' });
      expect(world.units.get('u-1')?.landlordId).toBe('c-ll');
      expect(world.units.get('u-1')?.beds).toBeUndefined();
      expect(world.auditEvents).toHaveLength(0);
    },
  );

  it('404s landlord_not_found for an empty landlordId', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    const res = await patchUnit(app, 'u-1', { landlordId: '' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'landlord_not_found' });
    expect(world.units.get('u-1')?.landlordId).toBe('c-ll');
  });

  it('(PIN) an UNCHANGED landlordId is not checked, even when the stored landlord is no longer a landlord (L2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    seedContact(world, 'c-ll', { type: 'tenant' });
    const res = await patchUnit(app, 'u-1', { landlordId: 'c-ll', beds: 3 });
    expect(res.status).toBe(200);
    expect(world.units.get('u-1')?.beds).toBe(3);
  });

  it('(PIN) a PATCH without landlordId never looks at the landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    const res = await patchUnit(app, 'u-1', { beds: 4 });
    expect(res.status).toBe(200);
    expect(world.units.get('u-1')?.beds).toBe(4);
  });

  it('(PIN) decides "changed" from a CONSISTENT unit read', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    seedContact(world, 'c-ll-2', { type: 'landlord' });
    const unitRead = vi.spyOn(world.unitsRepo, 'getById');
    const res = await patchUnit(app, 'u-1', { landlordId: 'c-ll-2' });
    expect(res.status).toBe(200);
    expect(unitRead).toHaveBeenCalledWith('u-1', { consistentRead: true });
  });

  it('(PIN) an unknown unit still 404s unit_not_found', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-ll', { type: 'landlord' });
    const res = await patchUnit(app, 'nope', { landlordId: 'c-ll' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unit_not_found' });
  });
});
