// POST /api/units/:unitId/recipients/:contactId/outcome (last-heard-from spec
// 5.4 as amended by 14.3) - every answer, in the route's order, and the
// writes behind each. Harness world fakes (no DynamoDB).
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { seedListingSend } from './helpers/listingSendSeed.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];
const SENT_AT = '2026-06-16T10:00:00.000Z';
const ADDRESS = '12 Oak St, Atlanta, GA';
const ACTOR = TEST_SESSION_USER.userId;

function seedUnit(world: FakeWorld, over: Partial<UnitItem> = {}): UnitItem {
  const unit: UnitItem = {
    unitId: 'unit-1',
    landlordId: 'contact-ll-1',
    status: 'available',
    address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA' },
    created_at: SENT_AT,
    updated_at: SENT_AT,
    ...over,
  };
  world.units.set(unit.unitId, unit);
  return unit;
}

function seedContact(world: FakeWorld, contactId: string, fields: Partial<ContactItem> = {}): void {
  world.contacts.push({ contactId, type: 'tenant', status: 'searching', phone: '+15550100001', firstName: 'Tia', lastName: 'Moss', ...fields } as ContactItem);
}

async function seedSend(world: FakeWorld, contactId = 'c-1'): Promise<void> {
  await seedListingSend(world.listingSendsRepo, { unitId: 'unit-1', contactId, sentAt: SENT_AT });
}

const post = (app: App, body: unknown, unitId = 'unit-1', contactId = 'c-1') =>
  request(app)
    .post(`/api/units/${unitId}/recipients/${contactId}/outcome`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body as object);

const stored = async (world: FakeWorld, contactId = 'c-1') => world.listingSendsRepo.getByKeyConsistent('unit-1', contactId);
const outcomeEvents = (world: FakeWorld) => world.activityEvents.filter((e) => String(e.type).startsWith('listing_'));

describe('outcome route - refusals in order', () => {
  it('404 unit_not_found for an unknown unit', async () => {
    const { app } = makeWebhookHarness();
    const res = await post(app, { outcome: 'not_interested' }, 'nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unit_not_found' });
  });

  it.each(['interested', 'not_interested', 'clear'])('409 unit_deleted for %s on a soft-deleted property - nothing written', async (outcome) => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { deleted_at: '2026-10-01T00:00:00.000Z', tour_type: 'self_guided' });
    seedContact(world, 'c-1');
    await seedSend(world);
    const res = await post(app, { outcome });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'unit_deleted' });
    expect((await stored(world))?.declined).toBeUndefined();
    expect(world.toursMap.size).toBe(0);
    expect(outcomeEvents(world)).toEqual([]);
  });

  it('404 send_not_found with no row, and for an UNCOUNTED row (ledgerRowCounted)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    expect((await post(app, { outcome: 'not_interested' })).body).toEqual({ error: 'send_not_found' });
    const failed = { attempt: '2026-06-16T10:00:00.000Z#SM1', conversationId: 'conv-1', state: 'failed' as const };
    await world.listingSendsRepo.putShareMemory('unit-1', 'c-1', { shares: { 'b-1': failed }, counted: false, sentAt: undefined, broadcastId: undefined }, { token: undefined });
    const res = await post(app, { outcome: 'not_interested' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'send_not_found' });
    expect((await stored(world))?.declined).toBeUndefined();
  });

  it('the row check precedes the body check (a bad body on a missing row is 404)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    expect((await post(app, { outcome: 'maybe' })).status).toBe(404);
  });

  it.each([[{}], [{ outcome: 'maybe' }], [{ outcome: 'clear', extra: 1 }], [['clear']]])('400 invalid_outcome for %j', async (body) => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    const res = await post(app, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_outcome' });
  });

  it('503 outcome_unavailable (no saved) when the recipient read fails BEFORE any write', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    world.contactsRepo.getRecipientDisplaysByIds = async () => {
      throw new Error('dynamo down');
    };
    const res = await post(app, { outcome: 'not_interested' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable' });
    expect((await stored(world))?.declined).toBeUndefined();
  });
});

