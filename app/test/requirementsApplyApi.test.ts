// property-requirements (spec D8, D5, D13; plan 2.1 planUnitApply, 2.3
// applyRequirements, 2.4): POST /api/contacts/:contactId/requirements/apply
// copies the landlord's CURRENT values of the listed items onto each listed
// property of record. Refusals (404 / 400 / 409) write nothing; then per unit,
// in request order: a consistent read, the pure plan, one conditional write,
// one unit_updated audit. Runs on the shared in-memory world
// (unitsLandlordOfRecord.test.ts pattern).
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { phoneRefId, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const LL = 'c-apply-landlord';
const OTHER_LL = 'c-apply-other-landlord';
const OLD = '2026-09-01T10:00:00.000Z';

// The route's 400 messages (contactRequirementsApply.ts).
const E_ITEMS = 'items must be a non-empty array of requirement item ids';
const E_EXPECTED = 'expected must hold exactly the listed items, each with exactly its keys';
const E_EXPECTED_VALUE = 'expected values must be a string, a number, a boolean or null';
const E_UNITS = 'units must be a non-empty array of at most 100 properties';
const E_UNIT_ID = 'each entry of units needs a unitId string';
const E_UNIT_REPEAT = 'units must not repeat a unitId';
const E_OWN_ITEMS = 'each entry of units needs ownItems, a list of items from items';

/** The landlord most cases apply from, stored as the contacts PATCH stores it. */
const LANDLORD_REQS: Record<string, unknown> = {
  req_credit_requirements: '600+ preferred',
  req_no_pets: true,
  req_pet_fee: '$300',
};
/** `expected` as the dialog sends it: every key of each listed item, null = blank. */
const EXPECTED_CREDIT = { credit_requirements: { credit_requirements: '600+ preferred' } };
const EXPECTED_PETS = { pets: { no_pets: true, pets: null, pet_fee: '$300' } };
const EXPECTED_BOTH = { ...EXPECTED_CREDIT, ...EXPECTED_PETS };
const EXPECTED_BLANK_DEPOSIT = {
  deposit: { deposit_one_month: null, deposit: null, deposit_flexible: null, deposit_notes: null },
};

type UnitRef = string | { unitId: string; ownItems: string[] };

function seedLandlord(world: FakeWorld, reqs: Record<string, unknown> = LANDLORD_REQS): void {
  world.contacts.push({
    contactId: LL,
    type: 'landlord',
    status: 'active',
    firstName: 'Lena',
    lastName: 'Lord',
    ...reqs,
  } as ContactItem);
}

function seedUnit(world: FakeWorld, unitId: string, fields: Record<string, unknown> = {}): void {
  world.units.set(unitId, {
    unitId,
    landlordId: LL,
    status: 'available',
    created_at: OLD,
    updated_at: OLD,
    ...fields,
  } as UnitItem);
}

function applyBody(items: string[], expected: Record<string, unknown>, units: UnitRef[]): Record<string, unknown> {
  return {
    items,
    expected,
    units: units.map((u) => (typeof u === 'string' ? { unitId: u, ownItems: [] } : u)),
  };
}

function postApply(app: import('express').Express, body: Record<string, unknown>, contactId = LL) {
  return request(app)
    .post(`/api/contacts/${encodeURIComponent(contactId)}/requirements/apply`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

function unitAudits(world: FakeWorld, unitId?: string): FakeWorld['auditEvents'] {
  return world.auditEvents.filter(
    (e) => e.event_type === 'unit_updated' && (unitId === undefined || e.entityKey === `units#${unitId}`),
  );
}

function sortedFields(e: FakeWorld['auditEvents'][number] | undefined): string[] {
  return [...((e?.payload?.['fields'] as string[] | undefined) ?? [])].sort();
}

function unitOf(world: FakeWorld, unitId: string): UnitItem | undefined {
  return world.units.get(unitId);
}

describe('refusals - each writes nothing', () => {
  it('404 contact_not_found for an unknown contact, before the body is read', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');
    const res = await postApply(app, { items: [] }, 'c-nobody');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'contact_not_found' });
    expect(unitAudits(world)).toEqual([]);
  });

  it('404 for a phone pointer row - a routing record, never a contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, { ...LANDLORD_REQS, phone: '+15550001111' });
    const pointerId = phoneRefId('+15550001111');
    world.contacts.push({
      contactId: pointerId,
      phone: '+15550001111',
      phone_ref: true,
      phone_ref_owner: LL,
    } as unknown as ContactItem);
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-1']), pointerId);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'contact_not_found' });
  });

  it.each(['tenant', 'partner', 'team_member', 'unknown'] as const)(
    '400 for a %s - contact is not a landlord',
    async (type) => {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({ contactId: 'c-not', type, status: 'active', ...LANDLORD_REQS } as ContactItem);
      seedUnit(world, 'u-1', { landlordId: 'c-not' });
      const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-1']), 'c-not');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'contact is not a landlord' });
      expect(unitOf(world, 'u-1')?.no_pets).toBeUndefined();
    },
  );

  const HUNDRED_AND_ONE = Array.from({ length: 101 }, (_, i) => `u-none-${i}`);
  it.each<[string, Record<string, unknown>, string]>([
    ['items missing', { expected: EXPECTED_PETS, units: [{ unitId: 'u-1', ownItems: [] }] }, E_ITEMS],
    ['items empty', applyBody([], {}, ['u-1']), E_ITEMS],
    ['items naming an unknown item', applyBody(['pets', 'pet_rent'], { ...EXPECTED_PETS, pet_rent: {} }, ['u-1']), E_ITEMS],
    ['expected missing', { items: ['pets'], units: [{ unitId: 'u-1', ownItems: [] }] }, E_EXPECTED],
    ['expected missing a listed item', applyBody(['credit_requirements', 'pets'], EXPECTED_PETS, ['u-1']), E_EXPECTED],
    ['expected naming an unlisted item', applyBody(['pets'], EXPECTED_BOTH, ['u-1']), E_EXPECTED],
    ['an expected item missing a key', applyBody(['pets'], { pets: { no_pets: true, pets: null } }, ['u-1']), E_EXPECTED],
    [
      'an expected item with an extra key',
      applyBody(['pets'], { pets: { no_pets: true, pets: null, pet_fee: '$300', pet_rent: null } }, ['u-1']),
      E_EXPECTED,
    ],
    ['an expected item that is not an object', applyBody(['pets'], { pets: 'No pets' }, ['u-1']), E_EXPECTED],
    [
      'an expected value that is an object',
      applyBody(['pets'], { pets: { no_pets: true, pets: { text: 'x' }, pet_fee: '$300' } }, ['u-1']),
      E_EXPECTED_VALUE,
    ],
    ['units missing', { items: ['pets'], expected: EXPECTED_PETS }, E_UNITS],
    ['units empty', applyBody(['pets'], EXPECTED_PETS, []), E_UNITS],
    ['units over 100', applyBody(['pets'], EXPECTED_PETS, HUNDRED_AND_ONE), E_UNITS],
    ['a unit without a unitId', { items: ['pets'], expected: EXPECTED_PETS, units: [{ ownItems: [] }] }, E_UNIT_ID],
    ['a repeated unit', applyBody(['pets'], EXPECTED_PETS, ['u-1', 'u-1']), E_UNIT_REPEAT],
    ['a unit without ownItems', { items: ['pets'], expected: EXPECTED_PETS, units: [{ unitId: 'u-1' }] }, E_OWN_ITEMS],
    [
      'ownItems naming an unlisted item',
      applyBody(['pets'], EXPECTED_PETS, [{ unitId: 'u-1', ownItems: ['credit_requirements'] }]),
      E_OWN_ITEMS,
    ],
  ])('400 for %s', async (_case, body, error) => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-1', { pets: 'Cats OK' });
    const res = await postApply(app, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect(unitOf(world, 'u-1')?.pets).toBe('Cats OK');
    expect(unitOf(world, 'u-1')?.updated_at).toBe(OLD);
    expect(unitAudits(world)).toEqual([]);
  });

  it('409 deposit_conflict when the landlord holds both deposit forms', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, { ...LANDLORD_REQS, req_deposit_one_month: true, req_deposit: 1500 });
    seedUnit(world, 'u-1');
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-1']));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'deposit_conflict' });
    expect(unitOf(world, 'u-1')?.no_pets).toBeUndefined();
    expect(unitAudits(world)).toEqual([]);
  });

  it('a malformed body is a 400 before deposit_conflict', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, { ...LANDLORD_REQS, req_deposit_one_month: true, req_deposit: 1500 });
    const res = await postApply(app, applyBody([], {}, ['u-1']));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: E_ITEMS });
  });

  it('409 requirements_changed when a listed item is no longer what the dialog showed', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, { ...LANDLORD_REQS, req_pet_fee: '$350' });
    seedUnit(world, 'u-1');
    const res = await postApply(app, applyBody(['credit_requirements', 'pets'], EXPECTED_BOTH, ['u-1']));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'requirements_changed' });
    expect(unitOf(world, 'u-1')?.credit_requirements).toBeUndefined();
    expect(unitAudits(world)).toEqual([]);
  });

  it('deposit_conflict is answered before requirements_changed', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, { ...LANDLORD_REQS, req_pet_fee: '$350', req_deposit_one_month: true, req_deposit: 1500 });
    seedUnit(world, 'u-1');
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-1']));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'deposit_conflict' });
  });
});

