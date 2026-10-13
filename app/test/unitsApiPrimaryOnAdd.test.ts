// primary-contact-integrity (spec 2026-10-12 section 4.4, P2, Cameron
// 2026-10-13) through POST /api/units/:id/contacts on the FakeWorld harness:
// the widened auto-primary (an add OR an edit of the contact's own row; a
// soft-deleted or missing primary / landlord of record counts as absent; a
// write never promotes another contact; unknown liveness writes unpromoted
// with a WARN), the unit_primary_contact_assigned { reason: 'auto_on_add' }
// audit row, and 409 primary_contact_deleted - ordered after the 404s and
// caseworker-integrity's I4 / I3 refusals, decided by the route AND, per
// attempt, by the roster write. The fake calls the same pure decision as the
// real repo (decideAutoPrimary).
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const STAMP = '2026-10-12T09:00:00.000Z';
const GONE = '2026-10-01T09:00:00.000Z';

/** A unit with NO landlordId attribute unless `fields` sets one. */
function seedUnit(world: FakeWorld, unitId: string, fields: Partial<UnitItem> = {}): void {
  world.units.set(unitId, {
    unitId,
    status: 'available',
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  } as UnitItem);
}

/** A contact typed landlord unless overridden. */
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

const assigned = (world: FakeWorld) =>
  world.auditEvents.filter((e) => e.event_type === 'unit_primary_contact_assigned');

/** The two shapes a requireComplete batch read fails in (spec 4.2). */
const READ_FAILURES: Array<[string, () => Error]> = [
  ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
  ['an incomplete batch read', () => new IncompleteBatchReadError(1, 1)],
];

