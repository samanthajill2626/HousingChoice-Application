// flyer-leads D4-D7 (plan section 8): POST /public/housing-fair for EXISTING
// and NEW contacts - who counts as existing (findByPhone, the deleted path),
// the welcome for new contacts only, the signed_up thread pin and its 24-hour
// repeat check, the unread mark (touch -> increment -> ONE event), the flyer
// share entry and the audit fields. Harness world fakes (no DynamoDB), with
// the public router's injected clock (plan 2.6, AR3) driven by `clock.ms`.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { phoneRefId, type ContactItem, type ContactType } from '../src/repos/contactsRepo.js';
import { seedFlyerSignUp, seedListingSend } from './helpers/listingSendSeed.js';
import { toConversationUpdatedEvent } from '../src/lib/events.js';
import type { ConversationItem, ConversationType } from '../src/repos/conversationsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
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

/**
 * A harness whose public router reads `clock.ms` (plan 2.6 `now`), with a rate
 * limit no case reaches. `now` is that injected clock as a spy, so a case can
 * pin AR8 #2's ONE reading per post and when it is taken (OR-16).
 */
function harness(env: Record<string, string> = {}) {
  const clock = { ms: T0 };
  const now = vi.fn(() => clock.ms);
  const h = makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100', ...env }, publicNow: now });
  return { ...h, clock, now };
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
const pins = (world: FakeWorld) => world.activityEvents.filter((e) => e.type === 'signed_up');
const convUpdates = (world: FakeWorld) =>
  world.emitted.filter((e) => e.event === 'conversation.updated').map((e) => e.payload as Record<string, unknown>);
const stepFailures = (capture: { lines: Record<string, unknown>[] }) =>
  capture.lines.filter((l) => l['msg'] === 'housing-fair signup step failed');
const captured = (capture: { lines: Record<string, unknown>[] }) =>
  capture.lines.filter((l) => l['msg'] === 'housing-fair signup captured');

/** Plan 1.1 labels for signupBody's name. */
const FLYER_LABEL = 'Signed up from the flyer for 12 Oak St, Atlanta, GA 30303 as Keisha Jones';
const A_FLYER_LABEL = 'Signed up from a flyer as Keisha Jones';
const JOIN_LABEL = 'Signed up on the join page as Keisha Jones';

/** An earlier counted send of unit-1 to c-1. */
const SENT_AT = '2026-10-01T10:00:00.000Z';
/** Plan 2.2: the flyer entry a sign-up at `iso` writes. */
const flyerEntry = (iso: string) => ({ attempt: `${iso}#flyer`, state: 'counted', by: 'acceptance', countedAt: iso });
const ledgerRow = (world: FakeWorld, unitId = 'unit-1', contactId = 'c-1') =>
  world.listingSendsRepo.getByKeyConsistent(unitId, contactId);

/** The pair's outcome on the contact page's Properties sent read (S3 derives signed_up). */
async function outcomeOf(app: App, contactId = 'c-1', unitId = 'unit-1'): Promise<string | undefined> {
  const res = await request(app)
    .get(`/api/contacts/${contactId}/listings-sent`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
  expect(res.status).toBe(200);
  return (res.body.sent as Array<{ unitId: string; outcome: string }>).find((r) => r.unitId === unitId)?.outcome;
}

/** The existing contact's open 1:1 thread, read and quiet. */
function seedThread(world: FakeWorld, over: Partial<ConversationItem> = {}): ConversationItem {
  const conv: ConversationItem = {
    conversationId: 'conv-1',
    participant_phone: PHONE,
    status: 'open',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    last_activity_at: '2026-10-01T10:00:00.000Z',
    last_message_preview: 'Is the place on Oak still open?',
    unread_count: 0,
    participants: [{ contactId: 'c-1', phone: PHONE }],
    created_at: '2026-10-01T10:00:00.000Z',
    ...over,
  };
  world.conversations.set(conv.conversationId, conv);
  return conv;
}

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

describe('the signed_up pin and the unread mark (D6)', () => {
  it('an existing tenant on a flyer: no text, ONE pin with the flyer label and the unit ref, the thread touched then unread, ONE event with the new count', async () => {
    const { app, world, capture, now } = harness();
    seedUnit(world);
    seedContact(world);
    seedThread(world);

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.sent).toHaveLength(0);
    expect(pins(world)).toEqual([
      expect.objectContaining({ contactId: 'c-1', label: FLYER_LABEL, refType: 'unit', refId: 'unit-1', at: T0_ISO }),
    ]);
    // ONE touch at the sign-up instant with the preview untouched (the order is pinned by the next case).
    expect(world.touches).toEqual([{ conversationId: 'conv-1', previewText: undefined, ts: T0_ISO }]);
    expect(world.unreadIncrements).toEqual(['conv-1']);
    expect(world.conversations.get('conv-1')).toMatchObject({
      status: 'open',
      last_activity_at: T0_ISO,
      last_message_preview: 'Is the place on Oak still open?',
      unread_count: 1,
      unread_flag: 'unread',
    });
    expect(convUpdates(world)).toEqual([
      expect.objectContaining({
        conversationId: 'conv-1',
        last_activity_at: T0_ISO,
        unread_count: 1,
        type: 'tenant_1to1',
        preview: 'Is the place on Oak still open?',
      }),
    ]);
    expect(captured(capture)).toEqual([expect.objectContaining({ recorded: true })]);
    // AR8 #2 (OR-16): ONE clock reading per post feeds the window, the pin and the touch.
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('an existing contact on a CLOSED thread: touch (which reopens it) runs BEFORE the increment, and the ONE event is built from the touched image', async () => {
    // The harness fake reuses only OPEN threads while the real repo adopts a closed one (its phone claim), so the adoption is stubbed and the order pinned by spies.
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world);
    const closed = seedThread(world, { status: 'closed' });
    vi.spyOn(world.conversationsRepo, 'createOrGetByParticipantPhone').mockResolvedValue(closed);
    const touch = vi.spyOn(world.conversationsRepo, 'touchLastActivity');
    const increment = vi.spyOn(world.conversationsRepo, 'incrementUnread');

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(touch).toHaveBeenCalledTimes(1);
    expect(increment).toHaveBeenCalledTimes(1);
    expect(touch.mock.invocationCallOrder[0]).toBeLessThan(increment.mock.invocationCallOrder[0] ?? 0);
    const touched = (await touch.mock.results[0]?.value) as ConversationItem;
    expect(touched).toMatchObject({ conversationId: 'conv-1', status: 'open', last_activity_at: T0_ISO });
    expect(world.conversations.get('conv-1')).toMatchObject({ status: 'open', unread_count: 1 });
    expect(convUpdates(world)).toEqual([{ ...toConversationUpdatedEvent(touched), unread_count: 1 }]);
  });

  it('the flyer label falls back to the unitId when the property has no address, and carries the TRIMMED typed name', async () => {
    const { app, world } = harness();
    seedUnit(world, 'unit-bare', { address: undefined });
    seedContact(world);

    await post(app, signupBody({ unitId: 'unit-bare', firstName: '  Keisha ', lastName: ' Jones  ' }));

    expect(pins(world).map((p) => [p.label, p.refType, p.refId])).toEqual([
      ['Signed up from the flyer for unit-bare as Keisha Jones', 'unit', 'unit-bare'],
    ]);
  });

  it('/join: the join-page label and no ref', async () => {
    const { app, world } = harness();
    seedContact(world);

    await post(app, signupBody());

    expect(pins(world)).toEqual([expect.objectContaining({ contactId: 'c-1', label: JOIN_LABEL, at: T0_ISO })]);
    expect(pins(world)[0]).not.toHaveProperty('refType');
    expect(pins(world)[0]).not.toHaveProperty('refId');
  });

  it.each([
    ['a placed property', 'unit-placed'],
    ['a deleted property', 'unit-deleted'],
    ['a made-up unitId', 'no-such-unit'],
  ])('a flyer for %s: the "from a flyer" label and no ref', async (_what, unitId) => {
    const { app, world } = harness();
    seedUnit(world, 'unit-placed', { status: 'placed' });
    seedUnit(world, 'unit-deleted', { deleted_at: '2026-10-01T00:00:00.000Z' });
    seedContact(world);

    await post(app, signupBody({ unitId }));

    expect(pins(world)).toEqual([expect.objectContaining({ label: A_FLYER_LABEL })]);
    expect(pins(world)[0]).not.toHaveProperty('refId');
  });

  it('an existing landlord with no thread: a landlord_1to1 thread gets the pin and the unread mark, and no welcome', async () => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world, { contactId: 'c-ll', type: 'landlord', status: 'active' });

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect([...world.conversations.values()].map((c) => [c.type, c.unread_count])).toEqual([['landlord_1to1', 1]]);
    expect(pins(world)).toEqual([expect.objectContaining({ contactId: 'c-ll', label: FLYER_LABEL, refId: 'unit-1' })]);
    expect(world.sent).toHaveLength(0);
  });

  // OR-14 (R5 F1): the mark is for the contact's 1:1 thread ONLY. A relay group
  // stores its POOL number as participant_phone, and the thread read returns
  // the first OPEN item for a phone whatever its type, so a sign-up typed with
  // a pool number resolves to the relay group - where a touch could reopen a
  // group staff just closed. The mark is skipped (WARN, step touch); the pin
  // still goes ahead. A pool number has no holder at first; a second sign-up
  // with it finds the junk contact the first one created.
  it.each([
    ['a new holder', false],
    ['an existing holder', true],
  ])('a sign-up typed with a relay group pool number, %s: the relay thread is never touched, marked or emitted', async (_what, existingHolder) => {
    const { app, world, capture } = harness();
    seedUnit(world);
    if (existingHolder) seedContact(world);
    const relay = seedThread(world, {
      conversationId: 'relay-1',
      type: 'relay_group',
      pool_number: PHONE,
      last_message_preview: 'Tour confirmed for Saturday',
      participants: [
        { contactId: 'c-m1', phone: '+15550109001' },
        { contactId: 'c-m2', phone: '+15550109002' },
      ],
    });
    const before = structuredClone(relay);

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.conversations.get('relay-1')).toEqual(before);
    expect(world.touches).toEqual([]);
    expect(world.unreadIncrements).toEqual([]);
    expect(convUpdates(world)).toEqual([]);
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'touch', reason: 'group_thread', level: 40 })]);
    expect(pins(world)).toEqual([expect.objectContaining({ label: FLYER_LABEL, refType: 'unit', refId: 'unit-1' })]);
    // The flyer entry is unaffected too (D7).
    const holder = world.contacts.find((c) => c.phone === PHONE);
    expect((await ledgerRow(world, 'unit-1', holder?.contactId ?? ''))?.shares).toEqual({ flyer: flyerEntry(T0_ISO) });
  });

  it('a NEW contact on a flyer: the welcome first, then the pin and the unread mark - and no repeat read', async () => {
    const { app, world, now } = harness();
    seedUnit(world);
    const since = vi.spyOn(world.activityEventsRepo, 'hasEventSince');
    const providerSend = vi.spyOn(world.adapter, 'sendPreparedMessage');
    const touch = vi.spyOn(world.conversationsRepo, 'touchLastActivity');

    await post(app, signupBody({ unitId: 'unit-1' }));

    const contact = world.contacts.find((c) => c.phone === PHONE);
    expect(world.sent).toHaveLength(1);
    expect(since).not.toHaveBeenCalled();
    expect(pins(world)).toEqual([
      expect.objectContaining({ contactId: contact?.contactId, label: FLYER_LABEL, refId: 'unit-1', at: T0_ISO }),
    ]);
    // The welcome's own touch carries its body; the mark's touch comes AFTER it and carries none.
    expect(world.touches.map((t) => t.previewText === undefined)).toEqual([false, true]);
    expect(world.touches.at(-1)?.ts).toBe(T0_ISO);
    const thread = [...world.conversations.values()][0];
    expect(thread).toMatchObject({ type: 'tenant_1to1', unread_count: 1 });
    expect(convUpdates(world).at(-1)).toMatchObject({ conversationId: thread?.conversationId, unread_count: 1 });
    // AR8 #2 (OR-16): ONE clock reading, taken AFTER the welcome - its provider
    // send and its own touch - and before the unread mark's touch.
    expect(now).toHaveBeenCalledTimes(1);
    const clockAt = now.mock.invocationCallOrder[0] ?? 0;
    expect(providerSend.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(clockAt);
    expect(touch.mock.invocationCallOrder).toHaveLength(2);
    expect(touch.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(clockAt);
    expect(clockAt).toBeLessThan(touch.mock.invocationCallOrder[1] ?? 0);
  });

  it('a NEW contact on a flyer whose welcome is refused still gets the flyer pin and the unread mark', async () => {
    const { app, world } = harness({ SMS_SENDING_ENABLED: 'false' });
    seedUnit(world);

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(world.sent).toHaveLength(0);
    expect(pins(world)).toEqual([expect.objectContaining({ label: FLYER_LABEL, refType: 'unit', refId: 'unit-1' })]);
    expect([...world.conversations.values()].map((c) => c.unread_count)).toEqual([1]);
  });

  it('the pin reaches the contact timeline with its label and its unit ref', async () => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world);

    await post(app, signupBody({ unitId: 'unit-1' }));
    const res = await request(app)
      .get('/api/contacts/c-1/timeline?kinds=milestone')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({ kind: 'milestone', type: 'signed_up', at: T0_ISO, label: FLYER_LABEL, refType: 'unit', refId: 'unit-1' }),
    ]);
  });
});

