// caseworker-integrity (spec 2026-10-12 section 4 "Landlord of record (I3)"
// and "Contact list (I4)"): POST /api/units/:id/contacts refuses a caseworker
// taking a NEW contact-list seat (409 contact_list_caseworker, any role) and a
// role-landlord add that CLAIMS the vacant landlord slot with a contact not
// typed landlord (409 landlord_not_landlord) - in that order, before the repo
// call; the repo's own 409 landlord_reassignment_required follows. Existing
// seats, re-asserting the owner, and other contact types stay allowed.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const STAMP = '2026-10-12T09:00:00.000Z';

const CASEWORKER: Partial<ContactItem> = {
  type: 'partner',
  role: 'Caseworker',
  firstName: 'Casey',
  lastName: 'Worker',
};

/** Non-landlord kinds that are NOT caseworkers (a caseworker hits I4 first). */
const NON_LANDLORDS: Array<[string, Partial<ContactItem>]> = [
  ['tenant', { type: 'tenant' }],
  ['partner', { type: 'partner', role: 'Navigator' }],
  ['unknown', { type: 'unknown' }],
  ['team member', { type: 'team_member' }],
];

function seedUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): UnitItem {
  const item: UnitItem = {
    unitId,
    landlordId: 'c-owner',
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
  world.units.set(unitId, item);
  return item;
}

/** A legacy OWNERLESS unit: no landlordId attribute at all (the repo's vacant slot). */
function seedOwnerlessUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): UnitItem {
  const item = seedUnit(world, unitId, overrides);
  delete (item as Partial<UnitItem>).landlordId;
  return item;
}

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId, ...fields } as ContactItem);
}

function addContact(app: import('express').Express, unitId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/units/${unitId}/contacts`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

const hasLandlordId = (unit: UnitItem | undefined): boolean =>
  unit !== undefined && Object.prototype.hasOwnProperty.call(unit, 'landlordId');

describe('contact list - a caseworker never takes a NEW seat (I4)', () => {
  it.each(['pm', 'owner', 'other', 'landlord'] as const)(
    '409s contact_list_caseworker for role %s - roster unchanged, no audit row',
    async (role) => {
      const { app, world } = makeWebhookHarness();
      seedUnit(world, 'u-1');
      seedContact(world, 'c-owner', { type: 'landlord' });
      seedContact(world, 'c-cw', CASEWORKER);
      const res = await addContact(app, 'u-1', { contactId: 'c-cw', role });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'contact_list_caseworker' });
      expect(world.units.get('u-1')?.contacts).toBeUndefined();
      expect(world.auditEvents).toHaveLength(0);
    },
  );

  it('the caseworker refusal comes before the landlord-claim refusal on a vacant slot', async () => {
    const { app, world } = makeWebhookHarness();
    seedOwnerlessUnit(world, 'u-vacant');
    seedContact(world, 'c-cw', CASEWORKER);
    const res = await addContact(app, 'u-vacant', { contactId: 'c-cw', role: 'landlord' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_list_caseworker' });
    expect(hasLandlordId(world.units.get('u-vacant'))).toBe(false);
  });

  it('(PIN) a caseworker who already holds a seat can still be re-roled and made primary (L2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-seated', {
      primary_contact: 'c-owner',
      contacts: [
        { contactId: 'c-owner', role: 'landlord', primaryContact: true },
        { contactId: 'c-cw', role: 'other', primaryContact: false },
      ],
    });
    seedContact(world, 'c-owner', { type: 'landlord' });
    seedContact(world, 'c-cw', CASEWORKER);
    const res = await addContact(app, 'u-seated', { contactId: 'c-cw', role: 'pm', primaryContact: true });
    expect(res.status).toBe(200);
    expect(world.units.get('u-seated')?.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-cw', role: 'pm', primaryContact: true }),
    );
  });

  it('(PIN) other non-landlord types still take a new seat', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    seedContact(world, 'c-owner', { type: 'landlord' });
    seedContact(world, 'c-ten', { type: 'tenant' });
    seedContact(world, 'c-nav', { type: 'partner', role: 'Navigator' });
    expect((await addContact(app, 'u-1', { contactId: 'c-ten', role: 'other' })).status).toBe(200);
    expect((await addContact(app, 'u-1', { contactId: 'c-nav', role: 'pm' })).status).toBe(200);
  });
});

describe('contact list - a role-landlord add that CLAIMS the vacant slot needs a landlord (I3)', () => {
  it.each(NON_LANDLORDS)(
    '409s landlord_not_landlord for a %s - the slot stays vacant, no audit row',
    async (_kind, fields) => {
      const { app, world } = makeWebhookHarness();
      seedOwnerlessUnit(world, 'u-vacant');
      seedContact(world, 'c-other', fields);
      const res = await addContact(app, 'u-vacant', { contactId: 'c-other', role: 'landlord' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'landlord_not_landlord' });
      expect(hasLandlordId(world.units.get('u-vacant'))).toBe(false);
      expect(world.auditEvents).toHaveLength(0);
    },
  );

  it('a SEATED caseworker re-roled to landlord on a vacant slot gets the landlord refusal', async () => {
    const { app, world } = makeWebhookHarness();
    seedOwnerlessUnit(world, 'u-vacant', {
      contacts: [{ contactId: 'c-cw', role: 'other', primaryContact: false }],
    });
    seedContact(world, 'c-cw', CASEWORKER);
    const res = await addContact(app, 'u-vacant', { contactId: 'c-cw', role: 'landlord' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'landlord_not_landlord' });
    expect(hasLandlordId(world.units.get('u-vacant'))).toBe(false);
    expect(world.units.get('u-vacant')?.contacts).toEqual([
      { contactId: 'c-cw', role: 'other', primaryContact: false },
    ]);
  });

  it('(PIN) a landlord claims the vacant slot', async () => {
    const { app, world } = makeWebhookHarness();
    seedOwnerlessUnit(world, 'u-vacant');
    seedContact(world, 'c-ll', { type: 'landlord' });
    const res = await addContact(app, 'u-vacant', { contactId: 'c-ll', role: 'landlord' });
    expect(res.status).toBe(200);
    expect(world.units.get('u-vacant')?.landlordId).toBe('c-ll');
  });

  it('(PIN) re-asserting the existing owner is not checked, even when the owner is no longer a landlord (L2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    seedContact(world, 'c-owner', { type: 'tenant' });
    const res = await addContact(app, 'u-1', { contactId: 'c-owner', role: 'landlord', primaryContact: true });
    expect(res.status).toBe(200);
    expect(world.units.get('u-1')?.landlordId).toBe('c-owner');
  });

  it('(PIN) a non-landlord landlord-role add on an OWNED unit is the repo reassignment refusal, not a claim', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    seedContact(world, 'c-ten', { type: 'tenant' });
    const res = await addContact(app, 'u-1', { contactId: 'c-ten', role: 'landlord' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'landlord_reassignment_required' });
  });

  it('(PIN) a non-landlord with a non-landlord role on an ownerless unit is not a claim', async () => {
    const { app, world } = makeWebhookHarness();
    seedOwnerlessUnit(world, 'u-vacant');
    seedContact(world, 'c-ten', { type: 'tenant' });
    const res = await addContact(app, 'u-vacant', { contactId: 'c-ten', role: 'pm' });
    expect(res.status).toBe(200);
    expect(hasLandlordId(world.units.get('u-vacant'))).toBe(false);
  });
});