describe('POST /api/units/:id/contacts - auto-primary widened (spec 4.4)', () => {
  it('470 Bolton: an edit of the only contact (typed landlord) on an ownerless no-primary property makes them the primary, audited auto_on_add', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-bolton', { contacts: [{ contactId: 'c-mark', role: 'pm', primaryContact: false }] });
    seedContact(world, 'c-mark', { firstName: 'Mark', lastName: 'Passmore' });

    const res = await addContact(app, 'u-bolton', { contactId: 'c-mark', role: 'owner', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-bolton')?.contacts).toEqual([
      { contactId: 'c-mark', role: 'owner', primaryContact: true, name: 'Mark Passmore' },
    ]);
    expect(world.units.get('u-bolton')?.primary_contact).toBe('c-mark');
    expect(assigned(world)).toEqual([
      {
        entityKey: 'units#u-bolton',
        event_type: 'unit_primary_contact_assigned',
        actorId: TEST_SESSION_USER.userId,
        payload: { actor: TEST_SESSION_USER.userId, contactId: 'c-mark', reason: 'auto_on_add' },
      },
    ]);
  });

  it('delete the primary, then add the replacement: the replacement is promoted (a soft-deleted flagged primary counts as absent)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-repl', {
      contacts: [{ contactId: 'c-mark', role: 'pm', primaryContact: true }],
      primary_contact: 'c-mark',
    });
    seedContact(world, 'c-mark', { deleted_at: GONE });
    seedContact(world, 'c-new');

    const res = await addContact(app, 'u-repl', { contactId: 'c-new', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-repl')?.contacts).toEqual([
      { contactId: 'c-mark', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'pm', primaryContact: true },
    ]);
    expect(world.units.get('u-repl')?.primary_contact).toBe('c-new');
    expect(assigned(world).map((e) => e.payload)).toEqual([
      { actor: TEST_SESSION_USER.userId, contactId: 'c-new', reason: 'auto_on_add' },
    ]);
  });

  it('a soft-deleted landlord of record counts as absent: an eligible add is promoted; landlordId stays', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-dll', {
      landlordId: 'c-ll',
      contacts: [{ contactId: 'c-ll', role: 'landlord', primaryContact: false }],
    });
    seedContact(world, 'c-ll', { deleted_at: GONE });
    seedContact(world, 'c-pm');

    const res = await addContact(app, 'u-dll', { contactId: 'c-pm', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-dll')?.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
    ]);
    expect(world.units.get('u-dll')?.primary_contact).toBe('c-pm');
    expect(world.units.get('u-dll')?.landlordId).toBe('c-ll');
  });

  it('(PIN) a LIVE landlord of record: the add joins non-primary and no auto_on_add row is written', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-live', {
      landlordId: 'c-ll',
      contacts: [{ contactId: 'c-ll', role: 'landlord', primaryContact: false }],
    });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-pm');

    const res = await addContact(app, 'u-live', { contactId: 'c-pm', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-live')?.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ]);
    expect(world.units.get('u-live')?.primary_contact).toBeUndefined();
    expect(assigned(world)).toEqual([]);
  });

  it('a contact NOT eligible (a tenant): nobody is promoted - the soft-deleted primary keeps its flag and the scalar', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ten', {
      contacts: [{ contactId: 'c-dead', role: 'pm', primaryContact: true }],
      primary_contact: 'c-dead',
    });
    seedContact(world, 'c-dead', { deleted_at: GONE });
    seedContact(world, 'c-ten', { type: 'tenant' });

    const res = await addContact(app, 'u-ten', { contactId: 'c-ten', role: 'other', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-ten')?.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ]);
    expect(world.units.get('u-ten')?.primary_contact).toBe('c-dead');
    expect(assigned(world)).toEqual([]);
  });

  it('a write for one contact never promotes another eligible contact already on the list', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-other', {
      contacts: [
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-eligible', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-dead',
    });
    seedContact(world, 'c-dead', { deleted_at: GONE });
    seedContact(world, 'c-eligible');
    seedContact(world, 'c-ten', { type: 'tenant' });

    const res = await addContact(app, 'u-other', { contactId: 'c-ten', role: 'other', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-other')?.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-eligible', role: 'pm', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ]);
    expect(world.units.get('u-other')?.primary_contact).toBe('c-dead');
  });

  it('reads liveness for exactly the flagged primary and the landlord of record - ONE complete batch read', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ids', {
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-other', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-dead',
    });
    seedContact(world, 'c-ll', { deleted_at: GONE });
    seedContact(world, 'c-dead', { deleted_at: GONE });
    seedContact(world, 'c-other');
    seedContact(world, 'c-new');
    const batchRead = vi.spyOn(world.contactsRepo, 'getManyByIds');

    const res = await addContact(app, 'u-ids', { contactId: 'c-new', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    expect(batchRead).toHaveBeenNthCalledWith(1, ['c-dead', 'c-ll'], { requireComplete: true });
    expect(world.units.get('u-ids')?.primary_contact).toBe('c-new');
  });

  it.each(READ_FAILURES)(
    'liveness unknown (%s): 200, the add joins non-primary, and the route WARNs',
    async (_shape, make) => {
      const { app, world, capture } = makeWebhookHarness();
      seedUnit(world, 'u-unknown', {
        contacts: [{ contactId: 'c-dead', role: 'pm', primaryContact: true }],
        primary_contact: 'c-dead',
      });
      seedContact(world, 'c-dead', { deleted_at: GONE });
      seedContact(world, 'c-new');
      vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(make());

      const res = await addContact(app, 'u-unknown', { contactId: 'c-new', role: 'pm', primaryContact: false });

      expect(res.status).toBe(200);
      expect(world.units.get('u-unknown')?.contacts).toEqual([
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-new', role: 'pm', primaryContact: false },
      ]);
      expect(world.units.get('u-unknown')?.primary_contact).toBe('c-dead');
      expect(assigned(world)).toEqual([]);
      expect(
        capture.atLevel(40).find((l) => l['msg'] === 'unit contact add: the liveness read failed - auto-primary skipped'),
      ).toMatchObject({ unitId: 'u-unknown', contactId: 'c-new' });
    },
  );
});

