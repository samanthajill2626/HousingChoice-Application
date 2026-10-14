// primary-contact-integrity (spec 2026-10-12 section 4.6, "Delete the
// contact" and "Restore a contact") through the contacts routes on the
// FakeWorld harness. DELETE /api/contacts/:id, after the soft delete
// persists, hands every property whose primary contact was that contact to
// its heir (services/primaryHandoff.ts: one consistent Scan over live and
// soft-deleted units, the deleted contact excluded and never read) -
// best-effort: a failed liveness read or a failing unit never fails the
// delete. No heir changes nothing, so delete-then-restore is lossless; POST
// /api/contacts/:id/restore changes no roster.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const STAMP = '2026-10-12T09:00:00.000Z';

const auth = (req: request.Test) => req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

/** A unit with NO landlordId unless `fields` sets one. */
function seedUnit(world: FakeWorld, unitId: string, fields: Partial<UnitItem>): void {
  world.units.set(unitId, {
    unitId,
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  } as UnitItem);
}

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'landlord', status: 'active', ...fields } as ContactItem);
}

const assigned = (world: FakeWorld) =>
  world.auditEvents.filter((e) => e.event_type === 'unit_primary_contact_assigned');

const READ_FAILURES: Array<[string, () => Error]> = [
  ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
  ['an incomplete batch read', () => new IncompleteBatchReadError(1, 1)],
];

