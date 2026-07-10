// BE4/C4 route tests -- the sent-to-tenants / listings-sent endpoints:
//   GET /api/units/:unitId/recipients            -> { recipients: ListingSendRow[] }
//   GET /api/contacts/:contactId/listings-sent   -> { sent: ListingSendRow[] }
// Both query directions return the SAME row. The former response PATCH route is
// GONE (the `response` label was removed end to end) -- a 404 pin guards its removal.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

function seedUnit(world: ReturnType<typeof createFakeWorld>, unitId: string): UnitItem {
  const item: UnitItem = {
    unitId,
    landlordId: 'contact-ll-1',
    status: 'available',
    created_at: '2026-06-12T09:00:00.000Z',
    updated_at: '2026-06-12T09:00:00.000Z',
  };
  world.units.set(unitId, item);
  return item;
}

function seedTenant(world: ReturnType<typeof createFakeWorld>, contactId: string): ContactItem {
  const item: ContactItem = {
    contactId,
    type: 'tenant',
    status: 'active',
    phone: `+1555010${contactId.slice(-4).padStart(4, '0')}`,
  };
  world.contacts.push(item);
  return item;
}

describe('GET /api/units/:unitId/recipients (BE4/C4 — "Sent to tenants")', () => {
  it('returns the unit recipients from listByUnit', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    await world.listingSendsRepo.recordSend({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast', broadcastId: 'b-1' });
    await world.listingSendsRepo.recordSend({ contactId: 'c-2', unitId: 'unit-1', via: 'individual' });

    const res = await request(app)
      .get('/api/units/unit-1/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.recipients).toHaveLength(2);
    const c1 = res.body.recipients.find((r: { contactId: string }) => r.contactId === 'c-1');
    expect(c1).toMatchObject({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast', broadcastId: 'b-1' });
    // The removed `response` label is gone from the wire.
    expect(c1).not.toHaveProperty('response');
    // The wire shape drops audit furniture.
    expect(c1).not.toHaveProperty('created_at');
    expect(c1).not.toHaveProperty('updated_at');
  });

  it('returns [] for a real unit with zero recipients', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-empty');
    const res = await request(app)
      .get('/api/units/unit-empty/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.recipients).toEqual([]);
  });

  it('404s for an unknown unit (matches GET /:unitId)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/units/nope/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/contacts/:contactId/listings-sent (BE4/C4 — "Listings sent")', () => {
  it('returns the contact listings-sent from listByContact (same row, inverse direction)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    seedTenant(world, 'c-1');
    await world.listingSendsRepo.recordSend({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast', broadcastId: 'b-1' });

    const res = await request(app)
      .get('/api/contacts/c-1/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.sent).toHaveLength(1);
    expect(res.body.sent[0]).toMatchObject({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast' });
    expect(res.body.sent[0]).not.toHaveProperty('response');
  });

  it('returns [] for a contact with no listings sent', async () => {
    const { app, world } = makeWebhookHarness();
    seedTenant(world, 'c-none');
    const res = await request(app)
      .get('/api/contacts/c-none/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.sent).toEqual([]);
  });

  it('404s for an unknown contact', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/contacts/ghost/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
  });
});

describe('the two directions return the SAME row', () => {
  it('a single recordSend surfaces in both units/recipients and contacts/listings-sent', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-x');
    seedTenant(world, 'c-x');
    await world.listingSendsRepo.recordSend({ contactId: 'c-x', unitId: 'unit-x', via: 'broadcast', broadcastId: 'b-x' });

    const byUnit = await request(app)
      .get('/api/units/unit-x/recipients')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    const byContact = await request(app)
      .get('/api/contacts/c-x/listings-sent')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(byUnit.body.recipients[0]).toEqual(byContact.body.sent[0]);
  });
});

describe('PATCH /api/units/:unitId/recipients/:contactId is GONE (response label removed)', () => {
  it('404s -- the response PATCH route no longer exists', async () => {
    // Regression pin: the `response` label was removed end to end, so the manual
    // set-response route must be absent. An existing send row + a valid old-shape
    // body must still 404 (route gone), not 200/400.
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    await world.listingSendsRepo.recordSend({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast' });

    const res = await request(app)
      .patch('/api/units/unit-1/recipients/c-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ response: 'interested' });

    expect(res.status).toBe(404);
    // No listing_reviewed milestone can be emitted anymore (the type is gone too).
    expect(world.activityEvents.filter((e) => String(e.type) === 'listing_reviewed')).toHaveLength(0);
  });
});

describe('recordSend upsert semantics (no `response` field)', () => {
  it('a re-send refreshes broadcastId attribution and preserves created_at (idempotent upsert)', async () => {
    const { world } = makeWebhookHarness();
    const first = await world.listingSendsRepo.recordSend({
      contactId: 'c-1',
      unitId: 'unit-1',
      via: 'broadcast',
      broadcastId: 'b-1',
    });
    // Re-send (e.g. a second broadcast of the same unit to the same tenant).
    const resent = await world.listingSendsRepo.recordSend({
      contactId: 'c-1',
      unitId: 'unit-1',
      via: 'broadcast',
      broadcastId: 'b-2',
    });
    expect(resent.broadcastId).toBe('b-2'); // attribution refreshed
    expect(resent.created_at).toBe(first.created_at); // first-write furniture preserved
    // No `response` label is ever written.
    expect(resent).not.toHaveProperty('response');
  });
});
