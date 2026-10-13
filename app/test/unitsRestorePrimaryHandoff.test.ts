// primary-contact-integrity (spec 2026-10-12 section 4.6, Cameron 2026-10-13)
// through POST /api/units/:id/restore on the FakeWorld harness:
// caseworker-integrity's restores hand the primary contact through the heir
// function. "Restore without a landlord" of a property whose cleared landlord
// was the primary promotes the EARLIEST-added remaining contact eligible for
// automatic routing (this replaced the sole-landlord promotion); the landlord
// SWAP re-runs the heir function after the swap, so a soft-deleted new
// landlord is not made primary. Liveness unknown (either read-failure shape)
// answers 503 roster_read_failed and writes nothing. Every hand-off appends
// unit_primary_contact_assigned { reason: 'handoff_on_restore', from: <old
// landlord> }. The plain restore changes no roster.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const DELETED_AT = '2026-10-01T09:00:00.000Z';

/** A SOFT-DELETED unit owned by c-old: c-old is the primary, c-pm a second row - unless overridden. */
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

const assigned = (world: FakeWorld) =>
  world.auditEvents.filter((e) => e.event_type === 'unit_primary_contact_assigned');
const restoredEvents = (world: FakeWorld) => world.auditEvents.filter((e) => e.event_type === 'unit_restored');

const READ_FAILURES: Array<[string, () => Error]> = [
  ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
  ['an incomplete batch read', () => new IncompleteBatchReadError(1, 2)],
];

describe('POST /api/units/:id/restore without a landlord - the heir function (spec 4.6)', () => {
  it('rows that are not eligible (a tenant, a soft-deleted landlord-typed contact) are skipped for the earliest eligible one; the hand-off is audited', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-c1', {
      contacts: [
        { contactId: 'c-old', role: 'landlord', primaryContact: true },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-gone', role: 'pm', primaryContact: false },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
    });
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-ten', { type: 'tenant' });
    seedContact(world, 'c-gone', { type: 'landlord', deleted_at: DELETED_AT });
    seedContact(world, 'c-own', { type: 'landlord' });
    seedContact(world, 'c-pm', { type: 'landlord' });

    const res = await restore(app, 'u-c1', { landlordId: null });

    expect(res.status).toBe(200);
    expect(world.units.get('u-c1')?.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-gone', role: 'pm', primaryContact: false },
      { contactId: 'c-own', role: 'owner', primaryContact: true },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ]);
    expect(world.units.get('u-c1')?.primary_contact).toBe('c-own');
    expect(restoredEvents(world)[0]?.payload).toMatchObject({
      landlordCleared: { from: 'c-old' },
      primaryPromoted: { to: 'c-own' },
    });
    expect(assigned(world)).toEqual([
      {
        entityKey: 'units#u-c1',
        event_type: 'unit_primary_contact_assigned',
        actorId: TEST_SESSION_USER.userId,
        payload: {
          actor: TEST_SESSION_USER.userId,
          contactId: 'c-own',
          reason: 'handoff_on_restore',
          from: 'c-old',
        },
      },
    ]);
  });

  it.each(READ_FAILURES)(
    'liveness unknown (%s): 503 roster_read_failed - nothing written, no audit',
    async (_shape, make) => {
      const { app, world, capture } = makeWebhookHarness();
      seedDeletedUnit(world, 'u-c2');
      seedContact(world, 'c-old', { type: 'tenant' });
      seedContact(world, 'c-pm', { type: 'landlord' });
      const before = structuredClone(world.units.get('u-c2'));
      vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(make());

      const res = await restore(app, 'u-c2', { landlordId: null });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'roster_read_failed' });
      expect(world.units.get('u-c2')).toEqual(before);
      expect(world.auditEvents).toHaveLength(0);
      expect(
        capture.atLevel(40).find((l) => l['msg'] === 'unit restore refused: the liveness read failed'),
      ).toMatchObject({ unitId: 'u-c2' });
    },
  );

  it('the cleared landlord was not the primary: no liveness is needed (every batch read failing changes nothing) and no hand-off event', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-c3', {
      primary_contact: 'c-pm',
      contacts: [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
    });
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-pm', { type: 'landlord' });
    vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(new Error('throttled'));

    const res = await restore(app, 'u-c3', { landlordId: null });

    expect(res.status).toBe(200);
    expect(world.units.get('u-c3')?.contacts).toEqual([{ contactId: 'c-pm', role: 'pm', primaryContact: true }]);
    expect(world.units.get('u-c3')?.primary_contact).toBe('c-pm');
    expect(assigned(world)).toEqual([]);
  });
});