describe('DELETE /api/contacts/:id - the primary hand-off (spec 4.6)', () => {
  it('moves the primary to the heir in the same request - flag and scalar - audited handoff_on_delete', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d', { firstName: 'Mark' });
    seedContact(world, 'c-p');
    seedUnit(world, 'u-1', {
      contacts: [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-p', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-d',
    });

    const del = await auth(request(app).delete('/api/contacts/c-d'));

    expect(del.status).toBe(200);
    expect(world.units.get('u-1')?.contacts).toEqual([
      { contactId: 'c-d', role: 'pm', primaryContact: false },
      { contactId: 'c-p', role: 'pm', primaryContact: true },
    ]);
    expect(world.units.get('u-1')?.primary_contact).toBe('c-p');
    expect(assigned(world)).toEqual([
      {
        entityKey: 'units#u-1',
        event_type: 'unit_primary_contact_assigned',
        actorId: TEST_SESSION_USER.userId,
        payload: {
          actor: TEST_SESSION_USER.userId,
          contactId: 'c-p',
          reason: 'handoff_on_delete',
          from: 'c-d',
        },
      },
    ]);
  });

  it('a live landlord of record takes over, on a soft-deleted unit too', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d');
    seedContact(world, 'c-ll');
    seedUnit(world, 'u-2', {
      landlordId: 'c-ll',
      deleted_at: STAMP,
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-d', role: 'pm', primaryContact: true },
      ],
      primary_contact: 'c-d',
    });

    const del = await auth(request(app).delete('/api/contacts/c-d'));

    expect(del.status).toBe(200);
    expect(world.units.get('u-2')?.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true },
      { contactId: 'c-d', role: 'pm', primaryContact: false },
    ]);
    expect(world.units.get('u-2')?.primary_contact).toBe('c-ll');
  });

  it('no heir: nothing changes - and restoring the contact leaves the property exactly as it was', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d');
    seedUnit(world, 'u-3', {
      contacts: [{ contactId: 'c-d', role: 'pm', primaryContact: true }],
      primary_contact: 'c-d',
    });
    const before = structuredClone(world.units.get('u-3'));

    const del = await auth(request(app).delete('/api/contacts/c-d'));
    expect(del.status).toBe(200);
    expect(world.units.get('u-3')).toEqual(before);

    const back = await auth(request(app).post('/api/contacts/c-d/restore'));
    expect(back.status).toBe(200);
    expect(world.units.get('u-3')).toEqual(before);
    expect(assigned(world)).toEqual([]);
  });

  it.each(READ_FAILURES)(
    'liveness unknown (%s): the delete still succeeds; the unit is skipped with a WARN',
    async (_shape, make) => {
      const { app, world, capture } = makeWebhookHarness();
      seedContact(world, 'c-d');
      seedContact(world, 'c-p');
      seedUnit(world, 'u-4', {
        contacts: [
          { contactId: 'c-d', role: 'pm', primaryContact: true },
          { contactId: 'c-p', role: 'pm', primaryContact: false },
        ],
        primary_contact: 'c-d',
      });
      const before = structuredClone(world.units.get('u-4'));
      vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(make());

      const del = await auth(request(app).delete('/api/contacts/c-d'));

      expect(del.status).toBe(200);
      expect(typeof del.body.contact.deleted_at).toBe('string');
      expect(world.units.get('u-4')).toEqual(before);
      expect(
        capture
          .atLevel(40)
          .find((l) => l['msg'] === 'contact delete: primary handoff skipped - the liveness read failed'),
      ).toMatchObject({ contactId: 'c-d', unitId: 'u-4' });
    },
  );

  it('one unit failing does not fail the delete; the others are handed off', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d');
    seedContact(world, 'c-p');
    for (const unitId of ['u-a', 'u-b']) {
      seedUnit(world, unitId, {
        contacts: [
          { contactId: 'c-d', role: 'pm', primaryContact: true },
          { contactId: 'c-p', role: 'pm', primaryContact: false },
        ],
        primary_contact: 'c-d',
      });
    }
    const real = world.unitsRepo.handOffPrimaryFrom.bind(world.unitsRepo);
    vi.spyOn(world.unitsRepo, 'handOffPrimaryFrom').mockImplementation(async (unitId, from, read) => {
      if (unitId === 'u-a') throw new Error('boom');
      return real(unitId, from, read);
    });

    const del = await auth(request(app).delete('/api/contacts/c-d'));

    expect(del.status).toBe(200);
    expect(world.units.get('u-a')?.primary_contact).toBe('c-d');
    expect(world.units.get('u-b')?.primary_contact).toBe('c-p');
  });

  it('restoring the contact afterwards changes no roster - the heir keeps the primary', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d');
    seedContact(world, 'c-p');
    seedUnit(world, 'u-5', {
      contacts: [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-p', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-d',
    });
    expect((await auth(request(app).delete('/api/contacts/c-d'))).status).toBe(200);
    const afterDelete = structuredClone(world.units.get('u-5'));

    const back = await auth(request(app).post('/api/contacts/c-d/restore'));

    expect(back.status).toBe(200);
    expect(world.units.get('u-5')).toEqual(afterDelete);
    expect(world.units.get('u-5')?.primary_contact).toBe('c-p');
    expect(assigned(world)).toHaveLength(1);
  });

  it('Scans consistently over live and deleted units and never reads the deleted contact for liveness', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d');
    seedContact(world, 'c-p');
    seedUnit(world, 'u-6', {
      contacts: [
        { contactId: 'c-d', role: 'pm', primaryContact: true },
        { contactId: 'c-p', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-d',
    });
    const scan = vi.spyOn(world.unitsRepo, 'list');
    const batchRead = vi.spyOn(world.contactsRepo, 'getManyByIds');

    expect((await auth(request(app).delete('/api/contacts/c-d'))).status).toBe(200);

    expect(scan).toHaveBeenCalledWith({ deleted: 'any', consistentRead: true });
    const livenessReads = batchRead.mock.calls.filter(
      ([, opts]) => (opts as { requireComplete?: boolean } | undefined)?.requireComplete === true,
    );
    expect(livenessReads.length).toBeGreaterThan(0);
    for (const [ids] of livenessReads) expect(ids).not.toContain('c-d');
  });

  // Planner fix wave F2 (Cameron 2026-10-13): on a stored list with NO flagged
  // row the landlord of record IS the property's contact, so deleting it hands
  // off as a restore does (repos/unitsRepo.ts contactIsPrimaryToHandOff). Only
  // the unit whose landlord of record it is: the same contact sitting
  // unflagged on ANOTHER no-flag unit's list is not that unit's primary.
  it('the landlord of record of a NO-flag roster: the eligible contact takes over, landlordId kept, audited - and only that unit', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-ll');
    seedContact(world, 'c-pm');
    seedContact(world, 'c-other');
    seedUnit(world, 'u-ll', {
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
    });
    seedUnit(world, 'u-seat', {
      landlordId: 'c-other',
      contacts: [
        { contactId: 'c-other', role: 'landlord', primaryContact: false },
        { contactId: 'c-ll', role: 'pm', primaryContact: false },
      ],
    });
    const seatBefore = structuredClone(world.units.get('u-seat'));

    const del = await auth(request(app).delete('/api/contacts/c-ll'));

    expect(del.status).toBe(200);
    expect(world.units.get('u-ll')?.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
    ]);
    expect(world.units.get('u-ll')?.primary_contact).toBe('c-pm');
    expect(world.units.get('u-ll')?.landlordId).toBe('c-ll');
    expect(world.units.get('u-seat')).toEqual(seatBefore);
    expect(assigned(world)).toEqual([
      {
        entityKey: 'units#u-ll',
        event_type: 'unit_primary_contact_assigned',
        actorId: TEST_SESSION_USER.userId,
        payload: {
          actor: TEST_SESSION_USER.userId,
          contactId: 'c-pm',
          reason: 'handoff_on_delete',
          from: 'c-ll',
        },
      },
    ]);
  });

  it('(PIN) a contact who is the primary of no property: no unit is written', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-d');
    seedContact(world, 'c-ll');
    seedUnit(world, 'u-7', {
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-d', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-ll',
    });
    const before = structuredClone(world.units.get('u-7'));

    expect((await auth(request(app).delete('/api/contacts/c-d'))).status).toBe(200);

    expect(world.units.get('u-7')).toEqual(before);
    expect(assigned(world)).toEqual([]);
  });
});