describe('the repeat check: one pin and one bump per contact per source per 24 hours (D6.1)', () => {
  it('the SAME property: no second pin or bump within 24 hours; after 24 hours both again', async () => {
    const { app, world, clock } = harness();
    seedUnit(world);
    seedContact(world);
    seedThread(world);
    const since = vi.spyOn(world.activityEventsRepo, 'hasEventSince');

    await post(app, signupBody({ unitId: 'unit-1' }));
    clock.ms = T0 + 23 * HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(pins(world)).toHaveLength(1);
    expect(world.unreadIncrements).toEqual(['conv-1']);
    expect(convUpdates(world)).toHaveLength(1);

    clock.ms = T0 + 25 * HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-1' }));

    // The window is the 24 hours before THIS sign-up, on this property's source.
    expect(since).toHaveBeenLastCalledWith('c-1', 'signed_up', new Date(T0 + HOUR_MS).toISOString(), 'unit-1');
    expect(pins(world).map((p) => p.at)).toEqual([T0_ISO, new Date(T0 + 25 * HOUR_MS).toISOString()]);
    expect(world.conversations.get('conv-1')?.unread_count).toBe(2);
    expect(convUpdates(world)).toHaveLength(2);
  });

  it('a DIFFERENT property within 24 hours records its own pin and bump', async () => {
    const { app, world, clock } = harness();
    seedUnit(world, 'unit-1');
    seedUnit(world, 'unit-2', { address: { line1: '9 Pine Rd', city: 'Decatur', state: 'GA' } });
    seedContact(world);
    seedThread(world);

    await post(app, signupBody({ unitId: 'unit-1' }));
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-2' }));

    expect(pins(world).map((p) => [p.refId, p.label])).toEqual([
      ['unit-1', FLYER_LABEL],
      ['unit-2', 'Signed up from the flyer for 9 Pine Rd, Decatur, GA as Keisha Jones'],
    ]);
    expect(world.conversations.get('conv-1')?.unread_count).toBe(2);
  });

  it('/join twice within 24 hours: one pin and one bump', async () => {
    const { app, world, clock } = harness();
    seedContact(world);
    seedThread(world);

    await post(app, signupBody());
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody());

    expect(pins(world)).toHaveLength(1);
    expect(world.unreadIncrements).toEqual(['conv-1']);
  });

  it('/join, then a flyer for an unavailable property within 24 hours: one pin (the shared no-property source)', async () => {
    const { app, world, clock } = harness();
    seedUnit(world, 'unit-placed', { status: 'placed' });
    seedContact(world);
    seedThread(world);

    await post(app, signupBody());
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-placed' }));

    expect(pins(world).map((p) => p.label)).toEqual([JOIN_LABEL]);
    expect(world.unreadIncrements).toEqual(['conv-1']);
  });

  it('made-up unitIds all share the no-property source: one pin, read with no ref', async () => {
    const { app, world, clock } = harness();
    seedContact(world);
    const since = vi.spyOn(world.activityEventsRepo, 'hasEventSince');

    await post(app, signupBody({ unitId: 'no-such-1' }));
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody({ unitId: 'no-such-2' }));
    clock.ms = T0 + 2 * HOUR_MS;
    await post(app, signupBody());

    expect(pins(world).map((p) => p.label)).toEqual([A_FLYER_LABEL]);
    expect(since.mock.calls.map((c) => c[3])).toEqual([undefined, undefined, undefined]);
  });
});

