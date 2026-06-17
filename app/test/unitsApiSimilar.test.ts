// BE5/C6 route test — GET /api/units/:id/similar → { similar: SimilarUnit[] }.
// Loads the target, ranks the available units (via the pure rankSimilarUnits),
// and 404s an unknown unit. The ranking determinism/scoring is unit-tested in
// similarUnits.test.ts; this asserts the wire wiring + the 404.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { UnitItem } from '../src/repos/unitsRepo.js';
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
    landlordId: 'L',
    status: 'available',
    ...overrides,
  });
}

describe('GET /api/units/:id/similar (BE5/C6)', () => {
  it('returns ranked SimilarUnit[] over available units, excluding self + non-available', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-target', {
      beds: 2,
      area: 'North',
      subzone: 'North-A',
      payment_standard: 1500,
      accepted_programs: ['HCV', 'VASH'],
    });
    // Best match across all dims.
    seedUnit(world, 'u-best', {
      beds: 2,
      area: 'North',
      subzone: 'North-A',
      payment_standard: 1500,
      accepted_programs: ['HCV', 'VASH'],
    });
    // Weak match.
    seedUnit(world, 'u-weak', { beds: 5, area: 'South', subzone: 'South-Z' });
    // Not available — must be excluded.
    seedUnit(world, 'u-placed', { status: 'placed', beds: 2, area: 'North', subzone: 'North-A' });

    const res = await request(app)
      .get('/api/units/u-target/similar')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    const similar = res.body.similar as Array<{ unitId: string; matchPct: number; status: string }>;
    const ids = similar.map((s) => s.unitId);
    expect(ids).not.toContain('u-target'); // self excluded
    expect(ids).not.toContain('u-placed'); // non-available excluded
    expect(ids[0]).toBe('u-best'); // best match ranks first
    expect(similar[0]!.matchPct).toBe(100);
    // Wire shape: each carries unitId/status/matchPct/summary.
    expect(similar[0]).toMatchObject({ unitId: 'u-best', status: 'available' });
    expect(typeof similar[0]!.matchPct).toBe('number');
  });

  it('returns similar available units even when the TARGET is not available', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'u-placed-target', { status: 'placed', beds: 2 });
    seedUnit(world, 'u-alt', { status: 'available', beds: 2 });
    const res = await request(app)
      .get('/api/units/u-placed-target/similar')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect((res.body.similar as Array<{ unitId: string }>).map((s) => s.unitId)).toContain('u-alt');
  });

  it('404s an unknown unit', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/units/ghost/similar')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unit_not_found');
  });
});
