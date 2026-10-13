// POST /api/placements - the tenant check (caseworker integrity spec
// 2026-10-12, section 4, I2). The existing 404 tenant_not_found stays; a
// contact that exists but is not typed `tenant` is refused 409
// { error: 'contact_not_tenant', contactKind } - for ANY starting stage -
// before the unit check and before any write. The read is CONSISTENT.
// Harness world fakes (no DynamoDB).
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const SUBJECT = 'c-subject';
const UNIT = 'unit-p1';

let app: App;
let world: FakeWorld;

beforeEach(async () => {
  ({ app, world } = makeWebhookHarness());
  await world.unitsRepo.create({ unitId: UNIT, landlordId: 'll-p1', status: 'available' });
});

const createPlacement = (body: object) =>
  request(app)
    .post('/api/placements')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);

function seedContact(fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

/** A refused create persists nothing, audits nothing and emits nothing. */
function expectNothingWritten(): void {
  expect(world.placements.size).toBe(0);
  expect(world.auditEvents.filter((a) => a.event_type === 'placement_created')).toEqual([]);
  expect(world.emitted.filter((e) => e.event === 'placement.updated')).toEqual([]);
}

const NOT_TENANTS = [
  ['landlord', { type: 'landlord' }, 'landlord'],
  ['partner', { type: 'partner' }, 'partner'],
  ['team member', { type: 'team_member' }, 'team_member'],
  ['unknown contact', { type: 'unknown' }, 'unknown'],
  ['caseworker', { type: 'partner', role: 'Caseworker' }, 'caseworker'],
] as const;

describe('POST /api/placements - the tenant must be a tenant (I2)', () => {
  it('opens a placement for a contact typed tenant, reading it CONSISTENTLY', async () => {
    seedContact({ type: 'tenant' });
    const getById = vi.spyOn(world.contactsRepo, 'getById');

    const res = await createPlacement({ tenantId: SUBJECT, unitId: UNIT });

    expect(res.status).toBe(201);
    expect(res.body.placement.tenantId).toBe(SUBJECT);
    expect(getById).toHaveBeenCalledWith(SUBJECT, { consistentRead: true });
  });

  it('(PIN) 404 tenant_not_found when the contact does not exist - nothing written', async () => {
    const res = await createPlacement({ tenantId: SUBJECT, unitId: UNIT });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
    expectNothingWritten();
  });

  it.each(NOT_TENANTS)('409 contact_not_tenant for a %s - nothing written', async (_label, fields, kind) => {
    seedContact(fields);

    const res = await createPlacement({ tenantId: SUBJECT, unitId: UNIT });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: kind });
    expectNothingWritten();
  });

  it('refused for any starting stage, a terminal one included', async () => {
    seedContact({ type: 'landlord' });

    const res = await createPlacement({ tenantId: SUBJECT, unitId: UNIT, stage: 'lost' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'landlord' });
    expectNothingWritten();
  });

  it('the tenant check answers before the unit check (a non-tenant on a missing unit is 409)', async () => {
    seedContact({ type: 'landlord' });

    const res = await createPlacement({ tenantId: SUBJECT, unitId: 'unit-ghost' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_not_tenant');
    expectNothingWritten();
  });
});
