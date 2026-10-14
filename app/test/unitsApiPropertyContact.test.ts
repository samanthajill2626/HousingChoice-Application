// primary-contact-integrity spec 7.5 (plan S3.5): GET /api/units/:id serves the
// property page's contact facts ONLY from a COMPLETE read of the roster's
// contact ids AND landlordId (spec 4.2): per-row `deleted` / `caseworker` /
// `autoEligible` (planner fix wave F1: eligible for AUTOMATIC routing - the
// only row the 7.4 box offers in one click), and the unit's `propertyContact`
// block. Either failure shape of that read (a raw chunk error or
// IncompleteBatchReadError) serves today's best-effort rows - names, NO
// flags - and NO block. The GET never 500s.
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const DELETED_AT = '2026-10-01T12:00:00.000Z';

type WireRow = Record<string, unknown> & { contactId: string };

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

const getUnit = (app: Express, unitId: string) =>
  request(app)
    .get(`/api/units/${unitId}`)
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

/** One deleted primary, one caseworker, one plain landlord-typed contact. */
function seedMixedRoster(world: FakeWorld, unitId: string): void {
  seedUnitWithoutLandlord(world, unitId, [
    { contactId: 'c-gone', role: 'pm', primaryContact: true },
    { contactId: 'c-cw', role: 'other', primaryContact: false },
    { contactId: 'c-mark', role: 'pm', primaryContact: false },
  ]);
  seedContact(world, 'c-gone', { firstName: 'Gail', lastName: 'Gone', deleted_at: DELETED_AT });
  seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker', firstName: 'Casey', lastName: 'Worker' });
  seedContact(world, 'c-mark', { firstName: 'Mark', lastName: 'Passmore' });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/units/:id - row flags and the propertyContact block (complete read, spec 7.5)', () => {
  it('a landlord-only unit: the landlord is the property contact, and nobody inherits it', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ll');
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });

    const res = await getUnit(app, 'u-ll');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true, name: 'Lee Lord', autoEligible: true },
    ]);
    expect(res.body.unit.propertyContact).toEqual({ contactId: 'c-ll', heirIfPrimaryRemoved: null });
  });

  it('470 Bolton: no landlord of record and no flagged primary - contactId null, reason none, no heir', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnitWithoutLandlord(world, 'u-bolton', [{ contactId: 'c-mark', role: 'pm', primaryContact: false }]);
    seedContact(world, 'c-mark', { firstName: 'Mark', lastName: 'Passmore' });

    const res = await getUnit(app, 'u-bolton');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-mark', role: 'pm', primaryContact: false, name: 'Mark Passmore', autoEligible: true },
    ]);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: null,
      reason: 'none',
      heirIfPrimaryRemoved: null,
    });
  });

  it('a deleted flagged primary: its row is marked, reason deleted, and the earliest ELIGIBLE live contact is the heir', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnitWithoutLandlord(world, 'u-del', [
      { contactId: 'c-gone', role: 'pm', primaryContact: true },
      { contactId: 'c-cw', role: 'other', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-pam', role: 'pm', primaryContact: false },
    ]);
    seedContact(world, 'c-gone', { firstName: 'Gail', lastName: 'Gone', deleted_at: DELETED_AT });
    seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker', firstName: 'Casey', lastName: 'Worker' });
    seedContact(world, 'c-ten', { type: 'tenant', firstName: 'Tia', lastName: 'Tenant' });
    seedContact(world, 'c-pam', { firstName: 'Pam', lastName: 'Two' });

    const res = await getUnit(app, 'u-del');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-gone', role: 'pm', primaryContact: true, name: 'Gail Gone', deleted: true },
      { contactId: 'c-cw', role: 'other', primaryContact: false, name: 'Casey Worker', caseworker: true },
      { contactId: 'c-ten', role: 'other', primaryContact: false, name: 'Tia Tenant' },
      { contactId: 'c-pam', role: 'pm', primaryContact: false, name: 'Pam Two', autoEligible: true },
    ]);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: null,
      reason: 'deleted',
      heirIfPrimaryRemoved: { contactId: 'c-pam', name: 'Pam Two' },
    });
  });

  it('only ineligible live contacts (a caseworker, a tenant): no heir', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnitWithoutLandlord(world, 'u-noheir', [
      { contactId: 'c-gone', role: 'pm', primaryContact: true },
      { contactId: 'c-cw', role: 'other', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
    ]);
    seedContact(world, 'c-gone', { firstName: 'Gail', deleted_at: DELETED_AT });
    seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker', firstName: 'Casey' });
    seedContact(world, 'c-ten', { type: 'tenant', firstName: 'Tia' });

    const res = await getUnit(app, 'u-noheir');

    expect(res.status).toBe(200);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: null,
      reason: 'deleted',
      heirIfPrimaryRemoved: null,
    });
  });

  it('a deleted primary next to a live landlord of record: the landlord is the property contact AND the heir', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-both', {
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: false },
        { contactId: 'c-gone', role: 'pm', primaryContact: true },
      ],
    });
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
    seedContact(world, 'c-gone', { firstName: 'Gail', lastName: 'Gone', deleted_at: DELETED_AT });

    const res = await getUnit(app, 'u-both');

    expect(res.status).toBe(200);
    const gone = (res.body.unit.contacts as WireRow[]).find((r) => r.contactId === 'c-gone');
    expect(gone).toMatchObject({ deleted: true });
    expect(res.body.unit.propertyContact).toEqual({
      contactId: 'c-ll',
      heirIfPrimaryRemoved: { contactId: 'c-ll', name: 'Lee Lord' },
    });
  });

  it('an OFF-roster landlord of record is read too, and named as the heir from that read', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-off', { contacts: [{ contactId: 'c-pat', role: 'pm', primaryContact: true }] });
    seedContact(world, 'c-pat', { firstName: 'Pat', lastName: 'Manager' });
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });

    const res = await getUnit(app, 'u-off');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-pat', role: 'pm', primaryContact: true, name: 'Pat Manager', autoEligible: true },
    ]);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: 'c-pat',
      heirIfPrimaryRemoved: { contactId: 'c-ll', name: 'Lee Lord' },
    });
  });

  it('an heir with no name on record carries its id only', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-noname', { contacts: [{ contactId: 'c-pat', role: 'pm', primaryContact: true }] });
    seedContact(world, 'c-pat', { firstName: 'Pat' });
    seedContact(world, 'c-ll');

    const res = await getUnit(app, 'u-noname');

    expect(res.status).toBe(200);
    expect(res.body.unit.propertyContact.heirIfPrimaryRemoved).toEqual({ contactId: 'c-ll' });
  });

  it('a landlord id that names NO contact record reads as deleted', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ghost', { landlordId: 'c-ghost' });

    const res = await getUnit(app, 'u-ghost');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-ghost', role: 'landlord', primaryContact: true, deleted: true },
    ]);
    expect(res.body.unit.propertyContact).toEqual({
      contactId: null,
      reason: 'deleted',
      heirIfPrimaryRemoved: null,
    });
  });

  it('a soft-deleted caseworker row carries BOTH flags', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-cw', {
      contacts: [
        { contactId: 'c-ll', role: 'landlord', primaryContact: true },
        { contactId: 'c-cw', role: 'other', primaryContact: false },
      ],
    });
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
    seedContact(world, 'c-cw', {
      type: 'partner',
      role: 'Caseworker',
      firstName: 'Casey',
      lastName: 'Worker',
      deleted_at: DELETED_AT,
    });

    const res = await getUnit(app, 'u-cw');

    expect(res.status).toBe(200);
    expect((res.body.unit.contacts as WireRow[]).find((r) => r.contactId === 'c-cw')).toEqual({
      contactId: 'c-cw',
      role: 'other',
      primaryContact: false,
      name: 'Casey Worker',
      deleted: true,
      caseworker: true,
    });
  });

  it('the complete read is ONE requireComplete batch read of the roster ids AND landlordId', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-reads', { contacts: [{ contactId: 'c-pat', role: 'pm', primaryContact: true }] });
    seedContact(world, 'c-pat', { firstName: 'Pat' });
    seedContact(world, 'c-ll', { firstName: 'Lee' });
    const reads = vi.spyOn(world.contactsRepo, 'getManyByIds');

    const res = await getUnit(app, 'u-reads');

    expect(res.status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(1);
    expect([...(reads.mock.calls[0]?.[0] ?? [])].sort()).toEqual(['c-ll', 'c-pat']);
    expect(reads.mock.calls[0]?.[1]).toMatchObject({ requireComplete: true });
  });
});

