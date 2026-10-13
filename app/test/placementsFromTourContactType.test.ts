// POST /api/placements/from-tour - the tenant check (caseworker integrity spec
// 2026-10-12, section 4, I2). The tour's tenant must still exist (404
// tenant_not_found, as before) AND be a contact typed `tenant` (409
// { error: 'contact_not_tenant', contactKind }), read CONSISTENTLY BEFORE the
// conversion claim - a refusal writes nothing: no claim, no placement, the
// tour untouched. Harness world fakes (no DynamoDB).
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const SUBJECT = 'c-subject';
const UNIT = 'unit-ft1';

let app: App;
let world: FakeWorld;

beforeEach(async () => {
  ({ app, world } = makeWebhookHarness());
  await world.unitsRepo.create({ unitId: UNIT, landlordId: 'll-ft1', status: 'available' });
});

const convert = (tourId: string) =>
  request(app)
    .post('/api/placements/from-tour')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ tourId });

function seedContact(fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

/** A toured tour whose exit gate said move forward (convertible). */
async function seedConvertibleTour(): Promise<string> {
  const tour = await world.toursRepo.create({
    tenantId: SUBJECT,
    unitId: UNIT,
    tourType: 'self_guided',
    scheduledAt: '2030-06-01T15:00:00.000Z',
    status: 'toured',
    outcome: 'move_forward',
    moveForward: true,
    convertible: true,
  });
  return tour.tourId;
}

/** Nothing claimed, nothing created: the tour is still toured and unconverted. */
function expectTourUntouched(tourId: string): void {
  const stored = world.toursMap.get(tourId)!;
  expect(stored.status).toBe('toured');
  expect(stored.convertedPlacementId).toBeUndefined();
  expect(world.placements.size).toBe(0);
}

const NOT_TENANTS = [
  ['landlord', { type: 'landlord' }, 'landlord'],
  ['team member', { type: 'team_member' }, 'team_member'],
  ['unknown contact', { type: 'unknown' }, 'unknown'],
  ['caseworker', { type: 'partner', role: 'Caseworker' }, 'caseworker'],
] as const;

describe('POST /api/placements/from-tour - the tenant must be a tenant (I2)', () => {
  it('converts for a contact typed tenant, reading it CONSISTENTLY', async () => {
    seedContact({ type: 'tenant' });
    const tourId = await seedConvertibleTour();
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    const res = await convert(tourId);

    expect(res.status).toBe(201);
    expect(res.body.placement.tenantId).toBe(SUBJECT);
    expect(getById).toHaveBeenCalledWith(SUBJECT, { consistentRead: true });
  });

  it.each(NOT_TENANTS)('409 contact_not_tenant for a %s - no claim, no placement', async (_label, fields, kind) => {
    seedContact(fields);
    const tourId = await seedConvertibleTour();

    const res = await convert(tourId);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: kind });
    expectTourUntouched(tourId);
  });

  it('(PIN) 404 tenant_not_found when the contact is gone - no claim, no placement', async () => {
    const tourId = await seedConvertibleTour();

    const res = await convert(tourId);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
    expectTourUntouched(tourId);
  });
});
