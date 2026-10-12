// caseworker-integrity I3 (spec 2026-10-12 section 4, "Landlord of record"):
// POST /api/units, and a PATCH that CHANGES landlordId, need the landlordId to
// name a contact typed `landlord` (a property manager is a landlord with a
// role) - 404 landlord_not_found when the contact is missing, 409
// landlord_not_landlord otherwise. Runs on the shared in-memory world.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
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

  it('(PIN) the validator 400 and the org-list 422 still come first', async () => {
    const { app } = makeWebhookHarness();
    const bad = await postUnit(app, { landlordId: 'c-ghost', beds: 'three' });
    expect(bad.status).toBe(400);
    const offList = await postUnit(app, { landlordId: 'c-ghost', accepted_authorities: ['Step Up'] });
    expect(offList.status).toBe(422);
    expect(offList.body.error).toBe('org_not_on_list');
  });
});
