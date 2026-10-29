// The read's derivations (WP1 B2a spec D9; charter 7.4, 8, 9.2, 10.3; PR13,
// PR17): band from the score, the Weak cap (each condition), every
// out-of-date reason and the failed-batch rule over the last job's
// failedBatches AND notScored, not ranked yet versus not scored, an
// unverified candidate's row and cap, and the sort in both directions with
// each priority strength. Pure functions over the shared job fixtures.
import { describe, expect, it } from 'vitest';
import type { AssembledCandidate } from '../src/services/ranking/assemble.js';
import {
  buildRow,
  currentRankingModel,
  inLastJob,
  outOfDateReasons,
  sortRows,
  type RankingReadRow,
  type RowContext,
} from '../src/services/ranking/readRanking.js';
import { RUBRIC_VERSION } from '../src/services/ranking/rubric.js';
import {
  ANCHOR_TENANT,
  ANCHOR_UNIT,
  DAY_MS,
  facts,
  isoAt,
  matchRow,
  propertyCandidate,
  runningJob,
  T0,
  tenantCandidate,
  tenantRecord,
  unverifiedProperty,
  unverifiedTenant,
} from './helpers/rankingJobFixtures.js';

function ctx(over: Partial<RowContext> = {}): RowContext {
  return {
    now: new Date(T0),
    maxAgeDays: 7,
    model: 'fake',
    job: undefined,
    openFieldsByUnit: new Map(),
    unreadFlagUnits: new Set(),
    ...over,
  };
}

const tenant = (id = 't-1', over: Parameters<typeof tenantCandidate>[1] = {}) => tenantCandidate(id, over);
const row = (over: Partial<Parameters<typeof matchRow>[0]> = {}) => matchRow({ tenantId: 't-1', unitId: ANCHOR_UNIT, ...over });

describe('band and cap', () => {
  it.each([
    [100, 'strong'], [80, 'strong'], [79, 'good'], [60, 'good'], [59, 'possible'], [40, 'possible'], [39, 'weak'], [0, 'weak'],
  ])('score %i reads %s', (score, band) => {
    expect(buildRow(tenant(), row({ score }), ctx()).match?.band).toBe(band);
  });

  it('a cap-eligible key, recorded on the property, failed, with no accommodation and no open flag, caps at Weak', () => {
    expect(buildRow(tenant(), row({ score: 92, failedRequirements: ['no_pets'] }), ctx()).match).toMatchObject({
      score: 92, band: 'weak', capped: true, capReason: 'requirement not met',
    });
  });

  it('a failed key the property does not record never caps', () => {
    const c = tenant('t-1', { propertyFacts: facts({ recordedRequirementKeys: [] }) });
    expect(buildRow(c, row({ score: 92, failedRequirements: ['no_pets'] }), ctx()).match).toMatchObject({ band: 'strong', capped: false, capReason: null });
  });

  it('a key that is not cap-eligible never caps', () => {
    const c = tenant('t-1', { propertyFacts: facts({ recordedRequirementKeys: ['deposit_one_month'] }) });
    expect(buildRow(c, row({ score: 92, failedRequirements: ['deposit_one_month'] }), ctx()).match?.capped).toBe(false);
  });

  it("the pair's accommodation flag suppresses the cap", () => {
    const r = row({ score: 92, failedRequirements: ['no_pets'], fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }] });
    expect(buildRow(tenant(), r, ctx()).match?.capped).toBe(false);
  });

  it('an OPEN unlawful flag on that field of that property suppresses the cap; a closed one does not', () => {
    const r = row({ score: 92, failedRequirements: ['qualifications'] });
    expect(buildRow(tenant(), r, ctx({ openFieldsByUnit: new Map([[ANCHOR_UNIT, ['qualifications']]]) })).match?.capped).toBe(false);
    // A closed flag is not in openFieldsByUnit (readRanking passes open fields only).
    expect(buildRow(tenant(), r, ctx()).match?.capped).toBe(true);
    // An open flag on ANOTHER property does not reach this pair.
    expect(buildRow(tenant(), r, ctx({ openFieldsByUnit: new Map([['unit-other', ['qualifications']]]) })).match?.capped).toBe(true);
  });

  it('a landlord: flag is treated as a flag on its plain key, and a landlord default counts as recorded', () => {
    const c = tenant('t-1', {
      propertyFacts: facts({ recordedRequirementKeys: ['qualifications'], freeTextByField: { 'landlord:qualifications': 'No kids.' } }),
    });
    const r = row({ score: 92, failedRequirements: ['qualifications'] });
    expect(buildRow(c, r, ctx()).match?.capped).toBe(true);
    expect(buildRow(c, r, ctx({ openFieldsByUnit: new Map([[ANCHOR_UNIT, ['landlord:qualifications']]]) })).match?.capped).toBe(false);
  });

  it('PR17: with no property facts, every failed cap-eligible key counts as recorded and no flag as open', () => {
    const c = unverifiedProperty('u-1');
    const r = matchRow({ tenantId: ANCHOR_TENANT, unitId: 'u-1', score: 88, failedRequirements: ['no_pets'] });
    const m = buildRow(c, r, ctx({ openFieldsByUnit: new Map([['u-1', ['no_pets']]]) })).match!;
    expect(m).toMatchObject({ capped: true, band: 'weak' });
    expect(m.outOfDate).toEqual(['unverified']);
  });

  it("PR17: a candidate property whose flag read failed: recorded keys from its facts, no flag open, row unverified", () => {
    const c = propertyCandidate('u-1');
    const r = matchRow({ tenantId: ANCHOR_TENANT, unitId: 'u-1', score: 88, failedRequirements: ['qualifications'], fingerprints: c.fingerprints });
    const m = buildRow(c, r, ctx({ openFieldsByUnit: new Map([['u-1', ['qualifications']]]), unreadFlagUnits: new Set(['u-1']) })).match!;
    expect(m.capped).toBe(true);
    expect(m.outOfDate).toEqual(['unverified']);
  });
});