describe('the pin and the unread mark are best-effort (D6.4)', () => {
  function existingOnFlyer() {
    const h = harness();
    seedUnit(h.world);
    seedContact(h.world);
    seedThread(h.world);
    return h;
  }

  it('a failed repeat read fails OPEN: the pin and the unread mark are recorded; WARN step repeat_check', async () => {
    const { app, world, capture } = existingOnFlyer();
    vi.spyOn(world.activityEventsRepo, 'hasEventSince').mockRejectedValue(new Error('activity read down'));

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pins(world)).toHaveLength(1);
    expect(world.conversations.get('conv-1')?.unread_count).toBe(1);
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'repeat_check', level: 40 })]);
  });

  it('a failed pin still marks the thread unread with one event; ERROR step pin', async () => {
    const { app, world, capture } = existingOnFlyer();
    vi.spyOn(world.activityEventsRepo, 'record').mockRejectedValue(new Error('pin write down'));

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.conversations.get('conv-1')?.unread_count).toBe(1);
    expect(convUpdates(world)).toHaveLength(1);
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'pin', level: 50 })]);
    expect(captured(capture)).toEqual([expect.objectContaining({ recorded: false })]);
  });

  it('a failed touch: no increment and no event; ERROR step touch', async () => {
    const { app, world, capture } = existingOnFlyer();
    vi.spyOn(world.conversationsRepo, 'touchLastActivity').mockRejectedValue(new Error('touch down'));

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pins(world)).toHaveLength(1);
    expect(world.unreadIncrements).toEqual([]);
    expect(convUpdates(world)).toEqual([]);
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'touch', level: 50 })]);
  });

  it('a failed increment still emits ONE conversation.updated from the touched image; ERROR step increment', async () => {
    const { app, world, capture } = existingOnFlyer();
    vi.spyOn(world.conversationsRepo, 'incrementUnread').mockRejectedValue(new Error('increment down'));

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(convUpdates(world)).toEqual([
      expect.objectContaining({ conversationId: 'conv-1', last_activity_at: T0_ISO, unread_count: 0 }),
    ]);
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'increment', level: 50 })]);
  });

  it('the event carries the count incrementUnread RETURNS, not the touched image count', async () => {
    const { app, world } = existingOnFlyer();
    vi.spyOn(world.conversationsRepo, 'incrementUnread').mockResolvedValue(7);

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(convUpdates(world)).toEqual([expect.objectContaining({ conversationId: 'conv-1', unread_count: 7 })]);
  });
});