describe('the landlord comparison (D1 equality)', () => {
  it('an UNLISTED item that changed is no conflict and is not copied', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, { ...LANDLORD_REQS, req_income_requirements: '3x the rent' });
    seedUnit(world, 'u-1');
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-1']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['u-1'], skipped: [] });
    expect(unitOf(world, 'u-1')?.income_requirements).toBeUndefined();
  });

  it("'' and false in expected read as blank", async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world); // holds no deposit
    seedUnit(world, 'u-1', { deposit: 900, requirement_sources: { deposit: 'copied' } });
    const res = await postApply(
      app,
      applyBody(
        ['deposit'],
        { deposit: { deposit_one_month: false, deposit: null, deposit_flexible: false, deposit_notes: '' } },
        ['u-1'],
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['u-1'], skipped: [] });
    expect(unitOf(world, 'u-1')?.deposit).toBeUndefined();
  });
});

describe('writes (D8, D5, D13)', () => {
  it('copies every key of each listed item, records them copied, stamps updated_at and audits once', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-1');
    const contactWrites = vi.spyOn(world.contactsRepo, 'update');
    const res = await postApply(app, applyBody(['credit_requirements', 'pets'], EXPECTED_BOTH, ['u-1']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['u-1'], skipped: [] });
    const u = unitOf(world, 'u-1');
    expect(u?.credit_requirements).toBe('600+ preferred');
    expect(u?.no_pets).toBe(true);
    expect(u?.pet_fee).toBe('$300');
    expect('pets' in (u ?? {})).toBe(false);
    expect(u?.requirement_sources).toEqual({ credit_requirements: 'copied', pets: 'copied' });
    expect(u?.updated_at).not.toBe(OLD);
    const audits = unitAudits(world, 'u-1');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityKey: 'units#u-1',
      actorId: TEST_SESSION_USER.userId,
      payload: { actor: TEST_SESSION_USER.userId, reason: 'requirements_applied', landlordId: LL },
    });
    // The unit keys the write changed - never requirement_sources.
    expect(sortedFields(audits[0])).toEqual(['credit_requirements', 'no_pets', 'pet_fee']);
    // The landlord contact itself is never written.
    expect(contactWrites).not.toHaveBeenCalled();
  });

  it('reads the landlord and each unit CONSISTENTLY', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-1');
    const contactReads = vi.spyOn(world.contactsRepo, 'getById');
    const unitReads = vi.spyOn(world.unitsRepo, 'getById');
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-1']));
    expect(res.status).toBe(200);
    expect(contactReads).toHaveBeenCalledWith(LL, { consistentRead: true });
    expect(unitReads).toHaveBeenCalledWith('u-1', { consistentRead: true });
  });

  it('a blank landlord item clears that item on the unit (the dialog\'s "Clears")', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-2', { deposit: 1400, deposit_flexible: true, requirement_sources: { deposit: 'copied' } });
    const res = await postApply(app, applyBody(['deposit'], EXPECTED_BLANK_DEPOSIT, ['u-2']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['u-2'], skipped: [] });
    const u = unitOf(world, 'u-2');
    expect(u?.deposit).toBeUndefined();
    expect(u?.deposit_flexible).toBeUndefined();
    expect(u?.requirement_sources).toEqual({ deposit: 'copied' });
    expect(sortedFields(unitAudits(world, 'u-2')[0])).toEqual(['deposit', 'deposit_flexible']);
  });

  it('normalizes the pets pair: a legacy true becomes No pets with the details REMOVEd', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-3', { pets: true, requirement_sources: { pets: 'copied' } });
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-3']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['u-3'], skipped: [] });
    const u = unitOf(world, 'u-3');
    expect(u?.no_pets).toBe(true);
    expect('pets' in (u ?? {})).toBe(false);
    expect(u?.pet_fee).toBe('$300');
    expect(u?.requirement_sources).toEqual({ pets: 'copied' });
    expect(sortedFields(unitAudits(world, 'u-3')[0])).toEqual(['no_pets', 'pet_fee', 'pets']);
  });

  it("a legacy false that already reads as the landlord's No pets is already_matches - not rewritten", async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, { req_no_pets: true });
    seedUnit(world, 'u-4', { pets: false });
    const res = await postApply(app, applyBody(['pets'], { pets: { no_pets: true, pets: null, pet_fee: null } }, ['u-4']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: [], skipped: [{ unitId: 'u-4', reason: 'already_matches' }] });
    const u = unitOf(world, 'u-4');
    expect(u?.pets).toBe(false);
    expect('no_pets' in (u ?? {})).toBe(false);
    expect('requirement_sources' in (u ?? {})).toBe(false);
    expect(u?.updated_at).toBe(OLD);
    expect(unitAudits(world)).toEqual([]);
  });

  it('a listed item that already equals the landlord keeps its set_here record', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-5', {
      credit_requirements: '600+ preferred',
      requirement_sources: { credit_requirements: 'set_here' },
    });
    const res = await postApply(app, applyBody(['credit_requirements', 'pets'], EXPECTED_BOTH, ['u-5']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['u-5'], skipped: [] });
    expect(unitOf(world, 'u-5')?.requirement_sources).toEqual({ credit_requirements: 'set_here', pets: 'copied' });
    expect(sortedFields(unitAudits(world, 'u-5')[0])).toEqual(['no_pets', 'pet_fee']);
  });

  it('already_matches when no listed item would change - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-6', {
      credit_requirements: '600+ preferred',
      no_pets: true,
      pet_fee: '$300',
      requirement_sources: { credit_requirements: 'copied', pets: 'copied' },
    });
    const res = await postApply(app, applyBody(['credit_requirements', 'pets'], EXPECTED_BOTH, ['u-6']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: [], skipped: [{ unitId: 'u-6', reason: 'already_matches' }] });
    expect(unitOf(world, 'u-6')?.updated_at).toBe(OLD);
    expect(unitAudits(world)).toEqual([]);
  });
});

