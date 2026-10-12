// caseworker-integrity (spec 2026-10-12 revision 4, section 4 "Contact list
// (I4)", paragraph "Auto-primary", Cameron 2026-10-12) through
// POST /api/units/:id/contacts on the FakeWorld harness: the same cases (a)-(d)
// and (f) as unitsRepoAutoPrimary.integration.test.ts runs on the real repo,
// which is what proves the FakeWorld UnitsRepo fake mirrors the real
// addContact. The body says `primaryContact: false`, exactly as the dashboard's
// "+ Add contact" posts it; the answer's roster carries the new primary.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const STAMP = '2026-10-12T09:00:00.000Z';

function seedUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): UnitItem {
  const item: UnitItem = {
    unitId,
    landlordId: 'c-ll',
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
  world.units.set(unitId, item);
  return item;
}

/** An OWNERLESS unit: no landlordId attribute at all (the repo's vacant slot). */
function seedOwnerlessUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): UnitItem {
  const item = seedUnit(world, unitId, overrides);
  delete (item as Partial<UnitItem>).landlordId;
  return item;
}

/** A contact typed `landlord` unless overridden (a property manager is a
 *  landlord-typed contact; the ROLE is what the contact-list row carries). */
function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'landlord', ...fields } as ContactItem);
}

function addContact(app: import('express').Express, unitId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/units/${unitId}/contacts`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

type WireRow = Record<string, unknown>;

/** The contactIds of the answer's rows marked primary. */
const primaries = (rows: WireRow[]): unknown[] =>
  rows.filter((row) => row['primaryContact'] === true).map((row) => row['contactId']);

const hasLandlordId = (unit: UnitItem | undefined): boolean =>
  unit !== undefined && Object.prototype.hasOwnProperty.call(unit, 'landlordId');

const SHAPES: Array<[string, Partial<UnitItem>]> = [
  ['no stored contact list', {}],
  ['an empty contact list (restored without a landlord)', { contacts: [] }],
  ['a contact list with no primary row', { contacts: [{ contactId: 'c-owner-row', role: 'owner', primaryContact: false }] }],
  [
    'only a stale primary_contact scalar (no row marked primary)',
    { contacts: [{ contactId: 'c-owner-row', role: 'owner', primaryContact: false }], primary_contact: 'c-gone' },
  ],
];

describe('POST /api/units/:id/contacts - auto-primary (spec revision 4 section 4)', () => {
  it.each(SHAPES)(
    '(a) ownerless with %s: an added PM becomes the primary contact and primary_contact names it',
    async (_shape, overrides) => {
      const { app, world } = makeWebhookHarness();
      seedOwnerlessUnit(world, 'u-a', overrides);
      seedContact(world, 'c-pm', { firstName: 'Pat', lastName: 'Manager' });

      const res = await addContact(app, 'u-a', { contactId: 'c-pm', role: 'pm', primaryContact: false });

      expect(res.status).toBe(200);
      const rows = res.body.unit.contacts as WireRow[];
      expect(rows.find((row) => row['contactId'] === 'c-pm')).toMatchObject({
        role: 'pm',
        primaryContact: true,
        name: 'Pat Manager',
      });
      expect(primaries(rows)).toEqual(['c-pm']);
      expect(res.body.unit.primary_contact).toBe('c-pm');
      const stored = world.units.get('u-a');
      expect(stored?.primary_contact).toBe('c-pm');
      // A PM never claims the landlord-of-record slot.
      expect(hasLandlordId(stored)).toBe(false);
    },
  );

  it.each(['owner', 'other'] as const)(
    '(a) whatever its role: an added %s on an ownerless no-primary property becomes the primary contact',
    async (role) => {
      const { app, world } = makeWebhookHarness();
      seedOwnerlessUnit(world, 'u-a');
      seedContact(world, 'c-new');

      const res = await addContact(app, 'u-a', { contactId: 'c-new', role, primaryContact: false });

      expect(res.status).toBe(200);
      expect(primaries(res.body.unit.contacts as WireRow[])).toEqual(['c-new']);
      expect(world.units.get('u-a')?.primary_contact).toBe('c-new');
    },
  );

  it('(b) a landlord of record and no primary row: an added PM is NOT the primary contact and primary_contact stays unset', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-b', { contacts: [{ contactId: 'c-ll', role: 'landlord', primaryContact: false }] });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-pm');

    const res = await addContact(app, 'u-b', { contactId: 'c-pm', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    const rows = res.body.unit.contacts as WireRow[];
    expect(rows.find((row) => row['contactId'] === 'c-pm')).toMatchObject({ role: 'pm', primaryContact: false });
    expect(primaries(rows)).toEqual([]);
    expect(res.body.unit.primary_contact).toBeUndefined();
    expect(world.units.get('u-b')?.primary_contact).toBeUndefined();
    expect(world.units.get('u-b')?.landlordId).toBe('c-ll');
  });

  it('(c) ownerless WITH a primary row: the add is not primary and the existing primary is unchanged', async () => {
    const { app, world } = makeWebhookHarness();
    seedOwnerlessUnit(world, 'u-c', {
      contacts: [{ contactId: 'c-first', role: 'pm', primaryContact: true }],
      primary_contact: 'c-first',
    });
    seedContact(world, 'c-first');
    seedContact(world, 'c-second');

    const res = await addContact(app, 'u-c', { contactId: 'c-second', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    expect(primaries(res.body.unit.contacts as WireRow[])).toEqual(['c-first']);
    expect(res.body.unit.primary_contact).toBe('c-first');
    expect(world.units.get('u-c')?.primary_contact).toBe('c-first');
  });

  it('(d) ownerless, no primary: a Landlord-role add claims landlordId AND becomes the primary contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedOwnerlessUnit(world, 'u-d');
    seedContact(world, 'c-new-ll');

    const res = await addContact(app, 'u-d', { contactId: 'c-new-ll', role: 'landlord', primaryContact: false });

    expect(res.status).toBe(200);
    expect(res.body.unit.landlordId).toBe('c-new-ll');
    const rows = res.body.unit.contacts as WireRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contactId: 'c-new-ll', role: 'landlord', primaryContact: true });
    expect(res.body.unit.primary_contact).toBe('c-new-ll');
    expect(world.units.get('u-d')?.landlordId).toBe('c-new-ll');
    expect(world.units.get('u-d')?.primary_contact).toBe('c-new-ll');
  });

  it.each([
    ['a role edit', 'owner'],
    ['a role edit that claims the vacant landlord slot', 'landlord'],
  ] as const)(
    '(f) (PIN) an upsert of a contact already on an ownerless no-primary list (%s, primaryContact false) does NOT become primary',
    async (_kind, role) => {
      const { app, world } = makeWebhookHarness();
      seedOwnerlessUnit(world, 'u-f', { contacts: [{ contactId: 'c-seated', role: 'pm', primaryContact: false }] });
      seedContact(world, 'c-seated');

      const res = await addContact(app, 'u-f', { contactId: 'c-seated', role, primaryContact: false });

      expect(res.status).toBe(200);
      const rows = res.body.unit.contacts as WireRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ contactId: 'c-seated', role, primaryContact: false });
      expect(res.body.unit.primary_contact).toBeUndefined();
      expect(world.units.get('u-f')?.primary_contact).toBeUndefined();
      // The landlord-role edit still claims the vacant slot (today's behavior).
      expect(hasLandlordId(world.units.get('u-f'))).toBe(role === 'landlord');
    },
  );
});
