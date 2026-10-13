// POST /__dev/fixtures/zero-primary-property (primary-contact-integrity spec
// section 10; plan contract 2.7 as refined by S5, task S5.5): the hermetic e2e
// seam that creates a NEW property in the imported shape - no landlord of
// record, the given contacts as NON-primary rows. The UI can reach a property
// with no primary contact (Restore without a landlord, then add only contacts
// not typed landlord), and can even recreate the imported shape - an eligible
// contact left non-primary - by classifying one of those contacts as a
// property manager after seating it (a type change promotes nobody, spec
// 4.4). The dev seam exists so a spec builds that shape in one call without
// the detour, and no lean seed unit is in it. Built like
// devOrgFixture.test.ts: the dev router gets the world fakes and shares the
// world with the harness app.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createDevRouter } from '../src/routes/dev.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SECRET = 'test-origin-secret';
const SEAM = '/__dev/fixtures/zero-primary-property';
/** A run-unique street - what an e2e spec passes. */
const STREET = '4821 Zero Primary Way NW';

interface Harness {
  app: Express;
  world: FakeWorld;
  capture: LogCapture;
  /** Unit ids present before the request. */
  existing: ReadonlySet<string>;
}

function buildHarness(): Harness {
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
    zeroPrimaryFixtureRepos: { contactsRepo: world.contactsRepo, unitsRepo: world.unitsRepo },
  });
  const { app } = makeWebhookHarness({ world, devRouter });
  world.contacts.push(
    { contactId: 'c-mark', type: 'landlord', status: 'active', firstName: 'Mark', lastName: 'Passmore' },
    { contactId: 'c-ten', type: 'tenant', status: 'searching', firstName: 'Tara', lastName: 'Tenant' },
  );
  world.units.set('u-existing', {
    unitId: 'u-existing',
    landlordId: 'c-owner',
    status: 'available',
    contacts: [{ contactId: 'c-owner', role: 'landlord', primaryContact: true }],
  });
  return { app, world, capture, existing: new Set(world.units.keys()) };
}

/** The units the seam created in this harness. */
const created = (h: Harness): UnitItem[] => [...h.world.units.values()].filter((u) => !h.existing.has(u.unitId));

describe('POST /__dev/fixtures/zero-primary-property', () => {
  it('creates a NEW property with no landlord of record and the contacts as non-primary rows, in order', async () => {
    const h = buildHarness();
    const res = await request(h.app)
      .post(SEAM)
      .send({
        street: STREET,
        rows: [
          { contactId: 'c-ten', role: 'other' },
          { contactId: 'c-mark', role: 'pm' },
        ],
      });
    expect(res.status).toBe(201);
    const [unit] = created(h);
    expect(created(h)).toHaveLength(1);
    expect(res.body).toEqual({ unitId: unit?.unitId });
    expect(unit !== undefined && Object.prototype.hasOwnProperty.call(unit, 'landlordId')).toBe(false);
    expect(unit?.primary_contact).toBeUndefined();
    expect(unit?.contacts).toEqual([
      { contactId: 'c-ten', role: 'other', primaryContact: false },
      { contactId: 'c-mark', role: 'pm', primaryContact: false },
    ]);
    expect(unit?.status).toBe('setup');
    expect(unit?.address).toEqual({ line1: STREET, city: 'Atlanta', state: 'GA', zip: '30314' });
    expect(unit?.accepted_authorities).toBeUndefined();
  });

  it('never touches an existing property', async () => {
    const h = buildHarness();
    const before = structuredClone(h.world.units.get('u-existing'));
    const res = await request(h.app).post(SEAM).send({ street: STREET, rows: [{ contactId: 'c-mark', role: 'pm' }] });
    expect(res.status).toBe(201);
    expect(h.world.units.get('u-existing')).toEqual(before);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['no street', { rows: [{ contactId: 'c-mark', role: 'pm' }] }, 'street must be a non-empty string'],
    ['a blank street', { street: '   ', rows: [{ contactId: 'c-mark', role: 'pm' }] }, 'street must be a non-empty string'],
    ['no rows', { street: STREET }, 'rows must be an array of 1 to 5 entries'],
    ['an empty rows list', { street: STREET, rows: [] }, 'rows must be an array of 1 to 5 entries'],
    [
      'six rows',
      {
        street: STREET,
        rows: ['c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'c-6'].map((contactId) => ({ contactId, role: 'other' })),
      },
      'rows must be an array of 1 to 5 entries',
    ],
    ['a row without a contactId', { street: STREET, rows: [{ role: 'pm' }] }, 'each row needs a non-empty contactId'],
    [
      'the landlord role',
      { street: STREET, rows: [{ contactId: 'c-mark', role: 'landlord' }] },
      'each row role must be pm, owner or other',
    ],
    [
      'a repeated contact',
      {
        street: STREET,
        rows: [
          { contactId: 'c-mark', role: 'pm' },
          { contactId: 'c-mark', role: 'owner' },
        ],
      },
      'a contactId may appear once',
    ],
  ])('refuses %s with 400 and creates nothing', async (_label, body, error) => {
    const h = buildHarness();
    const res = await request(h.app).post(SEAM).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect(created(h)).toEqual([]);
  });

  it('answers 404 for a contact that does not exist, and creates nothing', async () => {
    const h = buildHarness();
    const res = await request(h.app)
      .post(SEAM)
      .send({
        street: STREET,
        rows: [
          { contactId: 'c-mark', role: 'pm' },
          { contactId: 'c-missing', role: 'owner' },
        ],
      });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'contact_not_found', contactId: 'c-missing' });
    expect(created(h)).toEqual([]);
  });

  it('logs the unit id and the row count - never the street or a name', async () => {
    const h = buildHarness();
    const res = await request(h.app).post(SEAM).send({ street: STREET, rows: [{ contactId: 'c-mark', role: 'pm' }] });
    expect(h.capture.lines.find((l) => l['msg'] === 'dev zero-primary-property fixture created')).toMatchObject({
      unitId: (res.body as { unitId: string }).unitId,
      rows: 1,
    });
    // pino stamps the machine's hostname on every line - not ours to check.
    const logged = JSON.stringify(h.capture.lines.map(({ hostname: _hostname, ...line }) => line));
    for (const text of [STREET, 'Mark', 'Passmore']) expect(logged).not.toContain(text);
  });

  it('is absent when the dev router is not mounted', async () => {
    const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET });
    const app = buildApp({ config }); // no devRouter
    const res = await request(app)
      .post(SEAM)
      .set('x-origin-verify', SECRET)
      .send({ street: STREET, rows: [{ contactId: 'c-mark', role: 'pm' }] });
    expect(res.status).toBe(404);
  });
});
