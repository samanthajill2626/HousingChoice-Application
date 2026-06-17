// FIX 3 route tests — GET /api/units/:unitId/cases (tenant-name enriched), the
// "Cases on this listing" read endpoint. Mirrors the BE3/BE4 unit-scoped
// sibling reads (/related, /recipients): 404 unknown unit, [] for no cases,
// and tenantName resolved at read time (null when the tenant has no contact).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import type { CaseItem } from '../src/repos/casesRepo.js';
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

function seedCase(
  world: ReturnType<typeof createFakeWorld>,
  caseId: string,
  tenantId: string,
  unitId: string,
): void {
  world.cases.set(caseId, {
    caseId,
    tenantId,
    unitId,
    stage: 'touring',
    created_at: '2026-06-12T09:00:00.000Z',
    updated_at: '2026-06-12T09:00:00.000Z',
  } as CaseItem);
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

describe('GET /api/units/:id/cases (FIX 3 — Cases on this listing)', () => {
  it('returns the unit cases with tenantName resolved at read time', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-cases');
    seedCase(world, 'case-1', 'c-tenant-1', 'u-cases');
    seedCase(world, 'case-2', 'c-tenant-2', 'u-cases');
    seedContact(world, 'c-tenant-1', { firstName: 'Tina', lastName: 'One' });
    seedContact(world, 'c-tenant-2', { firstName: 'Tom', lastName: 'Two' });

    const res = await authedGet(app, '/api/units/u-cases/cases');
    expect(res.status).toBe(200);
    const cases = res.body.cases as Array<{ caseId: string; tenantId: string; tenantName: string | null }>;
    expect(cases.map((c) => c.caseId).sort()).toEqual(['case-1', 'case-2']);
    const byId = new Map(cases.map((c) => [c.caseId, c]));
    expect(byId.get('case-1')?.tenantName).toBe('Tina One');
    expect(byId.get('case-2')?.tenantName).toBe('Tom Two');
    // Case fields survive alongside the enrichment.
    expect(byId.get('case-1')).toMatchObject({ tenantId: 'c-tenant-1', unitId: 'u-cases', stage: 'touring' });
  });

  it('tenantName is null when the tenant has no contact (never 500)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-nocontact');
    seedCase(world, 'case-x', 'c-ghost', 'u-nocontact');

    const res = await authedGet(app, '/api/units/u-nocontact/cases');
    expect(res.status).toBe(200);
    expect(res.body.cases).toHaveLength(1);
    expect(res.body.cases[0].tenantName).toBeNull();
  });

  it('404s an unknown unit', async () => {
    const { app } = makeWebhookHarness();
    const res = await authedGet(app, '/api/units/ghost/cases');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unit_not_found');
  });

  it('returns { cases: [] } for a unit with no cases', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-empty');
    const res = await authedGet(app, '/api/units/u-empty/cases');
    expect(res.status).toBe(200);
    expect(res.body.cases).toEqual([]);
  });
});