describe('a flyer sign-up puts the property on the properties-sent list (D7)', () => {
  it('an existing tenant never sent the property: ONE counted flyer entry at the sign-up instant, and the pair reads signed_up', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world);

    await post(app, signupBody({ unitId: 'unit-1' }));

    const row = await ledgerRow(world);
    expect(row?.shares).toEqual({ flyer: flyerEntry(T0_ISO) });
    expect(row).toMatchObject({ counted: true, sentAt: T0_ISO });
    expect(row?.broadcastId).toBeUndefined();
    expect(await outcomeOf(app)).toBe('signed_up');
    // No "Property sent" milestone for it: the signed_up pin names the flyer.
    expect(world.activityEvents.filter((e) => e.type === 'listing_sent')).toHaveLength(0);
    expect(captured(capture)).toEqual([expect.objectContaining({ sentRecorded: true })]);
    expect(captured(capture)[0]).not.toHaveProperty('sentSkipped');
  });

  const ALREADY_SENT: Array<[string, Partial<ContactItem>, string]> = [
    ['no reply', {}, 'no_reply'],
    ['a reply', { last_heard_from_at: '2026-10-02T10:00:00.000Z' }, 'replied'],
  ];

  it.each(ALREADY_SENT)('a pair already sent, with %s, reads signed_up after the sign-up', async (_what, contactOver, before) => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world, contactOver);
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    expect(await outcomeOf(app)).toBe(before);

    await post(app, signupBody({ unitId: 'unit-1' }));

    const row = await ledgerRow(world);
    expect(row?.shares?.['flyer']).toEqual(flyerEntry(T0_ISO));
    expect(row?.sentAt).toBe(T0_ISO);
    expect(await outcomeOf(app)).toBe('signed_up');
  });

  it('a CURRENT decline holds: no flyer entry, still not_interested - and the pin and the unread mark are still recorded', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world);
    seedThread(world);
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    expect(await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-10-05T10:00:00.000Z', by: 'staff', staffId: 'usr-1' })).toBe('ok');

    await post(app, signupBody({ unitId: 'unit-1' }));

    const row = await ledgerRow(world);
    expect(row?.shares?.['flyer']).toBeUndefined();
    expect(row?.sentAt).toBe(SENT_AT);
    expect(await outcomeOf(app)).toBe('not_interested');
    expect(pins(world)).toHaveLength(1);
    expect(world.conversations.get('conv-1')?.unread_count).toBe(1);
    expect(capture.lines.some((l) => l['msg'] === 'share ledger: flyer entry not written - the pair holds a current decline')).toBe(true);
    expect(captured(capture)).toEqual([expect.objectContaining({ sentRecorded: false, sentSkipped: 'declined' })]);
  });

  it('a decline recorded AFTER a sign-up holds against a second sign-up', async () => {
    const { app, world, clock } = harness();
    seedUnit(world);
    seedContact(world);
    await post(app, signupBody({ unitId: 'unit-1' }));
    expect(await outcomeOf(app)).toBe('signed_up');
    expect(
      await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: new Date(T0 + HOUR_MS).toISOString(), by: 'staff', staffId: 'usr-1' }),
    ).toBe('ok');

    clock.ms = T0 + 2 * HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-1' }));

    const row = await ledgerRow(world);
    expect(row?.shares?.['flyer']).toEqual(flyerEntry(T0_ISO)); // the FIRST sign-up's entry, never a newer one
    expect(row?.sentAt).toBe(T0_ISO);
    expect(await outcomeOf(app)).toBe('not_interested');
  });

  it('a pair with a tour stays interested', async () => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world);
    await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
    await world.toursRepo.create({
      tourId: 't-1',
      tenantId: 'c-1',
      unitId: 'unit-1',
      tourType: 'self_guided',
      status: 'scheduled',
      createdAt: '2026-10-02T00:00:00.000Z',
    });
    expect(await outcomeOf(app)).toBe('interested');

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect((await ledgerRow(world))?.shares?.['flyer']).toEqual(flyerEntry(T0_ISO));
    expect(await outcomeOf(app)).toBe('interested');
  });

  it('a repeat inside the 24-hour cap still writes a NEWER flyer entry: the cap governs the pin and the bump only', async () => {
    const { app, world, clock } = harness();
    seedUnit(world);
    seedContact(world);
    await post(app, signupBody({ unitId: 'unit-1' }));
    clock.ms = T0 + HOUR_MS;

    await post(app, signupBody({ unitId: 'unit-1' }));

    const later = new Date(T0 + HOUR_MS).toISOString();
    expect(pins(world)).toHaveLength(1);
    expect((await ledgerRow(world))?.shares?.['flyer']).toEqual(flyerEntry(later));
    expect((await ledgerRow(world))?.sentAt).toBe(later);
  });

  it('a DIFFERENT property within 24 hours gets its own flyer entry', async () => {
    const { app, world, clock } = harness();
    seedUnit(world, 'unit-1');
    seedUnit(world, 'unit-2');
    seedContact(world);
    await post(app, signupBody({ unitId: 'unit-1' }));
    clock.ms = T0 + HOUR_MS;

    await post(app, signupBody({ unitId: 'unit-2' }));

    expect((await ledgerRow(world, 'unit-1'))?.shares).toEqual({ flyer: flyerEntry(T0_ISO) });
    expect((await ledgerRow(world, 'unit-2'))?.shares).toEqual({ flyer: flyerEntry(new Date(T0 + HOUR_MS).toISOString()) });
  });

  it('an existing unknown contact gets the entry, and the property Sent to read lists it', async () => {
    const { app, world } = harness();
    seedUnit(world);
    world.contacts.push({ contactId: 'c-u', type: 'unknown', status: 'needs_review', phone: PHONE } as ContactItem);

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect((await ledgerRow(world, 'unit-1', 'c-u'))?.shares).toEqual({ flyer: flyerEntry(T0_ISO) });
    expect((await world.listingSendsRepo.listByUnit('unit-1')).map((r) => r.contactId)).toEqual(['c-u']);
  });

  const NON_TENANTS: ContactType[] = ['landlord', 'partner'];

  it.each(NON_TENANTS)('an existing %s gets the pin and the unread mark but no entry', async (type) => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world, { type });

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(world.listingSends).toHaveLength(0);
    expect(pins(world)).toHaveLength(1);
    expect([...world.conversations.values()].map((c) => c.unread_count)).toEqual([1]);
    expect(captured(capture)).toEqual([expect.objectContaining({ sentRecorded: false, sentSkipped: 'not_tenant' })]);
  });

  it('/join, an unavailable property and a made-up unitId never touch the ledger', async () => {
    const { app, world, clock } = harness();
    seedUnit(world, 'unit-placed', { status: 'placed' });
    seedContact(world);
    const read = vi.spyOn(world.listingSendsRepo, 'getByKeyConsistent');
    const write = vi.spyOn(world.listingSendsRepo, 'putShareMemory');

    await post(app, signupBody());
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-placed' }));
    clock.ms = T0 + 2 * HOUR_MS;
    await post(app, signupBody({ unitId: 'no-such-unit' }));

    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(world.listingSends).toHaveLength(0);
  });

  // OR-15: the flyer entry is written whether the new contact's welcome was
  // sent or refused - the ledger runs whatever the welcome did.
  const WELCOME_OUTCOMES: Array<[string, Record<string, string>, number]> = [
    ['sent', {}, 1],
    ['refused (the SMS kill switch)', { SMS_SENDING_ENABLED: 'false' }, 0],
  ];

  it.each(WELCOME_OUTCOMES)('a NEW contact on a flyer, its welcome %s: the pin, the unread mark and the flyer entry', async (_what, env, sentCount) => {
    const { app, world } = harness(env);
    seedUnit(world);

    await post(app, signupBody({ unitId: 'unit-1' }));

    const contact = world.contacts.find((c) => c.phone === PHONE);
    expect(world.sent).toHaveLength(sentCount);
    expect(pins(world)).toHaveLength(1);
    expect([...world.conversations.values()].map((c) => c.unread_count)).toEqual([1]);
    expect((await ledgerRow(world, 'unit-1', contact?.contactId ?? ''))?.shares).toEqual({ flyer: flyerEntry(T0_ISO) });
  });

  it('a failed ledger write still answers { ok: true }: no entry, the pin kept, ERROR step ledger', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world);
    vi.spyOn(world.listingSendsRepo, 'getByKeyConsistent').mockRejectedValue(new Error('ledger read down'));

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.listingSends).toHaveLength(0);
    expect(pins(world)).toHaveLength(1);
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'ledger', level: 50 })]);
    expect(captured(capture)).toEqual([expect.objectContaining({ sentRecorded: false, sentSkipped: 'error' })]);
  });
});