describe('own values (the D6 definition) and ownItems', () => {
  it('an own value the request did not accept is skipped as changed_since_opened', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-7', { pets: 'Cats OK' }); // never touched, not blank
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-7']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: [], skipped: [{ unitId: 'u-7', reason: 'changed_since_opened' }] });
    expect(unitOf(world, 'u-7')?.pets).toBe('Cats OK');
    expect(unitOf(world, 'u-7')?.no_pets).toBeUndefined();
    expect(unitAudits(world)).toEqual([]);
  });

  it('a set_here record is an own value too', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-8', { pet_fee: '$200', requirement_sources: { pets: 'set_here' } });
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-8']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: [], skipped: [{ unitId: 'u-8', reason: 'changed_since_opened' }] });
    expect(unitOf(world, 'u-8')?.pet_fee).toBe('$200');
  });

  it('an own value accepted in ownItems is overwritten whole - never "No pets (Cats OK)"', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-7', { pets: 'Cats OK' });
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, [{ unitId: 'u-7', ownItems: ['pets'] }]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['u-7'], skipped: [] });
    const u = unitOf(world, 'u-7');
    expect(u?.no_pets).toBe(true);
    expect('pets' in (u ?? {})).toBe(false);
    expect(u?.pet_fee).toBe('$300');
    expect(u?.requirement_sources).toEqual({ pets: 'copied' });
    expect(sortedFields(unitAudits(world, 'u-7')[0])).toEqual(['no_pets', 'pet_fee', 'pets']);
  });

  it('an own value in an item the request does not list never holds the unit back', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-9', { pets: 'Cats OK' });
    const res = await postApply(app, applyBody(['credit_requirements'], EXPECTED_CREDIT, ['u-9']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['u-9'], skipped: [] });
    expect(unitOf(world, 'u-9')?.pets).toBe('Cats OK');
    expect(unitOf(world, 'u-9')?.requirement_sources).toEqual({ credit_requirements: 'copied' });
  });

  it('an all-blank landlord: a Clears item meets existing values - own values skipped only when not in ownItems', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, {});
    seedUnit(world, 'u-own', { deposit: 1500 });
    seedUnit(world, 'u-own-accepted', { deposit: 1450 });
    seedUnit(world, 'u-copied', { deposit: 1300, requirement_sources: { deposit: 'copied' } });
    seedUnit(world, 'u-blank');
    const res = await postApply(
      app,
      applyBody(['deposit'], EXPECTED_BLANK_DEPOSIT, [
        'u-own',
        { unitId: 'u-own-accepted', ownItems: ['deposit'] },
        'u-copied',
        'u-blank',
      ]),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      updated: ['u-own-accepted', 'u-copied'],
      skipped: [
        { unitId: 'u-own', reason: 'changed_since_opened' },
        { unitId: 'u-blank', reason: 'already_matches' },
      ],
    });
    expect(unitOf(world, 'u-own')?.deposit).toBe(1500);
    expect(unitOf(world, 'u-own-accepted')?.deposit).toBeUndefined();
    expect(unitOf(world, 'u-own-accepted')?.requirement_sources).toEqual({ deposit: 'copied' });
    expect(unitOf(world, 'u-copied')?.deposit).toBeUndefined();
    expect(unitOf(world, 'u-copied')?.requirement_sources).toEqual({ deposit: 'copied' });
    expect('requirement_sources' in (unitOf(world, 'u-blank') ?? {})).toBe(false);
  });
});

