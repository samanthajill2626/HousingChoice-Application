// Route tests — GET /api/units/:unitId/activity, the property-page Activity
// card's read. Serves the unit's AUDIT trail (entityKey `units#<unitId>`)
// newest-first with per-type whitelisted details + best-effort contactName
// enrichment — NEVER the raw audit payload. Mirrors the unit-scoped sibling
// reads (/related, /recipients, /placements): 404 unknown unit, [] for a
// unit with no history.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { zeroStats, type BroadcastRecipient } from '../src/repos/broadcastsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

function seedUnit(
  world: ReturnType<typeof createFakeWorld>,
  unitId: string,
  overrides: Partial<UnitItem> = {},
): void {
  world.units.set(unitId, {
    unitId,
    landlordId: 'c-ll-1',
    status: 'available',
    jurisdiction: 'DCA',
    created_at: '2026-06-12T09:00:00.000Z',
    updated_at: '2026-06-12T09:00:00.000Z',
    ...overrides,
  });
}

function seedContact(
  world: ReturnType<typeof createFakeWorld>,
  contactId: string,
  overrides: Partial<ContactItem> = {},
): void {
  world.contacts.push({ contactId, type: 'tenant', ...overrides } as ContactItem);
}

const authedGet = (app: import('express').Express, path: string) =>
  request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

/** share-sent-outcome D5: a finished share of `unitId`, written straight into the world. */
function seedShare(
  world: ReturnType<typeof createFakeWorld>,
  broadcastId: string,
  unitId: string,
  recipients: Record<string, BroadcastRecipient>,
): void {
  const now = new Date().toISOString();
  world.broadcasts.set(broadcastId, {
    broadcastId,
    created_by: 'usr_test',
    created_at: now,
    updated_at: now,
    status: 'sent',
    unitId,
    audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
    body_template: 'hi',
    stats: zeroStats(),
    recipients,
  });
}