describe('GET /api/units/:id - the autoEligible row flag (planner fix wave F1; spec 7.4 / 7.5)', () => {
  it('marks ONLY a live typed-landlord row - never a tenant, a caseworker, a deleted landlord-typed contact or a phone / email routing record', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnitWithoutLandlord(world, 'u-auto', [
      { contactId: 'c-pam', role: 'pm', primaryContact: false },
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-cw', role: 'other', primaryContact: false },
      { contactId: 'c-gone', role: 'owner', primaryContact: false },
      { contactId: 'c-pref', role: 'other', primaryContact: false },
      { contactId: 'c-eref', role: 'other', primaryContact: false },
    ]);
    seedContact(world, 'c-pam', { firstName: 'Pam', lastName: 'Two' });
    seedContact(world, 'c-ten', { type: 'tenant', firstName: 'Tia', lastName: 'Tenant' });
    seedContact(world, 'c-cw', { type: 'partner', role: 'Caseworker', firstName: 'Casey', lastName: 'Worker' });
    seedContact(world, 'c-gone', { firstName: 'Gail', lastName: 'Gone', deleted_at: DELETED_AT });
    // Routing pointers that even carry type landlord: the pointer test alone
    // keeps them out (isAutoRoutingEligible).
    seedContact(world, 'c-pref', { phone_ref: true, phone_ref_owner: 'c-pam' });
    seedContact(world, 'c-eref', { email_ref: true, email_ref_owner: 'c-pam' });

    const res = await getUnit(app, 'u-auto');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-pam', role: 'pm', primaryContact: false, name: 'Pam Two', autoEligible: true },
      { contactId: 'c-ten', role: 'other', primaryContact: false, name: 'Tia Tenant' },
      { contactId: 'c-cw', role: 'other', primaryContact: false, name: 'Casey Worker', caseworker: true },
      { contactId: 'c-gone', role: 'owner', primaryContact: false, name: 'Gail Gone', deleted: true },
      { contactId: 'c-pref', role: 'other', primaryContact: false },
      { contactId: 'c-eref', role: 'other', primaryContact: false },
    ]);
  });

  it('a soft-deleted landlord of record: its derived row is deleted, never autoEligible', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ll-gone');
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord', deleted_at: DELETED_AT });

    const res = await getUnit(app, 'u-ll-gone');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true, name: 'Lee Lord', deleted: true },
    ]);
  });

  it('a live landlord of record whose contact is typed TENANT is not autoEligible (the flag reads the type, not the role)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ll-tenant');
    seedContact(world, 'c-ll', { type: 'tenant', firstName: 'Lee', lastName: 'Lord' });

    const res = await getUnit(app, 'u-ll-tenant');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: true, name: 'Lee Lord' },
    ]);
  });
});

