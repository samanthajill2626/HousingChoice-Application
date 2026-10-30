// readRanking (WP1 B2a spec D9; PR13, PR16, PR17, PR26): the current pool and
// cards (assemble), the anchor's last job, every pool member's pair read by
// key (requireComplete), the open unlawful flags of the properties in view.
// The ceiling answers poolTooLarge with the anchor block and no rows; a 503
// comes from the anchor's own reads; a candidate's incomplete reads mark
// only its row unverified.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { AssembleResult } from '../src/services/ranking/assemble.js';
import { textHashOf } from '../src/services/ranking/flags.js';
import { RANKING_UNAVAILABLE_MESSAGE, readRanking, type RankingReadDeps } from '../src/services/ranking/readRanking.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  ANCHOR_TENANT,
  ANCHOR_UNIT,
  assembled,
  DAY_MS,
  facts,
  flagRecord,
  isoAt,
  matchRow,
  propertyCandidate,
  queuedJob,
  runningJob,
  T0,
  tenantAnchor,
  tenantCandidate,
  unitAnchor,
  unitRecord,
  unverifiedProperty,
  unverifiedTenant,
} from './helpers/rankingJobFixtures.js';
import { createMatchesFake, createRankingRunsFake } from './helpers/rankingRunsFake.js';

const UNIT = { kind: 'unit' as const, id: ANCHOR_UNIT };
const TENANT = { kind: 'tenant' as const, id: ANCHOR_TENANT };
const OPTS = { includeOlder: false, now: new Date(T0) };

function harness(result: AssembleResult | (() => Promise<AssembleResult>), seedRows = [matchRow({ tenantId: 't-1', unitId: ANCHOR_UNIT })]) {
  const runs = createRankingRunsFake();
  const matches = createMatchesFake(seedRows);
  const assemble = vi.fn(typeof result === 'function' ? result : async () => result);
  const poolTooLargeMissing = vi.fn<RankingReadDeps['poolTooLargeMissing']>(async () => []);
  const deps: RankingReadDeps = {
    assemble,
    poolTooLargeMissing,
    jobs: runs.repo,
    matches: matches.repo,
    config: {
      rankingMaxAgeDays: 7,
      rankingPriorityStrength: 'within_band',
      rankingDriver: 'fake',
      aiRankingModel: 'claude-sonnet-5-5',
      rankingReadConcurrency: 16,
      rankingPoolWindowDays: 90,
    },
    logger: createLogger({ destination: createLogCapture().stream }),
  };
  return { runs, matches, assemble, poolTooLargeMissing, deps };
}

const okOf = (read: Awaited<ReturnType<typeof readRanking>>) => {
  if (read.kind !== 'ok') throw new Error(`expected ok, got ${read.kind}`);
  return read;
};