describe('GET /api/units/:id/activity (property Activity card)', () => {
  it('404s an unknown unit', async () => {
    const { app } = makeWebhookHarness();
    const res = await authedGet(app, '/api/units/ghost/activity');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unit_not_found');
  });

  it('returns { events: [] } for a unit with no history', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-quiet');
    const res = await authedGet(app, '/api/units/u-quiet/activity');
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });

  it('surfaces real API writes newest-first with honest types + details', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-active');
    seedContact(world, 'c-pm-a', { firstName: 'Pat', lastName: 'Manager' });

    // Three real mutations, in order: edit → roster add → roster remove.
    const patch = await request(app)
      .patch('/api/units/u-active')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ rent_min: 1200, deposit: 500 });
    expect(patch.status).toBe(200);

    const add = await request(app)
      .post('/api/units/u-active/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ contactId: 'c-pm-a', role: 'pm' });
    expect(add.status).toBe(200);

    const remove = await request(app)
      .delete('/api/units/u-active/contacts/c-pm-a')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(remove.status).toBe(200);

    const res = await authedGet(app, '/api/units/u-active/activity');
    expect(res.status).toBe(200);
    const events = res.body.events as Array<Record<string, unknown>>;
    // Newest-first: remove, add, update.
    expect(events.map((e) => e.type)).toEqual([
      'unit_contact_removed',
      'unit_contact_added',
      'unit_updated',
    ]);

    const [removed, added, updated] = events;
    expect(updated).toMatchObject({
      type: 'unit_updated',
      actorId: TEST_SESSION_USER.userId,
      fields: ['rent_min', 'deposit'],
    });
    expect(added).toMatchObject({
      type: 'unit_contact_added',
      contactId: 'c-pm-a',
      contactName: 'Pat Manager',
      role: 'pm',
    });
    expect(removed).toMatchObject({
      type: 'unit_contact_removed',
      contactId: 'c-pm-a',
      contactName: 'Pat Manager',
    });

    // Every event carries the id/at derived from the audit ts SK.
    for (const e of events) {
      expect(typeof e.id).toBe('string');
      expect((e.id as string).length).toBeGreaterThan(0);
      expect(typeof e.at).toBe('string');
      expect(Number.isNaN(Date.parse(e.at as string))).toBe(false);
      // The wire shape NEVER carries the raw audit payload.
      expect(e).not.toHaveProperty('payload');
    }
  });

  it('maps a listing_status_changed audit row with from/to/source', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-status', { status: 'setup' });
    await world.auditRepo.append('units#u-status', 'listing_status_changed', {
      actor: TEST_SESSION_USER.userId,
      from: 'setup',
      to: 'available',
      source: 'manual',
    });

    const res = await authedGet(app, '/api/units/u-status/activity');
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({
      type: 'listing_status_changed',
      from: 'setup',
      to: 'available',
      source: 'manual',
    });
  });

  it('omits contactName (never 500s) when the contact no longer resolves', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-ghostref');
    await world.auditRepo.append('units#u-ghostref', 'unit_contact_removed', {
      actor: TEST_SESSION_USER.userId,
      contactId: 'c-vanished',
    });

    const res = await authedGet(app, '/api/units/u-ghostref/activity');
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({ type: 'unit_contact_removed', contactId: 'c-vanished' });
    expect(res.body.events[0]).not.toHaveProperty('contactName');
  });

  it('projects broadcast_sent and tour audit rows onto the activity wire', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u1');
    await world.auditRepo.append('units#u1', 'broadcast_sent', { broadcastId: 'b9', tenantCount: 3 });
    await world.auditRepo.append('units#u1', 'tour_scheduled', { tourId: 't5' });
    const res = await authedGet(app, '/api/units/u1/activity');
    expect(res.status).toBe(200);
    const b = (res.body.events as Array<Record<string, unknown>>).find((e) => e.type === 'broadcast_sent');
    expect(b).toMatchObject({ broadcastId: 'b9', tenantCount: 3 });
    const t = (res.body.events as Array<Record<string, unknown>>).find((e) => e.type === 'tour_scheduled');
    expect(t).toMatchObject({ tourId: 't5' });
  });

  // share-sent-outcome D5: the audit row finalize wrote (every slot, whatever
  // happened to it) is append-only; the card's count is the share's REACHED
  // recipients at read time.
  it("broadcast_sent tenantCount is the share's REACHED count at read time (delivered + sent), not the slots written at finalize; a share nobody reached reads 0; a missing share keeps the stored count", async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedShare(world, 'b-1', 'unit-1', {
      'c-1': { status: 'delivered' },
      'c-2': { status: 'sent' },
      'c-3': { status: 'failed', errorCode: '30007' },
      'c-4': { status: 'skipped', errorCode: 'manual_mode' },
    });
    seedShare(world, 'b-none', 'unit-1', { 'c-1': { status: 'failed', errorCode: '30007' } });
    await world.auditRepo.append('units#unit-1', 'broadcast_sent', { broadcastId: 'b-1', tenantCount: 4 });
    await world.auditRepo.append('units#unit-1', 'broadcast_sent', { broadcastId: 'b-none', tenantCount: 1 });
    await world.auditRepo.append('units#unit-1', 'broadcast_sent', { broadcastId: 'b-gone', tenantCount: 4 });
    const reads = vi.spyOn(world.broadcastsRepo, 'getByIds');

    const res = await authedGet(app, '/api/units/unit-1/activity');
    expect(res.status).toBe(200);
    const byShare = new Map(
      (res.body.events as Array<{ type: string; broadcastId?: string; tenantCount?: number }>)
        .filter((e) => e.type === 'broadcast_sent')
        .map((e) => [e.broadcastId, e.tenantCount]),
    );
    expect(byShare.get('b-1')).toBe(2);
    expect(byShare.get('b-none')).toBe(0);
    expect(byShare.get('b-gone')).toBe(4);
    // ONE projected batch read for the page's shares.
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]?.[1]).toEqual({ projection: 'stats' });
    expect([...(reads.mock.calls[0]?.[0] ?? [])].sort()).toEqual(['b-1', 'b-gone', 'b-none']);
  });

  it('a page with no broadcast_sent row reads no share', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    await world.auditRepo.append('units#unit-1', 'tour_scheduled', { tourId: 't5' });
    const reads = vi.spyOn(world.broadcastsRepo, 'getByIds');
    const res = await authedGet(app, '/api/units/unit-1/activity');
    expect(res.status).toBe(200);
    expect(reads).not.toHaveBeenCalled();
  });

  it('a share read failure keeps every stored count and answers 200 with one ERROR (the route never 500s)', async () => {
    const { app, world, capture } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedShare(world, 'b-1', 'unit-1', { 'c-1': { status: 'delivered' } });
    await world.auditRepo.append('units#unit-1', 'broadcast_sent', { broadcastId: 'b-1', tenantCount: 3 });
    vi.spyOn(world.broadcastsRepo, 'getByIds').mockRejectedValue(new Error('batch down'));

    const res = await authedGet(app, '/api/units/unit-1/activity');
    expect(res.status).toBe(200);
    expect(
      (res.body.events as Array<{ type: string; tenantCount?: number }>).find((e) => e.type === 'broadcast_sent')?.tenantCount,
    ).toBe(3);
    const errors = capture.atLevel(50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ unitId: 'unit-1', count: 1 });
  });

  it('passes an unknown event type through honestly (open set, no payload leak)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-future');
    await world.auditRepo.append('units#u-future', 'unit_frobnicated', {
      actor: TEST_SESSION_USER.userId,
      secret_phone: '+14045550123',
    });

    const res = await authedGet(app, '/api/units/u-future/activity');
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({ type: 'unit_frobnicated' });
    expect(JSON.stringify(res.body.events[0])).not.toContain('+14045550123');
  });

  it('bounds the page with ?limit= and 400s an invalid limit', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-many');
    for (let i = 0; i < 5; i++) {
      await world.auditRepo.append('units#u-many', 'unit_updated', {
        actor: TEST_SESSION_USER.userId,
        fields: [`f${i}`],
      });
    }

    const limited = await authedGet(app, '/api/units/u-many/activity?limit=2');
    expect(limited.status).toBe(200);
    expect(limited.body.events).toHaveLength(2);
    // Newest-first: the LAST two appends.
    expect(limited.body.events.map((e: { fields: string[] }) => e.fields)).toEqual([['f4'], ['f3']]);

    const bad = await authedGet(app, '/api/units/u-many/activity?limit=0');
    expect(bad.status).toBe(400);
    const alsoBad = await authedGet(app, '/api/units/u-many/activity?limit=101');
    expect(alsoBad.status).toBe(400);
  });

  // primary-contact-integrity C11: the event the roster writes, the contact
  // delete fan-out and the backfill script append when the primary moves
  // without a click. `reason` is projected for THIS event only.
  it('projects unit_primary_contact_assigned with contactId, contactName, reason and from', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-handoff');
    seedContact(world, 'c-heir', { type: 'landlord', firstName: 'Mark', lastName: 'Passmore' });
    await world.auditRepo.append('units#u-handoff', 'unit_primary_contact_assigned', {
      contactId: 'c-heir',
      reason: 'handoff_on_delete',
      from: 'c-gone',
    });

    const res = await authedGet(app, '/api/units/u-handoff/activity');
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toEqual({
      id: expect.any(String),
      at: expect.any(String),
      type: 'unit_primary_contact_assigned',
      contactId: 'c-heir',
      contactName: 'Mark Passmore',
      reason: 'handoff_on_delete',
      from: 'c-gone',
    });
  });

  it('projects every primary-assignment reason code verbatim', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-reasons');
    const codes = ['auto_on_add', 'handoff_on_remove', 'handoff_on_delete', 'handoff_on_restore', 'backfill'];
    for (const reason of codes) {
      await world.auditRepo.append('units#u-reasons', 'unit_primary_contact_assigned', {
        contactId: 'c-x',
        reason,
      });
    }

    const res = await authedGet(app, '/api/units/u-reasons/activity');
    expect(res.status).toBe(200);
    const served = (res.body.events as Array<{ reason?: string }>).map((e) => e.reason);
    expect([...served].sort()).toEqual([...codes].sort());
  });

  it('keeps a listing_status_changed free-text reason OFF the wire', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-status-reason', { status: 'available' });
    await world.auditRepo.append('units#u-status-reason', 'listing_status_changed', {
      actor: TEST_SESSION_USER.userId,
      from: 'setup',
      to: 'available',
      source: 'manual',
      reason: 'Owner asked to pause until spring',
    });

    const res = await authedGet(app, '/api/units/u-status-reason/activity');
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({ type: 'listing_status_changed', from: 'setup', to: 'available' });
    expect(res.body.events[0]).not.toHaveProperty('reason');
  });
});

