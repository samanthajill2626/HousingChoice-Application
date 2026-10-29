// One batch of a ranking job (WP1 B2a spec D7, D8, D10, D11): the generation
// check before the call and before every write; then the run, the matches
// (with the gzipped input snapshot), matchesWritten by a second update, the
// newly raised unlawful flags, and the progress write with its event. A failed
// call writes no match; a candidate the model did not return gets none and is
// listed in notScored; a match write keeps the rows that landed and fails only
// the candidates not confirmed written (PR37, PR42); a prompt that cannot be
// built fails the batch with no call and no run.
import { describe, expect, it, vi } from 'vitest';
import type { RankingUpdatedEvent } from '../src/lib/events.js';
import { createLogger } from '../src/lib/logger.js';
import { decodeSnapshot, rankingExpiresAt } from '../src/repos/matchesRepo.js';
import { unlawfulFlagItemId, type UnlawfulFlagInput } from '../src/repos/rankingRunsRepo.js';
import { EXAMPLES_VERSION } from '../src/services/ranking/examples.js';
import { textHashOf } from '../src/services/ranking/flags.js';
import { createRankingSlots, type RankingJobDeps } from '../src/services/ranking/job.js';
import { RUBRIC_VERSION } from '../src/services/ranking/rubric.js';
import { finishedBatchCount, runBatch, toRankingEvent, type BatchContext } from '../src/services/ranking/runBatch.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  ANCHOR_UNIT,
  assembled,
  facts,
  flagRecord,
  isoAt,
  parsed,
  runningJob,
  stubBuildPrompt,
  stubDriver,
  T0,
  tenantCandidate,
  throwingBuildPrompt,
  unitAnchor,
  type StubDriverOptions,
} from './helpers/rankingJobFixtures.js';
import { createMatchesFake, createRankingRunsFake } from './helpers/rankingRunsFake.js';

function harness(driverOpts: StubDriverOptions = {}, landlordCard = false) {
  const runs = createRankingRunsFake();
  const job = runningJob();
  // WL-S5-1: the fake holds its OWN copy, never the object the code under test holds.
  runs.jobs.set(job.itemId, structuredClone(job));
  const matches = createMatchesFake();
  const driver = stubDriver(driverOpts);
  const emitted: RankingUpdatedEvent[] = [];
  const capture = createLogCapture();
  let ids = 0;
  const deps: RankingJobDeps = {
    jobs: runs.repo,
    matches: matches.repo,
    driver,
    assemble: async () => assembled(unitAnchor(), []),
    buildPrompt: stubBuildPrompt,
    events: { emit: (_name, payload) => emitted.push(payload as RankingUpdatedEvent) },
    slots: createRankingSlots(2),
    config: {
      rankingBatchSize: 40,
      rankingBatchConcurrency: 4,
      rankingLeaseMs: 90_000,
      rankingPairTtlDays: 180,
      rankingLandlordCard: landlordCard,
      aiPriceTable: {},
      appEnv: 'local',
    },
    logger: createLogger({ destination: capture.stream }),
    now: () => isoAt(1_000),
    newId: () => `run-${++ids}`,
  };
  let current = true;
  let guardCalls = 0;
  /** Supersede the job from this guard call on (1-based); Infinity = never. */
  let supersedeFromCall = Number.POSITIVE_INFINITY;
  const ctx: BatchContext = {
    job,
    anchor: unitAnchor({ missing: [{ key: 'payment_standard', label: 'Payment standard' }] }),
    direction: 'tenants_for_property',
    homes: new Map(),
    raised: new Map<string, UnlawfulFlagInput>(),
    storedFlags: new Map(),
    guard: async () => {
      guardCalls += 1;
      return current && guardCalls < supersedeFromCall;
    },
  };
  return {
    runs, matches, driver, emitted, deps, ctx, job, capture,
    supersede: () => { current = false; },
    supersedeFromGuardCall: (n: number) => { supersedeFromCall = n; },
  };
}

const batch = () => [tenantCandidate('t-1'), tenantCandidate('t-2')];

