// property requirements (spec 2026-10-20 D5, D1; plan 2.4): POST /api/units
// records where each requirement value came from. With the New form's
// requirements_snapshot every item it names is classified against the
// SNAPSHOT (left as pre-filled -> copied; changed or cleared -> set_here),
// whatever the landlord holds now; without one only the items the body writes
// are classified, against the landlord's CURRENT values. The snapshot is never
// stored; a malformed one, or one taken from another landlord, is a 400, and
// so is a property holding both a one-month deposit and a fixed amount - all
// before the landlord check. requirement_sources is asserted on the HTTP
// response.
import { describe, expect, it } from 'vitest';
import { ALL_COPIED, getUnit, postUnit, seedLandlord, snapshotOf } from './helpers/requirementsFixtures.js';
import { makeWebhookHarness } from './helpers/twilioWebhookHarness.js';

describe('POST /api/units - with the New form requirements_snapshot (D5)', () => {
  it('fields left as pre-filled are copied, a cleared and a changed item are set here, and the snapshot is never stored', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', {
      req_no_pets: true,
      req_pet_fee: '$300',
      req_credit_requirements: 'Score 600+',
      req_tour_type: 'landlord_led',
      req_tour_process: 'Call Lee first',
    });
    const res = await postUnit(app, {
      landlordId: 'c-ll',
      requirements_snapshot: snapshotOf('c-ll', {
        pets: { no_pets: true, pet_fee: '$300' },
        credit_requirements: { credit_requirements: 'Score 600+' },
        touring: { tour_type: 'landlord_led', tour_process: 'Call Lee first' },
      }),
      no_pets: true,
      pet_fee: '$300',
      tour_type: 'landlord_led',
      tour_process: 'Text Lee first',
    });
    expect(res.status).toBe(201);
    expect(res.body.unit.requirement_sources).toEqual({
      ...ALL_COPIED,
      credit_requirements: 'set_here',
      touring: 'set_here',
    });
    expect(res.body.unit).not.toHaveProperty('requirements_snapshot');
    expect(res.body.unit).not.toHaveProperty('credit_requirements');
    const unitId = res.body.unit.unitId as string;
    const stored = world.units.get(unitId);
    expect(stored?.requirement_sources).toEqual(res.body.unit.requirement_sources);
    expect(stored).not.toHaveProperty('requirements_snapshot');
    const got = await getUnit(app, unitId);
    expect(got.body.unit.requirement_sources).toEqual(res.body.unit.requirement_sources);
  });

  it('every field left as pre-filled: all eight copied, even when the landlord changed after the form filled in', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_no_pets: true, req_pet_fee: '$350' });
    const res = await postUnit(app, {
      landlordId: 'c-ll',
      requirements_snapshot: snapshotOf('c-ll', { pets: { no_pets: true, pet_fee: '$300' } }),
      no_pets: true,
      pet_fee: '$300',
    });
    expect(res.status).toBe(201);
    expect(res.body.unit.requirement_sources).toEqual(ALL_COPIED);
    expect(res.body.unit.pet_fee).toBe('$300');
  });

  it('an all-blank snapshot (a landlord with no requirements) and a blank form: all eight copied', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    const res = await postUnit(app, { landlordId: 'c-ll', requirements_snapshot: snapshotOf('c-ll') });
    expect(res.status).toBe(201);
    expect(res.body.unit.requirement_sources).toEqual(ALL_COPIED);
  });

  it('an item the snapshot does not name is classified as without one; an unknown snapshot item is ignored', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_no_pets: true });
    const res = await postUnit(app, {
      landlordId: 'c-ll',
      requirements_snapshot: { landlordId: 'c-ll', pets: { no_pets: true }, frobnicate: { x: 1 } },
      no_pets: true,
      income_requirements: '3x rent',
    });
    expect(res.status).toBe(201);
    expect(res.body.unit.requirement_sources).toEqual({ pets: 'copied', income_requirements: 'set_here' });
  });

  const MALFORMED: Array<[string, unknown, string]> = [
    ['a string', 'x', 'requirements_snapshot must be an object with a landlordId'],
    ['null', null, 'requirements_snapshot must be an object with a landlordId'],
    ['no landlordId', { pets: { no_pets: true } }, 'requirements_snapshot must be an object with a landlordId'],
    ['an item that is not an object', { landlordId: 'c-ll', pets: 'No pets' }, 'requirements_snapshot.pets must be an object'],
  ];

  it.each(MALFORMED)('a malformed snapshot (%s) is a 400 - nothing created, no audit row', async (_name, raw, error) => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    const res = await postUnit(app, { landlordId: 'c-ll', requirements_snapshot: raw });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect(world.units.size).toBe(0);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('a snapshot taken from another landlord is a 400 - nothing created', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    seedLandlord(world, 'c-ll-2');
    const res = await postUnit(app, { landlordId: 'c-ll', requirements_snapshot: snapshotOf('c-ll-2') });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'requirements_snapshot.landlordId does not match landlordId' });
    expect(world.units.size).toBe(0);
  });

  it('the snapshot 400 comes before the landlord check (an unknown landlord still answers the 400)', async () => {
    const { app } = makeWebhookHarness();
    const res = await postUnit(app, { landlordId: 'c-ghost', requirements_snapshot: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'requirements_snapshot must be an object with a landlordId' });
  });
});

describe('POST /api/units - without a snapshot (D5)', () => {
  it("only the items the body writes are classified, against the landlord's CURRENT values", async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_no_pets: true, req_credit_requirements: 'Score 600+' });
    const res = await postUnit(app, { landlordId: 'c-ll', no_pets: true, income_requirements: '3x rent' });
    expect(res.status).toBe(201);
    expect(res.body.unit.requirement_sources).toEqual({ pets: 'copied', income_requirements: 'set_here' });
  });

  it('(PIN) a create writing no requirement field carries no requirement_sources', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll', { req_no_pets: true });
    const res = await postUnit(app, { landlordId: 'c-ll', beds: 2 });
    expect(res.status).toBe(201);
    expect(res.body.unit).not.toHaveProperty('requirement_sources');
  });
});

describe('POST /api/units - deposit_conflict (D1)', () => {
  it('a one-month deposit with a fixed amount is a 400 - nothing created, no audit row', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    const res = await postUnit(app, { landlordId: 'c-ll', deposit_one_month: true, deposit: 1200 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'deposit_conflict' });
    expect(world.units.size).toBe(0);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('the deposit_conflict 400 comes before the landlord check', async () => {
    const { app } = makeWebhookHarness();
    const res = await postUnit(app, { landlordId: 'c-ghost', deposit_one_month: true, deposit: 1200 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'deposit_conflict' });
  });

  it('(PIN) a one-month deposit alone, and a fixed amount alone, both create', async () => {
    const { app, world } = makeWebhookHarness();
    seedLandlord(world, 'c-ll');
    expect((await postUnit(app, { landlordId: 'c-ll', deposit_one_month: true })).status).toBe(201);
    expect((await postUnit(app, { landlordId: 'c-ll', deposit: 1200 })).status).toBe(201);
  });
});
