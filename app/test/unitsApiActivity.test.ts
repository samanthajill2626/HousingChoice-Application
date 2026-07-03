// Route tests — GET /api/units/:unitId/activity, the property-page Activity
// card's read. Serves the unit's AUDIT trail (entityKey `units#<unitId>`)
// newest-first with per-type whitelisted details + best-effort contactName
// enrichment — NEVER the raw audit payload. Mirrors the unit-scoped sibling
// reads (/related, /recipients, /placements): 404 unknown unit, [] for a
// unit with no history.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
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

  it('maps a listing_response_set audit row with response + contactName', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-resp');
    seedContact(world, 'c-tenant-r', { firstName: 'Tina', lastName: 'Renter' });
    await world.listingSendsRepo.recordSend({
      unitId: 'u-resp',
      contactId: 'c-tenant-r',
      via: 'broadcast',
    });

    const patch = await request(app)
      .patch('/api/units/u-resp/recipients/c-tenant-r')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ response: 'interested' });
    expect(patch.status).toBe(200);

    const res = await authedGet(app, '/api/units/u-resp/activity');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      type: 'listing_response_set',
      contactId: 'c-tenant-r',
      contactName: 'Tina Renter',
      response: 'interested',
    });
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
});
