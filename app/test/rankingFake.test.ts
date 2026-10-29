// WP1 B2a spec D6: the fake driver - deterministic scores from the cards
// with fixed rules and no network - and the console driver, which logs
// counts only and then scores with the SAME rules and seams (plan PR8). Both
// stamp their own model ('fake' / 'console'), so a real configured model
// reads their matches out of date (spec D9).
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { TENANT_MATCHING_INPUTS } from '../src/lib/tenantMatchingInputs.js';
import {
  ConsoleRankingDriver,
  FAKE_SEAM_FAIL_BATCH,
  FAKE_SEAM_OMIT,
  FakeRankingDriver,
  fakeInputLabels,
} from '../src/adapters/rankingFake.js';
import type { RankingCall } from '../src/services/ranking/driverTypes.js';
import { buildRankingBatch } from '../src/services/ranking/prompt.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  propertiesForTenantSource,
  propertyCardFixture,
  tenantCardFixture,
  tenantsForPropertySource,
} from './helpers/rankingBatchFixture.js';

const AREA = 'Area preference';
const MAX = 'Maximum tenant portion';

function ok(call: RankingCall) {
  if (!call.ok) throw new Error(`unexpected failure: ${call.failure} ${call.message}`);
  return call;
}

async function scoreOne(tenant: Record<string, unknown>, property: Record<string, unknown>) {
  const call = ok(await new FakeRankingDriver().rankBatch(buildRankingBatch(tenantsForPropertySource([tenant], property))));
  return call.output.byHandle.get('c1')!;
}

describe('the list finders (WI8: through the list, never a spelled key)', () => {
  it('find exactly the maximum portion (kind dollars) and the area preference (text marked for completeness)', () => {
    expect(fakeInputLabels()).toEqual({ maxPortion: MAX, area: AREA });
    expect(TENANT_MATCHING_INPUTS.filter((e) => e.kind === 'dollars')).toHaveLength(1);
    expect(TENANT_MATCHING_INPUTS.filter((e) => e.kind === 'text' && e.completeness)).toHaveLength(1);
  });
});

describe('the fake rules (start at 70; -25 per failed check; +10 for the area)', () => {
  it('nothing fires: 70, no reasons', async () => {
    const parsed = await scoreOne(tenantCardFixture({ [AREA]: 'Kirkwood' }), propertyCardFixture());
    expect(parsed).toEqual({ score: 70, for: [], against: [], unknowns: [], failedRequirements: [], fairHousingFlags: [] });
  });

  it('the area preference inside the property area or address: +10', async () => {
    expect((await scoreOne(tenantCardFixture({ [AREA]: 'decatur' }), propertyCardFixture())).score).toBe(80);
    const byAddress = await scoreOne(
      tenantCardFixture({ [AREA]: 'Tucker' }),
      propertyCardFixture({ area: undefined, address: { line1: '1 Fixture Way', city: 'Tucker', state: 'GA' } }),
    );
    expect(byAddress.score).toBe(80);
    expect(byAddress.for).toEqual([{ text: 'in preferred area', source: 'area' }]);
  });

  it('rent above the maximum portion: -25 (final_rent, else rent_min, else rent_max)', async () => {
    const parsed = await scoreOne(tenantCardFixture({ [MAX]: 500 }), propertyCardFixture({ rent_min: 1400 }));
    expect(parsed.score).toBe(45);
    expect(parsed.against).toEqual([{ text: 'rent above max portion', source: 'rent' }]);
    expect((await scoreOne(tenantCardFixture({ [MAX]: 1500 }), propertyCardFixture({ rent_min: 1400, final_rent: 1600 }))).score).toBe(45);
    expect((await scoreOne(tenantCardFixture({ [MAX]: 1500 }), propertyCardFixture({ rent_min: undefined, rent_max: 1450 }))).score).toBe(70);
  });

  it('a recorded No pets with tenant pets text: -25 and failedRequirements no_pets', async () => {
    const parsed = await scoreOne(tenantCardFixture({ pets: 'a cat' }), propertyCardFixture({ no_pets: true }));
    expect(parsed.score).toBe(45);
    expect(parsed.failedRequirements).toEqual(['no_pets']);
    expect(parsed.against).toEqual([{ text: 'no pets, has pets', source: 'pets' }]);
    expect((await scoreOne(tenantCardFixture({ pets: '  ' }), propertyCardFixture({ no_pets: true }))).score).toBe(70);
  });

  it('a recorded no_evictions_on_program with tenant evictions text: -25 and failedRequirements', async () => {
    const parsed = await scoreOne(tenantCardFixture({ evictions: '2019' }), propertyCardFixture({ no_evictions_on_program: true }));
    expect(parsed.score).toBe(45);
    expect(parsed.failedRequirements).toEqual(['no_evictions_on_program']);
  });

  it('rules add up and clamp at 0', async () => {
    const parsed = await scoreOne(
      tenantCardFixture({ [MAX]: 100, pets: 'dog', evictions: '2020' }),
      propertyCardFixture({ no_pets: true, no_evictions_on_program: true }),
    );
    expect(parsed.score).toBe(0);
    expect(parsed.against).toHaveLength(3);
    expect(parsed.failedRequirements).toEqual(['no_pets', 'no_evictions_on_program']);
  });

  it('reads the tenant from the anchor and the property from the candidate for a tenant anchor', async () => {
    const call = ok(await new FakeRankingDriver().rankBatch(buildRankingBatch(propertiesForTenantSource(
      [{ unitId: 'u-1', card: propertyCardFixture({ no_pets: true }) }, { unitId: 'u-2', card: propertyCardFixture() }],
      tenantCardFixture({ pets: 'a dog', [AREA]: 'Decatur' }),
    ))));
    expect(call.output.byHandle.get('c1')!.score).toBe(55);
    expect(call.output.byHandle.get('c2')!.score).toBe(80);
  });

  it('is deterministic', async () => {
    const batch = buildRankingBatch(tenantsForPropertySource([tenantCardFixture({ pets: 'x' }), tenantCardFixture()], propertyCardFixture({ no_pets: true })));
    const a = ok(await new FakeRankingDriver().rankBatch(batch));
    const b = ok(await new FakeRankingDriver().rankBatch(batch));
    expect(a.meta.rawText).toBe(b.meta.rawText);
  });
});

