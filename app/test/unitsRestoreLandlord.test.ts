// caseworker-integrity (spec 2026-10-12 section 4 "Restore", Cameron
// 2026-10-12): POST /api/units/:id/restore never brings a property back with a
// landlord of record that is not typed `landlord`, and never dead-ends.
//   - plain (no landlordId in the body): ownerless or a valid landlord ->
//     restore as before; otherwise 409 restore_needs_landlord { landlordName? }
//     and nothing is written;
//   - { landlordId: <id> } / { landlordId: null }: honored only when the plain
//     restore would refuse - swap or clear the landlord in one write;
//   - the unit_restored audit gains landlordReplaced / landlordCleared.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { phoneRefId, type ContactItem } from '../src/repos/contactsRepo.js';
import { RosterWriteConflictError, type UnitContact, type UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const DELETED_AT = '2026-10-01T09:00:00.000Z';

/** A SOFT-DELETED unit owned by c-old: c-old is the primary, c-pm a second row. */
function seedDeletedUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): UnitItem {
  const item: UnitItem = {
    unitId,
    landlordId: 'c-old',
    status: 'available',
    primary_contact: 'c-old',
    contacts: [
      { contactId: 'c-old', role: 'landlord', primaryContact: true },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ],
    deleted_at: DELETED_AT,
    created_at: DELETED_AT,
    updated_at: DELETED_AT,
    ...overrides,
  };
  world.units.set(unitId, item);
  return item;
}

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId, ...fields } as ContactItem);
}

function restore(app: import('express').Express, unitId: string, body?: Record<string, unknown>) {
  const req = request(app)
    .post(`/api/units/${unitId}/restore`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
  return body === undefined ? req : req.send(body);
}

const restoredEvents = (world: FakeWorld) => world.auditEvents.filter((e) => e.event_type === 'unit_restored');

const hasLandlordId = (unit: UnitItem | undefined): boolean =>
  unit !== undefined && Object.prototype.hasOwnProperty.call(unit, 'landlordId');

describe('POST /api/units/:id/restore - plain restore (I3)', () => {
  it('(PIN) restores as before when the landlord of record is still a landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-1');
    seedContact(world, 'c-old', { type: 'landlord', firstName: 'Lee', lastName: 'Lord' });
    const res = await restore(app, 'u-1');
    expect(res.status).toBe(200);
    expect(res.body.unit.deleted_at).toBeUndefined();
    expect(world.units.get('u-1')?.landlordId).toBe('c-old');
    expect(restoredEvents(world)).toHaveLength(1);
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('landlordReplaced');
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('landlordCleared');
  });

  it('(PIN) reads the unit and its landlord of record CONSISTENTLY', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-c');
    seedContact(world, 'c-old', { type: 'landlord' });
    const unitRead = vi.spyOn(world.unitsRepo, 'getById');
    const contactRead = vi.spyOn(world.contactsRepo, 'getById');
    const res = await restore(app, 'u-c');
    expect(res.status).toBe(200);
    expect(unitRead).toHaveBeenCalledWith('u-c', { consistentRead: true });
    expect(contactRead).toHaveBeenCalledWith('c-old', { consistentRead: true });
  });

  it('(PIN) restores an ownerless property as before', async () => {
    const { app, world } = makeWebhookHarness();
    const unit = seedDeletedUnit(world, 'u-2', {
      contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: false }],
    });
    delete (unit as Partial<UnitItem>).landlordId;
    delete unit.primary_contact;
    const res = await restore(app, 'u-2');
    expect(res.status).toBe(200);
    expect(world.units.get('u-2')?.deleted_at).toBeUndefined();
  });

  it('409s restore_needs_landlord with the stored name when the landlord is no longer a landlord - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-3');
    seedContact(world, 'c-old', { type: 'partner', role: 'Caseworker', firstName: 'Lee', lastName: 'Lord' });
    const res = await restore(app, 'u-3');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'restore_needs_landlord', landlordName: 'Lee Lord' });
    expect(world.units.get('u-3')?.deleted_at).toBe(DELETED_AT);
    expect(world.units.get('u-3')?.landlordId).toBe('c-old');
    expect(restoredEvents(world)).toHaveLength(0);
  });

  it('409s restore_needs_landlord without a name when the landlord contact no longer exists', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-4');
    const res = await restore(app, 'u-4');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'restore_needs_landlord' });
    expect(world.units.get('u-4')?.deleted_at).toBe(DELETED_AT);
    expect(restoredEvents(world)).toHaveLength(0);
  });

  it('(PIN) 404s an unknown unit', async () => {
    const { app } = makeWebhookHarness();
    const res = await restore(app, 'nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unit_not_found' });
  });

  it('(PIN) a property that is not deleted restores as before with no landlord check', async () => {
    const { app, world } = makeWebhookHarness();
    const unit = seedDeletedUnit(world, 'u-live');
    delete unit.deleted_at;
    seedContact(world, 'c-old', { type: 'tenant' });
    const res = await restore(app, 'u-live', { landlordId: null });
    expect(res.status).toBe(200);
    expect(world.units.get('u-live')?.landlordId).toBe('c-old');
  });

  it('400s a landlordId that is neither a contact id nor null - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-bad');
    for (const landlordId of [42, '', true, { id: 'c-new' }]) {
      const res = await restore(app, 'u-bad', { landlordId });
      expect(res.status, JSON.stringify(landlordId)).toBe(400);
      expect(res.body).toEqual({ error: 'landlordId must be a contact id or null' });
    }
    expect(world.units.get('u-bad')?.deleted_at).toBe(DELETED_AT);
  });
});

