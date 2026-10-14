// POST /__dev/listing-send-fixture (last-heard-from spec 14.4, e2e (6)): the
// hermetic seam that plants a LISTED, counted listing-send row with a chosen
// sentAt through putShareMemory - a real send's sentAt is always "now", so
// nothing else can put a send past the 24-hour QUIET threshold in front of
// the Follow up tab. 201 { row } on a fresh pair; 409 { error: 'send_exists' }
// when the pair already has a row. Built like devOrgFixture.test.ts.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createDevRouter } from '../src/routes/dev.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SEAM = '/__dev/listing-send-fixture';

function seedWorld(world: FakeWorld): void {
  world.contacts.push({ contactId: 'c-fix', type: 'tenant', status: 'searching', phone: '+15550100001' });
  world.units.set('u-fix', { unitId: 'u-fix', landlordId: 'c-landlord', status: 'available' });
}

function buildHarness(): { app: Express; world: FakeWorld } {
  const world = createFakeWorld();
  const logger = createLogger({ level: 'info', destination: createLogCapture().stream });
  const config = loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: 'test-origin-secret', MESSAGING_DRIVER: 'console' });
  const devRouter = createDevRouter({
    config,
    logger,
    orgFixtureRepos: { contactsRepo: world.contactsRepo, unitsRepo: world.unitsRepo },
    listingSendsRepo: world.listingSendsRepo,
  });
  const { app } = makeWebhookHarness({ world, devRouter });
  seedWorld(world);
  return { app, world };
}

describe('POST /__dev/listing-send-fixture', () => {
  it('201: writes a LISTED, counted row with the given sentAt (normalized), one counted individual share', async () => {
    const { app, world } = buildHarness();
    const res = await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-fix', sentAt: '2026-10-01T08:00:00-04:00' });
    expect(res.status).toBe(201);
    expect(res.body.row).toMatchObject({ unitId: 'u-fix', contactId: 'c-fix', sentAt: '2026-10-01T12:00:00.000Z', counted: true });
    const listed = await world.listingSendsRepo.listByUnit('u-fix');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.shares).toEqual({
      individual: { attempt: '!individual', state: 'counted', by: 'acceptance', countedAt: '2026-10-01T12:00:00.000Z' },
    });
    // Never an outcome (I2): the seam writes no decline.
    expect(listed[0]!.declined).toBeUndefined();
  });

  it('409 send_exists when the pair already has a row - never overwrites its shares or moves sentAt (plan review R1 #11)', async () => {
    const { app, world } = buildHarness();
    expect((await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-fix', sentAt: '2026-10-03T12:00:00.000Z' })).status).toBe(201);
    const before = structuredClone(world.listingSends[0]!);
    const res = await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-fix', sentAt: '2026-10-01T12:00:00.000Z' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'send_exists' });
    expect(world.listingSends).toHaveLength(1);
    expect(world.listingSends[0]).toEqual(before);
  });

  it('409 send_exists for a pre-existing UN-counted row too (any row, listed or not)', async () => {
    const { app, world } = buildHarness();
    world.listingSends.push({
      unitId: 'u-fix',
      contactId: 'c-fix',
      via: 'broadcast',
      counted: false,
      created_at: '2026-10-01T12:00:00.000Z',
      updated_at: '2026-10-01T12:00:00.000Z',
    });
    const res = await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-fix', sentAt: '2026-10-02T12:00:00.000Z' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'send_exists' });
    expect(world.listingSends[0]!.sentAt).toBeUndefined();
  });

  it('400 without unitId/contactId, or with an unparseable sentAt', async () => {
    const { app } = buildHarness();
    expect((await request(app).post(SEAM).send({ contactId: 'c-fix', sentAt: '2026-10-01T12:00:00.000Z' })).status).toBe(400);
    expect((await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-fix', sentAt: 'yesterday' })).status).toBe(400);
  });

  it('404 unit_not_found / contact_not_found', async () => {
    const { app } = buildHarness();
    const noUnit = await request(app).post(SEAM).send({ unitId: 'u-none', contactId: 'c-fix', sentAt: '2026-10-01T12:00:00.000Z' });
    expect(noUnit.status).toBe(404);
    expect(noUnit.body).toEqual({ error: 'unit_not_found' });
    const noContact = await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-none', sentAt: '2026-10-01T12:00:00.000Z' });
    expect(noContact.status).toBe(404);
    expect(noContact.body).toEqual({ error: 'contact_not_found' });
  });

  it('(PIN) the seam is absent when the dev router is not mounted (the /__dev/reseed gate)', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedWorld(world);
    const res = await request(app).post(SEAM).send({ unitId: 'u-fix', contactId: 'c-fix', sentAt: '2026-10-01T12:00:00.000Z' });
    expect(res.status).not.toBe(201);
    expect(world.listingSends).toHaveLength(0);
  });
});
