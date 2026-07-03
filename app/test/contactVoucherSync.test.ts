// Voucher sync (placement-deadline-model §6): the staff-set contact field
// `voucher_expiration_date` is the SOURCE of the `voucher_expiration` placement
// deadline. Setting/clearing it on a tenant contact upserts/retires the deadline
// on the tenant's ACTIVE (non-terminal) placements; the create-path arms it from
// the contact date at placement open. Driven on the in-memory world (no DB).
import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { soonestDeadline } from '../src/repos/placementDeadlinesRepo.js';

describe('contact voucher_expiration_date → placement deadline sync', () => {
  let app: Express;
  let world: FakeWorld;

  beforeEach(() => {
    const h = makeWebhookHarness();
    app = h.app;
    world = h.world;
  });

  const authedPatch = (path: string, body: Record<string, unknown>) =>
    request(app).patch(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);
  const authedPost = (path: string, body: Record<string, unknown>) =>
    request(app).post(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE).send(body);

  const voucherType = async (placementId: string): Promise<string | undefined> =>
    soonestDeadline(await world.placementDeadlinesRepo.listByPlacement(placementId))?.type ??
    undefined;

  it('editing the date arms voucher_expiration on ACTIVE placements, leaves terminal untouched, emits', async () => {
    await world.contactsRepo.create({ contactId: 'tn-1', type: 'tenant', status: 'searching' });
    const active = await world.placementsRepo.create({ tenantId: 'tn-1', unitId: 'u-a', stage: 'collect_rta' });
    const terminal = await world.placementsRepo.create({ tenantId: 'tn-1', unitId: 'u-b', stage: 'moved_in' });

    const res = await authedPatch('/api/contacts/tn-1', { voucher_expiration_date: '2026-12-01' });
    expect(res.status).toBe(200);
    // Canonicalized to ISO on the contact.
    expect(res.body.contact.voucher_expiration_date).toBe('2026-12-01T00:00:00.000Z');
    // Armed on the ACTIVE placement...
    expect(await voucherType(active.placementId)).toBe('voucher_expiration');
    const armed = await world.placementDeadlinesRepo.listByPlacement(active.placementId);
    expect(armed[0]!.at).toBe('2026-12-01T00:00:00.000Z');
    // ...NOT on the terminal one.
    expect(await world.placementDeadlinesRepo.listByPlacement(terminal.placementId)).toHaveLength(0);
    // A placement.updated fired for the touched active placement.
    const evt = world.emitted
      .filter((e) => e.event === 'placement.updated')
      .map((e) => e.payload as { placementId: string; next_deadline_type: string | null });
    expect(evt.some((p) => p.placementId === active.placementId && p.next_deadline_type === 'voucher_expiration')).toBe(true);
  });

  it('clearing the date (empty string) retires voucher_expiration on active placements', async () => {
    await world.contactsRepo.create({ contactId: 'tn-2', type: 'tenant', status: 'searching' });
    const active = await world.placementsRepo.create({ tenantId: 'tn-2', unitId: 'u-c', stage: 'collect_rta' });
    await world.placementDeadlinesRepo.arm(active.placementId, 'voucher_expiration', '2026-12-01T00:00:00.000Z');

    const res = await authedPatch('/api/contacts/tn-2', { voucher_expiration_date: '' });
    expect(res.status).toBe(200);
    expect(res.body.contact.voucher_expiration_date).toBeUndefined(); // cleared → REMOVE
    expect(await world.placementDeadlinesRepo.listByPlacement(active.placementId)).toHaveLength(0);
  });

  it('the create-path arms voucher_expiration from the tenant contact date', async () => {
    // A tenant whose voucher date is already on file.
    await world.contactsRepo.create({
      contactId: 'tn-3',
      type: 'tenant',
      status: 'searching',
      voucher_expiration_date: '2026-11-15T00:00:00.000Z',
    });
    await world.unitsRepo.create({ unitId: 'u-d', landlordId: 'll-1', status: 'available' });

    const res = await authedPost('/api/placements', { tenantId: 'tn-3', unitId: 'u-d' });
    expect(res.status).toBe(201);
    const placementId = res.body.placement.placementId as string;
    const rows = await world.placementDeadlinesRepo.listByPlacement(placementId);
    expect(rows.map((r) => r.type)).toEqual(['voucher_expiration']);
    expect(rows[0]!.at).toBe('2026-11-15T00:00:00.000Z');
    // The create response carries the computed soonest next_deadline_*.
    expect(res.body.placement.next_deadline_type).toBe('voucher_expiration');
  });

  it('rejects a non-date voucher_expiration_date (400) on both create and patch', async () => {
    await world.contactsRepo.create({ contactId: 'tn-4', type: 'tenant', status: 'searching' });
    expect((await authedPatch('/api/contacts/tn-4', { voucher_expiration_date: 'not-a-date' })).status).toBe(400);
    expect((await authedPost('/api/contacts', { type: 'tenant', voucher_expiration_date: 'nope' })).status).toBe(400);
  });
});
