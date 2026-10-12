// POST /api/tours - the tenant check (caseworker integrity spec 2026-10-12,
// section 4, I2). A tour's tenant must exist (404 tenant_not_found) and be a
// contact typed `tenant` (409 { error: 'contact_not_tenant', contactKind });
// the read is CONSISTENT and runs after the body validation and before any
// write. Harness world fakes (no DynamoDB). Deliberately NOT toursApi.test.ts:
// that file seeds a typed tenant for every tour it posts.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const NOW = '2030-05-01T12:00:00.000Z';
const SUBJECT = 'c-subject';
const BODY = {
  tenantId: SUBJECT,
  unitId: 'unit-abc',
  scheduledAt: '2030-06-01T15:00:00.000Z',
  tourType: 'self_guided',
};

const createTour = (app: App, body: object) =>
  request(app)
    .post('/api/tours')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);

function harness(): { app: App; world: FakeWorld } {
  const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
  return { app, world };
}

function seedContact(world: FakeWorld, fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

/** A refused create leaves nothing: no tour, no reminder row, no emit, no milestone. */
function expectNothingWritten(world: FakeWorld): void {
  expect(world.toursMap.size).toBe(0);
  expect(world.tourRemindersMap.size).toBe(0);
  expect(world.emitted.filter((e) => e.event === 'scheduled.updated' || e.event === 'tour.updated')).toEqual([]);
  expect(world.activityEvents.filter((e) => e.type === 'tour_scheduled')).toEqual([]);
}

const NOT_TENANTS = [
  ['landlord', { type: 'landlord' }, 'landlord'],
  ['partner', { type: 'partner' }, 'partner'],
  ['team member', { type: 'team_member' }, 'team_member'],
  ['unknown contact', { type: 'unknown' }, 'unknown'],
  ['caseworker', { type: 'partner', role: 'Caseworker' }, 'caseworker'],
] as const;

describe('POST /api/tours - the tenant must be a tenant (I2)', () => {
  it('creates the tour for a contact typed tenant, reading it CONSISTENTLY', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'tenant' });
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    const res = await createTour(app, BODY);

    expect(res.status).toBe(201);
    expect(res.body.tour).toMatchObject({ tenantId: SUBJECT, status: 'scheduled' });
    expect(getById).toHaveBeenCalledWith(SUBJECT, { consistentRead: true });
  });

  it('404 tenant_not_found when the contact does not exist - nothing written', async () => {
    const { app, world } = harness();

    const res = await createTour(app, BODY);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
    expectNothingWritten(world);
  });

  it.each(NOT_TENANTS)('409 contact_not_tenant for a %s - nothing written', async (_label, fields, kind) => {
    const { app, world } = harness();
    seedContact(world, fields);

    const res = await createTour(app, BODY);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: kind });
    expectNothingWritten(world);
  });

  it('a timeless (requested) create is checked the same way', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });

    const res = await createTour(app, { tenantId: SUBJECT, unitId: 'unit-abc', tourType: 'self_guided' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'landlord' });
    expectNothingWritten(world);
  });

  it('(PIN) body validation answers first: a bad tourType for a missing contact is 400, not 404', async () => {
    const { app, world } = harness();

    const res = await createTour(app, { ...BODY, tourType: 'bad_type' });

    expect(res.status).toBe(400);
    expectNothingWritten(world);
  });

  it('(PIN) a soft-deleted tenant still exists - no deleted-contact refusal (spec section 10)', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'tenant', deleted_at: '2026-10-01T00:00:00.000Z' });

    const res = await createTour(app, BODY);

    expect(res.status).toBe(201);
  });
});