describe('POST /api/units/:id/restore - with a landlord (I3)', () => {
  it('restores with the chosen landlord: old row out, new row pinned landlord, primary moved, audit landlordReplaced', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-5');
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-new', { type: 'landlord', firstName: 'Nora', lastName: 'Lane', company: 'Lane Homes' });
    const res = await restore(app, 'u-5', { landlordId: 'c-new' });
    expect(res.status).toBe(200);
    const stored = world.units.get('u-5')!;
    expect(stored.deleted_at).toBeUndefined();
    expect(stored.landlordId).toBe('c-new');
    expect(stored.primary_contact).toBe('c-new');
    expect(stored.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: true, name: 'Nora Lane', company: 'Lane Homes' },
    ]);
    // The response carries the enriched roster (the Contacts card applies it).
    expect(res.body.unit.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-new', role: 'landlord', name: 'Nora Lane' }),
    );
    expect(restoredEvents(world)).toHaveLength(1);
    expect(restoredEvents(world)[0]?.payload).toMatchObject({
      landlordReplaced: { from: 'c-old', to: 'c-new' },
    });
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('landlordCleared');
  });

  it('409s landlord_not_landlord when the chosen contact is not a landlord - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-6');
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker' });
    const res = await restore(app, 'u-6', { landlordId: 'c-cw' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'landlord_not_landlord' });
    expect(world.units.get('u-6')?.deleted_at).toBe(DELETED_AT);
    expect(world.units.get('u-6')?.landlordId).toBe('c-old');
    expect(restoredEvents(world)).toHaveLength(0);
  });

  it('404s landlord_not_found when the chosen contact does not exist - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-7');
    seedContact(world, 'c-old', { type: 'tenant' });
    const res = await restore(app, 'u-7', { landlordId: 'c-ghost' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'landlord_not_found' });
    expect(world.units.get('u-7')?.deleted_at).toBe(DELETED_AT);
    expect(restoredEvents(world)).toHaveLength(0);
  });

  it('(PIN) a body is ignored when the stored landlord is still valid - the restore is plain', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-8a');
    seedDeletedUnit(world, 'u-8b');
    seedContact(world, 'c-old', { type: 'landlord' });
    seedContact(world, 'c-new', { type: 'landlord' });
    expect((await restore(app, 'u-8a', { landlordId: 'c-new' })).status).toBe(200);
    expect((await restore(app, 'u-8b', { landlordId: null })).status).toBe(200);
    expect(world.units.get('u-8a')?.landlordId).toBe('c-old');
    expect(world.units.get('u-8b')?.landlordId).toBe('c-old');
    for (const event of restoredEvents(world)) {
      expect(event.payload).not.toHaveProperty('landlordReplaced');
      expect(event.payload).not.toHaveProperty('landlordCleared');
    }
  });

  // R1 code review, backend finding 2 - the review's interleaving through the
  // route: the route reads the DELETED unit and its landlord (typed tenant, so
  // a landlord is needed) and checks the choice; then, before the repo write,
  // staff B re-types the old landlord back to landlord and plain-restores the
  // property. Restore must never become a way to reassign or clear a LIVE
  // property's landlord: 409 unit_roster_conflict, the live unit keeps c-old.
  const RACE_CHOICES: Array<[string, string | null]> = [
    ['with a landlord', 'c-new'],
    ['without a landlord', null],
  ];
  it.each(RACE_CHOICES)(
    '409s unit_roster_conflict for a restore %s when the property came back live before the write - nothing changed',
    async (_label, landlordId) => {
      const { app, world } = makeWebhookHarness();
      seedDeletedUnit(world, 'u-race');
      seedContact(world, 'c-old', { type: 'tenant' });
      seedContact(world, 'c-new', { type: 'landlord' });
      const write = world.unitsRepo.restoreWithLandlord.bind(world.unitsRepo);
      world.unitsRepo.restoreWithLandlord = async (unitId, input) => {
        // Staff B, after the route's reads and before this write.
        world.contacts.find((c) => c.contactId === 'c-old')!.type = 'landlord';
        await world.unitsRepo.restore(unitId);
        return write(unitId, input);
      };
      const res = await restore(app, 'u-race', { landlordId });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'unit_roster_conflict' });
      const stored = world.units.get('u-race');
      expect(stored?.deleted_at).toBeUndefined();
      expect(stored?.landlordId).toBe('c-old');
      expect(stored?.primary_contact).toBe('c-old');
      expect(stored?.contacts).toEqual([
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ]);
      expect(restoredEvents(world)).toHaveLength(0);
    },
  );

  it('409s unit_roster_conflict when the landlord changed under the request - no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-9');
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-new', { type: 'landlord' });
    world.unitsRepo.restoreWithLandlord = async () => {
      throw new RosterWriteConflictError();
    };
    const res = await restore(app, 'u-9', { landlordId: 'c-new' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'unit_roster_conflict' });
    expect(restoredEvents(world)).toHaveLength(0);
  });
});

