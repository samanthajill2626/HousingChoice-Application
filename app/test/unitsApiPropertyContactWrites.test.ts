// primary-contact-integrity spec 7.5 (plan S3.6): the two contact-list writes
// (POST /api/units/:id/contacts and DELETE /api/units/:id/contacts/:contactId)
// answer with the same row flags and propertyContact block as GET, decided
// from the WRITTEN roster - and with today's rows and NO block when the
// complete read fails, in either shape.
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

/** A unit whose landlord of record is `c-ll` unless overridden. */
function seedUnit(world: FakeWorld, unitId: string, overrides: Partial<UnitItem> = {}): void {
  world.units.set(unitId, {
    unitId,
    landlordId: 'c-ll',
    status: 'available',
    created_at: '2026-06-12T09:00:00.000Z',
    updated_at: '2026-06-12T09:00:00.000Z',
    ...overrides,
  } as UnitItem);
}

/** The importer's shape: NO landlordId attribute at all. */
function seedUnitWithoutLandlord(
  world: FakeWorld,
  unitId: string,
  contacts: NonNullable<UnitItem['contacts']>,
): void {
  seedUnit(world, unitId, { contacts });
  delete (world.units.get(unitId) as Partial<UnitItem>).landlordId;
}

function seedContact(world: FakeWorld, contactId: string, overrides: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'landlord', ...overrides } as ContactItem);
}

const post = (app: Express, unitId: string) =>
  request(app)
    .post(`/api/units/${unitId}/contacts`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);

const del = (app: Express, unitId: string, contactId: string) =>
  request(app)
    .delete(`/api/units/${unitId}/contacts/${contactId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);

/** Make ONLY the complete (requireComplete) batch read throw; the best-effort read still answers. */
function failCompleteRead(world: FakeWorld, error: Error): void {
  const real = world.contactsRepo.getManyByIds.bind(world.contactsRepo);
  vi.spyOn(world.contactsRepo, 'getManyByIds').mockImplementation(async (ids, opts) => {
    if (opts?.requireComplete === true) throw error;
    return real(ids, opts);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('contact-list writes carry the propertyContact block (spec 7.5)', () => {
  it('POST add: the block is decided from the written roster', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-add');
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
    seedContact(world, 'c-pat', { firstName: 'Pat', lastName: 'Manager' });

    const res = await post(app, 'u-add').send({ contactId: 'c-pat', role: 'pm' });

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true, name: 'Lee Lord' },
      { contactId: 'c-pat', role: 'pm', primaryContact: false, name: 'Pat Manager' },
    ]);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: 'c-ll',
      heirIfPrimaryRemoved: { contactId: 'c-pat', name: 'Pat Manager' },
    });
  });

  it('DELETE of a NON-primary row: the block is decided from the written roster', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-rm', {
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-pat', role: 'pm', primaryContact: false },
        { contactId: 'c-pam', role: 'pm', primaryContact: false },
      ],
    });
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
    seedContact(world, 'c-pat', { firstName: 'Pat', lastName: 'Manager' });
    seedContact(world, 'c-pam', { firstName: 'Pam', lastName: 'Two' });

    const res = await del(app, 'u-rm', 'c-pat');

    expect(res.status).toBe(200);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: 'c-ll',
      heirIfPrimaryRemoved: { contactId: 'c-pam', name: 'Pam Two' },
    });
  });

  it('DELETE of the PRIMARY with a live heir: the block names the heir as the property contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnitWithoutLandlord(world, 'u-handoff', [
      { contactId: 'c-pat', role: 'pm', primaryContact: true },
      { contactId: 'c-pam', role: 'pm', primaryContact: false },
    ]);
    seedContact(world, 'c-pat', { firstName: 'Pat', lastName: 'Manager' });
    seedContact(world, 'c-pam', { firstName: 'Pam', lastName: 'Two' });

    const res = await del(app, 'u-handoff', 'c-pat');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-pam', role: 'pm', primaryContact: true, name: 'Pam Two' },
    ]);
    expect(res.body.unit.propertyContact).toEqual({ contactId: 'c-pam', heirIfPrimaryRemoved: null });
  });

  const shapes: [string, () => Error][] = [
    ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
    ['IncompleteBatchReadError', () => new IncompleteBatchReadError(1, 2)],
  ];
  for (const [shape, makeError] of shapes) {
    it(`${shape}: POST add answers 200 with today's rows and no block`, async () => {
      const { app, world } = makeWebhookHarness();
      seedUnit(world, 'u-add-inc');
      seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
      seedContact(world, 'c-pat', { firstName: 'Pat', lastName: 'Manager' });
      failCompleteRead(world, makeError());

      const res = await post(app, 'u-add-inc').send({ contactId: 'c-pat', role: 'pm' });

      expect(res.status).toBe(200);
      expect(res.body.unit.contacts).toEqual([
        { contactId: 'c-ll', role: 'landlord', primaryContact: true, name: 'Lee Lord' },
        { contactId: 'c-pat', role: 'pm', primaryContact: false, name: 'Pat Manager' },
      ]);
      expect(res.body.unit).not.toHaveProperty('propertyContact');
    });

    it(`${shape}: DELETE of a non-primary row answers 200 with no block`, async () => {
      const { app, world } = makeWebhookHarness();
      seedUnit(world, 'u-rm-inc', {
        contacts: [
          { contactId: 'c-ll', role: 'landlord', primaryContact: true },
          { contactId: 'c-pat', role: 'pm', primaryContact: false },
        ],
      });
      seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
      seedContact(world, 'c-pat', { firstName: 'Pat', lastName: 'Manager' });
      failCompleteRead(world, makeError());

      const res = await del(app, 'u-rm-inc', 'c-pat');

      expect(res.status).toBe(200);
      expect(res.body.unit.contacts).toEqual([
        { contactId: 'c-ll', role: 'landlord', primaryContact: true, name: 'Lee Lord' },
      ]);
      expect(res.body.unit).not.toHaveProperty('propertyContact');
    });
  }
});
