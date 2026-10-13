// GET /api/broadcasts/follow-ups (last-heard-from spec 5.6, 14.4): the route
// serves the builder's list, is not shadowed by another broadcasts handler,
// and answers 503 outcome_unavailable when a required join fails (D12).
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { ListingSendItem } from '../src/repos/listingSendsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const DAY = 86_400_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

function seed(world: FakeWorld): void {
  const units: UnitItem[] = [
    { unitId: 'u-a', landlordId: 'c-ll', status: 'available', address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' }, tour_type: 'self_guided' },
    { unitId: 'u-b', landlordId: 'c-ll', status: 'available' },
    { unitId: 'u-off', landlordId: 'c-ll', status: 'on_hold' },
  ];
  for (const u of units) world.units.set(u.unitId, u);
  const tenant = (contactId: string, phone: string): ContactItem => ({ contactId, type: 'tenant', status: 'searching', phone, firstName: 'Ten', lastName: contactId });
  world.contacts.push(tenant('c-1', '+15550100001'), tenant('c-2', '+15550100002'), tenant('c-3', '+15550100003'));
  const send = (unitId: string, contactId: string, sentAt: string): ListingSendItem => ({ unitId, contactId, sentAt, via: 'individual', counted: true, created_at: sentAt, updated_at: sentAt });
  world.listingSends.push(send('u-a', 'c-1', ago(3 * DAY)), send('u-b', 'c-2', ago(5 * DAY)), send('u-off', 'c-3', ago(3 * DAY)));
}

function get(app: import('express').Express) {
  return request(app).get('/api/broadcasts/follow-ups').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
}

describe('GET /api/broadcasts/follow-ups', () => {
  it('serves the waiting rows of AVAILABLE properties, longest-waiting first, with byUnit', async () => {
    const world = createFakeWorld();
    seed(world);
    const { app } = makeWebhookHarness({ world });
    const res = await get(app);
    expect(res.status).toBe(200);
    // Exactly the builder's three keys - not the GET /broadcasts list, not a 404.
    expect(Object.keys(res.body).sort()).toEqual(['byUnit', 'items', 'truncated']);
    expect(res.body.items.map((i: { unitId: string; contactId: string }) => `${i.unitId}/${i.contactId}`)).toEqual(['u-b/c-2', 'u-a/c-1']);
    expect(res.body.items[1]).toMatchObject({ unitLabel: '12 Oak St, Atlanta, GA 30303', interestedMode: 'route', outcome: 'no_reply' });
    // No conversationId on the wire (spec 5.6): Text goes through ensureContactConversation.
    for (const item of res.body.items as Array<Record<string, unknown>>) expect(item).not.toHaveProperty('conversationId');
    expect(res.body.byUnit).toEqual({ 'u-a': 1, 'u-b': 1 });
    expect(res.body.truncated).toBe(false);
  });

  it('503 outcome_unavailable when the contacts batch is incomplete (the projected read - review ADV-2)', async () => {
    const world = createFakeWorld();
    seed(world);
    vi.spyOn(world.contactsRepo, 'getRecipientDisplaysByIds').mockRejectedValueOnce(new IncompleteBatchReadError(1, 3));
    const { app } = makeWebhookHarness({ world });
    const res = await get(app);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable' });
  });

  it('503 outcome_unavailable when a listing-sends read fails', async () => {
    const world = createFakeWorld();
    seed(world);
    vi.spyOn(world.listingSendsRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
    const { app } = makeWebhookHarness({ world });
    expect((await get(app)).status).toBe(503);
  });

  it('503 outcome_unavailable when a tours read fails', async () => {
    const world = createFakeWorld();
    seed(world);
    vi.spyOn(world.toursRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
    const { app } = makeWebhookHarness({ world });
    const res = await get(app);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'outcome_unavailable' });
  });
});
