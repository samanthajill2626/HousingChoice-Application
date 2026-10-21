// property-requirements (spec D2, D1, D5, D13; plan 2.4): a landlord's
// requirements are 15 `req_` keys on its contact, written one key at a time
// through PATCH /api/contacts/:contactId. Landlord-only on the RESULTING type;
// 400 deposit_conflict against a consistent read merged with the body; the
// audit contact_updated lists the req_ keys; never the tenant pets /
// pets_source / AI suggestion path; ignored by contact CREATE; and a landlord
// edit never touches a property. Runs on the shared in-memory world, like
// landlordContactFields.test.ts.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const LL = 'c-req-landlord';
const NOT_LANDLORD = { error: 'requirements can only be set on a landlord' };

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem>): void {
  world.contacts.push({
    contactId,
    status: 'active',
    created_at: '2026-10-01T10:00:00.000Z',
    ...fields,
  } as ContactItem);
}

function patchContact(
  app: import('express').Express,
  contactId: string,
  body: Record<string, unknown>,
) {
  return request(app)
    .patch(`/api/contacts/${contactId}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

function storedContact(world: FakeWorld, contactId: string): ContactItem | undefined {
  return world.contacts.find((c) => c.contactId === contactId);
}

/** Only the req_ keys of a contact (a stored item or a wire body). */
function reqKeysOf(contact: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(contact ?? {}).filter(([key]) => key.startsWith('req_')));
}

/** The `fields` of every contact_updated row for the contact, each sorted. */
function contactUpdatedFields(world: FakeWorld, contactId: string): string[][] {
  return world.auditEvents
    .filter((e) => e.entityKey === `contacts#${contactId}` && e.event_type === 'contact_updated')
    .map((e) => [...((e.payload?.['fields'] as string[] | undefined) ?? [])].sort());
}

describe('PATCH /api/contacts/:contactId - landlord requirement keys (D2)', () => {
  it('stores each key in its D1 kind, and GET returns it', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, { type: 'landlord' });
    const want = {
      req_no_evictions_on_program: true,
      req_credit_requirements: '600+ preferred',
      req_no_pets: true,
      req_pets: 'Service animals only',
      req_pet_fee: '$300 one-time',
      req_deposit: 1500,
      req_deposit_flexible: true,
      req_application_fee: 0,
      req_tour_type: 'landlord_led',
      req_tour_process: 'Text to schedule.',
    };
    const res = await patchContact(app, LL, want);
    expect(res.status).toBe(200);
    expect(reqKeysOf(res.body.contact)).toEqual(want);
    expect(reqKeysOf(storedContact(world, LL))).toEqual(want);
    const got = await request(app)
      .get(`/api/contacts/${LL}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .expect(200);
    expect(reqKeysOf(got.body.contact)).toEqual(want);
  });

  it('writes one key at a time: a later save leaves the other keys as stored', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, { type: 'landlord', req_no_pets: true, req_pets: 'Service animals only' });
    const res = await patchContact(app, LL, { req_pet_fee: '$250' });
    expect(res.status).toBe(200);
    expect(reqKeysOf(storedContact(world, LL))).toEqual({
      req_no_pets: true,
      req_pets: 'Service animals only',
      req_pet_fee: '$250',
    });
  });

  it('REMOVEs a key: false or null for a checkbox, "" or null for text, null for money, "" for tour type', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, {
      type: 'landlord',
      req_no_pets: true,
      req_deposit_flexible: true,
      req_pets: 'Cats OK',
      req_credit_requirements: '600+',
      req_deposit: 900,
      req_tour_type: 'pm_team',
      req_tour_process: 'Text the PM.',
    });
    const res = await patchContact(app, LL, {
      req_no_pets: false,
      req_deposit_flexible: null,
      req_pets: '',
      req_credit_requirements: null,
      req_deposit: null,
      req_tour_type: '',
      req_tour_process: null,
    });
    expect(res.status).toBe(200);
    expect(reqKeysOf(storedContact(world, LL))).toEqual({});
  });

  it.each<[string, unknown]>([
    ['req_pets', true], // no boolean pets on the landlord side (D2)
    ['req_no_pets', 'yes'],
    ['req_deposit', -5],
    ['req_application_fee', '25'],
    ['req_tour_type', 'walk_in'],
  ])('400s %s = %j and stores nothing', async (key, value) => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, { type: 'landlord' });
    const res = await patchContact(app, LL, { [key]: value });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain(key);
    expect(reqKeysOf(storedContact(world, LL))).toEqual({});
    expect(contactUpdatedFields(world, LL)).toEqual([]);
  });

  it('(PIN) ignores an unknown req_ key like any unknown contact key', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, { type: 'landlord' });
    const ok = await patchContact(app, LL, { company: 'Acme Homes', req_bogus: 'x' });
    expect(ok.status).toBe(200);
    expect(storedContact(world, LL)?.company).toBe('Acme Homes');
    expect('req_bogus' in (storedContact(world, LL) ?? {})).toBe(false);
    const alone = await patchContact(app, LL, { req_bogus: 'x' });
    expect(alone.status).toBe(400);
    expect(alone.body).toEqual({ error: 'no updatable fields supplied' });
  });
});

describe('landlord only - the RESULTING type (D2)', () => {
  it.each(['tenant', 'partner', 'team_member', 'unknown'] as const)(
    '400s on a %s and writes nothing',
    async (type) => {
      const { app, world } = makeWebhookHarness();
      seedContact(world, 'c-other', { type });
      const res = await patchContact(app, 'c-other', { req_credit_requirements: '600+' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(NOT_LANDLORD);
      expect(reqKeysOf(storedContact(world, 'c-other'))).toEqual({});
      expect(contactUpdatedFields(world, 'c-other')).toEqual([]);
    },
  );

  it('400s when the same body re-types a landlord to tenant - the type stays landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, { type: 'landlord' });
    const res = await patchContact(app, LL, { type: 'tenant', req_pets: 'Cats OK' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(NOT_LANDLORD);
    expect(storedContact(world, LL)?.type).toBe('landlord');
    expect(reqKeysOf(storedContact(world, LL))).toEqual({});
  });

  it('accepts the keys when the same body re-types a contact TO landlord', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, 'c-new', { type: 'unknown', status: 'needs_review' });
    const res = await patchContact(app, 'c-new', { type: 'landlord', req_pets: 'Cats OK' });
    expect(res.status).toBe(200);
    expect(storedContact(world, 'c-new')?.type).toBe('landlord');
    expect(reqKeysOf(storedContact(world, 'c-new'))).toEqual({ req_pets: 'Cats OK' });
  });

  it('404s an unknown contact', async () => {
    const { app } = makeWebhookHarness();
    const res = await patchContact(app, 'c-nobody', { req_pets: 'Cats OK' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'contact_not_found' });
  });

  it('reads the stored contact CONSISTENTLY when the body carries a req_ key', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, { type: 'landlord' });
    const reads = vi.spyOn(world.contactsRepo, 'getById');
    const res = await patchContact(app, LL, { req_pets: 'Cats OK' });
    expect(res.status).toBe(200);
    expect(reads).toHaveBeenCalledWith(LL, { consistentRead: true });
  });
});

describe('deposit_conflict - one month OR a fixed amount (D1)', () => {
  it('400s a one-month deposit over a stored fixed amount - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, { type: 'landlord', req_deposit: 1500 });
    const res = await patchContact(app, LL, { req_deposit_one_month: true });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'deposit_conflict' });
    expect(reqKeysOf(storedContact(world, LL))).toEqual({ req_deposit: 1500 });
  });

  it('400s a fixed amount over a stored one-month deposit', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, { type: 'landlord', req_deposit_one_month: true });
    const res = await patchContact(app, LL, { req_deposit: 1200 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'deposit_conflict' });
    expect(reqKeysOf(storedContact(world, LL))).toEqual({ req_deposit_one_month: true });
  });

  it('400s a body that sets both at once', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, { type: 'landlord' });
    const res = await patchContact(app, LL, { req_deposit_one_month: true, req_deposit: 1200 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'deposit_conflict' });
    expect(reqKeysOf(storedContact(world, LL))).toEqual({});
  });

  it("accepts the save that checks One month's rent and clears the amount in the same body", async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, { type: 'landlord', req_deposit: 1500 });
    const res = await patchContact(app, LL, { req_deposit_one_month: true, req_deposit: null });
    expect(res.status).toBe(200);
    expect(reqKeysOf(storedContact(world, LL))).toEqual({ req_deposit_one_month: true });
  });

  it('a body with no Deposit key is not checked, even over a stored conflict', async () => {
    const { app, world } = makeWebhookHarness();
    // Raw data only - the API can never store both.
    seedContact(world, LL, { type: 'landlord', req_deposit_one_month: true, req_deposit: 1500 });
    const res = await patchContact(app, LL, { req_pets: 'Cats OK' });
    expect(res.status).toBe(200);
    expect(storedContact(world, LL)?.['req_pets']).toBe('Cats OK');
  });
});

describe('audit and isolation', () => {
  it('contact_updated lists the req_ keys with the other changed fields (D13)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, { type: 'landlord' });
    const res = await patchContact(app, LL, { company: 'Acme Homes', req_no_pets: true, req_pet_fee: '$300' });
    expect(res.status).toBe(200);
    expect(contactUpdatedFields(world, LL)).toEqual([['company', 'req_no_pets', 'req_pet_fee']]);
    const audit = world.auditEvents.find((e) => e.event_type === 'contact_updated');
    expect(audit?.actorId).toBe(TEST_SESSION_USER.userId);
  });

  it('a req_pets write never touches the tenant pets, pets_source or the pending pets suggestion', async () => {
    const { app, world } = makeWebhookHarness();
    const petsSource = { source: 'ai', at: '2026-07-16T00:00:00.000Z', conversationId: 'conv-x' };
    seedContact(world, LL, { type: 'landlord', pets: 'yes', evictions: 'none', pets_source: petsSource });
    await world.extractionRepo.putSuggestion({
      ownerContactId: LL,
      target: 'pets',
      currentValue: 'yes',
      suggestedValue: 'no',
      conversationId: 'conv-x',
    });
    const suggestionReads = vi.spyOn(world.extractionRepo, 'getSuggestion');
    const writes = vi.spyOn(world.contactsRepo, 'update');
    const res = await patchContact(app, LL, { req_pets: 'Cats OK', req_no_evictions_on_program: true });
    expect(res.status).toBe(200);
    // The ONE contact write carries exactly the two req_ keys: no `pets`, no
    // `pets_source: null` provenance clear, no `evictions`.
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]?.[1]).toEqual({ req_pets: 'Cats OK', req_no_evictions_on_program: true });
    // No suggestion is read, so none can be superseded.
    expect(suggestionReads).not.toHaveBeenCalled();
    suggestionReads.mockRestore();
    const stored = storedContact(world, LL);
    expect(stored?.pets).toBe('yes');
    expect(stored?.evictions).toBe('none');
    expect(stored?.['pets_source']).toEqual(petsSource);
    expect(await world.extractionRepo.getSuggestion(LL, 'pets')).toMatchObject({
      target: 'pets',
      suggestedValue: 'no',
    });
    expect(contactUpdatedFields(world, LL)).toEqual([['req_no_evictions_on_program', 'req_pets']]);
  });

  it('a landlord edit never touches its properties (D5)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, LL, { type: 'landlord' });
    world.units.set('u-own', {
      unitId: 'u-own',
      landlordId: LL,
      status: 'available',
      pets: 'Cats OK',
      updated_at: '2026-09-01T10:00:00.000Z',
    } as UnitItem);
    const before = structuredClone(world.units.get('u-own'));
    const res = await patchContact(app, LL, { req_no_pets: true });
    expect(res.status).toBe(200);
    expect(world.units.get('u-own')).toEqual(before);
    expect(world.auditEvents.filter((e) => e.entityKey.startsWith('units#'))).toEqual([]);
  });
});

describe('contact CREATE', () => {
  it('(PIN) POST /api/contacts ignores req_ keys (the new-landlord form has Company only)', async () => {
    const { app, world } = makeWebhookHarness();
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'landlord', firstName: 'Pat', lastName: 'Owner', req_no_pets: true, req_credit_requirements: '600+' })
      .expect(201);
    expect(reqKeysOf(created.body.contact)).toEqual({});
    expect(reqKeysOf(storedContact(world, created.body.contact.contactId))).toEqual({});
  });
});
