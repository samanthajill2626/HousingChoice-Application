// POST /__dev/tour-auto-close/tick (tour auto-close spec 6.1): the hermetic e2e
// seam for the worker's 15-minute auto-close poll. One POST runs ONE
// runTourAutoClose pass with a normalized `now`; `tourIds` (1..50 non-empty
// strings) scopes the pass so a spec can never close another spec's tours.
//
// Built like the devGating tick harnesses (ruling D-g): the dev router gets
// the SAME eight deps worker.ts builds, wired to the world fakes, and shares
// the world with the harness app. CLOCK TRAP: the fake `create` stamps
// updatedAt with the wall clock, so every seeded tour's updatedAt is pinned to
// its createdAt right after the write.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createDevRouter } from '../src/routes/dev.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SECRET = 'test-origin-secret';
const TICK = '/__dev/tour-auto-close/tick';
const NOW_ERROR = { error: 'now must be a valid ISO 8601 datetime' };
const IDS_ERROR = { error: 'tourIds must be a non-empty array of at most 50 tour ids' };

// Due at 2026-09-15T15:00:00.000Z (its time + 14 days); a tick at NOW closes it.
const CREATED = '2026-08-25T00:00:00.000Z';
const CREATED_LATER = '2026-08-26T00:00:00.000Z';
const AT = '2026-09-01T15:00:00.000Z';
const NOW_INPUT = '2026-09-20T00:00:00Z';
const NOW = '2026-09-20T00:00:00.000Z';

function buildTickHarness(): { app: Express; world: FakeWorld } {
  const world = createFakeWorld();
  const capture = createLogCapture();
  const logger = createLogger({ destination: capture.stream });
  const config = loadConfig({
    NODE_ENV: 'test',
    DEV_AUTH_ENABLED: '1',
    CF_ORIGIN_SECRET: SECRET,
    MESSAGING_DRIVER: 'console',
  });
  const devRouter = createDevRouter({
    config,
    logger,
    // The same eight deps worker.ts builds - wired to the world fakes.
    tourAutoCloseDeps: {
      toursRepo: world.toursRepo,
      tourRemindersRepo: world.tourRemindersRepo,
      conversationsRepo: world.conversationsRepo,
      unitsRepo: world.unitsRepo,
      auditRepo: world.auditRepo,
      activityEventsRepo: world.activityEventsRepo,
      events: world.events,
      logger,
    },
  });
  const { app } = makeWebhookHarness({ world, devRouter });
  return { app, world };
}

/** A scheduled tour booked ahead and never marked, due at NOW (clock pinned). */
async function seedDueTour(world: FakeWorld, createdAt: string): Promise<string> {
  const tour = await world.toursRepo.create({
    tenantId: 'c-tick-tenant',
    unitId: 'unit-tick',
    scheduledAt: AT,
    tourType: 'self_guided',
    createdAt,
  });
  world.toursMap.get(tour.tourId)!.updatedAt = createdAt;
  return tour.tourId;
}

const statusOf = (world: FakeWorld, tourId: string): string | undefined => world.toursMap.get(tourId)?.status;

describe('POST /__dev/tour-auto-close/tick', () => {
  it('runs one sweep at the NORMALIZED now and reports the summary; the due tour closes', async () => {
    const { app, world } = buildTickHarness();
    const tourId = await seedDueTour(world, CREATED);

    const res = await request(app).post(TICK).send({ now: NOW_INPUT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, now: NOW, scanned: 1, due: 1, closed: 1, lost: 0, failed: 0 });
    expect(world.toursMap.get(tourId)).toMatchObject({
      status: 'closed',
      outcome: 'no_outcome',
      autoClosedFrom: 'scheduled',
    });
    expect(world.emitted.filter((e) => e.event === 'tour.updated').map((e) => e.payload)).toEqual([
      { tourId, status: 'closed' },
    ]);
    expect(world.sent).toEqual([]);
  });

  it('tourIds scopes the sweep: with two due tours only the named one closes', async () => {
    const { app, world } = buildTickHarness();
    const a = await seedDueTour(world, CREATED);
    const b = await seedDueTour(world, CREATED_LATER);

    const res = await request(app).post(TICK).send({ now: NOW_INPUT, tourIds: [a] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, now: NOW, scanned: 1, due: 1, closed: 1, lost: 0, failed: 0 });
    expect(statusOf(world, a)).toBe('closed');
    expect(statusOf(world, b)).toBe('scheduled');
  });

  it('accepts exactly 50 tour ids (unknown ids are ignored)', async () => {
    const { app, world } = buildTickHarness();
    const a = await seedDueTour(world, CREATED);
    const ids = [a, ...Array.from({ length: 49 }, (_, i) => `tour-unknown-${i}`)];

    const res = await request(app).post(TICK).send({ now: NOW_INPUT, tourIds: ids });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, now: NOW, scanned: 1, due: 1, closed: 1, lost: 0, failed: 0 });
    expect(statusOf(world, a)).toBe('closed');
  });

  it('defaults now to the wall clock when the body carries none', async () => {
    const { app } = buildTickHarness();
    const res = await request(app).post(TICK).send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, scanned: 0, due: 0, closed: 0, lost: 0, failed: 0 });
    expect(typeof res.body.now).toBe('string');
    expect(new Date(res.body.now as string).toISOString()).toBe(res.body.now);
  });

  it('rejects a malformed now with 400 and closes nothing', async () => {
    const { app, world } = buildTickHarness();
    const tourId = await seedDueTour(world, CREATED);

    for (const bad of ['nope', '', 123, { nested: true }]) {
      const res = await request(app).post(TICK).send({ now: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body, JSON.stringify(bad)).toEqual(NOW_ERROR);
    }
    expect(statusOf(world, tourId)).toBe('scheduled');
  });

  it('rejects malformed tourIds with 400 and closes nothing: not an array, empty, 51 ids, a blank or non-string id', async () => {
    const { app, world } = buildTickHarness();
    const tourId = await seedDueTour(world, CREATED);
    const fiftyOne = [tourId, ...Array.from({ length: 50 }, (_, i) => `tour-unknown-${i}`)];

    for (const bad of [tourId, { [tourId]: true }, null, [], fiftyOne, [tourId, ''], [tourId, 42]]) {
      const res = await request(app).post(TICK).send({ now: NOW_INPUT, tourIds: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body, JSON.stringify(bad)).toEqual(IDS_ERROR);
    }
    expect(statusOf(world, tourId)).toBe('scheduled');
  });

  it('is absent when the dev router is not mounted', async () => {
    const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET });
    const app = buildApp({ config }); // no devRouter
    const res = await request(app).post(TICK).set('x-origin-verify', SECRET).send({ now: NOW });
    expect(res.status).toBe(404);
  });
});
