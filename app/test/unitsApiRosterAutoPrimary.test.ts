// caseworker-integrity (spec 2026-10-12 revision 4, section 4 "Contact list
// (I4)", paragraph "Auto-primary", Cameron 2026-10-12) through
// POST /api/units/:id/contacts on the FakeWorld harness: the same cases (a)-(d),
// (f), (g) and (i) as unitsRepoAutoPrimary.integration.test.ts runs on the real repo,
// which is what proves the FakeWorld UnitsRepo fake mirrors the real
// addContact. The body says `primaryContact: false`, exactly as the dashboard's
// "+ Add contact" posts it; the answer's roster carries the new primary. The
// contacts are typed landlord unless a case says otherwise: since revision 5
// (Cameron's Q4) only a landlord-typed contact is auto-promoted - case (g).
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

  // Q4 (Cameron 2026-10-12, spec revision 5): auto-primary applies only to a
  // contact typed landlord. A contact of any other type added to an ownerless,
  // primary-less property joins the list NON-primary; the landlord-typed PM
  // added next to the same property is still made its primary contact.
  const NOT_LANDLORDS: Array<[string, Partial<ContactItem>]> = [
    ['tenant', { type: 'tenant' }],
    ['partner who is not a caseworker', { type: 'partner', role: 'Navigator' }],
    ['unknown contact', { type: 'unknown' }],
    ['team member', { type: 'team_member' }],
  ];
  it.each(NOT_LANDLORDS)(
    '(g) a %s added to an ownerless no-primary property joins NON-primary; a landlord-typed PM added next is the primary contact',
    async (_kind, fields) => {
      const { app, world } = makeWebhookHarness();
      seedOwnerlessUnit(world, 'u-g', { contacts: [] });
      seedContact(world, 'c-not-ll', fields);
      seedContact(world, 'c-pm', { firstName: 'Pat', lastName: 'Manager' });

      const res = await addContact(app, 'u-g', { contactId: 'c-not-ll', role: 'other', primaryContact: false });

      expect(res.status).toBe(200);
      const rows = res.body.unit.contacts as WireRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ contactId: 'c-not-ll', role: 'other', primaryContact: false });
      expect(res.body.unit.primary_contact).toBeUndefined();
      expect(world.units.get('u-g')?.primary_contact).toBeUndefined();

      const pm = await addContact(app, 'u-g', { contactId: 'c-pm', role: 'pm', primaryContact: false });

      expect(pm.status).toBe(200);
      expect(primaries(pm.body.unit.contacts as WireRow[])).toEqual(['c-pm']);
      expect(world.units.get('u-g')?.primary_contact).toBe('c-pm');
    },
  );

  // Spec revision 6 section 4 "Contact list (I4)" (final review A4; fix wave
  // FWF-3): auto-primary follows the ONE automatic-routing eligibility rule
  // the restore's hand-off uses (the earliest-added eligible contact takes
  // over, primary-contact-integrity spec 4.3 / 4.6) - typed landlord, not
  // soft-deleted, not a routing pointer. A soft-deleted contact still exists
  // and can be added, but a soft-deleted landlord-typed contact joins
  // NON-primary; the I3 claim still asks only the type, so its Landlord-role
  // add still claims the vacant slot.
  it.each(['pm', 'landlord'] as const)(
    '(i) a SOFT-DELETED contact typed landlord added as %s to an ownerless no-primary property joins NON-primary',
    async (role) => {
      const { app, world } = makeWebhookHarness();
      seedOwnerlessUnit(world, 'u-i', { contacts: [] });
      seedContact(world, 'c-gone', { deleted_at: STAMP });

      const res = await addContact(app, 'u-i', { contactId: 'c-gone', role, primaryContact: false });

      expect(res.status).toBe(200);
      const rows = res.body.unit.contacts as WireRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ contactId: 'c-gone', role, primaryContact: false });
      expect(res.body.unit.primary_contact).toBeUndefined();
      expect(world.units.get('u-i')?.primary_contact).toBeUndefined();
      expect(hasLandlordId(world.units.get('u-i'))).toBe(role === 'landlord');
    },
  );

  // R2 code review finding A1 (fix wave 2 FW2-2): the unit_contact_added audit
  // row records the EFFECTIVE primary flag, read from the written unit - the
  // request's flag is false on every dashboard add - plus autoPrimary: true
  // when the rule, not the request, made the contact primary.
  const contactAddedPayloads = (world: FakeWorld) =>
    world.auditEvents.filter((e) => e.event_type === 'unit_contact_added').map((e) => e.payload);

  it('(h) the audit row of an auto-primary add says primary, and autoPrimary', async () => {
    const { app, world } = makeWebhookHarness();
    seedOwnerlessUnit(world, 'u-h');
    seedContact(world, 'c-pm');

    const res = await addContact(app, 'u-h', { contactId: 'c-pm', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    const payloads = contactAddedPayloads(world);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ contactId: 'c-pm', role: 'pm', primaryContact: true, autoPrimary: true });
  });

  it('(h2) (PIN) a requested primary is audited primary without autoPrimary; a non-primary add is audited not primary', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-h2', {
      contacts: [{ contactId: 'c-ll', role: 'landlord', primaryContact: true }],
      primary_contact: 'c-ll',
    });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-pm');
    seedContact(world, 'c-owner');

    expect((await addContact(app, 'u-h2', { contactId: 'c-pm', role: 'pm', primaryContact: true })).status).toBe(200);
    expect((await addContact(app, 'u-h2', { contactId: 'c-owner', role: 'owner', primaryContact: false })).status).toBe(
      200,
    );

    const [requested, plain] = contactAddedPayloads(world);
    expect(requested).toMatchObject({ contactId: 'c-pm', primaryContact: true });
    expect(requested).not.toHaveProperty('autoPrimary');
    expect(plain).toMatchObject({ contactId: 'c-owner', primaryContact: false });
    expect(plain).not.toHaveProperty('autoPrimary');
  });

  // primary-contact-integrity plan contract 2.4 (code review R1 finding L2):
  // unit_primary_contact_assigned records an AUTOMATIC pick only - an explicit
  // Make primary stays unit_contact_added, as before. The no-primary box's
  // "Make <Name> primary" (spec 7.4) sends this same write, and on this shape
  // the rule would have promoted the contact too, so only the request's own
  // flag tells the two apart.
  it('(h3) (PIN) an explicit Make primary on an ownerless no-primary list appends unit_contact_added only - no unit_primary_contact_assigned', async () => {
    const { app, world } = makeWebhookHarness();
    seedOwnerlessUnit(world, 'u-h3', { contacts: [{ contactId: 'c-seated', role: 'pm', primaryContact: false }] });
    seedContact(world, 'c-seated');

    const res = await addContact(app, 'u-h3', { contactId: 'c-seated', role: 'pm', primaryContact: true });

    expect(res.status).toBe(200);
    expect(primaries(res.body.unit.contacts as WireRow[])).toEqual(['c-seated']);
    expect(world.units.get('u-h3')?.primary_contact).toBe('c-seated');
    const payloads = contactAddedPayloads(world);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ contactId: 'c-seated', primaryContact: true });
    expect(payloads[0]).not.toHaveProperty('autoPrimary');
    expect(world.auditEvents.filter((e) => e.event_type === 'unit_primary_contact_assigned')).toEqual([]);
  });

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

  // primary-contact-integrity spec 4.4 (Cameron 2026-10-13) REPLACES the old
  // pin "an upsert does NOT become primary": an edit of the contact's own row
  // counts like an add - the edited contact becomes the primary and the
  // promotion is audited auto_on_add.
  it.each([
    ['a role edit', 'owner'],
    ['a role edit that claims the vacant landlord slot', 'landlord'],
  ] as const)(
    '(f) an edit of a contact already on an ownerless no-primary list (%s, primaryContact false) makes THAT contact the primary',
    async (_kind, role) => {
      const { app, world } = makeWebhookHarness();
      seedOwnerlessUnit(world, 'u-f', { contacts: [{ contactId: 'c-seated', role: 'pm', primaryContact: false }] });
      seedContact(world, 'c-seated');

      const res = await addContact(app, 'u-f', { contactId: 'c-seated', role, primaryContact: false });

      expect(res.status).toBe(200);
      const rows = res.body.unit.contacts as WireRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ contactId: 'c-seated', role, primaryContact: true });
      expect(res.body.unit.primary_contact).toBe('c-seated');
      expect(world.units.get('u-f')?.primary_contact).toBe('c-seated');
      // The landlord-role edit also claims the vacant slot (unchanged).
      expect(hasLandlordId(world.units.get('u-f'))).toBe(role === 'landlord');
      expect(
        world.auditEvents
          .filter((e) => e.event_type === 'unit_primary_contact_assigned')
          .map((e) => e.payload),
      ).toEqual([expect.objectContaining({ contactId: 'c-seated', reason: 'auto_on_add' })]);
    },
  );
});
