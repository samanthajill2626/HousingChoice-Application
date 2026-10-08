// POST /__dev/org-fixture (clean org names, plan 3.12 / spec section 7): the
// hermetic e2e seam that plants a RAW organization value on a record a spec
// created, BYPASSING the org-list write check, so a spec can exercise
// Settings > "Not on the list" without seeding junk into the shared lean
// world. contact -> SET housingAuthority | agency | organization; unit -> APPEND to
// accepted_authorities. Built like devTourAutoCloseTick.test.ts: the dev
// router gets the world fakes and shares the world with the harness app.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createDevRouter } from '../src/routes/dev.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SECRET = 'test-origin-secret';
const SEAM = '/__dev/org-fixture';
/** A run-unique value no list holds - what an e2e spec plants. */
const OFF_LIST = 'Zeta Housing Office 4821';

function buildHarness(): { app: Express; world: FakeWorld; capture: LogCapture } {
  const world = createFakeWorld();
  const capture = createLogCapture();
  const logger = createLogger({ level: 'info', destination: capture.stream });
  const config = loadConfig({
    NODE_ENV: 'test',
    DEV_AUTH_ENABLED: '1',
    CF_ORIGIN_SECRET: SECRET,
    MESSAGING_DRIVER: 'console',
  });
  const devRouter = createDevRouter({
    config,
    logger,
    orgFixtureRepos: { contactsRepo: world.contactsRepo, unitsRepo: world.unitsRepo },
  });
  const { app } = makeWebhookHarness({ world, devRouter });
  world.contacts.push({
    contactId: 'c-fix',
    type: 'tenant',
    status: 'searching',
    firstName: 'Fix',
    lastName: 'Ture',
    housingAuthority: 'Atlanta Housing Authority',
  });
  world.units.set('u-fix', {
    unitId: 'u-fix',
    landlordId: 'c-landlord',
    status: 'setup',
    accepted_authorities: ['Atlanta Housing Authority'],
  });
  world.units.set('u-bare', { unitId: 'u-bare', landlordId: 'c-landlord', status: 'setup' });
  return { app, world, capture };
}

const contactOf = (world: FakeWorld) => world.contacts.find((c) => c.contactId === 'c-fix')!;

describe('POST /__dev/org-fixture', () => {
  it('SETs a raw organization on a contact (branch B, spec D17)', async () => {
    const { app, world } = buildHarness();
    const res = await request(app).post(SEAM).send({ contactId: 'c-fix', field: 'organization', value: OFF_LIST });
    expect(res.status).toBe(200);
    expect(contactOf(world)['organization']).toBe(OFF_LIST);
  });

  it('SETs a raw off-list housing authority on a contact - no list check', async () => {
    const { app, world } = buildHarness();
    const res = await request(app).post(SEAM).send({ contactId: 'c-fix', field: 'housingAuthority', value: OFF_LIST });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(contactOf(world)['housingAuthority']).toBe(OFF_LIST);
  });

  it('SETs a raw agency on a contact', async () => {
    const { app, world } = buildHarness();
    const res = await request(app).post(SEAM).send({ contactId: 'c-fix', field: 'agency', value: OFF_LIST });
    expect(res.status).toBe(200);
    expect(contactOf(world)['agency']).toBe(OFF_LIST);
  });

  it('APPENDS a raw value to a unit list, once', async () => {
    const { app, world } = buildHarness();
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app).post(SEAM).send({ unitId: 'u-fix', field: 'accepted_authorities', value: OFF_LIST });
      expect(res.status).toBe(200);
    }
    expect(world.units.get('u-fix')!.accepted_authorities).toEqual(['Atlanta Housing Authority', OFF_LIST]);
  });

  it('starts the list on a unit that has none', async () => {
    const { app, world } = buildHarness();
    const res = await request(app).post(SEAM).send({ unitId: 'u-bare', field: 'accepted_authorities', value: OFF_LIST });
    expect(res.status).toBe(200);
    expect(world.units.get('u-bare')!.accepted_authorities).toEqual([OFF_LIST]);
  });

  it.each([
    ['no record id', { field: 'agency', value: OFF_LIST }, 'exactly one of contactId or unitId is required'],
    [
      'both record ids',
      { contactId: 'c-fix', unitId: 'u-fix', field: 'agency', value: OFF_LIST },
      'exactly one of contactId or unitId is required',
    ],
    ['an empty contact id', { contactId: '', field: 'agency', value: OFF_LIST }, 'exactly one of contactId or unitId is required'],
    ['an empty value', { contactId: 'c-fix', field: 'housingAuthority', value: '' }, 'value must be a non-empty string'],
    ['a blank value', { contactId: 'c-fix', field: 'housingAuthority', value: '   ' }, 'value must be a non-empty string'],
    ['a non-string value', { contactId: 'c-fix', field: 'housingAuthority', value: 7 }, 'value must be a non-empty string'],
    [
      'a unit field on a contact',
      { contactId: 'c-fix', field: 'accepted_authorities', value: OFF_LIST },
      'field must be housingAuthority, agency or organization for a contact',
    ],
    [
      'a contact field on a unit',
      { unitId: 'u-fix', field: 'housingAuthority', value: OFF_LIST },
      'field must be accepted_authorities for a unit',
    ],
  ])('refuses %s with 400 and writes nothing', async (_label, body, error) => {
    const { app, world } = buildHarness();
    const res = await request(app).post(SEAM).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect(contactOf(world)['housingAuthority']).toBe('Atlanta Housing Authority');
    expect(contactOf(world)['agency']).toBeUndefined();
    expect(world.units.get('u-fix')!.accepted_authorities).toEqual(['Atlanta Housing Authority']);
  });

  it('answers 404 for a record that does not exist', async () => {
    const { app } = buildHarness();
    const contact = await request(app).post(SEAM).send({ contactId: 'c-missing', field: 'agency', value: OFF_LIST });
    expect(contact.status).toBe(404);
    expect(contact.body).toEqual({ error: 'contact_not_found' });
    const unit = await request(app).post(SEAM).send({ unitId: 'u-missing', field: 'accepted_authorities', value: OFF_LIST });
    expect(unit.status).toBe(404);
    expect(unit.body).toEqual({ error: 'unit_not_found' });
  });

  it('logs ids and the field - never the value', async () => {
    const { app, capture } = buildHarness();
    await request(app).post(SEAM).send({ contactId: 'c-fix', field: 'agency', value: OFF_LIST });
    expect(capture.lines.find((l) => l['msg'] === 'dev org-fixture applied')).toMatchObject({
      contactId: 'c-fix',
      field: 'agency',
    });
    expect(JSON.stringify(capture.lines)).not.toContain(OFF_LIST);
  });
});