describe('the fake seams', () => {
  it(`${FAKE_SEAM_FAIL_BATCH} on the anchor fails the batch`, async () => {
    const call = await new FakeRankingDriver().rankBatch(buildRankingBatch(tenantsForPropertySource(
      [tenantCardFixture()],
      propertyCardFixture({ notes: `quiet ${FAKE_SEAM_FAIL_BATCH}` }),
    )));
    expect(call).toMatchObject({ ok: false, failure: 'driver', message: `fake ranking driver: ${FAKE_SEAM_FAIL_BATCH} seam` });
  });

  it(`${FAKE_SEAM_FAIL_BATCH} on any candidate fails the whole batch`, async () => {
    const call = await new FakeRankingDriver().rankBatch(buildRankingBatch(tenantsForPropertySource([
      tenantCardFixture(),
      tenantCardFixture({ notes: FAKE_SEAM_FAIL_BATCH }),
    ])));
    expect(call.ok).toBe(false);
  });

  it(`${FAKE_SEAM_OMIT} omits that candidate only`, async () => {
    const call = ok(await new FakeRankingDriver().rankBatch(buildRankingBatch(tenantsForPropertySource([
      tenantCardFixture({ notes: `x ${FAKE_SEAM_OMIT}` }),
      tenantCardFixture(),
    ]))));
    expect([...call.output.byHandle.keys()]).toEqual(['c2']);
  });

  it('[fake:unlawful:<field>] raises an unlawful flag on that field of the pair property', async () => {
    const call = ok(await new FakeRankingDriver().rankBatch(buildRankingBatch(tenantsForPropertySource(
      [tenantCardFixture(), tenantCardFixture()],
      propertyCardFixture({ qualifications: 'No kids.', notes: 'x [fake:unlawful:qualifications]' }),
    ))));
    expect(call.output.byHandle.get('c1')!.fairHousingFlags).toEqual([{ kind: 'unlawful', field: 'qualifications' }]);
    expect(call.output.byHandle.get('c2')!.fairHousingFlags).toEqual([{ kind: 'unlawful', field: 'qualifications' }]);
  });

  it('the production parse still applies: an unlawful seam on a checkbox is dropped and counted', async () => {
    const call = ok(await new FakeRankingDriver().rankBatch(buildRankingBatch(tenantsForPropertySource(
      [tenantCardFixture()],
      propertyCardFixture({ no_pets: true, notes: '[fake:unlawful:no_pets]' }),
    ))));
    expect(call.output.byHandle.get('c1')!.fairHousingFlags).toEqual([]);
    expect(call.output.droppedUnlawfulFlags).toBe(1);
  });
});

describe('meta', () => {
  it('fake: driver and model fake, the batch fingerprint, the raw text, no usage, measured latency', async () => {
    const times = [1000, 1007];
    const batch = buildRankingBatch(tenantsForPropertySource([tenantCardFixture()]));
    const call = ok(await new FakeRankingDriver({ now: () => times.shift()! }).rankBatch(batch));
    expect(call.meta).toEqual({
      driver: 'fake',
      model: 'fake',
      promptFingerprint: batch.promptFingerprint,
      rawText: call.meta.rawText,
      latencyMs: 7,
    });
    expect(JSON.parse(call.meta.rawText!)).toHaveProperty('candidates');
  });
});

describe('the console driver', () => {
  it('scores exactly as the fake does and stamps model console', async () => {
    const batch = buildRankingBatch(tenantsForPropertySource([tenantCardFixture({ pets: 'cat' })], propertyCardFixture({ no_pets: true })));
    const capture = createLogCapture();
    const consoleCall = ok(await new ConsoleRankingDriver({ logger: createLogger({ level: 'info', destination: capture.stream }) }).rankBatch(batch));
    const fakeCall = ok(await new FakeRankingDriver().rankBatch(batch));
    expect(consoleCall.meta.driver).toBe('console');
    expect(consoleCall.meta.model).toBe('console');
    expect(consoleCall.output).toEqual(fakeCall.output);
  });

  it('logs counts and sizes only - never a name, an address or Notes text', async () => {
    const batch = buildRankingBatch(tenantsForPropertySource(
      [tenantCardFixture({ firstName: 'Zelda', lastName: 'Secretname', notes: 'Private note text' })],
      propertyCardFixture({ address: { line1: '99 Hidden Lane', city: 'Decatur' } }),
      { batchIndex: 2 },
    ));
    const capture = createLogCapture();
    await new ConsoleRankingDriver({ logger: createLogger({ level: 'info', destination: capture.stream }) }).rankBatch(batch);
    expect(capture.lines).toHaveLength(1);
    expect(capture.lines[0]).toMatchObject({
      msg: 'console ranking driver: scoring with the fake rules (offline)',
      batchIndex: 2,
      candidates: 1,
      homesSeen: 0,
      userChars: batch.user.length,
    });
    const logged = JSON.stringify(capture.lines);
    for (const secret of ['Zelda', 'Secretname', 'Private note text', '99 Hidden Lane']) expect(logged).not.toContain(secret);
  });
});