describe('outcome route - not_interested and clear', () => {
  it('not_interested: stores { at, by: staff, staffId }, answers the re-projected row, writes both audit surfaces', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    const res = await post(app, { outcome: 'not_interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ contactId: 'c-1', unitId: 'unit-1', outcome: 'not_interested', interestedSupported: true, interestedMode: 'form', eligible: true, tenantName: 'Tia Moss' });
    expect(res.body.row.declined).toEqual({ at: expect.any(String), by: 'staff' });
    const row = await stored(world);
    expect(row?.declined).toEqual({ at: res.body.row.declined.at, by: 'staff', staffId: ACTOR });
    expect(outcomeEvents(world)).toEqual([
      expect.objectContaining({ contactId: 'c-1', type: 'listing_declined', label: `Not interested in ${ADDRESS}`, refType: 'unit', refId: 'unit-1' }),
    ]);
    expect(world.auditEvents.filter((e) => e.event_type === 'listing_declined')).toEqual([
      { entityKey: 'units#unit-1', event_type: 'listing_declined', actorId: ACTOR, payload: { contactId: 'c-1', actor: ACTOR } },
    ]);
  });

  it('not_interested is idempotent: a second call rewrites the record with a new at and records again', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    const first = await post(app, { outcome: 'not_interested' });
    const second = await post(app, { outcome: 'not_interested' });
    expect(second.status).toBe(200);
    expect(second.body.row.declined.at >= first.body.row.declined.at).toBe(true);
    expect(outcomeEvents(world)).toHaveLength(2);
  });

  it('a PARTNER may be marked not interested', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-pt', { type: 'partner', status: 'active', role: 'Caseworker' });
    await seedSend(world, 'c-pt');
    const res = await post(app, { outcome: 'not_interested' }, 'unit-1', 'c-pt');
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'not_interested', interestedSupported: false });
  });

  it('clear after a decline: REMOVEs the record, writes listing_decline_cleared, answers the waiting outcome', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await post(app, { outcome: 'not_interested' });
    const res = await post(app, { outcome: 'clear' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'no_reply' });
    expect(res.body.row).not.toHaveProperty('declined');
    expect(await stored(world)).not.toHaveProperty('declined');
    expect(outcomeEvents(world).map((e) => e.type)).toEqual(['listing_declined', 'listing_decline_cleared']);
    expect(outcomeEvents(world)[1]).toMatchObject({ label: `Not interested cleared for ${ADDRESS}`, refType: 'unit', refId: 'unit-1' });
  });

  it('clear with no stored decline answers 200 and records NOTHING (contract change 2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    const res = await post(app, { outcome: 'clear' });
    expect(res.status).toBe(200);
    expect(outcomeEvents(world)).toEqual([]);
  });

  it('a failed audit write never fails the route (best-effort)', async () => {
    const { app, world, capture } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    world.failAuditAppendFor.add('listing_declined');
    const res = await post(app, { outcome: 'not_interested' });
    expect(res.status).toBe(200);
    expect(capture.atLevel(50).some((l) => l['msg'] === 'listing_declined unit audit failed (best-effort)')).toBe(true);
  });

  it('503 { saved: true } when the write landed but the re-projection read failed', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    // not_interested reads no tours before its write; the re-projection does.
    world.toursRepo.listByUnit = async () => {
      throw new Error('tours GSI unavailable');
    };
    const res = await post(app, { outcome: 'not_interested' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable', saved: true });
    expect((await stored(world))?.declined).toMatchObject({ by: 'staff' });
  });
});