// property requirements (spec 2026-10-20 D13): an Apply from the landlord
// writes unit_updated { fields, reason: 'requirements_applied', landlordId }.
// The projection lifts `reason` for unit_updated ONLY when it is exactly that
// code; the landlordId stays off the wire.
describe('GET /api/units/:id/activity - the Apply reason (property requirements D13)', () => {
  it("projects unit_updated with reason 'requirements_applied' and the field names", async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-apply');
    await world.auditRepo.append('units#u-apply', 'unit_updated', {
      actor: TEST_SESSION_USER.userId,
      fields: ['no_pets', 'pet_fee'],
      reason: 'requirements_applied',
      landlordId: 'c-ll-1',
    });

    const res = await authedGet(app, '/api/units/u-apply/activity');
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toEqual({
      id: expect.any(String),
      at: expect.any(String),
      type: 'unit_updated',
      actorId: TEST_SESSION_USER.userId,
      fields: ['no_pets', 'pet_fee'],
      reason: 'requirements_applied',
    });
  });

  it('(PIN) keeps any other unit_updated reason OFF the wire', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-other-reason');
    await world.auditRepo.append('units#u-other-reason', 'unit_updated', {
      fields: ['beds'],
      reason: 'Owner asked',
    });

    const res = await authedGet(app, '/api/units/u-other-reason/activity');
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({ type: 'unit_updated', fields: ['beds'] });
    expect(res.body.events[0]).not.toHaveProperty('reason');
  });

  it("(PIN) keeps 'requirements_applied' OFF the wire on any other event type", async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-status-applied', { status: 'available' });
    await world.auditRepo.append('units#u-status-applied', 'listing_status_changed', {
      from: 'setup',
      to: 'available',
      source: 'manual',
      reason: 'requirements_applied',
    });

    const res = await authedGet(app, '/api/units/u-status-applied/activity');
    expect(res.status).toBe(200);
    expect(res.body.events[0]).not.toHaveProperty('reason');
  });
});