describe('out of date', () => {
  it('a current, fresh, same-version match is not out of date', () => {
    expect(outOfDateReasons(tenant(), row(), ctx())).toEqual([]);
  });

  it('card: the tenant card or the unit card fingerprint differs', () => {
    expect(outOfDateReasons(tenant('t-1', { fingerprints: { tenantCard: 'tc-new', unitCard: 'uc-anchor', pairHistory: 'ph-t-1' } }), row(), ctx())).toEqual(['card']);
    expect(outOfDateReasons(tenant('t-1', { fingerprints: { tenantCard: 'tc-t-1', unitCard: 'uc-new', pairHistory: 'ph-t-1' } }), row(), ctx())).toEqual(['card']);
  });

  it('pairHistory: the pair history fingerprint differs', () => {
    expect(outOfDateReasons(tenant('t-1', { fingerprints: { tenantCard: 'tc-t-1', unitCard: 'uc-anchor', pairHistory: 'ph-new' } }), row(), ctx())).toEqual(['pairHistory']);
  });

  it('(PIN) only fingerprints decide card and pair history: a different send list with equal fingerprints changes nothing', () => {
    const c = tenant('t-1', { pairHistory: { sends: [{ at: isoAt(-DAY_MS), kind: 'sent' }], declined: null, tours: [], daysSinceLastSend: 1 } });
    expect(outOfDateReasons(c, row(), ctx())).toEqual([]);
  });

  it('age: older than RANKING_MAX_AGE_DAYS; exactly the limit is still current', () => {
    expect(outOfDateReasons(tenant(), row({ computedAt: isoAt(-7 * DAY_MS - 1) }), ctx())).toEqual(['age']);
    expect(outOfDateReasons(tenant(), row({ computedAt: isoAt(-7 * DAY_MS) }), ctx())).toEqual([]);
  });

  it.each([
    ['rubric', { rubricVersion: 'r0' }],
    ['examples', { examplesVersion: 'e0' }],
    ['model', { model: 'claude-opus-5-5' }],
  ])('version: a %s other than current', (_label, over) => {
    expect(outOfDateReasons(tenant(), row(over), ctx())).toEqual(['version']);
  });

  it('a fake match is out of date wherever a real model is configured', () => {
    expect(outOfDateReasons(tenant(), row({ model: 'fake' }), ctx({ model: 'claude-sonnet-5-5' }))).toEqual(['version']);
    expect(row().rubricVersion).toBe(RUBRIC_VERSION);
  });

  it.each([
    ['a failed batch', runningJob({ startedAt: T0, failedBatches: [{ index: 0, candidateIds: ['t-1'], failure: 'timeout' }] })],
    ['notScored (omitted)', runningJob({ startedAt: T0, notScored: [{ candidateId: 't-1', reason: 'omitted' }] })],
    ['notScored (unreadable)', runningJob({ startedAt: T0, notScored: [{ candidateId: 't-1', reason: 'unreadable' }] })],
  ])('failedBatch: listed in %s of the last job and computed before that job started (PR13)', (_label, job) => {
    expect(outOfDateReasons(tenant(), row({ computedAt: isoAt(-60_000) }), ctx({ job }))).toEqual(['failedBatch']);
  });

  it('failedBatch does NOT flag a pair re-scored since (by the other anchor)', () => {
    const job = runningJob({ startedAt: T0, failedBatches: [{ index: 0, candidateIds: ['t-1'], failure: 'timeout' }] });
    expect(outOfDateReasons(tenant(), row({ computedAt: isoAt(60_000) }), ctx({ job, now: new Date(isoAt(120_000)) }))).toEqual([]);
  });

  it('unverified: shown with the stored match, the card comparisons skipped', () => {
    expect(outOfDateReasons(unverifiedTenant('t-1'), row(), ctx())).toEqual(['unverified']);
  });

  it('reasons accumulate in a fixed order', () => {
    const job = runningJob({ startedAt: T0, notScored: [{ candidateId: 't-1', reason: 'omitted' }] });
    const c = tenant('t-1', { fingerprints: { tenantCard: 'tc-new', unitCard: 'uc-anchor', pairHistory: 'ph-new' } });
    expect(outOfDateReasons(c, row({ computedAt: isoAt(-8 * DAY_MS), model: 'old' }), ctx({ job }))).toEqual([
      'card', 'pairHistory', 'age', 'version', 'failedBatch',
    ]);
  });
});