describe('the housing_fair_signup audit fields (D6, plan 2.6)', () => {
  type Harness = ReturnType<typeof harness>;

  it('an existing tenant on a flyer, entry written: the full payload (no sentSkipped) and the matching log fields', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world);

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(signupAudits(world)).toEqual([
      {
        entityKey: 'contacts#c-1',
        event_type: 'housing_fair_signup',
        payload: {
          marker: expect.any(String),
          isNew: false,
          welcomeSent: false,
          viaFlyer: true,
          signupVersion: 2,
          housingAuthority: null,
          existingContact: true,
          deletedContact: false,
          recorded: true,
          sentRecorded: true,
          consentVersion: 'ctia-2026-06',
        },
      },
    ]);
    expect(captured(capture)).toEqual([
      expect.objectContaining({ isNew: false, viaFlyer: true, existingContact: true, deletedContact: false, recorded: true, sentRecorded: true }),
    ]);
  });

  it('a soft-deleted holder (AR11): the event lands on THAT contact with deletedContact true, recorded and sentRecorded false, sentSkipped deleted', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world, { contactId: 'c-del', deleted_at: '2026-10-01T00:00:00.000Z' });

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(signupAudits(world)).toEqual([
      {
        entityKey: 'contacts#c-del',
        event_type: 'housing_fair_signup',
        payload: {
          marker: expect.any(String),
          isNew: false,
          welcomeSent: false,
          viaFlyer: true,
          signupVersion: 2,
          housingAuthority: null,
          existingContact: false,
          deletedContact: true,
          recorded: false,
          sentRecorded: false,
          sentSkipped: 'deleted',
          consentVersion: 'ctia-2026-06',
        },
      },
    ]);
    expect(captured(capture)).toEqual([
      expect.objectContaining({ existingContact: false, deletedContact: true, recorded: false, sentRecorded: false, sentSkipped: 'deleted' }),
    ]);
  });

  const SKIP_CASES: Array<{ skipped: string; arrange: (h: Harness) => Promise<Record<string, unknown>> }> = [
    {
      skipped: 'not_flyer',
      arrange: async (h) => {
        seedContact(h.world);
        return signupBody();
      },
    },
    {
      skipped: 'not_shareable',
      arrange: async (h) => {
        seedContact(h.world);
        seedUnit(h.world, 'unit-placed', { status: 'placed' });
        return signupBody({ unitId: 'unit-placed' });
      },
    },
    {
      skipped: 'not_tenant',
      arrange: async (h) => {
        seedContact(h.world, { type: 'landlord' });
        seedUnit(h.world);
        return signupBody({ unitId: 'unit-1' });
      },
    },
    {
      skipped: 'declined',
      arrange: async (h) => {
        seedContact(h.world);
        seedUnit(h.world);
        await seedListingSend(h.world.listingSendsRepo, { unitId: 'unit-1', contactId: 'c-1', sentAt: SENT_AT });
        await h.world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-10-05T10:00:00.000Z', by: 'staff', staffId: 'usr-1' });
        return signupBody({ unitId: 'unit-1' });
      },
    },
    {
      // AR2: a NEWER flyer entry is already stored (two sign-ups inside two app
      // instances' clock skew), so the order rule keeps it.
      skipped: 'refused',
      arrange: async (h) => {
        seedContact(h.world);
        seedUnit(h.world);
        await seedFlyerSignUp(h.world.listingSendsRepo, {
          unitId: 'unit-1',
          contactId: 'c-1',
          signedUpAt: new Date(T0 + HOUR_MS).toISOString(),
        });
        return signupBody({ unitId: 'unit-1' });
      },
    },
    {
      skipped: 'lost',
      arrange: async (h) => {
        seedContact(h.world);
        seedUnit(h.world);
        vi.spyOn(h.world.listingSendsRepo, 'putShareMemory').mockResolvedValue(false);
        return signupBody({ unitId: 'unit-1' });
      },
    },
    {
      skipped: 'error',
      arrange: async (h) => {
        seedContact(h.world);
        seedUnit(h.world);
        vi.spyOn(h.world.listingSendsRepo, 'getByKeyConsistent').mockRejectedValue(new Error('ledger read down'));
        return signupBody({ unitId: 'unit-1' });
      },
    },
  ];

  it.each(SKIP_CASES)('sentSkipped $skipped: sentRecorded false, and the pin still recorded', async ({ skipped, arrange }) => {
    const h = harness();
    const body = await arrange(h);

    const res = await post(h.app, body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(signupAudits(h.world).map((e) => e.payload)).toEqual([
      expect.objectContaining({ existingContact: true, deletedContact: false, recorded: true, sentRecorded: false, sentSkipped: skipped }),
    ]);
  });

  it('a decline recorded AFTER a sign-up: the second sign-up audits sentSkipped declined', async () => {
    const { app, world, clock } = harness();
    seedUnit(world);
    seedContact(world);
    await post(app, signupBody({ unitId: 'unit-1' }));
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: new Date(T0 + HOUR_MS).toISOString(), by: 'staff', staffId: 'usr-1' });
    clock.ms = T0 + 2 * HOUR_MS;

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(signupAudits(world).map((e) => [e.payload?.['sentRecorded'], e.payload?.['sentSkipped']])).toEqual([
      [true, undefined],
      [false, 'declined'],
    ]);
  });

  it('recorded is false on a repeat inside the 24-hour cap and when the pin write fails; the flyer entry is still recorded', async () => {
    const { app, world, clock } = harness();
    seedUnit(world);
    seedContact(world);
    await post(app, signupBody({ unitId: 'unit-1' }));
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-1' }));
    vi.spyOn(world.activityEventsRepo, 'record').mockRejectedValue(new Error('pin write down'));
    clock.ms = T0 + 25 * HOUR_MS;

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(signupAudits(world).map((e) => [e.payload?.['recorded'], e.payload?.['sentRecorded']])).toEqual([
      [true, true],
      [false, true],
      [false, true],
    ]);
  });
});