// flyer-leads planner review A-L2: the contactName enrichment uses the Sent to
// card's label rule (routes/units.ts recipientLabelOf, AR13) - the name, else
// the contact's OWN formatted phone. A flyer sign-up puts a nameless `unknown`
// contact on the Sent to card (spec D7) and never renames it (D4); staff can
// record an outcome on that row, which appends listing_declined (or
// listing_interested / listing_decline_cleared) to the unit's trail, and this
// card printed that contact's raw contactId.
describe('GET /api/units/:id/activity - contactName follows the Sent to label rule (flyer-leads A-L2)', () => {
  async function seedOutcomeRow(world: ReturnType<typeof createFakeWorld>, unitId: string, contactId: string): Promise<void> {
    await world.auditRepo.append(`units#${unitId}`, 'listing_declined', {
      actor: TEST_SESSION_USER.userId,
      contactId,
    });
  }

  const eventFor = (events: Array<Record<string, unknown>>, contactId: string) =>
    events.find((e) => e['contactId'] === contactId);

  it('a nameless contact with a phone reads as its formatted phone; a non-NANP phone as stored', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-label');
    seedContact(world, 'c-unk', { type: 'unknown', status: 'active', phone: '+14045550142' });
    seedContact(world, 'c-intl', { type: 'unknown', status: 'active', phone: '+442071838750' });
    await seedOutcomeRow(world, 'u-label', 'c-unk');
    await seedOutcomeRow(world, 'u-label', 'c-intl');

    const res = await authedGet(app, '/api/units/u-label/activity');
    expect(res.status).toBe(200);
    const events = res.body.events as Array<Record<string, unknown>>;
    expect(eventFor(events, 'c-unk')).toMatchObject({ type: 'listing_declined', contactName: '(404) 555-0142' });
    expect(eventFor(events, 'c-intl')).toMatchObject({ type: 'listing_declined', contactName: '+442071838750' });
  });

  it('(PIN) a contact with neither a name nor a phone carries no contactName (the client falls back to the id)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-label');
    seedContact(world, 'c-bare', { type: 'unknown', status: 'active' });
    await seedOutcomeRow(world, 'u-label', 'c-bare');

    const res = await authedGet(app, '/api/units/u-label/activity');
    expect(res.status).toBe(200);
    const row = eventFor(res.body.events as Array<Record<string, unknown>>, 'c-bare');
    expect(row).toMatchObject({ type: 'listing_declined', contactId: 'c-bare' });
    expect(row).not.toHaveProperty('contactName');
  });

  it('(PIN) a named contact keeps its name, even when it has a phone', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-label');
    seedContact(world, 'c-named', { firstName: 'Brianna', lastName: 'Whitfield', phone: '+14045550143' });
    await seedOutcomeRow(world, 'u-label', 'c-named');

    const res = await authedGet(app, '/api/units/u-label/activity');
    expect(res.status).toBe(200);
    expect(eventFor(res.body.events as Array<Record<string, unknown>>, 'c-named')).toMatchObject({
      type: 'listing_declined',
      contactName: 'Brianna Whitfield',
    });
  });
});