describe('skip reasons', () => {
  it('not_found, deleted and landlord_changed, in request order - nothing written to them', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-deleted', { deleted_at: '2026-10-01T00:00:00.000Z' });
    seedUnit(world, 'u-other', { landlordId: OTHER_LL });
    seedUnit(world, 'u-ok');
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-missing', 'u-deleted', 'u-other', 'u-ok']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      updated: ['u-ok'],
      skipped: [
        { unitId: 'u-missing', reason: 'not_found' },
        { unitId: 'u-deleted', reason: 'deleted' },
        { unitId: 'u-other', reason: 'landlord_changed' },
      ],
    });
    expect(world.units.has('u-missing')).toBe(false);
    expect(unitOf(world, 'u-deleted')?.no_pets).toBeUndefined();
    expect(unitOf(world, 'u-other')?.no_pets).toBeUndefined();
    expect(unitAudits(world).map((e) => e.entityKey)).toEqual(['units#u-ok']);
  });

  it('a write whose condition fails is skipped as changed_during_apply, and the run goes on', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-a');
    seedUnit(world, 'u-b');
    vi.spyOn(world.unitsRepo, 'applyRequirements').mockRejectedValueOnce(
      new ConditionalCheckFailedException({ message: 'raced', $metadata: {} }),
    );
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-a', 'u-b']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['u-b'], skipped: [{ unitId: 'u-a', reason: 'changed_during_apply' }] });
    expect(unitOf(world, 'u-a')?.no_pets).toBeUndefined();
    expect(unitAudits(world).map((e) => e.entityKey)).toEqual(['units#u-b']);
  });

  it('an exception set between the read and the write is never overwritten', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-race');
    // The harness getById is NOT mocked: it hands the route the LIVE stored
    // object (twilioWebhookHarness.ts:2886-2888). A colleague's write then lands
    // on the stored unit after the route's read and before its write: the
    // wrapper mutates the stored unit, then calls the real fenced write with
    // exactly what the route passed. Only a route that fences against its OWN
    // copy of the read (ruling AR6) sees the race; a route passing the live
    // object would compare the mutated unit with itself and overwrite the
    // exception.
    const realApply = world.unitsRepo.applyRequirements.bind(world.unitsRepo);
    let passedRead: UnitItem | undefined;
    vi.spyOn(world.unitsRepo, 'applyRequirements').mockImplementationOnce(async (read, patch) => {
      passedRead = read;
      const live = world.units.get(read.unitId);
      if (live !== undefined) {
        live.pets = 'Dogs OK';
        live.requirement_sources = { pets: 'set_here' };
      }
      return realApply(read, patch);
    });
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-race']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: [], skipped: [{ unitId: 'u-race', reason: 'changed_during_apply' }] });
    expect(passedRead).not.toBe(world.units.get('u-race'));
    expect(unitOf(world, 'u-race')?.pets).toBe('Dogs OK');
    expect(unitOf(world, 'u-race')?.no_pets).toBeUndefined();
    expect(unitOf(world, 'u-race')?.requirement_sources).toEqual({ pets: 'set_here' });
    expect(unitAudits(world)).toEqual([]);
  });
});

describe('audit failure and the cap', () => {
  it('an audit append that fails is logged, never thrown - the units stay updated', async () => {
    const { app, world, capture } = makeWebhookHarness();
    seedLandlord(world);
    seedUnit(world, 'u-1');
    seedUnit(world, 'u-2');
    world.failAuditAppendFor.add('unit_updated');
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ['u-1', 'u-2']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: ['u-1', 'u-2'], skipped: [] });
    expect(unitOf(world, 'u-1')?.no_pets).toBe(true);
    expect(unitOf(world, 'u-2')?.no_pets).toBe(true);
    const warns = capture
      .atLevel(40)
      .filter((l) => l['msg'] === 'requirements apply: audit append failed (best-effort)');
    expect(warns).toHaveLength(2);
    expect(warns[0]).toMatchObject({ contactId: LL, unitId: 'u-1' });
  });

  it('accepts exactly 100 properties in one request (101 is the 400 above)', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world);
    const ids = Array.from({ length: 100 }, (_, i) => `u-none-${i}`);
    const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, ids));
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect(res.body.skipped).toEqual(ids.map((unitId) => ({ unitId, reason: 'not_found' })));
  });
});