describe('POST /api/units/:id/contacts - 409 primary_contact_deleted (spec 4.4)', () => {
  it('making a soft-deleted contact primary when its row is not the primary: 409 - nothing written, no audit', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-409', {
      landlordId: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-dead', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-ll',
    });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-dead', { deleted_at: GONE });
    const before = structuredClone(world.units.get('u-409'));

    const res = await addContact(app, 'u-409', { contactId: 'c-dead', role: 'pm', primaryContact: true });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'primary_contact_deleted' });
    expect(world.units.get('u-409')).toEqual(before);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('a NEW seat for a soft-deleted contact asked to be primary: 409 too', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-409b', { landlordId: 'c-ll' });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-dead', { deleted_at: GONE });

    const res = await addContact(app, 'u-409b', { contactId: 'c-dead', role: 'pm', primaryContact: true });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'primary_contact_deleted' });
    expect(world.units.get('u-409b')?.contacts).toBeUndefined();
  });

  it('re-sending primaryContact true for a soft-deleted contact whose row IS the primary: 200, nothing changes', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-resend', {
      contacts: [{ contactId: 'c-dead', role: 'pm', primaryContact: true }],
      primary_contact: 'c-dead',
    });
    seedContact(world, 'c-dead', { deleted_at: GONE });

    const res = await addContact(app, 'u-resend', { contactId: 'c-dead', role: 'pm', primaryContact: true });

    expect(res.status).toBe(200);
    expect(world.units.get('u-resend')?.contacts).toEqual([{ contactId: 'c-dead', role: 'pm', primaryContact: true }]);
    expect(world.units.get('u-resend')?.primary_contact).toBe('c-dead');
    expect(assigned(world)).toEqual([]);
  });

  it('(PIN) adding a soft-deleted contact NON-primary stays allowed', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-np', { landlordId: 'c-ll' });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-dead', { deleted_at: GONE });

    const res = await addContact(app, 'u-np', { contactId: 'c-dead', role: 'pm', primaryContact: false });

    expect(res.status).toBe(200);
    expect(world.units.get('u-np')?.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true },
      { contactId: 'c-dead', role: 'pm', primaryContact: false },
    ]);
  });

  it('order: an unknown contact answers 404 contact_not_found first', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ord0', { landlordId: 'c-ll' });
    seedContact(world, 'c-ll');

    const res = await addContact(app, 'u-ord0', { contactId: 'c-ghost', role: 'pm', primaryContact: true });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'contact_not_found' });
  });

  it('order: a soft-deleted caseworker taking a NEW seat answers contact_list_caseworker first', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ord1', { landlordId: 'c-ll' });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker', deleted_at: GONE });

    const res = await addContact(app, 'u-ord1', { contactId: 'c-cw', role: 'pm', primaryContact: true });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_list_caseworker' });
  });

  it('order: a soft-deleted non-landlord claiming the vacant landlord slot answers landlord_not_landlord first', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ord2');
    seedContact(world, 'c-ten', { type: 'tenant', deleted_at: GONE });

    const res = await addContact(app, 'u-ord2', { contactId: 'c-ten', role: 'landlord', primaryContact: true });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'landlord_not_landlord' });
  });

  it('decided again in the roster write: the primary moved off the deleted contact after the route read - 409, nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-race', {
      contacts: [
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-other', role: 'pm', primaryContact: false },
      ],
      primary_contact: 'c-dead',
    });
    seedContact(world, 'c-dead', { deleted_at: GONE });
    seedContact(world, 'c-other');
    const write = world.unitsRepo.addContact.bind(world.unitsRepo);
    world.unitsRepo.addContact = async (unitId, contact, facts, opts) => {
      // Staff B makes c-other the primary after the route's reads (which saw
      // c-dead's row as the primary, so the route let the re-send through).
      const unit = world.units.get(unitId)!;
      unit.contacts = [
        { contactId: 'c-dead', role: 'pm', primaryContact: false },
        { contactId: 'c-other', role: 'pm', primaryContact: true },
      ];
      unit.primary_contact = 'c-other';
      return write(unitId, contact, facts, opts);
    };

    const res = await addContact(app, 'u-race', { contactId: 'c-dead', role: 'pm', primaryContact: true });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'primary_contact_deleted' });
    expect(world.units.get('u-race')?.contacts).toEqual([
      { contactId: 'c-dead', role: 'pm', primaryContact: false },
      { contactId: 'c-other', role: 'pm', primaryContact: true },
    ]);
    expect(world.units.get('u-race')?.primary_contact).toBe('c-other');
    expect(world.auditEvents).toHaveLength(0);
  });
});