// Planner review C-F1 (spec D6.4: failures never reach the public page): the
// housing_fair_signup audit is best-effort on BOTH paths. A throw is logged
// once (ERROR, the marker and step audit, no PII) and the answer is still
// { ok: true } - on the main path after the pin, the unread mark and the
// flyer entry were written, so a visitor is never told to re-submit a sign-up
// that landed. The harness's failAuditAppendFor throws before recording.
describe('the housing_fair_signup audit is best-effort too (D6.4, planner review C-F1)', () => {
  /** The typed name, the phone in every form, the stored name and the pin's address. */
  const PII = ['Keisha', 'Jones', PHONE, '5550102000', '010-2000', 'Storedfirst', 'Storedlast', '12 Oak St'];

  it('the main path: 200 { ok: true }, the pin, the unread mark and the flyer entry still written; ONE ERROR step audit with no name or phone', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world, { firstName: 'Storedfirst', lastName: 'Storedlast' });
    seedThread(world);
    world.failAuditAppendFor.add('housing_fair_signup');

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(signupAudits(world)).toEqual([]);
    expect(pins(world)).toEqual([
      expect.objectContaining({ contactId: 'c-1', label: FLYER_LABEL, refType: 'unit', refId: 'unit-1', at: T0_ISO }),
    ]);
    expect(world.unreadIncrements).toEqual(['conv-1']);
    expect(world.conversations.get('conv-1')).toMatchObject({ unread_count: 1 });
    expect(convUpdates(world)).toEqual([expect.objectContaining({ conversationId: 'conv-1', unread_count: 1 })]);
    expect((await ledgerRow(world))?.shares).toEqual({ flyer: flyerEntry(T0_ISO) });
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'audit', level: 50, marker: expect.any(String) })]);
    const stepLine = JSON.stringify(stepFailures(capture));
    for (const pii of PII) expect(stepLine, pii).not.toContain(pii);
    // The request still closes with its captured line.
    expect(captured(capture)).toEqual([expect.objectContaining({ recorded: true, sentRecorded: true })]);
  });

  it('the deleted path: 200 { ok: true } and ONE ERROR step audit with no name or phone', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world, {
      contactId: 'c-del',
      firstName: 'Storedfirst',
      lastName: 'Storedlast',
      deleted_at: '2026-10-01T00:00:00.000Z',
    });
    world.failAuditAppendFor.add('housing_fair_signup');

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(signupAudits(world)).toEqual([]);
    expect(world.conversations.size).toBe(0);
    expect(world.activityEvents).toHaveLength(0);
    expect(stepFailures(capture)).toEqual([expect.objectContaining({ step: 'audit', level: 50, marker: expect.any(String) })]);
    const stepLine = JSON.stringify(stepFailures(capture));
    for (const pii of PII) expect(stepLine, pii).not.toContain(pii);
    expect(captured(capture)).toEqual([expect.objectContaining({ deletedContact: true, sentSkipped: 'deleted' })]);
  });
});

