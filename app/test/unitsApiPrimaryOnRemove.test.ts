// primary-contact-integrity (spec 2026-10-12 section 4.6, "Remove from the
// property") through DELETE /api/units/:id/contacts/:contactId on the
// FakeWorld harness. Removing the PRIMARY row hands the primary to the heir
// function's pick (the removed contact excluded): the live landlord of record
// - given a row as primary when it has none - else the earliest-added
// remaining contact eligible for automatic routing; no heir clears every flag
// and REMOVEs the scalar; a liveness read that fails (either shape) refuses
// with 503 roster_read_failed and writes nothing. A hand-off appends
// unit_primary_contact_assigned { reason: 'handoff_on_remove', from }.
// Removing a non-primary row reads no liveness.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const STAMP = '2026-10-12T09:00:00.000Z';
const GONE = '2026-10-01T09:00:00.000Z';

/** A unit with NO landlordId attribute unless `fields` sets one. */
function seedUnit(world: FakeWorld, unitId: string, fields: Partial<UnitItem>): void {
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

function remove(app: import('express').Express, unitId: string, contactId: string) {
  return request(app)
    .delete(`/api/units/${unitId}/contacts/${contactId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

const assigned = (world: FakeWorld) =>
  world.auditEvents.filter((e) => e.event_type === 'unit_primary_contact_assigned');

const READ_FAILURES: Array<[string, () => Error]> = [
  ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
  ['an incomplete batch read', () => new IncompleteBatchReadError(1, 2)],
];

describe('DELETE /api/units/:id/contacts/:contactId - removing the primary (spec 4.6)', () => {
  it('the live landlord of record takes over - flag and scalar - audited handoff_on_remove', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1', {
      landlordId: 'c-ll',
      primary_contact: 'c-pm',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
      ],
    });
    seedContact(world, 'c-ll');
    seedContact(world, 'c-pm');

    const res = await remove(app, 'u-1', 'c-pm');

    expect(res.status).toBe(200);
    expect(world.units.get('u-1')?.contacts).toEqual([{ contactId: 'c-ll', role: 'landlord', primaryContact: true }]);
    expect(world.units.get('u-1')?.primary_contact).toBe('c-ll');
    expect(res.body.unit.contacts).toEqual([expect.objectContaining({ contactId: 'c-ll', primaryContact: true })]);
    expect(assigned(world)).toEqual([
      {
        entityKey: 'units#u-1',
        event_type: 'unit_primary_contact_assigned',
        actorId: TEST_SESSION_USER.userId,
        payload: {
          actor: TEST_SESSION_USER.userId,
          contactId: 'c-ll',
          reason: 'handoff_on_remove',
          from: 'c-pm',
        },
      },
    ]);
  });

  it('an off-roster landlord of record takes over with a landlord row added as the primary', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-2', {
      landlordId: 'c-ll',
      primary_contact: 'c-pm',
      contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }],
    });
    seedContact(world, 'c-ll');

    const res = await remove(app, 'u-2', 'c-pm');

    expect(res.status).toBe(200);
    expect(world.units.get('u-2')?.contacts).toHaveLength(1);
    expect(world.units.get('u-2')?.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-ll', role: 'landlord', primaryContact: true }),
    );
    expect(world.units.get('u-2')?.primary_contact).toBe('c-ll');
  });

  it('no landlord of record (470 Bolton): the earliest-added eligible contact takes over - a tenant and a caseworker are skipped', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-3', {
      primary_contact: 'c-mark',
      contacts: [
        { contactId: 'c-mark', role: 'pm', primaryContact: true },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-cw', role: 'other', primaryContact: false },
        { contactId: 'c-own', role: 'owner', primaryContact: false },
        { contactId: 'c-late', role: 'pm', primaryContact: false },
      ],
    });
    seedContact(world, 'c-mark');
    seedContact(world, 'c-ten', { type: 'tenant' });
    seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker' });
    seedContact(world, 'c-own');
    seedContact(world, 'c-late');

    const res = await remove(app, 'u-3', 'c-mark');

    expect(res.status).toBe(200);
    expect(world.units.get('u-3')?.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-cw', role: 'other', primaryContact: false },
      { contactId: 'c-own', role: 'owner', primaryContact: true },
      { contactId: 'c-late', role: 'pm', primaryContact: false },
    ]);
    expect(world.units.get('u-3')?.primary_contact).toBe('c-own');
    expect(assigned(world).map((e) => e.payload)).toEqual([
      { actor: TEST_SESSION_USER.userId, contactId: 'c-own', reason: 'handoff_on_remove', from: 'c-mark' },
    ]);
  });

  it('no eligible contact left: every flag cleared, the scalar removed, no hand-off event', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-4', {
      primary_contact: 'c-pm',
      contacts: [
        { contactId: 'c-pm', role: 'pm', primaryContact: true },
        { contactId: 'c-ten', role: 'other', primaryContact: false },
        { contactId: 'c-gone', role: 'owner', primaryContact: false },
      ],
    });
    seedContact(world, 'c-pm');
    seedContact(world, 'c-ten', { type: 'tenant' });
    seedContact(world, 'c-gone', { deleted_at: GONE });

    const res = await remove(app, 'u-4', 'c-pm');

    expect(res.status).toBe(200);
    expect(world.units.get('u-4')?.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-gone', role: 'owner', primaryContact: false },
    ]);
    expect(world.units.get('u-4')?.primary_contact).toBeUndefined();
    expect(assigned(world)).toEqual([]);
    expect(world.auditEvents.map((e) => e.event_type)).toEqual(['unit_contact_removed']);
  });

  it.each(READ_FAILURES)(
    'liveness unknown (%s): 503 roster_read_failed - nothing written, no audit',
    async (_shape, make) => {
      const { app, world, capture } = makeWebhookHarness();
      seedUnit(world, 'u-5', {
        landlordId: 'c-ll',
        primary_contact: 'c-pm',
        contacts: [
          { contactId: 'c-ll', role: 'landlord', primaryContact: false },
          { contactId: 'c-pm', role: 'pm', primaryContact: true },
        ],
      });
      seedContact(world, 'c-ll');
      seedContact(world, 'c-pm');
      const before = structuredClone(world.units.get('u-5'));
      vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(make());

      const res = await remove(app, 'u-5', 'c-pm');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'roster_read_failed' });
      expect(world.units.get('u-5')).toEqual(before);
      expect(world.auditEvents).toHaveLength(0);
      expect(
        capture.atLevel(40).find((l) => l['msg'] === 'unit contact remove refused: the liveness read failed'),
      ).toMatchObject({ unitId: 'u-5', contactId: 'c-pm' });
    },
  );

  it('(PIN) removing a NON-primary row needs no liveness: it succeeds even when every batch read fails', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-6', {
      landlordId: 'c-ll',
      primary_contact: 'c-ll',
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-other', role: 'pm', primaryContact: false },
      ],
    });
    // Every batch read throws - the response's best-effort enrichment survives
    // that, and a removal that needed liveness would answer 503 instead.
    vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(new Error('throttled'));

    const res = await remove(app, 'u-6', 'c-other');

    expect(res.status).toBe(200);
    expect(world.units.get('u-6')?.contacts).toEqual([{ contactId: 'c-ll', role: 'landlord', primaryContact: true }]);
    expect(world.units.get('u-6')?.primary_contact).toBe('c-ll');
    expect(world.auditEvents.map((e) => e.event_type)).toEqual(['unit_contact_removed']);
  });
});