describe('readRanking', () => {
  it('reads the anchor block, no job, the window, one row per pool member, no flags', async () => {
    const anchor = unitAnchor({ anchorNotes: ['not_available'], missing: [{ key: 'rent', label: 'Rent' }] });
    const h = harness(assembled(anchor, [tenantCandidate('t-1'), tenantCandidate('t-2')]));
    const read = okOf(await readRanking(UNIT, OPTS, h.deps));
    expect(read.anchor).toEqual({
      kind: 'unit', id: ANCHOR_UNIT, display: '12 Oak St, Atlanta', anchorNotes: ['not_available'],
      missing: [{ key: 'rent', label: 'Rent' }], cardChanged: false,
    });
    expect(read.job).toBeNull();
    expect(read.poolWindowDays).toBe(90);
    expect('poolTooLarge' in read).toBe(false);
    expect(read.rows.map((r) => [r.candidateId, r.match?.band ?? null, r.notRankedYet])).toEqual([
      ['t-1', 'good', false],
      ['t-2', null, true],
    ]);
    expect(read.flags).toEqual([]);
    expect(h.assemble).toHaveBeenCalledWith(UNIT, OPTS);
  });

  it("reads every pool member's pair by key with requireComplete", async () => {
    const h = harness(assembled(unitAnchor(), [tenantCandidate('t-1'), unverifiedTenant('t-2')]));
    const spy = vi.spyOn(h.matches.repo, 'getPairs');
    await readRanking(UNIT, OPTS, h.deps);
    expect(spy).toHaveBeenCalledWith(
      [{ tenantId: 't-1', unitId: ANCHOR_UNIT }, { tenantId: 't-2', unitId: ANCHOR_UNIT }],
      { requireComplete: true },
    );
  });

  it('a legacy row (no schema: 2) is ignored: the member reads not ranked yet', async () => {
    const legacy = { ...matchRow({ tenantId: 't-1', unitId: ANCHOR_UNIT }), schema: 1 } as unknown as ReturnType<typeof matchRow>;
    const h = harness(assembled(unitAnchor(), [tenantCandidate('t-1')]), [legacy]);
    expect(okOf(await readRanking(UNIT, OPTS, h.deps)).rows[0]?.notRankedYet).toBe(true);
  });

  it("cardChanged when a stored match's anchor-side fingerprint differs from the anchor's (unit card for a property anchor)", async () => {
    const c = tenantCandidate('t-1', { fingerprints: { tenantCard: 'tc-t-1', unitCard: 'uc-edited', pairHistory: 'ph-t-1' } });
    const h = harness(assembled(unitAnchor({ fingerprint: 'uc-edited' }), [c]));
    const read = okOf(await readRanking(UNIT, OPTS, h.deps));
    expect(read.anchor.cardChanged).toBe(true);
    expect(read.rows[0]?.match?.outOfDate).toEqual(['card']);
  });

  it('a changed CANDIDATE card does not set cardChanged', async () => {
    const c = tenantCandidate('t-1', { fingerprints: { tenantCard: 'tc-edited', unitCard: 'uc-anchor', pairHistory: 'ph-t-1' } });
    const h = harness(assembled(unitAnchor(), [c]));
    expect(okOf(await readRanking(UNIT, OPTS, h.deps)).anchor.cardChanged).toBe(false);
  });

  it('cardChanged for a tenant anchor compares the tenant card', async () => {
    const stored = matchRow({ tenantId: ANCHOR_TENANT, unitId: 'u-1', fingerprints: { tenantCard: 'tc-old', unitCard: 'uc-u-1', pairHistory: 'ph-u-1' } });
    const h = harness(assembled(tenantAnchor(), [propertyCandidate('u-1')]), [stored]);
    expect(okOf(await readRanking(TENANT, OPTS, h.deps)).anchor.cardChanged).toBe(true);
  });

  it('the job block is the job view, expired derived for a queued record past its expiry', async () => {
    const h = harness(assembled(unitAnchor(), []));
    const record = queuedJob({ requestedAt: isoAt(-700_000) });
    h.runs.jobs.set(record.itemId, record);
    expect(okOf(await readRanking(UNIT, OPTS, h.deps)).job).toMatchObject({
      status: 'expired', message: 'The ranking was not picked up. Press Rank again.', notScored: [],
    });
  });

  it("a candidate in the last job's failed batch or notScored list with no match reads not scored (PR13)", async () => {
    const h = harness(assembled(unitAnchor(), [tenantCandidate('t-8'), tenantCandidate('t-9')]), []);
    const record = runningJob({
      status: 'done',
      failedBatches: [{ index: 0, candidateIds: ['t-9'], failure: 'timeout' }],
      notScored: [{ candidateId: 't-8', reason: 'omitted' }],
    });
    h.runs.jobs.set(record.itemId, record);
    const rows = okOf(await readRanking(UNIT, OPTS, h.deps)).rows;
    expect(rows.map((r) => [r.candidateId, r.notScored, r.notRankedYet])).toEqual([
      ['t-8', true, false],
      ['t-9', true, false],
    ]);
  });

  it('an unverified tenant shows its stored match marked unverified; the other rows are untouched', async () => {
    const h = harness(
      assembled(unitAnchor(), [unverifiedTenant('t-1'), tenantCandidate('t-2')]),
      [matchRow({ tenantId: 't-1', unitId: ANCHOR_UNIT }), matchRow({ tenantId: 't-2', unitId: ANCHOR_UNIT })],
    );
    const rows = okOf(await readRanking(UNIT, OPTS, h.deps)).rows;
    expect(rows.find((r) => r.candidateId === 't-1')?.match?.outOfDate).toEqual(['unverified']);
    expect(rows.find((r) => r.candidateId === 't-2')?.match?.outOfDate).toEqual([]);
  });

  it('PR17: a tenant anchor with an unverified property (no facts) shows its stored match, capped on its failed key, and never throws', async () => {
    const stored = matchRow({ tenantId: ANCHOR_TENANT, unitId: 'u-1', score: 88, failedRequirements: ['no_pets'] });
    const h = harness(assembled(tenantAnchor(), [unverifiedProperty('u-1'), propertyCandidate('u-2')]), [stored]);
    const spy = vi.spyOn(h.runs.repo, 'getOpenCandidateFlags');
    const read = okOf(await readRanking(TENANT, OPTS, h.deps));
    expect(read.rows.find((r) => r.candidateId === 'u-1')?.match).toMatchObject({ capped: true, band: 'weak', outOfDate: ['unverified'] });
    // No flag read for a property whose facts are unknown.
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['u-2']);
  });

  it("PR17: a candidate property's failed flag read marks only its row unverified (a tenant anchor lists no flag at all)", async () => {
    const stored = matchRow({
      tenantId: ANCHOR_TENANT, unitId: 'u-1', score: 88, failedRequirements: ['qualifications'],
      fingerprints: { tenantCard: 'tc-anchor', unitCard: 'uc-u-1', pairHistory: 'ph-u-1' },
    });
    const h = harness(assembled(tenantAnchor(), [propertyCandidate('u-1'), propertyCandidate('u-2')]), [stored]);
    const flag = flagRecord({ unitId: 'u-2', field: 'qualifications', textHash: textHashOf('Two years of rental history.'), reason: 'r', runId: 'run-1', raisedAt: T0 });
    h.runs.flags.set(flag.itemId, flag);
    const original = h.runs.repo.getOpenCandidateFlags;
    h.runs.repo.getOpenCandidateFlags = async (unitId) => {
      if (unitId === 'u-1') throw new Error('throttled');
      return original(unitId);
    };
    const read = okOf(await readRanking(TENANT, OPTS, h.deps));
    expect(read.rows.find((r) => r.candidateId === 'u-1')?.match).toMatchObject({ capped: true, outOfDate: ['unverified'] });
    expect(read.rows.find((r) => r.candidateId === 'u-2')?.notRankedYet).toBe(true);
    // Spec D10 rev 7 (PFW1-2): u-2's open flag is read, never listed.
    expect(read.flags).toEqual([]);
  });

  it("PR17: the property anchor's own flag read failing answers unavailable", async () => {
    const h = harness(assembled(unitAnchor(), [tenantCandidate('t-1')]));
    h.runs.repo.getOpenCandidateFlags = async () => { throw new Error('throttled'); };
    expect(await readRanking(UNIT, OPTS, h.deps)).toEqual({ kind: 'unavailable', message: RANKING_UNAVAILABLE_MESSAGE });
  });

  it("flags: the open unlawful flags of the property anchor (from its own facts), closed ones omitted, and they suppress the cap", async () => {
    const text = { qualifications: 'No kids.', notes: 'Edited since.' };
    const anchor = unitAnchor({ propertyFacts: facts({ freeTextByField: text }) });
    const c = tenantCandidate('t-1', { propertyFacts: facts({ freeTextByField: text }) });
    const h = harness(assembled(anchor, [c]), [matchRow({ tenantId: 't-1', unitId: ANCHOR_UNIT, score: 90, failedRequirements: ['qualifications'] })]);
    const open = flagRecord({ unitId: ANCHOR_UNIT, field: 'qualifications', textHash: textHashOf('No kids.'), reason: 'no kids', runId: 'run-1', raisedAt: T0 });
    const closed = flagRecord({ unitId: ANCHOR_UNIT, field: 'notes', textHash: textHashOf('Adults only.'), reason: 'adults', runId: 'run-1', raisedAt: T0 });
    h.runs.flags.set(open.itemId, open);
    h.runs.flags.set(closed.itemId, closed);
    const read = okOf(await readRanking(UNIT, OPTS, h.deps));
    expect(read.flags).toEqual([{ unitId: ANCHOR_UNIT, field: 'qualifications', reason: 'no kids', runId: 'run-1', raisedAt: T0 }]);
    expect(read.rows[0]?.match).toMatchObject({ capped: false, band: 'strong' });
  });

  it("flags: the unit anchor's open flags show with an empty pool", async () => {
    const anchor = unitAnchor({ propertyFacts: facts({ freeTextByField: { qualifications: 'No kids.' } }) });
    const h = harness(assembled(anchor, []), []);
    const open = flagRecord({ unitId: ANCHOR_UNIT, field: 'qualifications', textHash: textHashOf('No kids.'), reason: 'r', runId: 'run-1', raisedAt: T0 });
    h.runs.flags.set(open.itemId, open);
    expect(okOf(await readRanking(UNIT, OPTS, h.deps)).flags.map((f) => f.field)).toEqual(['qualifications']);
  });

  it("flags (spec D10 rev 7, PFW1-2): a tenant anchor reads each candidate property's flags for the cap, and lists none", async () => {
    const text = { qualifications: 'No kids.' };
    const h = harness(
      assembled(tenantAnchor(), [
        propertyCandidate('u-1', { propertyFacts: facts({ freeTextByField: text }) }),
        propertyCandidate('u-2'),
      ]),
      [
        matchRow({
          tenantId: ANCHOR_TENANT, unitId: 'u-1', score: 90, failedRequirements: ['qualifications'],
          fingerprints: { tenantCard: 'tc-anchor', unitCard: 'uc-u-1', pairHistory: 'ph-u-1' },
        }),
      ],
    );
    const spy = vi.spyOn(h.runs.repo, 'getOpenCandidateFlags');
    const flag = flagRecord({ unitId: 'u-1', field: 'qualifications', textHash: textHashOf('No kids.'), reason: 'r', runId: 'run-1', raisedAt: T0 });
    h.runs.flags.set(flag.itemId, flag);
    const read = okOf(await readRanking(TENANT, OPTS, h.deps));
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(['u-1', 'u-2']);
    // The cap is unchanged: the open flag on qualifications keeps u-1's failed
    // qualifications from capping the pair.
    expect(read.rows.find((r) => r.candidateId === 'u-1')?.match).toMatchObject({ capped: false, band: 'strong' });
    expect(read.flags).toEqual([]);
  });

  const overCeiling = (): AssembleResult => {
    const record = unitRecord(ANCHOR_UNIT, { address: { line1: '12 Oak St', city: 'Atlanta' } });
    return {
      ok: false,
      reason: 'pool_too_large',
      size: 412,
      message: 'Pool too large to rank (412 candidates)',
      anchorRecord: record,
      anchor: { kind: 'unit', record },
      anchorNotes: ['not_available'],
      orgEntries: [],
    };
  };

  it('PR16 / FB4 / BA3: the ceiling answers poolTooLarge (size and the pool message) with the anchor block and its missing flags, no rows, computing no pairs', async () => {
    const failure = overCeiling();
    const h = harness(failure);
    h.poolTooLargeMissing.mockResolvedValue([{ key: 'payment_standard', label: 'Payment standard' }]);
    const spy = vi.spyOn(h.matches.repo, 'getPairs');
    expect(await readRanking(UNIT, OPTS, h.deps)).toEqual({
      kind: 'ok',
      anchor: {
        kind: 'unit',
        id: ANCHOR_UNIT,
        display: '12 Oak St, Atlanta',
        anchorNotes: ['not_available'],
        missing: [{ key: 'payment_standard', label: 'Payment standard' }],
        cardChanged: false,
      },
      job: null,
      rows: [],
      flags: [],
      poolWindowDays: 90,
      poolTooLarge: { size: 412, message: 'Pool too large to rank (412 candidates)' },
    });
    expect(h.poolTooLargeMissing).toHaveBeenCalledWith(failure);
    expect(spy).not.toHaveBeenCalled();
  });

  it("FB4 / PR17: over the ceiling, a failure of the anchor's own landlord read (poolTooLargeMissing throws) is unavailable", async () => {
    const h = harness(overCeiling());
    h.poolTooLargeMissing.mockRejectedValue(new Error('landlord read incomplete'));
    expect(await readRanking(UNIT, OPTS, h.deps)).toEqual({ kind: 'unavailable', message: RANKING_UNAVAILABLE_MESSAGE });
  });

  it('PR43 (read side): after a property-anchor job left every tenant not scored (unreadable), rows read "not scored - retry" and an older match reads out of date', async () => {
    const h = harness(assembled(unitAnchor(), [tenantCandidate('t-1'), tenantCandidate('t-2')]), [
      matchRow({ tenantId: 't-1', unitId: ANCHOR_UNIT, computedAt: isoAt(-DAY_MS) }),
    ]);
    const job = runningJob({
      status: 'done',
      finishedAt: isoAt(1_000),
      poolSize: 2,
      batchCount: 0,
      notScored: [
        { candidateId: 't-1', reason: 'unreadable' },
        { candidateId: 't-2', reason: 'unreadable' },
      ],
      message: "Could not read this property's record. Press Rank again.",
    });
    h.runs.jobs.set(job.itemId, job);
    const read = okOf(await readRanking(UNIT, OPTS, h.deps));
    const byId = new Map(read.rows.map((row) => [row.candidateId, row]));
    expect(byId.get('t-2')).toMatchObject({ notRankedYet: false, notScored: true, match: null });
    expect(byId.get('t-1')?.match?.outOfDate).toContain('failedBatch');
    expect(read.job).toMatchObject({ status: 'done', message: "Could not read this property's record. Press Rank again." });
  });

  it('PR38 (read side): after a tenant-anchor job left every home not scored (unreadable), rows read "not scored - retry" and an older match reads out of date', async () => {
    const h = harness(assembled(tenantAnchor(), [propertyCandidate('u-1'), propertyCandidate('u-2')]), [
      matchRow({ tenantId: ANCHOR_TENANT, unitId: 'u-1', computedAt: isoAt(-DAY_MS) }),
    ]);
    const job = runningJob({
      anchorKind: 'tenant',
      status: 'done',
      finishedAt: isoAt(1_000),
      poolSize: 2,
      batchCount: 0,
      notScored: [
        { candidateId: 'u-1', reason: 'unreadable' },
        { candidateId: 'u-2', reason: 'unreadable' },
      ],
      message: "Could not read this tenant's record. Press Rank again.",
    });
    h.runs.jobs.set(job.itemId, job);
    const read = okOf(await readRanking(TENANT, OPTS, h.deps));
    const byId = new Map(read.rows.map((row) => [row.candidateId, row]));
    expect(byId.get('u-2')).toMatchObject({ notRankedYet: false, notScored: true, match: null });
    expect(byId.get('u-1')?.match?.outOfDate).toContain('failedBatch');
    expect(read.job).toMatchObject({ status: 'done', message: "Could not read this tenant's record. Press Rank again." });
  });

  it('a missing anchor answers not_found', async () => {
    const h = harness({ ok: false, reason: 'anchor_not_found', message: 'This record was not found.' });
    expect(await readRanking(UNIT, OPTS, h.deps)).toEqual({ kind: 'not_found' });
  });

  it.each([
    ['the anchor card cannot be read', { ok: false, reason: 'anchor_unreadable', message: 'This record could not be read in full. Try again.' } as const],
    ['the organization list cannot be read', { ok: false, reason: 'org_list_failed', message: 'The organization list could not be read.' } as const],
  ])("unavailable when %s, with the gatherer's message", async (_label, result) => {
    const h = harness(result);
    expect(await readRanking(UNIT, OPTS, h.deps)).toEqual({ kind: 'unavailable', message: result.message });
  });

  it('unavailable (never a clean ranking) when the gatherer throws, the pairs read is incomplete, or the job read fails', async () => {
    const thrown = harness(async () => { throw new Error('boom'); });
    expect(await readRanking(UNIT, OPTS, thrown.deps)).toEqual({ kind: 'unavailable', message: RANKING_UNAVAILABLE_MESSAGE });

    const incomplete = harness(assembled(unitAnchor(), [tenantCandidate('t-1')]));
    incomplete.matches.failGets = true;
    expect(await readRanking(UNIT, OPTS, incomplete.deps)).toEqual({ kind: 'unavailable', message: RANKING_UNAVAILABLE_MESSAGE });

    const jobRead = harness(assembled(unitAnchor(), [tenantCandidate('t-1')]));
    jobRead.runs.repo.getJob = async () => { throw new Error('throttled'); };
    expect(await readRanking(UNIT, OPTS, jobRead.deps)).toEqual({ kind: 'unavailable', message: RANKING_UNAVAILABLE_MESSAGE });
  });

  it('the rows come back sorted (band, then score)', async () => {
    const h = harness(
      assembled(unitAnchor(), [tenantCandidate('t-1'), tenantCandidate('t-2'), tenantCandidate('t-3')]),
      [matchRow({ tenantId: 't-1', unitId: ANCHOR_UNIT, score: 45 }), matchRow({ tenantId: 't-2', unitId: ANCHOR_UNIT, score: 88 })],
    );
    expect(okOf(await readRanking(UNIT, OPTS, h.deps)).rows.map((r) => r.candidateId)).toEqual(['t-2', 't-1', 't-3']);
  });
});