describe('outcome route - interested', () => {
  it('400 interested_unsupported on a partner row and on a missing contact - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-pt', { type: 'partner', status: 'active' });
    await seedSend(world, 'c-pt');
    await seedSend(world, 'c-gone');
    for (const contactId of ['c-pt', 'c-gone']) {
      const res = await post(app, { outcome: 'interested' }, 'unit-1', contactId);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'interested_unsupported' });
    }
    expect(world.toursMap.size).toBe(0);
  });

  it('requireTenantContact (CONSISTENT) refuses a contact converted after the batch read: 409 contact_not_tenant', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-1', { type: 'partner', status: 'active' });
    await seedSend(world);
    // The eventually consistent recipient read still says tenant.
    world.contactsRepo.getRecipientDisplaysByIds = async () => new Map([['c-1', { contactId: 'c-1', type: 'tenant' as const, phone: '+15550100001' }]]);
    const getById = vi.spyOn(world.contactsRepo, 'getById');
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'partner' });
    expect(getById).toHaveBeenCalledWith('c-1', { consistentRead: true });
    expect(world.toursMap.size).toBe(0);
  });

  it('404 tenant_not_found when the contact row is gone behind a stale tenant read', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    await seedSend(world);
    world.contactsRepo.getRecipientDisplaysByIds = async () => new Map([['c-1', { contactId: 'c-1', type: 'tenant' as const }]]);
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
  });

  it('an existing qualifying tour: no tour created, NO listing_interested event, the row reads interested', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world); // no tour_type: an existing tour needs none
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.toursRepo.create({ tourId: 't-1', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'scheduled', createdAt: '2026-06-20T00:00:00.000Z' });
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'interested', tour: { tourId: 't-1', state: 'scheduled' } });
    expect(world.toursMap.size).toBe(1);
    expect(outcomeEvents(world)).toEqual([]);
  });

  it('503 WITHOUT saved when the click wrote nothing (existing tour, no decline) and the re-read fails (review A-3)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.toursRepo.create({ tourId: 't-1', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'scheduled', createdAt: '2026-06-20T00:00:00.000Z' });
    const before = await stored(world);
    // The pre-write tours read succeeds; the re-projection's read throws.
    const realListByUnit = world.toursRepo.listByUnit.bind(world.toursRepo);
    let calls = 0;
    world.toursRepo.listByUnit = async (unitId: string) => {
      calls += 1;
      if (calls === 1) return realListByUnit(unitId);
      throw new Error('tours GSI unavailable');
    };
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable' });
    expect(world.toursMap.size).toBe(1);
    expect(await stored(world)).toEqual(before);
    expect(outcomeEvents(world)).toEqual([]);
  });

  it('503 WITHOUT saved when the click wrote nothing and the re-read finds no counted row (review A-3)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.toursRepo.create({ tourId: 't-1', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'scheduled', createdAt: '2026-06-20T00:00:00.000Z' });
    const realGet = world.listingSendsRepo.getByKeyConsistent.bind(world.listingSendsRepo);
    let calls = 0;
    world.listingSendsRepo.getByKeyConsistent = async (unitId: string, contactId: string) => {
      calls += 1;
      return calls === 1 ? realGet(unitId, contactId) : undefined;
    };
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable' });
  });

  it('an existing tour behind an EFFECTIVE decline: the decline is cleared (event), no create', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.toursRepo.create({ tourId: 't-1', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'scheduled', createdAt: '2026-06-20T00:00:00.000Z' });
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-25T00:00:00.000Z', by: 'staff' });
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'interested' });
    expect(await stored(world)).not.toHaveProperty('declined');
    expect(outcomeEvents(world).map((e) => e.type)).toEqual(['listing_decline_cleared']);
    expect(world.toursMap.size).toBe(1);
  });

  // Knowing rewrite (review B R2-2 part 1, spec 14.7): this case used to pin
  // that a SUPERSEDED decline is left on the row with no clear. An explicit
  // Interested overrides EVERY earlier decline, so the record it read is now
  // cleared whatever its effectiveness - but `listing_decline_cleared` is
  // recorded only when that decline was effective (nothing visible changed).
  it('a SUPERSEDED decline is cleared too (an explicit Interested overrides every earlier decline) - no event', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-18T00:00:00.000Z', by: 'staff' });
    await world.toursRepo.create({ tourId: 't-1', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'requested', createdAt: '2026-06-20T00:00:00.000Z' });
    const clear = vi.spyOn(world.listingSendsRepo, 'clearDeclined');
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'interested' });
    expect(clear).toHaveBeenCalledWith('unit-1', 'c-1', { expectedAt: '2026-06-18T00:00:00.000Z' });
    expect(await stored(world)).not.toHaveProperty('declined');
    expect(outcomeEvents(world)).toEqual([]);
    expect(world.toursMap.size).toBe(1);
  });

  it('a retry after a clear that failed behind a create repairs it: the stale (now superseded) decline is cleared, no event (review B R2-2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-25T00:00:00.000Z', by: 'staff' });
    // The first click created the tour, then its clear threw.
    const realClear = world.listingSendsRepo.clearDeclined.bind(world.listingSendsRepo);
    world.listingSendsRepo.clearDeclined = async () => {
      throw new Error('throttled');
    };
    await post(app, { outcome: 'interested' });
    expect(world.toursMap.size).toBe(1);
    expect((await stored(world))?.declined).toBeDefined();
    world.listingSendsRepo.clearDeclined = realClear;
    // The retry finds the tour (no second create) and clears the stale record.
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'interested' });
    expect(world.toursMap.size).toBe(1);
    expect(await stored(world)).not.toHaveProperty('declined');
    expect(outcomeEvents(world).map((e) => e.type)).toEqual(['listing_interested']);
  });

  it('clearing a superseded decline is a write: a failed re-read then answers 503 saved:true (review B R2-2 / A-3)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-18T00:00:00.000Z', by: 'staff' });
    await world.toursRepo.create({ tourId: 't-1', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'requested', createdAt: '2026-06-20T00:00:00.000Z' });
    const realListByUnit = world.toursRepo.listByUnit.bind(world.toursRepo);
    let calls = 0;
    world.toursRepo.listByUnit = async (unitId: string) => {
      calls += 1;
      if (calls === 1) return realListByUnit(unitId);
      throw new Error('tours GSI unavailable');
    };
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable', saved: true });
    expect(await stored(world)).not.toHaveProperty('declined');
  });

  it('409 tour_type_required with no qualifying tour and no structured tour_type - nothing written, decline kept', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.toursRepo.create({ tourId: 't-x', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'canceled' });
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-25T00:00:00.000Z', by: 'staff' });
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'tour_type_required' });
    expect(world.toursMap.size).toBe(1);
    expect((await stored(world))?.declined).toBeDefined();
    expect(outcomeEvents(world)).toEqual([]);
  });

  it('creates ONE requested tour with tourType = unit.tour_type and only then records listing_interested', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'landlord_led' });
    seedContact(world, 'c-1');
    await seedSend(world);
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    const created = [...world.toursMap.values()];
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ tenantId: 'c-1', unitId: 'unit-1', tourType: 'landlord_led', status: 'requested' });
    expect(created[0]).not.toHaveProperty('scheduledAt');
    const tourId = created[0]!.tourId;
    expect(res.body.row).toMatchObject({ outcome: 'interested', tour: { tourId, state: 'requested' }, interestedMode: 'route' });
    expect(outcomeEvents(world)).toEqual([
      expect.objectContaining({ type: 'listing_interested', label: `Interested in ${ADDRESS} - tour requested`, refType: 'unit', refId: 'unit-1' }),
    ]);
    expect(world.auditEvents.filter((e) => e.event_type === 'listing_interested')).toEqual([
      { entityKey: 'units#unit-1', event_type: 'listing_interested', actorId: ACTOR, payload: { contactId: 'c-1', actor: ACTOR, tourId } },
    ]);
  });

  it('a canceled tour is not "existing": interested creates a new one', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.toursRepo.create({ tourId: 't-x', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'canceled' });
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(world.toursMap.size).toBe(2);
  });

  // Review ADV-3 (knowing rewrite of the old "clear THEN create" order pin):
  // the tour is created first, so a failed create can never cost another
  // staff member's decline.
  it('an effective decline with no tour: create (event) THEN clear (event), in that order', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'pm_team' });
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-25T00:00:00.000Z', by: 'staff' });
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'interested' });
    expect(outcomeEvents(world).map((e) => e.type)).toEqual(['listing_interested', 'listing_decline_cleared']);
    expect(await stored(world)).not.toHaveProperty('declined');
  });

  it('a failed tour create leaves an effective decline and the timeline untouched (review ADV-3)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-1');
    await seedSend(world);
    const decline = { at: '2026-06-25T00:00:00.000Z', by: 'staff' as const, staffId: 'usr_b' };
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', decline);
    world.toursRepo.create = async () => {
      throw new Error('tours write failed');
    };
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(500);
    expect((await stored(world))?.declined).toEqual(decline);
    expect(outcomeEvents(world)).toEqual([]);
    expect(world.toursMap.size).toBe(0);
  });

  // Review B R2-2 part 2 / A R2-2 (spec 14.7): once the click wrote, a throw
  // is never a bare 500 - the copy must say "Saved", not invite a retry.
  it('a clear that THROWS after a successful create answers 503 saved:true, logged with ids only (review B R2-2 / A R2-2)', async () => {
    const { app, world, capture } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-25T00:00:00.000Z', by: 'staff' });
    world.listingSendsRepo.clearDeclined = async () => {
      throw new Error('throttled');
    };
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable', saved: true });
    expect(world.toursMap.size).toBe(1);
    expect((await stored(world))?.declined).toBeDefined();
    expect(outcomeEvents(world).map((e) => e.type)).toEqual(['listing_interested']);
    const line = capture.atLevel(50).find((l) => l['msg'] === 'outcome: failed after a write - 503 saved');
    expect(line).toMatchObject({ unitId: 'unit-1', contactId: 'c-1', outcome: 'interested' });
    // PII: ids only - never the name or the phone.
    expect(JSON.stringify(line)).not.toMatch(/Tia|Moss|5550100001/);
  });

  it('a clear that finds no counted row AFTER the create is not a 404: the tour was written -> 503 saved, no cleared event', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-25T00:00:00.000Z', by: 'staff' });
    // The row stops being counted between the read and the clear.
    const realGet = world.listingSendsRepo.getByKeyConsistent.bind(world.listingSendsRepo);
    let reads = 0;
    world.listingSendsRepo.getByKeyConsistent = async (unitId: string, contactId: string) => {
      reads += 1;
      return reads === 1 ? realGet(unitId, contactId) : undefined;
    };
    world.listingSendsRepo.clearDeclined = async () => 'not_found';
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable', saved: true });
    expect(world.toursMap.size).toBe(1);
    expect(outcomeEvents(world).map((e) => e.type)).toEqual(['listing_interested']);
  });

  // Review B R2-1: compare-and-clear - the click clears only the decline it
  // READ (its `at`), so a decline another staff member records meanwhile
  // survives, and the re-projection answers the truth.
  it("another staff member's decline recorded DURING the create survives (compare-and-clear, review B R2-1)", async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-1');
    await seedSend(world);
    const read = { at: '2026-06-25T00:00:00.000Z', by: 'staff' as const, staffId: 'usr_a' };
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', read);
    const theirs = { at: new Date(Date.now() + 60_000).toISOString(), by: 'staff' as const, staffId: 'usr_b' };
    const realCreate = world.toursRepo.create.bind(world.toursRepo);
    world.toursRepo.create = async (input) => {
      const created = await realCreate(input);
      // B clicks Not interested on another screen while A's create runs.
      await world.listingSendsRepo.setDeclined('unit-1', 'c-1', theirs);
      return created;
    };
    const clear = vi.spyOn(world.listingSendsRepo, 'clearDeclined');
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(clear).toHaveBeenCalledWith('unit-1', 'c-1', { expectedAt: read.at });
    expect((await stored(world))?.declined).toEqual(theirs);
    // B's decline is later than A's new tour, so it is effective.
    expect(res.body.row).toMatchObject({ outcome: 'not_interested' });
    expect(outcomeEvents(world).map((e) => e.type)).toEqual(['listing_interested']);
    expect(world.toursMap.size).toBe(1);
  });

  it('a lost compare-and-clear with NO create is never a 404: no cleared event, the re-projection answers (review B R2-1)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.toursRepo.create({ tourId: 't-1', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'scheduled', createdAt: '2026-06-20T00:00:00.000Z' });
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-25T00:00:00.000Z', by: 'staff' });
    const theirs = { at: '2026-06-26T00:00:00.000Z', by: 'staff' as const, staffId: 'usr_b' };
    // B re-declines between A's read and A's clear.
    const realClear = world.listingSendsRepo.clearDeclined.bind(world.listingSendsRepo);
    world.listingSendsRepo.clearDeclined = async (unitId, contactId, opts) => {
      await world.listingSendsRepo.setDeclined(unitId, contactId, theirs);
      return realClear(unitId, contactId, opts);
    };
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'not_interested' });
    expect((await stored(world))?.declined).toEqual(theirs);
    expect(outcomeEvents(world)).toEqual([]);
    expect(world.toursMap.size).toBe(1);
  });

  it('a clear answering not_found with NO create and the row unchanged is not a 404 either: 200 with the row as it stands (review B R2-1)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world);
    seedContact(world, 'c-1');
    await seedSend(world);
    await world.toursRepo.create({ tourId: 't-1', tenantId: 'c-1', unitId: 'unit-1', tourType: 'self_guided', status: 'scheduled', createdAt: '2026-06-20T00:00:00.000Z' });
    await world.listingSendsRepo.setDeclined('unit-1', 'c-1', { at: '2026-06-25T00:00:00.000Z', by: 'staff' });
    world.listingSendsRepo.clearDeclined = async () => 'not_found';
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ outcome: 'not_interested' });
    expect(outcomeEvents(world)).toEqual([]);
  });

  it('503 (no saved) when the pre-write tours read fails - nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, { tour_type: 'self_guided' });
    seedContact(world, 'c-1');
    await seedSend(world);
    world.toursRepo.listByUnit = async () => {
      throw new Error('tours GSI unavailable');
    };
    const res = await post(app, { outcome: 'interested' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable' });
    expect(world.toursMap.size).toBe(0);
  });
});