describe("GET /api/units/:id - an incomplete read serves today's rows, no flags, no block, never a 500", () => {
  const shapes: [string, () => Error][] = [
    ['a raw chunk error', () => new Error('ProvisionedThroughputExceededException')],
    ['IncompleteBatchReadError', () => new IncompleteBatchReadError(1, 3)],
  ];
  for (const [shape, makeError] of shapes) {
    it(`${shape}: best-effort names, no deleted/caseworker flags, no propertyContact`, async () => {
      const { app, world } = makeWebhookHarness();
      seedMixedRoster(world, 'u-inc');
      failCompleteRead(world, makeError());

      const res = await getUnit(app, 'u-inc');

      expect(res.status).toBe(200);
      expect(res.body.unit.contacts).toEqual([
        { contactId: 'c-gone', role: 'pm', primaryContact: true, name: 'Gail Gone' },
        { contactId: 'c-cw', role: 'other', primaryContact: false, name: 'Casey Worker' },
        { contactId: 'c-mark', role: 'pm', primaryContact: false, name: 'Mark Passmore' },
      ]);
      // c-mark is a live typed landlord - autoEligible on a COMPLETE read, and
      // absent here like every other flag (planner fix wave F1).
      for (const row of res.body.unit.contacts as WireRow[]) expect(row).not.toHaveProperty('autoEligible');
      expect(res.body.unit).not.toHaveProperty('propertyContact');
    });
  }

  it('both reads failing: bare rows, no block, still 200', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-down');
    seedContact(world, 'c-ll', { firstName: 'Lee', lastName: 'Lord' });
    vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValue(new Error('contacts table unavailable'));

    const res = await getUnit(app, 'u-down');

    expect(res.status).toBe(200);
    expect(res.body.unit.contacts).toEqual([{ contactId: 'c-ll', role: 'landlord', primaryContact: true }]);
    expect(res.body.unit).not.toHaveProperty('propertyContact');
  });
});
