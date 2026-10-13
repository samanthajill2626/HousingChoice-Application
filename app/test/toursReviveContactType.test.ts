// PATCH /api/tours/:id - reviving a CANCELED tour (caseworker integrity spec
// 2026-10-12, section 4, I2). Moving a tour whose CURRENT status is canceled
// into an OPEN status - scheduled (a new time alone auto-advances, or an
// explicit status), toured, no_show - needs a contact typed `tenant`: 409
// { error: 'contact_not_tenant', contactKind }, 404 tenant_not_found when the
// contact is gone, read CONSISTENTLY, before the write. A move between open
// statuses, or into a closed one, is not checked, and the transition guards
// still answer first. Harness world fakes (no DynamoDB); tours are seeded
// straight into the store, since POST /api/tours itself refuses non-tenants.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { TourStatus } from '../src/lib/toursModel.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const NOW = '2030-05-01T12:00:00.000Z';
const AT = '2030-06-01T15:00:00.000Z';
const NEW_AT = '2030-06-02T15:00:00.000Z';
const SUBJECT = 'c-subject';

const patchTour = (app: App, tourId: string, body: object) =>
  request(app)
    .patch(`/api/tours/${tourId}`)
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

async function seedTour(world: FakeWorld, status: TourStatus): Promise<string> {
  const tour = await world.toursRepo.create({
    tenantId: SUBJECT,
    unitId: 'unit-abc',
    tourType: 'self_guided',
    scheduledAt: AT,
    status,
  });
  return tour.tourId;
}

/** The refused PATCH left the tour canceled, armed nothing and emitted nothing. */
function expectUntouched(world: FakeWorld, tourId: string): void {
  expect(world.toursMap.get(tourId)?.status).toBe('canceled');
  expect([...world.tourRemindersMap.values()].filter((r) => r.tourId === tourId)).toEqual([]);
  expect(world.emitted.filter((e) => e.event === 'tour.updated' || e.event === 'scheduled.updated')).toEqual([]);
}

const REVIVALS = [
  ['a new time alone (auto-advances to scheduled)', { scheduledAt: NEW_AT }, 'scheduled'],
  ['status scheduled', { status: 'scheduled' }, 'scheduled'],
  ['status toured', { status: 'toured' }, 'toured'],
  ['status no_show', { status: 'no_show' }, 'no_show'],
] as const;

describe('PATCH /api/tours/:id - reviving a canceled tour needs a tenant (I2)', () => {
  it.each(REVIVALS)('%s: 409 contact_not_tenant for a landlord, nothing written', async (_label, body) => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedTour(world, 'canceled');

    const res = await patchTour(app, tourId, body);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'landlord' });
    expectUntouched(world, tourId);
  });

  it.each(REVIVALS)('%s: allowed for a tenant, read CONSISTENTLY', async (_label, body, status) => {
    const { app, world } = harness();
    seedContact(world, { type: 'tenant' });
    const tourId = await seedTour(world, 'canceled');
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    const res = await patchTour(app, tourId, body);

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe(status);
    expect(getById).toHaveBeenCalledWith(SUBJECT, { consistentRead: true });
  });

  it('a caseworker is refused with contactKind caseworker', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'partner', role: 'Caseworker' });
    const tourId = await seedTour(world, 'canceled');

    const res = await patchTour(app, tourId, { scheduledAt: NEW_AT });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'caseworker' });
    expectUntouched(world, tourId);
  });

  it('404 tenant_not_found when the contact is gone - nothing written', async () => {
    const { app, world } = harness();
    const tourId = await seedTour(world, 'canceled');

    const res = await patchTour(app, tourId, { status: 'scheduled' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
    expectUntouched(world, tourId);
  });
});

describe('PATCH /api/tours/:id - what the revival check does NOT cover', () => {
  it('(PIN) a move between open statuses is not checked: scheduled -> toured for a landlord', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedTour(world, 'scheduled');

    const res = await patchTour(app, tourId, { status: 'toured' });

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('toured');
  });

  it('(PIN) no_show -> scheduled (a reschedule between open statuses) is not checked', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedTour(world, 'no_show');

    const res = await patchTour(app, tourId, { scheduledAt: NEW_AT });

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('scheduled');
  });

  it('(PIN) a move into a closed status is not checked: scheduled -> canceled for a landlord', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedTour(world, 'scheduled');

    const res = await patchTour(app, tourId, { status: 'canceled' });

    expect(res.status).toBe(200);
    expect(res.body.tour.status).toBe('canceled');
  });

  it('(PIN) restating canceled on a canceled tour is not checked', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedTour(world, 'canceled');

    const res = await patchTour(app, tourId, { status: 'canceled' });

    expect(res.status).toBe(200);
  });

  it('(PIN) the transition guard answers first: canceled -> requested is 409 illegal_status_transition', async () => {
    const { app, world } = harness();
    seedContact(world, { type: 'landlord' });
    const tourId = await seedTour(world, 'canceled');

    const res = await patchTour(app, tourId, { status: 'requested' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('illegal_status_transition');
  });
});
