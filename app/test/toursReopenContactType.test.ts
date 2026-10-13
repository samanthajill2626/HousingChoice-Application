// POST /api/tours/:id/reopen - the tenant check (caseworker integrity spec
// 2026-10-12, section 4, I2). Every reopen target (scheduled / toured /
// no_show) is an OPEN status, so a reopen needs a contact typed `tenant`: 409
// { error: 'contact_not_tenant', contactKind }, 404 tenant_not_found when the
// contact is gone, read CONSISTENTLY after the reopen decision and before the
// conditional write. Harness world fakes (no DynamoDB); closed tours are
// seeded straight into the store.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const NOW = '2030-05-01T12:00:00.000Z';
const AT = '2030-04-01T15:00:00.000Z';
const SUBJECT = 'c-subject';

const reopen = (app: App, tourId: string) =>
  request(app)
    .post(`/api/tours/${tourId}/reopen`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({});

function harness(): { app: App; world: FakeWorld } {
  const { app, world } = makeWebhookHarness({ toursNow: () => NOW });
  return { app, world };
}

function seedContact(world: FakeWorld, fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

async function seedClosedTour(world: FakeWorld, closedFields: Partial<TourItem>): Promise<string> {
  const tour = await world.toursRepo.create({
    tenantId: SUBJECT,
    unitId: 'unit-abc',
    tourType: 'self_guided',
    scheduledAt: AT,
    status: 'closed',
    ...closedFields,
  });
  return tour.tourId;
}

/** The ways a tour comes to be closed, with the open status a reopen sends it to. */
const CLOSED_FROM = [
  ['a person decided not a fit', { outcome: 'not_a_fit', moveForward: false }, 'toured'],
  [
    'auto-closed from scheduled',
    { outcome: 'no_outcome', autoClosedAt: NOW, autoClosedFrom: 'scheduled' },
    'scheduled',
  ],
  ['auto-closed from no_show', { outcome: 'no_outcome', autoClosedAt: NOW, autoClosedFrom: 'no_show' }, 'no_show'],
] as const;

/** The refused reopen left the tour closed with its outcome, recorded nothing and emitted nothing. */
function expectStillClosed(world: FakeWorld, tourId: string, outcome: string): void {
  const stored = world.toursMap.get(tourId)!;
  expect(stored.status).toBe('closed');
  expect(stored.outcome).toBe(outcome);
  expect(world.auditEvents.filter((e) => e.event_type === 'tour_reopened')).toEqual([]);
  expect(world.emitted.filter((e) => e.event === 'tour.updated')).toEqual([]);
}

describe('POST /api/tours/:id/reopen - the tenant must be a tenant (I2)', () => {
  it.each(CLOSED_FROM)('%s: reopens for a tenant, read CONSISTENTLY', async (_label, closed, target) => {
    const { app, world } = harness();
    seedContact(world, { type: 'tenant' });
    const tourId = await seedClosedTour(world, closed);
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    const res = await reopen(app, tourId);

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe(target);
    expect(getById).toHaveBeenCalledWith(SUBJECT, { consistentRead: true });
  });

  it.each(CLOSED_FROM)('%s: 409 contact_not_tenant for a landlord, the tour stays closed', async (_label, closed) => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedClosedTour(world, closed);

    const res = await reopen(app, tourId);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'landlord' });
    expectStillClosed(world, tourId, closed.outcome);
  });

  it('a caseworker is refused with contactKind caseworker', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'partner', role: 'Caseworker' });
    const tourId = await seedClosedTour(world, { outcome: 'not_a_fit', moveForward: false });

    const res = await reopen(app, tourId);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'caseworker' });
    expectStillClosed(world, tourId, 'not_a_fit');
  });

  it('404 tenant_not_found when the contact is gone - the tour stays closed', async () => {
    const { app, world } = harness();
    const tourId = await seedClosedTour(world, { outcome: 'not_a_fit', moveForward: false });

    const res = await reopen(app, tourId);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
    expectStillClosed(world, tourId, 'not_a_fit');
  });

  it('(PIN) a tour that cannot reopen answers that first: a scheduled tour of a landlord is 409 tour_not_closed', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tour = await world.toursRepo.create({
      tenantId: SUBJECT,
      unitId: 'unit-abc',
      tourType: 'self_guided',
      scheduledAt: AT,
      status: 'scheduled',
    });

    const res = await reopen(app, tour.tourId);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'tour_not_closed' });
  });
});