describe('POST /api/units/:id/restore - without a landlord (I3)', () => {
  it('restores ownerless: landlordId and the old row removed, primary cleared, audit landlordCleared', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-10');
    const res = await restore(app, 'u-10', { landlordId: null });
    expect(res.status).toBe(200);
    const stored = world.units.get('u-10');
    expect(stored?.deleted_at).toBeUndefined();
    expect(hasLandlordId(stored)).toBe(false);
    expect(stored?.primary_contact).toBeUndefined();
    expect(stored?.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: false }]);
    expect(restoredEvents(world)[0]?.payload).toMatchObject({ landlordCleared: { from: 'c-old' } });
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('landlordReplaced');
  });
});

// Cameron's Q5 (spec revision 5 section 4 "Restore", the sole-landlord
// promotion; fix wave 2 FW2-12): a restore WITHOUT a landlord of a property
// whose cleared landlord was its primary contact promotes the ONE remaining
// contact-list row whose contact is typed landlord (any roster role; read
// consistently, a missing contact or a routing pointer is not eligible) in the
// same conditional write; with zero or two-plus such rows nobody is promoted.
// The write is conditioned on the contact list the route read, so a
// concurrent contact-list change answers 409 unit_roster_conflict. The audit
// gains primaryPromoted { to } next to landlordCleared.
describe('POST /api/units/:id/restore - without a landlord: the sole-landlord promotion', () => {
  /** Deleted; c-old (now a tenant) was its landlord of record and primary; `remaining` rows stay on the list. */
  function seedClearedPrimary(world: FakeWorld, unitId: string, remaining: UnitContact[]): void {
    seedDeletedUnit(world, unitId, {
      contacts: [{ contactId: 'c-old', role: 'landlord', primaryContact: true }, ...remaining],
    });
    seedContact(world, 'c-old', { type: 'tenant' });
  }

  it('one remaining contact typed landlord: promoted in the same write - its row primary, primary_contact set, audit primaryPromoted', async () => {
    const { app, world } = makeWebhookHarness();
    seedClearedPrimary(world, 'u-p1', [
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ]);
    seedContact(world, 'c-pm', { type: 'landlord', firstName: 'Pat', lastName: 'Manager' });
    seedContact(world, 'c-ten', { type: 'tenant' });

    const res = await restore(app, 'u-p1', { landlordId: null });

    expect(res.status).toBe(200);
    const stored = world.units.get('u-p1');
    expect(stored?.deleted_at).toBeUndefined();
    expect(hasLandlordId(stored)).toBe(false);
    expect(stored?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ]);
    expect(stored?.primary_contact).toBe('c-pm');
    expect(res.body.unit.primary_contact).toBe('c-pm');
    expect(res.body.unit.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-pm', primaryContact: true, name: 'Pat Manager' }),
    );
    expect(restoredEvents(world)).toHaveLength(1);
    expect(restoredEvents(world)[0]?.payload).toMatchObject({
      landlordCleared: { from: 'c-old' },
      primaryPromoted: { to: 'c-pm' },
    });
  });

  it('promoted too when only the primary_contact scalar named the cleared landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-p2', {
      contacts: [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
    });
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-pm', { type: 'landlord' });

    const res = await restore(app, 'u-p2', { landlordId: null });

    expect(res.status).toBe(200);
    expect(world.units.get('u-p2')?.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: true }]);
    expect(world.units.get('u-p2')?.primary_contact).toBe('c-pm');
    expect(restoredEvents(world)[0]?.payload).toMatchObject({ primaryPromoted: { to: 'c-pm' } });
  });

  it('two remaining contacts typed landlord: nobody is promoted - no primary row, primary_contact removed, no primaryPromoted', async () => {
    const { app, world } = makeWebhookHarness();
    seedClearedPrimary(world, 'u-p3', [
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-owner', role: 'owner', primaryContact: false },
    ]);
    seedContact(world, 'c-pm', { type: 'landlord' });
    seedContact(world, 'c-owner', { type: 'landlord' });

    const res = await restore(app, 'u-p3', { landlordId: null });

    expect(res.status).toBe(200);
    expect(world.units.get('u-p3')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-owner', role: 'owner', primaryContact: false },
    ]);
    expect(world.units.get('u-p3')?.primary_contact).toBeUndefined();
    expect(restoredEvents(world)[0]?.payload).toMatchObject({ landlordCleared: { from: 'c-old' } });
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('primaryPromoted');
  });

  it('only a contact NOT typed landlord remains: nobody is promoted', async () => {
    const { app, world } = makeWebhookHarness();
    seedClearedPrimary(world, 'u-p4', [{ contactId: 'c-ten', role: 'other', primaryContact: false }]);
    seedContact(world, 'c-ten', { type: 'tenant' });

    const res = await restore(app, 'u-p4', { landlordId: null });

    expect(res.status).toBe(200);
    expect(world.units.get('u-p4')?.contacts).toEqual([{ contactId: 'c-ten', role: 'other', primaryContact: false }]);
    expect(world.units.get('u-p4')?.primary_contact).toBeUndefined();
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('primaryPromoted');
  });

  it('the cleared landlord was NOT the primary (another row is): unchanged - that primary and the scalar stay', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-p5', {
      primary_contact: 'c-ten',
      contacts: [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
        { contactId: 'c-ten', role: 'other', primaryContact: true },
      ],
    });
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-pm', { type: 'landlord' });
    seedContact(world, 'c-ten', { type: 'tenant' });

    const res = await restore(app, 'u-p5', { landlordId: null });

    expect(res.status).toBe(200);
    expect(world.units.get('u-p5')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: true },
    ]);
    expect(world.units.get('u-p5')?.primary_contact).toBe('c-ten');
    expect(restoredEvents(world)[0]?.payload).not.toHaveProperty('primaryPromoted');
  });

  it('a missing contact and a routing pointer row are not eligible - the one landlord-typed contact left is promoted', async () => {
    const { app, world } = makeWebhookHarness();
    const pointerId = phoneRefId('+15550004000');
    seedClearedPrimary(world, 'u-p6', [
      { contactId: 'c-ghost', role: 'other', primaryContact: false },
      { contactId: pointerId, role: 'pm', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ]);
    // The pointer row's flag decides, not a type: even one carrying `landlord` is never a contact.
    world.contacts.push({
      contactId: pointerId,
      type: 'landlord',
      phone: '+15550004000',
      phone_ref: true,
      phone_ref_owner: 'c-pm',
    } as unknown as ContactItem);
    seedContact(world, 'c-pm', { type: 'landlord', phone: '+15550004000' });

    const res = await restore(app, 'u-p6', { landlordId: null });

    expect(res.status).toBe(200);
    expect(world.units.get('u-p6')?.primary_contact).toBe('c-pm');
    expect(world.units.get('u-p6')?.contacts?.filter((row) => row.primaryContact)).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
    ]);
  });

  it('(PIN) reads the remaining contacts CONSISTENTLY', async () => {
    const { app, world } = makeWebhookHarness();
    seedClearedPrimary(world, 'u-p7', [{ contactId: 'c-pm', role: 'pm', primaryContact: false }]);
    seedContact(world, 'c-pm', { type: 'landlord' });
    const contactRead = vi.spyOn(world.contactsRepo, 'getById');

    expect((await restore(app, 'u-p7', { landlordId: null })).status).toBe(200);

    expect(contactRead).toHaveBeenCalledWith('c-pm', { consistentRead: true });
  });

  it('a contact-list change between the route read and the write: 409 unit_roster_conflict - nothing written, no audit', async () => {
    const { app, world } = makeWebhookHarness();
    seedClearedPrimary(world, 'u-race', [{ contactId: 'c-pm', role: 'pm', primaryContact: false }]);
    seedContact(world, 'c-pm', { type: 'landlord' });
    seedContact(world, 'c-owner', { type: 'landlord' });
    const write = world.unitsRepo.restoreWithLandlord.bind(world.unitsRepo);
    world.unitsRepo.restoreWithLandlord = async (unitId, input) => {
      // Staff B adds a second landlord-typed contact after the route decided
      // "promote c-pm" from the list it read - that decision no longer holds.
      await world.unitsRepo.addContact(
        unitId,
        { contactId: 'c-owner', role: 'owner' },
        { caseworker: false, landlordTyped: true },
      );
      return write(unitId, input);
    };

    const res = await restore(app, 'u-race', { landlordId: null });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'unit_roster_conflict' });
    const stored = world.units.get('u-race');
    expect(stored?.deleted_at).toBe(DELETED_AT);
    expect(stored?.landlordId).toBe('c-old');
    expect(stored?.primary_contact).toBe('c-old');
    expect(stored?.contacts).toEqual([
      { contactId: 'c-old', role: 'landlord', primaryContact: true },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-owner', role: 'owner', primaryContact: false },
    ]);
    expect(restoredEvents(world)).toHaveLength(0);
  });
});