describe('not ranked yet / not scored', () => {
  it('no match and not listed by the last job: not ranked yet', () => {
    expect(buildRow(tenant(), undefined, ctx())).toMatchObject({ notRankedYet: true, notScored: false, match: null });
  });

  it("no match and listed in the last job's failedBatches or notScored (PR13): not scored", () => {
    for (const job of [
      runningJob({ failedBatches: [{ index: 2, candidateIds: ['t-1'], failure: 'timeout' }] }),
      runningJob({ notScored: [{ candidateId: 't-1', reason: 'omitted' }] }),
      runningJob({ notScored: [{ candidateId: 't-1', reason: 'unreadable' }] }),
    ]) {
      expect(inLastJob(job, 't-1')).toBe(true);
      expect(buildRow(tenant(), undefined, ctx({ job }))).toMatchObject({ notRankedYet: false, notScored: true, match: null });
    }
  });

  it("carries the candidate's display, consent (tenants) and priority (properties)", () => {
    expect(buildRow(tenant('t-1', { hasConsent: false }), undefined, ctx())).toMatchObject({
      candidateId: 't-1', tenantId: 't-1', unitId: ANCHOR_UNIT, display: 'Tenant t-1', hasConsent: false,
    });
    expect(buildRow(propertyCandidate('u-1', { priority: true }), undefined, ctx())).toMatchObject({
      candidateId: 'u-1', tenantId: ANCHOR_TENANT, priority: true,
    });
  });
});

describe('currentRankingModel', () => {
  it('is the model id for anthropic and the driver name otherwise', () => {
    expect(currentRankingModel({ rankingDriver: 'anthropic', aiRankingModel: 'claude-sonnet-5-5' })).toBe('claude-sonnet-5-5');
    expect(currentRankingModel({ rankingDriver: 'fake', aiRankingModel: 'claude-sonnet-5-5' })).toBe('fake');
    expect(currentRankingModel({ rankingDriver: 'console', aiRankingModel: 'claude-sonnet-5-5' })).toBe('console');
  });
});

