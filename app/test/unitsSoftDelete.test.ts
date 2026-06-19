// Soft-delete listings (units): DELETE /api/units/:id (stamp deleted_at, keep all
// data) + POST /api/units/:id/restore, plus the visibility rules — deleted units
// vanish from the normal lists (incl. the no-filter list the landlord card reads,
// the byStatus filter, and the byLandlord path) and surface only in the
// ?deleted=true view. Runs on the shared in-memory world (makeWebhookHarness).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

function seedUnit(
  world: ReturnType<typeof createFakeWorld>,
  unitId: string,
  overrides: Partial<UnitItem> = {},
): void {
  world.units.set(unitId, {
    unitId,
    landlordId: 'contact-ll-1',
    status: 'available',
    jurisdiction: 'DCA',
    ...overrides,
  });
}

const ids = (body: { units: UnitItem[] }): string[] => body.units.map((u) => u.unitId);

describe('DELETE /api/units/:id (soft delete) + restore', () => {
  it('soft-deletes: stamps deleted_at, keeps the record, hides it from the list', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-1');

    const del = await auth(request(app).delete('/api/units/u-1'));
    expect(del.status).toBe(200);
    expect(typeof del.body.unit.deleted_at).toBe('string');
    // The record is RETAINED, not removed.
    expect(world.units.get('u-1')).toBeDefined();

    // Gone from the no-filter list (the path the landlord card + listings page read)…
    const list = await auth(request(app).get('/api/units'));
    expect(ids(list.body)).not.toContain('u-1');

    // …but present in the Deleted view.
    const deletedView = await auth(request(app).get('/api/units?deleted=true'));
    expect(ids(deletedView.body)).toEqual(['u-1']);
  });

  it('restore clears deleted_at and brings the listing back into the list', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-2');

    await auth(request(app).delete('/api/units/u-2'));
    const restore = await auth(request(app).post('/api/units/u-2/restore'));
    expect(restore.status).toBe(200);
    expect(restore.body.unit.deleted_at).toBeUndefined();

    const list = await auth(request(app).get('/api/units'));
    expect(ids(list.body)).toContain('u-2');
    const deletedView = await auth(request(app).get('/api/units?deleted=true'));
    expect(ids(deletedView.body)).not.toContain('u-2');
  });

  it('excludes deleted from the no-filter, byStatus, and byLandlord list paths', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'live', { landlordId: 'LL', status: 'available' });
    seedUnit(world, 'gone', { landlordId: 'LL', status: 'available', deleted_at: '2026-06-19T00:00:00.000Z' });

    const all = await auth(request(app).get('/api/units'));
    expect(ids(all.body)).toEqual(['live']);

    const byStatus = await auth(request(app).get('/api/units?status=available'));
    expect(ids(byStatus.body)).toEqual(['live']);

    const byLandlord = await auth(request(app).get('/api/units?landlordId=LL'));
    expect(ids(byLandlord.body)).toEqual(['live']);

    // The Deleted view (no-filter) shows only the deleted one.
    const deletedView = await auth(request(app).get('/api/units?deleted=true'));
    expect(ids(deletedView.body)).toEqual(['gone']);
  });

  it('404s when deleting or restoring a unit that does not exist', async () => {
    const { app } = makeWebhookHarness();
    expect((await auth(request(app).delete('/api/units/nope'))).status).toBe(404);
    expect((await auth(request(app).post('/api/units/nope/restore'))).status).toBe(404);
  });
});