// flyer-leads FW-P2 / FW-P3 (Cameron, 2026-10-22): the form cannot opt a
// number back in, so the sign-up's pin tells staff why texts are off - worded
// by its CAUSE since FW-P3 (Cameron's pick (a)). A flag on one of the
// number's 1:1 threads is a STOP from that number: the START note, since
// Twilio's block lifts only when the person texts START, YES or UNSTOP from
// it. The contact's flag alone (a staff Do-Not-Contact, or the contact's
// other number opted out) gets the Do-Not-Contact note. Nothing else
// changes: the unread mark, the repeat check, the flyer entry, the welcome
// rule, the answer and the audit; neither flag is written.
const STOP_NOTE = ' (this number opted out of texts - they need to text START from it to get texts again)';
const DNC_NOTE = ' (marked Do-Not-Contact - texts stay off unless staff choose Allow SMS)';

/** The three signed_up pin forms: [what, the extra body fields, the label]. */
const PIN_FORMS: Array<[string, Record<string, unknown>, string]> = [
  ['the flyer', { unitId: 'unit-1' }, FLYER_LABEL],
  ['a flyer whose property is not shareable', { unitId: 'unit-placed' }, A_FLYER_LABEL],
  ['the join page', {}, JOIN_LABEL],
];

describe('an opted-out number: the pin tells staff (FW-P2)', () => {
  it.each(PIN_FORMS)('the CONTACT opted out (its flag only), %s: the pin label ends with the Do-Not-Contact note', async (_what, extra, label) => {
    const { app, world } = harness();
    seedUnit(world);
    seedUnit(world, 'unit-placed', { status: 'placed' });
    seedContact(world, { sms_opt_out: true });
    seedThread(world);

    const res = await post(app, signupBody(extra));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pins(world)).toEqual([expect.objectContaining({ contactId: 'c-1', label: `${label}${DNC_NOTE}`, at: T0_ISO })]);
    expect(world.unreadIncrements).toEqual(['conv-1']);
    expect(world.sent).toHaveLength(0);
    expect(world.contacts.find((c) => c.contactId === 'c-1')?.sms_opt_out).toBe(true);
  });

  it('the THREAD opted out (the contact carries no flag): the STOP note - and the mark, the entry, the audit and the repeat check are unchanged', async () => {
    const { app, world, clock } = harness();
    seedUnit(world);
    seedContact(world);
    seedThread(world, { sms_opt_out: true });

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pins(world)).toEqual([
      expect.objectContaining({ contactId: 'c-1', label: `${FLYER_LABEL}${STOP_NOTE}`, refType: 'unit', refId: 'unit-1', at: T0_ISO }),
    ]);
    expect(world.unreadIncrements).toEqual(['conv-1']);
    expect(convUpdates(world)).toEqual([expect.objectContaining({ conversationId: 'conv-1', unread_count: 1 })]);
    expect((await ledgerRow(world))?.shares).toEqual({ flyer: flyerEntry(T0_ISO) });
    // No new audit field: the same payload as any existing tenant's flyer sign-up.
    expect(signupAudits(world).map((e) => e.payload)).toEqual([
      {
        marker: expect.any(String),
        isNew: false,
        welcomeSent: false,
        viaFlyer: true,
        signupVersion: 2,
        housingAuthority: null,
        existingContact: true,
        deletedContact: false,
        recorded: true,
        sentRecorded: true,
        consentVersion: 'ctia-2026-06',
      },
    ]);
    expect(world.conversations.get('conv-1')?.sms_opt_out).toBe(true);
    // The repeat check still holds a second sign-up within 24 hours to the one pin and bump.
    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-1' }));
    expect(pins(world)).toHaveLength(1);
    expect(world.unreadIncrements).toEqual(['conv-1']);
  });

  it('a NEW contact on a thread that opted out before any contact held the number: the welcome is refused as today, and the pin carries the STOP note', async () => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedThread(world, { type: 'unknown_1to1', participants: undefined, sms_opt_out: true });

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const contact = world.contacts.find((c) => c.phone === PHONE);
    expect(contact).toMatchObject({ type: 'tenant', housing_fair_welcomed: false });
    expect(contact).not.toHaveProperty('sms_opt_out');
    expect(world.sent).toHaveLength(0);
    expect(capture.lines.filter((l) => l['msg'] === 'housing-fair welcome text refused')).toEqual([
      expect.objectContaining({ code: 'contact_opted_out' }),
    ]);
    expect(pins(world)).toEqual([
      expect.objectContaining({ contactId: contact?.contactId, label: `${FLYER_LABEL}${STOP_NOTE}`, refId: 'unit-1', at: T0_ISO }),
    ]);
    expect(world.unreadIncrements).toEqual(['conv-1']);
    expect(world.conversations.get('conv-1')?.sms_opt_out).toBe(true);
  });

  it('(PIN) not opted out - both flags present and false: no note', async () => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world, { sms_opt_out: false });
    seedThread(world, { sms_opt_out: false });

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(pins(world).map((p) => p.label)).toEqual([FLYER_LABEL]);
  });
});