describe('runBatch', () => {
  it('writes the run, then the matches, then matchesWritten, then the progress, then the event', async () => {
    const h = harness();
    expect(await runBatch(batch(), 0, h.ctx, h.deps)).toEqual({ kind: 'scored', omitted: 0, written: 2 });
    expect(h.runs.writes).toEqual([
      'putRun:run-1',
      'markMatchesWritten:run-1:2',
      'updateJobProgress:{"batchDone":0,"runIds":["run-1"]}',
    ]);
    expect(h.runs.runs.get('run-1')?.matchesWritten).toEqual({ count: 2, at: isoAt(1_000) });
    expect(h.matches.puts).toHaveLength(1);
    expect(h.emitted).toEqual([
      { anchorKind: 'unit', anchorId: ANCHOR_UNIT, generation: 'gen-1', status: 'running', batchesDone: 1, batchCount: 0 },
    ]);
  });

  it('builds the prompt with the batch index and the landlord card switch (PR19)', async () => {
    const h = harness({}, true);
    await runBatch(batch(), 3, h.ctx, h.deps);
    expect(h.driver.inputs[0]).toMatchObject({ batchIndex: 3, landlordCard: true, candidateIds: ['t-1', 't-2'] });
  });

  it('writes one schema-2 row per scored pair with every D8 field and the D8.1 snapshot', async () => {
    const h = harness({
      resultFor: () =>
        parsed({
          score: 91,
          unknowns: ['payment standard', 'Move-in date'],
          fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }],
        }),
    });
    await runBatch([tenantCandidate('t-1', { missing: [{ key: 'area_preference', label: 'Area preference' }] })], 0, h.ctx, h.deps);
    const row = h.matches.rows.get(`t-1#${ANCHOR_UNIT}`)!;
    expect(row).toMatchObject({
      tenantId: 't-1',
      unitId: ANCHOR_UNIT,
      schema: 2,
      score: 91,
      for: parsed().for,
      against: [],
      failedRequirements: [],
      fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }],
      stage: 1,
      rubricVersion: RUBRIC_VERSION,
      examplesVersion: EXAMPLES_VERSION,
      promptFingerprint: 'fp-test',
      model: 'fake',
      runId: 'run-1',
      jobGeneration: 'gen-1',
      computedAt: isoAt(1_000),
      anchorSide: 'unit',
      fingerprints: { tenantCard: 'tc-t-1', unitCard: 'uc-anchor', pairHistory: 'ph-t-1' },
      expires_at: rankingExpiresAt(isoAt(1_000), 180),
    });
    // Code flags first (anchor, then candidate, with their keys), then the
    // model's unknowns that are not already a flag's label (case folded).
    expect(row.missing).toEqual([
      { key: 'payment_standard', text: 'Payment standard' },
      { key: 'area_preference', text: 'Area preference' },
      { text: 'Move-in date' },
    ]);
    expect(decodeSnapshot(row.inputSnapshot)).toEqual({ candidateId: 't-1', anchorCard: 'as sent' });
    // The run's result for the pair carries the same merged list (PR14).
    expect(h.runs.runs.get('run-1')?.results[0]?.missing).toEqual(row.missing);
  });

  it('a failed call records the run, writes no match and lists the whole batch as a failed call', async () => {
    const h = harness({ failFor: () => 'timeout' });
    expect(await runBatch(batch(), 2, h.ctx, h.deps)).toEqual({ kind: 'failed', failure: 'timeout', unscored: 2, omitted: 0, written: 0 });
    expect(h.runs.runs.get('run-1')?.outcome).toBe('failed');
    expect(h.matches.puts).toEqual([]);
    const record = h.runs.jobs.get(h.job.itemId)!;
    expect(record.failedBatches).toEqual([{ index: 2, candidateIds: ['t-1', 't-2'], failure: 'timeout' }]);
    expect(record.batchesDone).toEqual([]);
    expect(record.runIds).toEqual(['run-1']);
    expect(h.emitted.at(-1)?.batchesDone).toBe(1);
  });

  it('a candidate the model did not return gets no match and is listed in notScored (PR13); the batch counts done', async () => {
    const h = harness({ omit: ['t-2'] });
    expect(await runBatch(batch(), 0, h.ctx, h.deps)).toEqual({ kind: 'scored', omitted: 1, written: 1 });
    expect([...h.matches.rows.keys()]).toEqual([`t-1#${ANCHOR_UNIT}`]);
    const record = h.runs.jobs.get(h.job.itemId)!;
    expect(record.batchesDone).toEqual([0]);
    expect(record.failedBatches).toEqual([]);
    expect(record.notScored).toEqual([{ candidateId: 't-2', reason: 'omitted' }]);
  });

  it('a putMatches that THROWS (a bug, per S2) fails the whole batch as repo; matchesWritten stays absent; runBatch does not throw', async () => {
    const h = harness();
    h.matches.failPuts = true;
    expect(await runBatch(batch(), 0, h.ctx, h.deps)).toEqual({ kind: 'failed', failure: 'repo', unscored: 2, omitted: 0, written: 0 });
    expect(h.runs.runs.get('run-1')?.matchesWritten).toBeUndefined();
    expect(h.runs.jobs.get(h.job.itemId)?.failedBatches).toEqual([{ index: 0, candidateIds: ['t-1', 't-2'], failure: 'repo' }]);
  });

  it('PR37: a partial match write keeps the rows that landed, stamps their count, and lists only the unwritten candidates', async () => {
    const h = harness();
    h.matches.failPairs.add(`t-2#${ANCHOR_UNIT}`);
    expect(await runBatch(batch(), 0, h.ctx, h.deps)).toEqual({ kind: 'failed', failure: 'repo', unscored: 1, omitted: 0, written: 1 });
    expect([...h.matches.rows.keys()]).toEqual([`t-1#${ANCHOR_UNIT}`]);
    expect(h.matches.rows.get(`t-1#${ANCHOR_UNIT}`)?.runId).toBe('run-1');
    const record = h.runs.jobs.get(h.job.itemId)!;
    expect(record.failedBatches).toEqual([{ index: 0, candidateIds: ['t-2'], failure: 'repo' }]);
    // Some rows landed: the index is in BOTH lists (counted once as finished).
    expect(record.batchesDone).toEqual([0]);
    expect(record.runIds).toEqual(['run-1']);
    expect(h.emitted.at(-1)?.batchesDone).toBe(1);
    expect(h.runs.runs.get('run-1')?.matchesWritten).toEqual({ count: 1, at: isoAt(1_000) });
  });

  it('PR37: nothing landed (every pair unwritten) fails the whole batch as repo and stamps nothing', async () => {
    const h = harness();
    h.matches.failPairs.add(`t-1#${ANCHOR_UNIT}`);
    h.matches.failPairs.add(`t-2#${ANCHOR_UNIT}`);
    expect(await runBatch(batch(), 0, h.ctx, h.deps)).toEqual({ kind: 'failed', failure: 'repo', unscored: 2, omitted: 0, written: 0 });
    expect(h.runs.jobs.get(h.job.itemId)?.failedBatches).toEqual([{ index: 0, candidateIds: ['t-1', 't-2'], failure: 'repo' }]);
    // No row landed: failedBatches only.
    expect(h.runs.jobs.get(h.job.itemId)?.batchesDone).toEqual([]);
    expect(h.runs.runs.get('run-1')?.matchesWritten).toBeUndefined();
  });

  it('PR36: a putRun that throws after the paid call fails the batch as repo, writes no match, and logs usage and cost', async () => {
    const h = harness();
    h.runs.repo.putRun = async () => { throw new Error('TransactionCanceledException'); };
    expect(await runBatch(batch(), 1, h.ctx, h.deps)).toEqual({ kind: 'failed', failure: 'repo', unscored: 2, omitted: 0, written: 0 });
    expect(h.driver.calls).toHaveLength(1);
    expect(h.matches.puts).toEqual([]);
    expect(h.runs.jobs.get(h.job.itemId)?.failedBatches).toEqual([{ index: 1, candidateIds: ['t-1', 't-2'], failure: 'repo' }]);
    const line = h.capture.lines.find((l) => l['msg'] === 'ranking run write failed - usage and cost logged here');
    expect(line).toMatchObject({ runId: 'run-1', model: 'fake', usage: { inputTokens: 1000, outputTokens: 500 }, costUsd: 0 });
  });

  it('R2B7: a putRun that throws after a FAILED call records the call\'s own failure kind, not repo', async () => {
    const h = harness({ failFor: () => 'timeout' });
    h.runs.repo.putRun = async () => { throw new Error('TransactionCanceledException'); };
    expect(await runBatch(batch(), 1, h.ctx, h.deps)).toEqual({ kind: 'failed', failure: 'timeout', unscored: 2, omitted: 0, written: 0 });
    expect(h.runs.jobs.get(h.job.itemId)?.failedBatches).toEqual([{ index: 1, candidateIds: ['t-1', 't-2'], failure: 'timeout' }]);
    const line = h.capture.lines.find((l) => l['msg'] === 'ranking run write failed - usage and cost logged here');
    expect(line).toMatchObject({ runId: 'run-1', callFailure: 'timeout' });
  });

  it('PR42 / R2B4: a partially written batch keeps its omitted count, lists only the not-written candidate, and notes the omitted one', async () => {
    const h = harness({ omit: ['t-3'] });
    h.matches.failPairs.add(`t-2#${ANCHOR_UNIT}`);
    const three = [tenantCandidate('t-1'), tenantCandidate('t-2'), tenantCandidate('t-3')];
    expect(await runBatch(three, 0, h.ctx, h.deps)).toEqual({ kind: 'failed', failure: 'repo', unscored: 1, omitted: 1, written: 1 });
    const record = h.runs.jobs.get(h.job.itemId)!;
    expect(record.failedBatches).toEqual([{ index: 0, candidateIds: ['t-2'], failure: 'repo' }]);
    expect(record.batchesDone).toEqual([0]);
    expect(record.notScored).toEqual([{ candidateId: 't-3', reason: 'omitted' }]);
    expect([...h.matches.rows.keys()]).toEqual([`t-1#${ANCHOR_UNIT}`]);
  });

  it('BA6: a job superseded after its match write does not stamp matchesWritten or write progress', async () => {
    const h = harness();
    // Guard calls: 1 before the prompt, 2 before putRun, 3 before putMatches, 4 before markMatchesWritten.
    h.supersedeFromGuardCall(4);
    expect(await runBatch(batch(), 0, h.ctx, h.deps)).toEqual({ kind: 'stopped' });
    expect(h.matches.puts).toHaveLength(1);
    expect(h.runs.writes).toEqual(['putRun:run-1']);
    expect(h.runs.runs.get('run-1')?.matchesWritten).toBeUndefined();
  });

  it('a prompt that cannot be built (RankingPromptError) fails the batch as driver, with no call and no run (IR34)', async () => {
    const h = harness();
    h.deps.buildPrompt = throwingBuildPrompt('t-2');
    expect(await runBatch(batch(), 1, h.ctx, h.deps)).toEqual({ kind: 'failed', failure: 'driver', unscored: 2, omitted: 0, written: 0 });
    expect(h.driver.calls).toEqual([]);
    expect(h.runs.runs.size).toBe(0);
    expect(h.runs.jobs.get(h.job.itemId)?.failedBatches).toEqual([{ index: 1, candidateIds: ['t-1', 't-2'], failure: 'driver' }]);
  });

  it('stops before the model call when the job is superseded', async () => {
    const h = harness();
    h.supersede();
    expect(await runBatch(batch(), 0, h.ctx, h.deps)).toEqual({ kind: 'stopped' });
    expect(h.driver.calls).toEqual([]);
    expect(h.runs.writes).toEqual([]);
  });

  it('a job superseded while the call is in flight writes nothing after it', async () => {
    const h = harness({ gate: async () => { h.supersede(); } });
    expect(await runBatch(batch(), 0, h.ctx, h.deps)).toEqual({ kind: 'stopped' });
    expect(h.driver.calls).toHaveLength(1);
    expect(h.runs.writes).toEqual([]);
    expect(h.matches.puts).toEqual([]);
  });

  it('FW1-2: a FAILED call whose job stopped during it is logged at WARN with its usage, cost and failure (no run is written)', async () => {
    const h = harness({ gate: async () => { h.supersede(); }, failFor: () => 'timeout' });
    expect(await runBatch(batch(), 2, h.ctx, h.deps)).toEqual({ kind: 'stopped' });
    expect(h.runs.writes).toEqual([]);
    const line = h.capture.lines.find(
      (l) => l['msg'] === 'ranking run not written - the job stopped after the call; usage and cost logged here',
    );
    // The putRun-failure line's fields (PR36), at WARN: the spend is never invisible.
    expect(line).toMatchObject({
      level: 40,
      batchIndex: 2,
      candidates: 2,
      runId: 'run-1',
      model: 'fake',
      usage: { inputTokens: 1000, outputTokens: 500 },
      costUsd: 0,
      callFailure: 'timeout',
    });
    expect('err' in line!).toBe(false);
  });

  it('writes a newly raised unlawful flag once per property and field across batches (first raising run kept)', async () => {
    const flagged = { qualifications: 'No kids under 12.' };
    // Each pair reports qualifications failed: recorded on the property, so
    // only the flag open at run finish keeps it from capping.
    const h = harness({
      resultFor: () =>
        parsed({ failedRequirements: ['qualifications'], fairHousingFlags: [{ kind: 'unlawful', field: 'qualifications' }] }),
    });
    const withFacts = (id: string) => tenantCandidate(id, { propertyFacts: facts({ freeTextByField: flagged }) });
    await runBatch([withFacts('t-1')], 0, h.ctx, h.deps);
    await runBatch([withFacts('t-2')], 1, h.ctx, h.deps);
    const itemId = unlawfulFlagItemId(ANCHOR_UNIT, 'qualifications');
    expect(h.runs.writes.filter((w) => w.startsWith('putFlag:'))).toEqual([`putFlag:${itemId}:run-1`]);
    expect(h.runs.flags.get(itemId)).toMatchObject({ textHash: textHashOf('No kids under 12.'), runId: 'run-1' });
    // Open at run finish (raised by this job): neither pair is capped.
    expect(h.runs.runs.get('run-1')?.results[0]?.cappedAtRun).toEqual({ capped: false, capReason: null });
    expect(h.runs.runs.get('run-2')?.results[0]?.cappedAtRun).toEqual({ capped: false, capReason: null });
  });

  it('WL-S5-2: a putRun failure drops the flags its batch newly raised, so a later batch raising the same flag writes it', async () => {
    const flagged = { qualifications: 'No kids under 12.' };
    const h = harness({ resultFor: () => parsed({ fairHousingFlags: [{ kind: 'unlawful', field: 'qualifications' }] }) });
    const withFacts = (id: string) => tenantCandidate(id, { propertyFacts: facts({ freeTextByField: flagged }) });
    vi.spyOn(h.runs.repo, 'putRun').mockRejectedValueOnce(new Error('TransactionCanceledException'));
    expect(await runBatch([withFacts('t-1')], 0, h.ctx, h.deps)).toEqual({ kind: 'failed', failure: 'repo', unscored: 1, omitted: 0, written: 0 });
    // The failed batch wrote no flag and left no entry in the job's merge map.
    expect(h.runs.flags.size).toBe(0);
    expect(h.ctx.raised.size).toBe(0);
    await runBatch([withFacts('t-2')], 1, h.ctx, h.deps);
    const itemId = unlawfulFlagItemId(ANCHOR_UNIT, 'qualifications');
    expect(h.runs.writes.filter((w) => w.startsWith('putFlag:'))).toEqual([`putFlag:${itemId}:run-2`]);
    expect(h.runs.flags.get(itemId)).toMatchObject({ textHash: textHashOf('No kids under 12.'), runId: 'run-2' });
  });

  it('an OPEN stored flag keeps its first raising run; a CLOSED one is overwritten (re-raised after close)', async () => {
    const text = { qualifications: 'No kids under 12.' };
    const result = () => parsed({ fairHousingFlags: [{ kind: 'unlawful', field: 'qualifications' }] });
    const open = flagRecord({ unitId: ANCHOR_UNIT, field: 'qualifications', textHash: textHashOf('No kids under 12.'), reason: 'r', runId: 'run-old', raisedAt: T0 });

    const h = harness({ resultFor: result });
    h.runs.flags.set(open.itemId, open);
    await runBatch([tenantCandidate('t-1', { propertyFacts: facts({ freeTextByField: text }) })], 0, h.ctx, h.deps);
    expect(h.runs.flags.get(open.itemId)?.runId).toBe('run-old');

    const h2 = harness({ resultFor: result });
    h2.runs.flags.set(open.itemId, { ...open, textHash: textHashOf('Old text before the edit.') });
    await runBatch([tenantCandidate('t-1', { propertyFacts: facts({ freeTextByField: text }) })], 0, h2.ctx, h2.deps);
    expect(h2.runs.flags.get(open.itemId)?.runId).toBe('run-1');
  });

  it("reads each property's stored flags once per job, and a failed read only loses cappedAtRun's stored flags", async () => {
    const h = harness();
    const spy = vi.spyOn(h.runs.repo, 'getOpenCandidateFlags');
    await runBatch(batch(), 0, h.ctx, h.deps);
    await runBatch([tenantCandidate('t-3')], 1, h.ctx, h.deps);
    expect(spy).toHaveBeenCalledTimes(1);

    const h2 = harness();
    vi.spyOn(h2.runs.repo, 'getOpenCandidateFlags').mockRejectedValue(new Error('throttled'));
    expect(await runBatch(batch(), 0, h2.ctx, h2.deps)).toMatchObject({ kind: 'scored' });
  });
});

describe('finishedBatchCount / toRankingEvent', () => {
  it('counts distinct finished batch indexes, scored and failed', () => {
    expect(
      finishedBatchCount({
        batchesDone: [0, 2],
        failedBatches: [
          { index: 1, candidateIds: ['a'], failure: 'timeout' },
          { index: 2, candidateIds: ['b'], failure: 'repo' },
        ],
      }),
    ).toBe(3);
  });

  it('the event carries exactly the six keys (WI16)', () => {
    const event = toRankingEvent(runningJob({ batchCount: 3, batchesDone: [0] }));
    expect(Object.keys(event).sort()).toEqual(['anchorId', 'anchorKind', 'batchCount', 'batchesDone', 'generation', 'status']);
    expect(event).toEqual({ anchorKind: 'unit', anchorId: ANCHOR_UNIT, generation: 'gen-1', status: 'running', batchesDone: 1, batchCount: 3 });
  });
});
