// FIX 3 route tests — GET /api/units/:unitId/placements (tenant-name enriched), the
// "Placements on this listing" read endpoint. Mirrors the BE3/BE4 unit-scoped
// sibling reads (/related, /recipients): 404 unknown unit, [] for no placements,
// and tenantName resolved at read time (null when the tenant has no contact).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import type { PlacementItem } from '../src/repos/placementsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

function seedUnit(
  world: ReturnType<typeof createFakeWorld>,
  unitId: string,
  overrides: Partial<UnitItem> = {},
): void {
  world.units.set(unitId, {
    unitId,
    landlordId: 'c-ll-1',
    status: 'available',
    jurisdiction: 'DCA',
    created_at: '2026-06-12T09:00:00.000Z',
    updated_at: '2026-06-12T09:00:00.000Z',
    ...overrides,
  });
}

function seedPlacement(
  world: ReturnType<typeof createFakeWorld>,
  placementId: string,
  tenantId: string,
  unitId: string,
): void {
  world.placements.set(placementId, {
    placementId,
    tenantId,
    unitId,
    stage: 'awaiting_inspection',
    created_at: '2026-06-12T09:00:00.000Z',
    updated_at: '2026-06-12T09:00:00.000Z',
  } as PlacementItem);
}

function seedContact(
  world: ReturnType<typeof createFakeWorld>,
  contactId: string,
  overrides: Partial<ContactItem> = {},
): void {
  world.contacts.push({ contactId, type: 'tenant', ...overrides } as ContactItem);
}

const authedGet = (app: import('express').Express, path: string) =>
  request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

describe('GET /api/units/:id/placements (FIX 3 — Placements on this listing)', () => {
  it('returns the unit placements with tenantName resolved at read time', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-placements');
    seedPlacement(world, 'placement-1', 'c-tenant-1', 'u-placements');
    seedPlacement(world, 'placement-2', 'c-tenant-2', 'u-placements');
    seedContact(world, 'c-tenant-1', { firstName: 'Tina', lastName: 'One' });
    seedContact(world, 'c-tenant-2', { firstName: 'Tom', lastName: 'Two' });

    const res = await authedGet(app, '/api/units/u-placements/placements');
    expect(res.status).toBe(200);
    const placements = res.body.placements as Array<{ placementId: string; tenantId: string; tenantName: string | null }>;
    expect(placements.map((c) => c.placementId).sort()).toEqual(['placement-1', 'placement-2']);
    const byId = new Map(placements.map((c) => [c.placementId, c]));
    expect(byId.get('placement-1')?.tenantName).toBe('Tina One');
    expect(byId.get('placement-2')?.tenantName).toBe('Tom Two');
    // Placement fields survive alongside the enrichment.
    expect(byId.get('placement-1')).toMatchObject({ tenantId: 'c-tenant-1', unitId: 'u-placements', stage: 'awaiting_inspection' });
  });

  it('tenantName is null when the tenant has no contact (never 500)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-nocontact');
    seedPlacement(world, 'placement-x', 'c-ghost', 'u-nocontact');

    const res = await authedGet(app, '/api/units/u-nocontact/placements');
    expect(res.status).toBe(200);
    expect(res.body.placements).toHaveLength(1);
    expect(res.body.placements[0].tenantName).toBeNull();
  });

  it('404s an unknown unit', async () => {
    const { app } = makeWebhookHarness();
    const res = await authedGet(app, '/api/units/ghost/placements');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unit_not_found');
  });

  it('returns { placements: [] } for a unit with no placements', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-empty');
    const res = await authedGet(app, '/api/units/u-empty/placements');
    expect(res.status).toBe(200);
    expect(res.body.placements).toEqual([]);
  });
});
