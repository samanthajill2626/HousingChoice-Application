// BE4/C4 route tests — the sent-to-tenants / listings-sent endpoints + the
// response PATCH:
//   GET   /api/units/:unitId/recipients            → { recipients: ListingSendRow[] }
//   GET   /api/contacts/:contactId/listings-sent   → { sent: ListingSendRow[] }
//   PATCH /api/units/:unitId/recipients/:contactId → { recipient }
// Both query directions return the SAME row; the PATCH validates + 404s + emits
// listing_reviewed only on a real interested/not_a_fit change; re-send (via the
// repo) preserves an already-set response.
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
    expect(c1).toMatchObject({ contactId: 'c-1', unitId: 'unit-1', response: 'no_reply', via: 'broadcast', broadcastId: 'b-1' });
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
    expect(res.body.sent[0]).toMatchObject({ contactId: 'c-1', unitId: 'unit-1', response: 'no_reply', via: 'broadcast' });
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

describe('PATCH /api/units/:unitId/recipients/:contactId (BE4/C4 — response)', () => {
  it('sets the response, returns { recipient }, audits, and emits listing_reviewed', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    await world.listingSendsRepo.recordSend({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast' });

    const res = await request(app)
      .patch('/api/units/unit-1/recipients/c-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ response: 'interested' });

    expect(res.status).toBe(200);
    expect(res.body.recipient).toMatchObject({ contactId: 'c-1', unitId: 'unit-1', response: 'interested' });
    // The row is updated.
    expect(world.listingSends.find((r) => r.contactId === 'c-1')?.response).toBe('interested');
    // listing_reviewed emitted, deep-linking to the unit.
    const reviewed = world.activityEvents.filter((e) => e.type === 'listing_reviewed');
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toMatchObject({ contactId: 'c-1', refType: 'unit', refId: 'unit-1' });
    // Audited.
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({ entityKey: 'units#unit-1', event_type: 'listing_response_set' }),
    );
  });

  it('rejects an invalid response with 400', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    await world.listingSendsRepo.recordSend({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast' });
    const res = await request(app)
      .patch('/api/units/unit-1/recipients/c-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ response: 'maybe' });
    expect(res.status).toBe(400);
    expect(world.activityEvents.filter((e) => e.type === 'listing_reviewed')).toHaveLength(0);
  });

  it('404s when the send row does not exist', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const res = await request(app)
      .patch('/api/units/unit-1/recipients/c-missing')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ response: 'interested' });
    expect(res.status).toBe(404);
  });

  it('does NOT emit listing_reviewed on a set to no_reply or an unchanged value', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    await world.listingSendsRepo.recordSend({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast' });

    // Set to no_reply (the default) — no reviewed milestone.
    await request(app)
      .patch('/api/units/unit-1/recipients/c-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ response: 'no_reply' });
    expect(world.activityEvents.filter((e) => e.type === 'listing_reviewed')).toHaveLength(0);

    // Set to interested (a real change) — one milestone.
    await request(app)
      .patch('/api/units/unit-1/recipients/c-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ response: 'interested' });
    expect(world.activityEvents.filter((e) => e.type === 'listing_reviewed')).toHaveLength(1);

    // Set to interested AGAIN (no change) — still just one milestone.
    await request(app)
      .patch('/api/units/unit-1/recipients/c-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ response: 'interested' });
    expect(world.activityEvents.filter((e) => e.type === 'listing_reviewed')).toHaveLength(1);
  });

  it('no double-emit: two identical interested sets collapse to ONE listing_reviewed (atomic conditional)', async () => {
    // The atomic-conditional setResponse only "changes" on a real value
    // transition. Two PATCHes of no_reply→interested (the second hitting the
    // changed:false / ConditionalCheckFailed path) is exactly what a concurrent
    // double-PATCH collapses to — exactly ONE milestone must result.
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    await world.listingSendsRepo.recordSend({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast' });

    const first = await request(app)
      .patch('/api/units/unit-1/recipients/c-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ response: 'interested' });
    expect(first.status).toBe(200);

    // Second identical set: the row already === 'interested', so the conditional
    // does NOT write and changed === false → NO second milestone.
    const second = await request(app)
      .patch('/api/units/unit-1/recipients/c-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ response: 'interested' });
    expect(second.status).toBe(200);
    expect(second.body.recipient).toMatchObject({ contactId: 'c-1', response: 'interested' });

    // Exactly ONE listing_reviewed despite two interested PATCHes.
    expect(world.activityEvents.filter((e) => e.type === 'listing_reviewed')).toHaveLength(1);
  });

  it('a re-send does not reset an already-set response (no_reset invariant)', async () => {
    const { world } = makeWebhookHarness();
    await world.listingSendsRepo.recordSend({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast', broadcastId: 'b-1' });
    await world.listingSendsRepo.setResponse('unit-1', 'c-1', 'interested');
    // Re-send (e.g. a second broadcast of the same unit to the same tenant).
    const resent = await world.listingSendsRepo.recordSend({ contactId: 'c-1', unitId: 'unit-1', via: 'broadcast', broadcastId: 'b-2' });
    expect(resent.response).toBe('interested'); // preserved
    expect(resent.broadcastId).toBe('b-2'); // attribution refreshed
  });
});