describe('sortRows', () => {
  function entry(candidate: AssembledCandidate, score: number | null, over: { capped?: boolean } = {}) {
    const stored =
      score === null
        ? undefined
        : matchRow({
            tenantId: candidate.tenantId,
            unitId: candidate.unitId,
            score,
            ...(candidate.fingerprints !== null && { fingerprints: candidate.fingerprints }),
            ...(over.capped === true && { failedRequirements: ['no_pets'] }),
          });
    return { row: buildRow(candidate, stored, ctx()), candidate };
  }
  const ids = (rows: RankingReadRow[]) => rows.map((r) => r.candidateId);
  const heard = (id: string, offsetMs: number) => tenant(id, { record: tenantRecord(id, { last_heard_from_at: isoAt(offsetMs) }) });

  it('property anchor: band, then score, then last heard from else created_at (sortRecencyAt; none last); capped last within Weak; unranked last in pool order', () => {
    const never = tenant('good-70-never', {
      record: tenantRecord('good-70-never', { last_heard_from_at: undefined, created_at: undefined }),
    });
    // FB19 (spec D9): an IMPORTED tenant never heard from sorts by created_at -
    // the pool window's import exception (poolRecencyAt) does not apply here.
    const imported = tenant('good-70-imported', {
      record: tenantRecord('good-70-imported', {
        last_heard_from_at: undefined,
        created_at: isoAt(-5 * DAY_MS),
        imported_from: 'quo-airtable-import',
      }),
    });
    const entries = [
      entry(tenant('unranked-1'), null),
      entry(heard('weak-capped', 0), 95, { capped: true }),
      entry(heard('weak-30', -DAY_MS), 30),
      entry(heard('good-70-old', -9 * DAY_MS), 70),
      entry(heard('good-70-new', -DAY_MS), 70),
      entry(never, 70),
      entry(imported, 70),
      entry(tenant('strong-81'), 81),
      entry(tenant('unranked-2'), null),
    ];
    expect(ids(sortRows(entries, 'unit', 'within_band'))).toEqual([
      'strong-81', 'good-70-new', 'good-70-imported', 'good-70-old', 'good-70-never', 'weak-30', 'weak-capped', 'unranked-1', 'unranked-2',
    ]);
  });

  it('property anchor: priority does not apply', () => {
    const entries = [entry(tenant('a'), 70), entry(tenant('b', { priority: true }), 65)];
    expect(ids(sortRows(entries, 'unit', 'always_first'))).toEqual(['a', 'b']);
  });

  const prop = (id: string, priority: boolean, display?: string) =>
    propertyCandidate(id, { priority, ...(display !== undefined && { display }) });

  it('tenant anchor, within_band: band, then priority on before off, then score, then label; no lift for a capped pair', () => {
    const entries = [
      entry(prop('good-plain-75', false), 75),
      entry(prop('good-prio-62', true), 62),
      entry(prop('strong-plain-90', false), 90),
      entry(prop('weak-prio-capped', true), 88, { capped: true }),
      entry(prop('weak-plain-20', false), 20),
      entry(prop('good-plain-75-a', false, 'A Street, Atlanta'), 75),
    ];
    expect(ids(sortRows(entries, 'tenant', 'within_band'))).toEqual([
      'strong-plain-90', 'good-prio-62', 'good-plain-75-a', 'good-plain-75', 'weak-plain-20', 'weak-prio-capped',
    ]);
  });

  it('tenant anchor, one_band_up: a priority pair sorts as one band higher (score unchanged); never above Strong; not when capped', () => {
    const entries = [
      entry(prop('strong-plain-85', false), 85),
      entry(prop('good-prio-65', true), 65),
      entry(prop('strong-prio-81', true), 81),
      entry(prop('possible-plain-55', false), 55),
      entry(prop('weak-prio-30', true), 30),
      entry(prop('weak-prio-capped', true), 90, { capped: true }),
    ];
    const sorted = sortRows(entries, 'tenant', 'one_band_up');
    // weak-prio-30 sorts as Possible, then priority on before off puts it
    // ahead of possible-plain-55; the capped priority pair stays last in Weak.
    expect(ids(sorted)).toEqual([
      'strong-prio-81', 'good-prio-65', 'strong-plain-85', 'weak-prio-30', 'possible-plain-55', 'weak-prio-capped',
    ]);
    expect(sorted.find((r) => r.candidateId === 'good-prio-65')?.match).toMatchObject({ score: 65, band: 'good' });
  });

  it('tenant anchor, always_first: every non-capped priority pair first, then the rest by band', () => {
    const entries = [
      entry(prop('strong-plain-95', false), 95),
      entry(prop('weak-prio-25', true), 25),
      entry(prop('good-prio-70', true), 70),
      entry(prop('weak-prio-capped', true), 90, { capped: true }),
      entry(prop('unranked-prio', true), null),
    ];
    expect(ids(sortRows(entries, 'tenant', 'always_first'))).toEqual([
      'good-prio-70', 'weak-prio-25', 'strong-plain-95', 'weak-prio-capped', 'unranked-prio',
    ]);
  });
});
