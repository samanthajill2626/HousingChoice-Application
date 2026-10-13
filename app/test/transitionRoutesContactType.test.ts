// POST /api/placements/:id/transition - the route's answer when the service
// refuses a placement leaving a terminal stage (caseworker integrity spec
// 2026-10-12, section 4): handleTransitionError maps ContactNotTenantError to
// 409 { error: 'contact_not_tenant', contactKind } and TenantNotFoundError to
// 404 { error: 'tenant_not_found' }; its existing answers are unchanged.
// Harness world fakes (no DynamoDB).
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlacementStage } from '../src/lib/statusModel.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

const SUBJECT = 'c-subject';
const UNIT = 'unit-1';

let app: App;
let world: FakeWorld;

beforeEach(async () => {
  ({ app, world } = makeWebhookHarness());
  await world.unitsRepo.create({ unitId: UNIT, landlordId: 'll-1', status: 'available' });
});

const transition = (placementId: string, body: object) =>
  request(app)
    .post(`/api/placements/${placementId}/transition`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);

function seedContact(fields: Partial<ContactItem>): void {
  world.contacts.push({ contactId: SUBJECT, type: 'tenant', ...fields } as ContactItem);
}

async function seedPlacement(stage: PlacementStage): Promise<string> {
  const placement = await world.placementsRepo.create({ tenantId: SUBJECT, unitId: UNIT, stage });
  return placement.placementId;
}

describe('POST /api/placements/:id/transition - contact-type answers (I2)', () => {
  it('409 contact_not_tenant (with contactKind) for a landlord placement leaving lost; the stage stays', async () => {
    seedContact({ type: 'landlord' });
    const id = await seedPlacement('lost');

    const res = await transition(id, { toStage: 'send_application', source: 'manual' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'landlord' });
    expect(world.placements.get(id)!.stage).toBe('lost');
  });

  it('409 names a caseworker as caseworker', async () => {
    seedContact({ type: 'partner', role: 'Caseworker' });
    const id = await seedPlacement('moved_in');

    const res = await transition(id, { toStage: 'awaiting_move_in', source: 'manual' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'contact_not_tenant', contactKind: 'caseworker' });
  });

  it('404 tenant_not_found when the tenant contact is gone', async () => {
    const id = await seedPlacement('lost');

    const res = await transition(id, { toStage: 'send_application', source: 'manual' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'tenant_not_found' });
    expect(world.placements.get(id)!.stage).toBe('lost');
  });

  it('(PIN) a tenant placement leaves lost (200)', async () => {
    seedContact({ type: 'tenant' });
    const id = await seedPlacement('lost');

    const res = await transition(id, { toStage: 'send_application', source: 'manual' });

    expect(res.status).toBe(200);
    expect(res.body.placement.stage).toBe('send_application');
  });

  it('(PIN) an unknown placement is still 404 placement_not_found', async () => {
    const res = await transition('placement-ghost', { toStage: 'send_application', source: 'manual' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'placement_not_found' });
  });
});
