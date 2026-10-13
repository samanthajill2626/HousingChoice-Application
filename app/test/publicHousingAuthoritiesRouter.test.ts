// join-housing-authority D1/D2: createPublicHousingAuthoritiesRouter on a bare
// Express app - the one GET route, its response, and its OWN per-client limit
// (60 per 60 s). The full-app behavior (its mount ahead of the shared /public
// limiter in app.ts) is tested in publicIntake.test.ts.
import express, { type Request } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { OrgListRepo } from '../src/repos/orgListRepo.js';
import { createPublicHousingAuthoritiesRouter } from '../src/routes/public.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createOrgListFake } from './helpers/orgListFake.js';

const LIST = '/public/housing-authorities';

/** The starting list's housing authority names in D1 order. */
const STARTING_AUTHORITY_NAMES = [
  'Atlanta Housing Authority',
  'Augusta Housing Authority',
  'College Park Housing Authority',
  'Decatur Housing Authority',
  'DeKalb County Housing Authority',
  'East Point Housing Authority',
  'Fulton County Housing Authority',
  'Georgia Department of Community Affairs',
  'Georgia Housing Voucher Program (DBHDD)',
  'Jonesboro Housing Authority',
  'Macon-Bibb County Housing Authority',
  'Marietta Housing Authority',
];

function listApp(orgListRepo: OrgListRepo, rateLimitKeyOf?: (req: Request) => string) {
  const app = express();
  app.use(
    '/public',
    createPublicHousingAuthoritiesRouter({
      logger: createLogger({ destination: createLogCapture().stream }),
      orgListRepo,
      ...(rateLimitKeyOf !== undefined && { rateLimitKeyOf }),
    }),
  );
  return app;
}

describe('createPublicHousingAuthoritiesRouter (D1)', () => {
  it('answers GET /housing-authorities with { names } and Cache-Control: no-store, writing nothing', async () => {
    const repo = createOrgListFake();
    const res = await request(listApp(repo)).get(LIST);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ names: STARTING_AUTHORITY_NAMES });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await repo.peek()).toBeNull();
  });

  it('defines only that GET: another method or path is not handled by this router', async () => {
    const app = listApp(createOrgListFake());
    expect((await request(app).post(LIST).send({})).status).toBe(404);
    expect((await request(app).get(`${LIST}/extra`)).status).toBe(404);
    expect((await request(app).get('/public/units/u-1/flyer')).status).toBe(404);
  });

  it('forwards a list read failure to the error handler (status 500)', async () => {
    const repo = createOrgListFake();
    vi.spyOn(repo, 'peek').mockRejectedValue(new Error('settings table unavailable'));
    expect((await request(listApp(repo)).get(LIST)).status).toBe(500);
  });
});

describe('createPublicHousingAuthoritiesRouter - its own limit (D2)', () => {
  it('allows 60 reads per client in a window, refuses the 61st with 429 + Retry-After; another client is unaffected', async () => {
    const app = listApp(createOrgListFake(), (req) => String(req.headers['x-client'] ?? 'none'));
    for (let i = 0; i < 60; i += 1) {
      const res = await request(app).get(LIST).set('x-client', 'a');
      expect(res.status, `read ${i + 1}`).toBe(200);
    }
    const limited = await request(app).get(LIST).set('x-client', 'a');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await request(app).get(LIST).set('x-client', 'b')).status).toBe(200);
  });

  it('a refused read does not touch the list store', async () => {
    const repo = createOrgListFake();
    const app = listApp(repo, () => 'one-client');
    for (let i = 0; i < 60; i += 1) {
      expect((await request(app).get(LIST)).status, `read ${i + 1}`).toBe(200);
    }
    const peekAfterLimit = vi.spyOn(repo, 'peek');
    expect((await request(app).get(LIST)).status).toBe(429);
    expect(peekAfterLimit).not.toHaveBeenCalled();
  });
});
