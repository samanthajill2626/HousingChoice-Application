// caseworker-integrity (spec 2026-10-12 section 4 "Landlord of record (I3)"
// and "Contact list (I4)"): POST /api/units/:id/contacts refuses a caseworker
// taking a NEW contact-list seat (409 contact_list_caseworker, any role) and a
// role-landlord add that CLAIMS the vacant landlord slot with a contact not
// typed landlord (409 landlord_not_landlord) - in that order, before the repo
// call; the repo's own 409 landlord_reassignment_required follows. Existing
// seats, re-asserting the owner, and other contact types stay allowed.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { emailRefId, phoneRefId, type ContactItem } from '../src/repos/contactsRepo.js';
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

  it('(PIN) decides from CONSISTENT reads of the unit and the contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    seedContact(world, 'c-owner', { type: 'landlord' });
    seedContact(world, 'c-ten', { type: 'tenant' });
    const unitRead = vi.spyOn(world.unitsRepo, 'getById');
    const contactRead = vi.spyOn(world.contactsRepo, 'getById');
    const res = await addContact(app, 'u-1', { contactId: 'c-ten', role: 'other' });
    expect(res.status).toBe(200);
    expect(unitRead).toHaveBeenCalledWith('u-1', { consistentRead: true });
    expect(contactRead).toHaveBeenCalledWith('c-ten', { consistentRead: true });
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

// R2 code review finding A3 / challenge B-4 (fix wave 2 item FW2-3): a
// contacts ROUTING POINTER row (phone_ref / email_ref - a routing record,
// never a contact; FW-5's class) named as the contact to add is not found -
// 404 contact_not_found, never a landlord claim's 409 and never a seat.
const POINTERS: Array<[string, Record<string, unknown>]> = [
  [
    'phone',
    { contactId: phoneRefId('+15550003000'), phone: '+15550003000', phone_ref: true, phone_ref_owner: 'c-owner' },
  ],
  [
    'email',
    {
      contactId: emailRefId('owner@example.com'),
      email: 'owner@example.com',
      email_ref: true,
      email_ref_owner: 'c-owner',
    },
  ],
];

describe('contact list - a routing pointer row is not a contact', () => {
  function seedPointer(world: FakeWorld, pointer: Record<string, unknown>): void {
    seedContact(world, 'c-owner', { type: 'landlord', phone: '+15550003000', email: 'owner@example.com' });
    world.contacts.push(pointer as unknown as ContactItem);
  }

  it.each(POINTERS)(
    'a %s pointer added with role landlord to an ownerless unit: 404 contact_not_found (not 409) - the slot stays vacant',
    async (_kind, pointer) => {
      const { app, world } = makeWebhookHarness();
      seedOwnerlessUnit(world, 'u-vacant');
      seedPointer(world, pointer);
      const res = await addContact(app, 'u-vacant', { contactId: pointer['contactId'], role: 'landlord' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'contact_not_found' });
      expect(hasLandlordId(world.units.get('u-vacant'))).toBe(false);
      expect(world.units.get('u-vacant')?.contacts).toBeUndefined();
      expect(world.auditEvents).toHaveLength(0);
    },
  );

  it.each(POINTERS)(
    'a %s pointer added with role pm: 404 contact_not_found - nothing seated',
    async (_kind, pointer) => {
      const { app, world } = makeWebhookHarness();
      seedOwnerlessUnit(world, 'u-vacant');
      seedPointer(world, pointer);
      const res = await addContact(app, 'u-vacant', { contactId: pointer['contactId'], role: 'pm' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'contact_not_found' });
      expect(world.units.get('u-vacant')?.contacts).toBeUndefined();
      expect(world.units.get('u-vacant')?.primary_contact).toBeUndefined();
      expect(world.auditEvents).toHaveLength(0);
    },
  );
});

// R1 code review backend finding 1, R2 challenge B-1 (fix wave 2 item FW2-1):
// the checks above decide from the route's own consistent reads; a property
// change landing between those reads and the roster write is re-decided
// inside unitsRepo.addContact, per attempt, from the facts the route read
// about the contact - the same 409s, nothing written. Each race is injected
// right after the route's reads (the R2 review's two probes).
describe('contact list - a property change after the route read is re-decided in the roster write', () => {
  it('I4: a caseworker whose seat is removed after the route read is not re-seated - 409 contact_list_caseworker, nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    // Ownerless and primary-less, so a re-created seat would also have become
    // the primary contact (R2 finding A6).
    seedOwnerlessUnit(world, 'u-race', { contacts: [{ contactId: 'c-cw', role: 'other', primaryContact: false }] });
    seedContact(world, 'c-cw', CASEWORKER);
    const write = world.unitsRepo.addContact.bind(world.unitsRepo);
    world.unitsRepo.addContact = async (unitId, contact, facts) => {
      // Staff B removes the seat after the route's reads, before this write.
      await world.unitsRepo.removeContact(unitId, 'c-cw');
      return write(unitId, contact, facts);
    };
    // The role edit the dashboard sends for a seated row.
    const res = await addContact(app, 'u-race', { contactId: 'c-cw', role: 'pm', primaryContact: false });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_list_caseworker' });
    const stored = world.units.get('u-race');
    expect(stored?.contacts).toEqual([]);
    expect(stored?.primary_contact).toBeUndefined();
    expect(hasLandlordId(stored)).toBe(false);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('I3: the landlord of record cleared after the route read - a tenant landlord-role add does not claim the slot - 409 landlord_not_landlord', async () => {
    const { app, world } = makeWebhookHarness();
    // Soft-deleted; its landlord of record c-old (the primary) was re-typed to tenant.
    seedUnit(world, 'u-race', {
      landlordId: 'c-old',
      primary_contact: 'c-old',
      contacts: [{ contactId: 'c-old', role: 'landlord', primaryContact: true }],
      deleted_at: STAMP,
    });
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-ten', { type: 'tenant' });
    const write = world.unitsRepo.addContact.bind(world.unitsRepo);
    world.unitsRepo.addContact = async (unitId, contact, facts) => {
      // Staff B's "Restore without a landlord" commits after the route's reads
      // (which saw an owner, so this add was no claim there).
      await world.unitsRepo.restoreWithLandlord(unitId, { expectLandlordId: 'c-old', next: null });
      return write(unitId, contact, facts);
    };
    const res = await addContact(app, 'u-race', { contactId: 'c-ten', role: 'landlord' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'landlord_not_landlord' });
    const stored = world.units.get('u-race');
    // B's restore stands; the landlord slot stays vacant and c-ten is not seated.
    expect(stored?.deleted_at).toBeUndefined();
    expect(hasLandlordId(stored)).toBe(false);
    expect(stored?.contacts).toEqual([]);
    expect(stored?.primary_contact).toBeUndefined();
    expect(world.auditEvents).toHaveLength(0);
  });
});
