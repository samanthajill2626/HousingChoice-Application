// flyer-leads D4-D7 (plan section 8): POST /public/housing-fair for EXISTING
// and NEW contacts - who counts as existing (findByPhone, the deleted path),
// the welcome for new contacts only, the signed_up thread pin and its 24-hour
// repeat check, the unread mark (touch -> increment -> ONE event), the flyer
// share entry and the audit fields. Harness world fakes (no DynamoDB), with
// the public router's injected clock (plan 2.6, AR3) driven by `clock.ms`.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem, ContactType } from '../src/repos/contactsRepo.js';
import type { ConversationType } from '../src/repos/conversationsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const FAIR = '/public/housing-fair';
/** signupBody's phone, normalized. */
const PHONE = '+15550102000';
const T0_ISO = '2026-10-21T15:00:00.000Z';
const T0 = Date.parse(T0_ISO);
const HOUR_MS = 3_600_000;

function signupBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { firstName: 'Keisha', lastName: 'Jones', phone: '(555) 010-2000', smsConsent: true, ...overrides };
}

/** A harness whose public router reads `clock.ms` (plan 2.6 `now`), with a rate limit no case reaches. */
function harness(env: Record<string, string> = {}) {
  const clock = { ms: T0 };
  const h = makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100', ...env }, publicNow: () => clock.ms });
  return { ...h, clock };
}

const post = (app: App, body: Record<string, unknown>) =>
  request(app).post(FAIR).set('x-origin-verify', ORIGIN_SECRET).send(body);

function seedUnit(world: FakeWorld, unitId = 'unit-1', over: Partial<UnitItem> = {}): UnitItem {
  const unit: UnitItem = {
    unitId,
    landlordId: 'll-1',
    status: 'available',
    address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' },
    ...over,
  };
  world.units.set(unitId, unit);
  return unit;
}

/** An existing contact on PHONE (a welcomed, searching tenant unless overridden). */
function seedContact(world: FakeWorld, over: Partial<ContactItem> = {}): ContactItem {
  const contact = {
    contactId: 'c-1',
    type: 'tenant',
    status: 'searching',
    phone: PHONE,
    firstName: 'Tia',
    lastName: 'Moss',
    housing_fair_welcomed: true,
    ...over,
  } as ContactItem;
  world.contacts.push(contact);
  return contact;
}

const signupAudits = (world: FakeWorld) => world.auditEvents.filter((e) => e.event_type === 'housing_fair_signup');

describe('who counts as an existing contact (D4) and the welcome for new contacts only (D5)', () => {
  it('an existing contact is never changed: no field written (consent included), no welcome, findByPhone the one lookup', async () => {
    const { app, world } = harness();
    seedUnit(world);
    // Never welcomed and no recorded consent: today's rule would have welcomed it and set the flag.
    seedContact(world, { status: 'needs_review', housing_fair_welcomed: false });
    const before = structuredClone(world.contacts);
    const update = vi.spyOn(world.contactsRepo, 'update');
    const create = vi.spyOn(world.contactsRepo, 'create');
    const findOne = vi.spyOn(world.contactsRepo, 'findByPhone');
    const findAll = vi.spyOn(world.contactsRepo, 'findAllByPhone');

    const res = await post(app, signupBody({ unitId: 'unit-1', voucherSize: 3 }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.sent).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findAll).not.toHaveBeenCalled();
    expect(world.contacts).toStrictEqual(before);
    expect(world.contacts[0]).not.toHaveProperty('consent_method');
  });

  const THREAD_TYPES: Array<[ContactType, ConversationType]> = [
    ['landlord', 'landlord_1to1'],
    ['partner', 'partner_1to1'],
    ['unknown', 'unknown_1to1'],
  ];

  it.each(THREAD_TYPES)('an existing %s with no thread gets a %s thread and no welcome', async (type, threadType) => {
    const { app, world } = harness();
    seedContact(world, { type, housing_fair_welcomed: undefined });

    const res = await post(app, signupBody());

    expect(res.status).toBe(200);
    expect([...world.conversations.values()].map((c) => [c.participant_phone, c.type])).toEqual([[PHONE, threadType]]);
    expect(world.sent).toHaveLength(0);
  });

  it('(PIN) a NEW contact gets a tenant_1to1 thread and exactly one welcome, and its flag', async () => {
    const { app, world } = harness();

    const res = await post(app, signupBody());

    expect(res.status).toBe(200);
    expect([...world.conversations.values()].map((c) => c.type)).toEqual(['tenant_1to1']);
    expect(world.sent).toHaveLength(1);
    expect(world.contacts.find((c) => c.phone === PHONE)?.housing_fair_welcomed).toBe(true);
  });

  it('a soft-deleted holder takes the deleted path: no conversation, no send, no new contact, no write - only the audit, on THAT contact', async () => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world, { contactId: 'c-del', deleted_at: '2026-10-01T00:00:00.000Z', housing_fair_welcomed: false });
    const before = structuredClone(world.contacts);
    const createOrGet = vi.spyOn(world.conversationsRepo, 'createOrGetByParticipantPhone');

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(createOrGet).not.toHaveBeenCalled();
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
    expect(world.contacts).toStrictEqual(before);
    expect(world.activityEvents).toHaveLength(0);
    expect(world.listingSends).toHaveLength(0);
    expect(world.unreadIncrements).toHaveLength(0);
    expect(signupAudits(world).map((e) => e.entityKey)).toEqual(['contacts#c-del']);
  });
});