describe('POST /api/units/:id/restore with a landlord - the swap re-runs the heir function (spec 4.6)', () => {
  it('the new landlord is live: it takes the primary; audited handoff_on_restore from the old landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-s1');
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-new', { type: 'landlord' });
    seedContact(world, 'c-pm', { type: 'landlord' });

    const res = await restore(app, 'u-s1', { landlordId: 'c-new' });

    expect(res.status).toBe(200);
    expect(world.units.get('u-s1')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: true },
    ]);
    expect(world.units.get('u-s1')?.primary_contact).toBe('c-new');
    expect(assigned(world).map((e) => e.payload)).toEqual([
      { actor: TEST_SESSION_USER.userId, contactId: 'c-new', reason: 'handoff_on_restore', from: 'c-old' },
    ]);
  });

  it('the new landlord is SOFT-DELETED: the earliest eligible remaining contact takes the primary; the new landlord stays landlord of record, not primary', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-s2');
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-new', { type: 'landlord', deleted_at: DELETED_AT });
    seedContact(world, 'c-pm', { type: 'landlord' });

    const res = await restore(app, 'u-s2', { landlordId: 'c-new' });

    expect(res.status).toBe(200);
    expect(world.units.get('u-s2')?.landlordId).toBe('c-new');
    expect(world.units.get('u-s2')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(world.units.get('u-s2')?.primary_contact).toBe('c-pm');
    expect(assigned(world).map((e) => e.payload)).toEqual([
      { actor: TEST_SESSION_USER.userId, contactId: 'c-pm', reason: 'handoff_on_restore', from: 'c-old' },
    ]);
  });

  it('the new landlord soft-deleted and nobody else eligible: no primary row, the scalar removed, no hand-off event', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-s3');
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-new', { type: 'landlord', deleted_at: DELETED_AT });
    seedContact(world, 'c-pm', { type: 'tenant' });

    const res = await restore(app, 'u-s3', { landlordId: 'c-new' });

    expect(res.status).toBe(200);
    expect(world.units.get('u-s3')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(world.units.get('u-s3')?.primary_contact).toBeUndefined();
    expect(assigned(world)).toEqual([]);
  });

  it.each(READ_FAILURES)(
    'liveness unknown (%s): 503 roster_read_failed - nothing written, no audit',
    async (_shape, make) => {
      const { app, world } = makeWebhookHarness();
      seedDeletedUnit(world, 'u-s4');
      seedContact(world, 'c-old', { type: 'tenant' });
      seedContact(world, 'c-new', { type: 'landlord' });
      const before = structuredClone(world.units.get('u-s4'));
      vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(make());

      const res = await restore(app, 'u-s4', { landlordId: 'c-new' });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'roster_read_failed' });
      expect(world.units.get('u-s4')).toEqual(before);
      expect(world.auditEvents).toHaveLength(0);
    },
  );

  it('the old landlord was not the primary: the other primary stays, no liveness is needed, no hand-off event', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-s5', {
      primary_contact: 'c-pm',
      contacts: [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
    });
    seedContact(world, 'c-old', { type: 'tenant' });
    seedContact(world, 'c-new', { type: 'landlord' });
    vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(new Error('throttled'));

    const res = await restore(app, 'u-s5', { landlordId: 'c-new' });

    expect(res.status).toBe(200);
    expect(world.units.get('u-s5')?.contacts).toEqual([
      { contactId: 'c-pm', role: 'pm', primaryContact: true },
      { contactId: 'c-new', role: 'landlord', primaryContact: false },
    ]);
    expect(world.units.get('u-s5')?.primary_contact).toBe('c-pm');
    expect(assigned(world)).toEqual([]);
  });
});

describe('POST /api/units/:id/restore - the plain restore changes no roster (spec 9.1)', () => {
  it('(PIN) a soft-deleted flagged primary stays flagged after a plain restore; no hand-off event', async () => {
    const { app, world } = makeWebhookHarness();
    seedDeletedUnit(world, 'u-plain', {
      primary_contact: 'c-dead',
      contacts: [
        { contactId: 'c-old', role: 'landlord', primaryContact: false },
        { contactId: 'c-dead', role: 'pm', primaryContact: true },
        { contactId: 'c-pm', role: 'pm', primaryContact: false },
      ],
    });
    seedContact(world, 'c-old', { type: 'landlord' });
    seedContact(world, 'c-dead', { type: 'landlord', deleted_at: DELETED_AT });
    seedContact(world, 'c-pm', { type: 'landlord' });

    const res = await restore(app, 'u-plain');

    expect(res.status).toBe(200);
    expect(world.units.get('u-plain')?.deleted_at).toBeUndefined();
    expect(world.units.get('u-plain')?.contacts).toEqual([
      { contactId: 'c-old', role: 'landlord', primaryContact: false },
      { contactId: 'c-dead', role: 'pm', primaryContact: true },
      { contactId: 'c-pm', role: 'pm', primaryContact: false },
    ]);
    expect(world.units.get('u-plain')?.primary_contact).toBe('c-dead');
    expect(assigned(world)).toEqual([]);
  });
});