// flyer-leads FW-P3 (Cameron, 2026-10-22: "Go with (a), the Do-Not-Contact
// note"): the note says WHY texts are off. A flag on any 1:1 thread of the
// signed-up NUMBER - the one the thread step returns, or an older one, read
// with findByParticipantPhone under readNumberSuppression's thread rule
// (isNumberThreadOptedOut) - is a STOP from that number: the START note. The
// contact's flag alone is a staff Do-Not-Contact, or the contact's other
// number opted out: the Do-Not-Contact note. The read runs only when a pin is
// written, and it is best-effort: a throw is logged (WARN step
// opt_out_check, no PII) and the thread step's own flag stands in.
describe('the opted-out note by cause (FW-P3)', () => {
  /** The primary number of a two-number contact whose second number is PHONE. */
  const OTHER_PHONE = '+15550109999';
  /** The typed name, the phone in every form, the stored name and the pin's address. */
  const PII = ['Keisha', 'Jones', PHONE, '5550102000', '010-2000', 'Tia', 'Moss', '12 Oak St'];

  /** An older, CLOSED thread of PHONE - never the one the thread step returns. */
  function seedOlderThread(world: FakeWorld, over: Partial<ConversationItem> = {}): ConversationItem {
    return seedThread(world, {
      conversationId: 'conv-old',
      status: 'closed',
      last_activity_at: '2026-06-01T10:00:00.000Z',
      created_at: '2026-06-01T10:00:00.000Z',
      ...over,
    });
  }

  it.each(PIN_FORMS)('the thread step returns a flagged thread, %s: the STOP note', async (_what, extra, label) => {
    const { app, world } = harness();
    seedUnit(world);
    seedUnit(world, 'unit-placed', { status: 'placed' });
    seedContact(world);
    seedThread(world, { sms_opt_out: true });

    const res = await post(app, signupBody(extra));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pins(world)).toEqual([expect.objectContaining({ contactId: 'c-1', label: `${label}${STOP_NOTE}`, at: T0_ISO })]);
  });

  it('the flag only on an OLDER thread of the number (the thread step returns a clean one): the STOP note; only the current thread is marked, and no flag is written', async () => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world);
    seedOlderThread(world, { sms_opt_out: true });
    seedThread(world);
    const read = vi.spyOn(world.conversationsRepo, 'findByParticipantPhone');

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(read.mock.calls).toEqual([[PHONE]]);
    expect(pins(world)).toEqual([
      expect.objectContaining({ contactId: 'c-1', label: `${FLYER_LABEL}${STOP_NOTE}`, refId: 'unit-1', at: T0_ISO }),
    ]);
    expect(world.unreadIncrements).toEqual(['conv-1']);
    expect(world.conversations.get('conv-old')).toMatchObject({ status: 'closed', sms_opt_out: true });
    expect(world.conversations.get('conv-1')).not.toHaveProperty('sms_opt_out');
    expect(world.contacts.find((c) => c.contactId === 'c-1')).not.toHaveProperty('sms_opt_out');
  });

  const CONTACT_ONLY: Array<[string, (world: FakeWorld) => void]> = [
    [
      'a staff Do-Not-Contact on a one-number contact',
      (world) => {
        seedContact(world, { sms_opt_out: true });
        seedThread(world);
      },
    ],
    [
      'the contact\'s OTHER number opted out (its primary STOPped; the sign-up comes from its second number)',
      (world) => {
        // A primary-number STOP flags the contact AND that number's own thread; PHONE's thread is clean.
        seedContact(world, { phone: OTHER_PHONE, sms_opt_out: true });
        world.contacts.push({ contactId: phoneRefId(PHONE), type: 'unknown', phone: PHONE, phone_ref: true, phone_ref_owner: 'c-1' } as ContactItem);
        seedThread(world, {
          conversationId: 'conv-primary',
          participant_phone: OTHER_PHONE,
          participants: [{ contactId: 'c-1', phone: OTHER_PHONE }],
          sms_opt_out: true,
        });
        seedThread(world);
      },
    ],
  ];

  it.each(CONTACT_ONLY)('only the contact is flagged - %s: the Do-Not-Contact note', async (_what, arrange) => {
    const { app, world } = harness();
    seedUnit(world);
    arrange(world);

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pins(world)).toEqual([
      expect.objectContaining({ contactId: 'c-1', label: `${FLYER_LABEL}${DNC_NOTE}`, refId: 'unit-1', at: T0_ISO }),
    ]);
    expect(world.unreadIncrements).toEqual(['conv-1']);
    expect(world.contacts.find((c) => c.contactId === 'c-1')?.sms_opt_out).toBe(true);
  });

  it('both the number and the contact flagged (what a primary-number STOP writes): the STOP note', async () => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world, { sms_opt_out: true });
    seedThread(world, { sms_opt_out: true });

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(pins(world).map((p) => p.label)).toEqual([`${FLYER_LABEL}${STOP_NOTE}`]);
  });

  it('(PIN) neither flagged, with an older clean thread too: no note', async () => {
    const { app, world } = harness();
    seedUnit(world);
    seedContact(world);
    seedOlderThread(world);
    seedThread(world);

    await post(app, signupBody({ unitId: 'unit-1' }));

    expect(pins(world).map((p) => p.label)).toEqual([FLYER_LABEL]);
  });

  it('the number read runs once per sign-up that writes a pin, whatever the flags, and never on a repeat inside 24 hours', async () => {
    const { app, world, clock } = harness();
    seedUnit(world);
    seedContact(world);
    seedThread(world, { sms_opt_out: true });
    const read = vi.spyOn(world.conversationsRepo, 'findByParticipantPhone');

    await post(app, signupBody({ unitId: 'unit-1' }));
    // Read although the thread step's own flag already decides the note, so
    // the answer's timing never turns on the opt-out.
    expect(read.mock.calls).toEqual([[PHONE]]);

    clock.ms = T0 + HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-1' }));
    expect(pins(world)).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);

    clock.ms = T0 + 25 * HOUR_MS;
    await post(app, signupBody({ unitId: 'unit-1' }));
    expect(pins(world).map((p) => p.label)).toEqual([`${FLYER_LABEL}${STOP_NOTE}`, `${FLYER_LABEL}${STOP_NOTE}`]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  const READ_THROWS: Array<[string, Partial<ConversationItem>, string]> = [
    ['the thread step returned a flagged thread: the STOP note stands', { sms_opt_out: true }, `${FLYER_LABEL}${STOP_NOTE}`],
    ['only an OLDER thread is flagged: unseen, so no note', {}, FLYER_LABEL],
  ];

  it.each(READ_THROWS)('the number read throws - ONE WARN step opt_out_check with no PII, the thread step\'s flag stands in, 200 { ok: true }; %s', async (_what, threadOver, label) => {
    const { app, world, capture } = harness();
    seedUnit(world);
    seedContact(world);
    seedOlderThread(world, { sms_opt_out: true });
    seedThread(world, threadOver);
    vi.spyOn(world.conversationsRepo, 'findByParticipantPhone').mockRejectedValue(new Error('participant index down'));

    const res = await post(app, signupBody({ unitId: 'unit-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pins(world).map((p) => p.label)).toEqual([label]);
    expect(world.unreadIncrements).toEqual(['conv-1']);
    expect((await ledgerRow(world))?.shares).toEqual({ flyer: flyerEntry(T0_ISO) });
    expect(stepFailures(capture)).toEqual([
      expect.objectContaining({ step: 'opt_out_check', level: 40, marker: expect.any(String) }),
    ]);
    const stepLine = JSON.stringify(stepFailures(capture));
    for (const pii of PII) expect(stepLine, pii).not.toContain(pii);
    expect(captured(capture)).toEqual([expect.objectContaining({ recorded: true, sentRecorded: true })]);
  });
});
