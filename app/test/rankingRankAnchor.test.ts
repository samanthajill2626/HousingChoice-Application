// rankAnchor (WP1 B2a spec D7): compute the pool and cards (assemble), split
// the verified candidates into batches of RANKING_BATCH_SIZE in pool order,
// run them with at most RANKING_BATCH_CONCURRENCY in flight, finish done
// (with or without failed batches); a pool of zero is done with no batches;
// an unreadable candidate is left out of the call and listed in notScored; it
// never throws; a lease renewal runs every lease/3 and a refused renewal
// stops the job; a superseded job exits quietly. PR36: a failed generation
// check is retried once, then fails the job. PR38: an unreadable tenant
// anchor is done with every candidate not scored.
import { describe, expect, it } from 'vitest';
import type { RankingUpdatedEvent } from '../src/lib/events.js';
import { createLogger } from '../src/lib/logger.js';
import type { AssembleResult } from '../src/services/ranking/assemble.js';
import {
  createRankingSlots,
  GUARD_RETRY_MS,
  MSG_ERROR,
  MSG_PROPERTY_UNREADABLE,
  MSG_TENANT_UNREADABLE,
  rankAnchor,
  type LeaseTimers,
  type RankingJobDeps,
} from '../src/services/ranking/job.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  ANCHOR_UNIT,
  assembled,
  deferred,
  flush,
  isoAt,
  matchRow,
  runningJob,
  stubBuildPrompt,
  stubDriver,
  tenantAnchor,
  tenantCandidate,
  unitAnchor,
  unverifiedProperty,
  unverifiedTenant,
  type StubDriverOptions,
} from './helpers/rankingJobFixtures.js';
import { createMatchesFake, createRankingRunsFake } from './helpers/rankingRunsFake.js';

const pool = (n: number) => Array.from({ length: n }, (_, i) => tenantCandidate(`t-${i + 1}`));

/** A billed model and its price, so a paid call's logged cost is not zero (1000 in / 500 out = $0.007). */
const PRICED_MODEL = 'claude-sonnet-5-5';
const PRICE_TABLE = { [PRICED_MODEL]: { in: 2, out: 10 } };
/** Code review R1 A1-2 (FW1-2): the line a stopped job's paid call leaves when its run is not written. */
const PAID_CALL_MSG = 'ranking run not written - the job stopped after the call; usage and cost logged here';
const paidCallLine = (lines: Record<string, unknown>[]) => lines.find((l) => l['msg'] === PAID_CALL_MSG);

function harness(opts: {
  result?: AssembleResult | (() => Promise<AssembleResult>);
  driver?: StubDriverOptions;
  batchSize?: number;
  concurrency?: number;
  job?: ReturnType<typeof runningJob>;
} = {}) {
  const runs = createRankingRunsFake();
  const job = opts.job ?? runningJob();
  // WL-S5-1: the fake holds its OWN copy, never the object rankAnchor holds -
  // otherwise a case's supersession (h.record().generation = ...) rewrites the
  // job's own generation too and the guard never sees it.
  runs.jobs.set(job.itemId, structuredClone(job));
  const matches = createMatchesFake([matchRow({ tenantId: 't-3', unitId: ANCHOR_UNIT, runId: 'run-before' })]);
  const driver = stubDriver(opts.driver);
  const emitted: RankingUpdatedEvent[] = [];
  const intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timers: LeaseTimers = {
    setInterval: (fn, ms) => {
      const entry = { fn, ms, cleared: false };
      intervals.push(entry);
      return entry;
    },
    clearInterval: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  let ids = 0;
  const capture = createLogCapture();
  const sleeps: number[] = [];
  const result = opts.result ?? assembled(unitAnchor(), pool(5));
  const deps: RankingJobDeps = {
    jobs: runs.repo,
    matches: matches.repo,
    driver,
    assemble: typeof result === 'function' ? result : async () => result,
    buildPrompt: stubBuildPrompt,
    events: { emit: (_n, p) => emitted.push(p as RankingUpdatedEvent) },
    slots: createRankingSlots(2),
    config: {
      rankingBatchSize: opts.batchSize ?? 2,
      rankingBatchConcurrency: opts.concurrency ?? 4,
      rankingLeaseMs: 90_000,
      rankingPairTtlDays: 180,
      rankingLandlordCard: false,
      aiPriceTable: {},
      appEnv: 'local',
    },
    logger: createLogger({ destination: capture.stream }),
    now: () => isoAt(1_000),
    newId: () => `id-${++ids}`,
    timers,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const record = () => runs.jobs.get(job.itemId)!;
  return { runs, matches, driver, emitted, intervals, deps, job, record, capture, sleeps };
}

describe('rankAnchor', () => {
  it('scores the pool in batches of RANKING_BATCH_SIZE in pool order and finishes done', async () => {
    const h = harness();
    await rankAnchor(h.job, h.deps);
    expect(h.driver.calls.map((c) => c.join(',')).sort()).toEqual(['t-1,t-2', 't-3,t-4', 't-5']);
    expect(h.driver.inputs.map((i) => i.batchIndex).sort()).toEqual([0, 1, 2]);
    expect(h.record()).toMatchObject({ status: 'done', poolSize: 5, batchCount: 3, finishedAt: isoAt(1_000), notScored: [] });
    expect([...h.record().batchesDone].sort()).toEqual([0, 1, 2]);
    expect(h.record().runIds).toHaveLength(3);
    expect(h.runs.runs.size).toBe(3);
    expect(h.matches.rows.size).toBe(5);
    expect('message' in h.record()).toBe(false);
  });

  it('runs at most RANKING_BATCH_CONCURRENCY batches at once', async () => {
    const h = harness({ batchSize: 1, concurrency: 2, driver: { gate: () => flush(3) } });
    await rankAnchor(h.job, h.deps);
    expect(h.driver.calls).toHaveLength(5);
    expect(h.driver.maxInFlight()).toBe(2);
  });

  it('parallel batches with one failing: done, the failed call listed, the message counts candidates (PR42), its pairs untouched', async () => {
    const h = harness({ driver: { failFor: (ids) => (ids.includes('t-3') ? 'timeout' : undefined) } });
    await rankAnchor(h.job, h.deps);
    expect(h.record().status).toBe('done');
    expect(h.record().failedBatches).toEqual([{ index: 1, candidateIds: ['t-3', 't-4'], failure: 'timeout' }]);
    expect([...h.record().batchesDone].sort()).toEqual([0, 2]);
    expect(h.record().message).toBe('2 tenants could not be scored. Press Rank again.');
    expect(h.matches.rows.get(`t-3#${ANCHOR_UNIT}`)?.runId).toBe('run-before');
    expect(h.matches.rows.has(`t-4#${ANCHOR_UNIT}`)).toBe(false);
  });

  it('PR42 / R2B4: a partly saved batch reads "N scores could not be saved", never a failed batch, and the omitted count stays', async () => {
    // Batches [t-1,t-2] [t-3,t-4] [t-5]: t-3's row is not confirmed written
    // (t-4's lands), and the model leaves out t-5.
    const h = harness({ driver: { omit: ['t-5'] } });
    h.matches.failPairs.add(`t-3#${ANCHOR_UNIT}`);
    await rankAnchor(h.job, h.deps);
    expect(h.record().status).toBe('done');
    expect(h.record().failedBatches).toEqual([{ index: 1, candidateIds: ['t-3'], failure: 'repo' }]);
    // The partly saved batch is finished AND listed: batchesDone holds every index.
    expect([...h.record().batchesDone].sort()).toEqual([0, 1, 2]);
    expect(h.emitted.at(-1)).toMatchObject({ status: 'done', batchesDone: 3, batchCount: 3 });
    expect(h.matches.rows.get(`t-4#${ANCHOR_UNIT}`)?.runId).toBeDefined();
    expect(h.record().notScored).toEqual([{ candidateId: 't-5', reason: 'omitted' }]);
    expect(h.record().message).toBe('1 tenant was not scored by the model. Press Rank again. 1 score could not be saved. Press Rank again.');
  });

  it('a candidate the model left out is counted in the message (PR13)', async () => {
    const h = harness({ driver: { omit: ['t-5'] } });
    await rankAnchor(h.job, h.deps);
    expect(h.record().notScored).toEqual([{ candidateId: 't-5', reason: 'omitted' }]);
    expect(h.record().message).toBe('1 tenant was not scored by the model. Press Rank again.');
  });

  it('a pool of zero is done with no batches and one done event', async () => {
    const h = harness({ result: assembled(unitAnchor(), []) });
    await rankAnchor(h.job, h.deps);
    expect(h.driver.calls).toEqual([]);
    expect(h.record()).toMatchObject({ status: 'done', poolSize: 0, batchCount: 0 });
    expect(h.emitted.at(-1)).toEqual({
      anchorKind: 'unit', anchorId: ANCHOR_UNIT, generation: 'gen-1', status: 'done', batchesDone: 0, batchCount: 0,
    });
  });

  it("a pool that cannot be built fails the job with the pool's message and calls no model", async () => {
    const failure: AssembleResult = { ok: false, reason: 'pool_too_large', size: 412, message: 'Pool too large to rank (412 candidates)' };
    const h = harness({ result: failure });
    await rankAnchor(h.job, h.deps);
    expect(h.driver.calls).toEqual([]);
    expect(h.record()).toMatchObject({ status: 'failed', message: 'Pool too large to rank (412 candidates)' });
  });

  it('an anchor_unreadable with no candidateIds (no pool yet) fails the job with its message', async () => {
    const failure: AssembleResult = { ok: false, reason: 'anchor_unreadable', message: 'This record could not be read in full. Try again.' };
    const h = harness({ result: failure });
    await rankAnchor(h.job, h.deps);
    expect(h.record()).toMatchObject({ status: 'failed', message: 'This record could not be read in full. Try again.' });
  });

  it('PR38: an unreadable TENANT anchor is done, every pool candidate not scored (unreadable), with the message', async () => {
    const job = runningJob({ anchorKind: 'tenant' });
    const failure: AssembleResult = {
      ok: false,
      reason: 'anchor_unreadable',
      message: 'This record could not be read in full. Try again.',
      candidateIds: ['u-1', 'u-2'],
    };
    const h = harness({ job, result: failure });
    await rankAnchor(h.job, h.deps);
    expect(h.driver.calls).toEqual([]);
    expect(h.runs.runs.size).toBe(0);
    expect(h.record()).toMatchObject({
      status: 'done',
      poolSize: 2,
      batchCount: 0,
      failedBatches: [],
      notScored: [
        { candidateId: 'u-1', reason: 'unreadable' },
        { candidateId: 'u-2', reason: 'unreadable' },
      ],
      message: MSG_TENANT_UNREADABLE,
    });
    expect(MSG_TENANT_UNREADABLE).toBe("Could not read this tenant's record. Press Rank again.");
    expect(h.emitted.at(-1)).toMatchObject({ status: 'done', batchesDone: 0, batchCount: 0 });
  });

  it('PR43: an unreadable PROPERTY anchor with the pool ids is done, every tenant not scored (unreadable), with the message', async () => {
    const failure: AssembleResult = {
      ok: false,
      reason: 'anchor_unreadable',
      message: 'This record could not be read in full. Try again.',
      candidateIds: ['t-1', 't-2', 't-3'],
    };
    const h = harness({ result: failure });
    await rankAnchor(h.job, h.deps);
    expect(h.driver.calls).toEqual([]);
    expect(h.record()).toMatchObject({
      status: 'done',
      poolSize: 3,
      batchCount: 0,
      failedBatches: [],
      notScored: [
        { candidateId: 't-1', reason: 'unreadable' },
        { candidateId: 't-2', reason: 'unreadable' },
        { candidateId: 't-3', reason: 'unreadable' },
      ],
      message: MSG_PROPERTY_UNREADABLE,
    });
    expect(MSG_PROPERTY_UNREADABLE).toBe("Could not read this property's record. Press Rank again.");
  });

  it('PR38: a tenant anchor_unreadable WITHOUT candidateIds still fails the job (no pool to list)', async () => {
    const job = runningJob({ anchorKind: 'tenant' });
    const failure: AssembleResult = { ok: false, reason: 'anchor_unreadable', message: 'This record could not be read in full. Try again.' };
    const h = harness({ job, result: failure });
    await rankAnchor(h.job, h.deps);
    expect(h.record()).toMatchObject({ status: 'failed', message: 'This record could not be read in full. Try again.' });
  });

  it('PR36: a generation check that throws once is retried and the job still finishes done', async () => {
    const h = harness();
    let reads = 0;
    h.runs.onGetJob = () => {
      reads += 1;
      if (reads === 1) throw new Error('ProvisionedThroughputExceededException');
    };
    await rankAnchor(h.job, h.deps);
    expect(h.record().status).toBe('done');
    expect(h.driver.calls).toHaveLength(3);
    expect(h.capture.lines.some((l) => l['msg'] === 'ranking job generation check failed - retrying once')).toBe(true);
    // R2B5: the retry waits GUARD_RETRY_MS first.
    expect(h.sleeps).toEqual([GUARD_RETRY_MS]);
    expect(GUARD_RETRY_MS).toBe(500);
  });

  it('R2B5: guard reads that fail AFTER every batch has written never turn a fully scored job into failed', async () => {
    const h = harness({ batchSize: 5 });
    // One batch: read 1 before the pool progress, then 2 prompt, 3 putRun,
    // 4 putMatches, 5 markMatchesWritten, 6 progress. Every later read throws;
    // with no guard read before the (generation-conditioned) finish, none happens.
    let reads = 0;
    h.runs.onGetJob = () => {
      reads += 1;
      if (reads >= 7) throw new Error('ProvisionedThroughputExceededException');
    };
    await rankAnchor(h.job, h.deps);
    expect(reads).toBe(6);
    expect(h.record()).toMatchObject({ status: 'done', batchCount: 1 });
    expect('message' in h.record()).toBe(false);
  });

  it('R2B5: a job superseded after its last batch write is not finished (the finish write is generation-conditioned)', async () => {
    const h = harness({ batchSize: 5 });
    h.deps.events = {
      emit: (_name, payload) => {
        const event = payload as RankingUpdatedEvent;
        h.emitted.push(event);
        // The batch's progress has just been written; a takeover now owns the record.
        if (event.status === 'running' && event.batchesDone === 1) h.record().generation = 'gen-takeover';
      },
    };
    await rankAnchor(h.job, h.deps);
    expect(h.record()).toMatchObject({ status: 'running', generation: 'gen-takeover' });
    expect(h.runs.writes.some((w) => w.startsWith('finishJob'))).toBe(false);
  });

  it('PR36: a generation check that throws twice fails the job with MSG_ERROR and calls no model', async () => {
    const h = harness();
    h.runs.onGetJob = () => {
      throw new Error('ProvisionedThroughputExceededException');
    };
    await expect(rankAnchor(h.job, h.deps)).resolves.toBeUndefined();
    expect(h.driver.calls).toEqual([]);
    expect(h.record()).toMatchObject({ status: 'failed', message: MSG_ERROR, generation: 'gen-1' });
    expect(h.emitted.at(-1)).toMatchObject({ status: 'failed' });
    expect(h.intervals[0]!.cleared).toBe(true);
  });

  it('leaves an unreadable candidate out of the call, lists it in notScored, and says so (tenants)', async () => {
    const candidates = [tenantCandidate('t-1'), unverifiedTenant('t-2'), unverifiedTenant('t-3')];
    const h = harness({ result: assembled(unitAnchor(), candidates) });
    await rankAnchor(h.job, h.deps);
    expect(h.driver.calls).toEqual([['t-1']]);
    expect(h.record()).toMatchObject({
      status: 'done',
      poolSize: 3,
      batchCount: 1,
      failedBatches: [],
      notScored: [
        { candidateId: 't-2', reason: 'unreadable' },
        { candidateId: 't-3', reason: 'unreadable' },
      ],
      message: '2 tenants could not be read and were not scored. Press Rank again.',
    });
  });

  it('says properties for a tenant anchor', async () => {
    const job = runningJob({ anchorKind: 'tenant' });
    const h = harness({ job, result: assembled(tenantAnchor(), [unverifiedProperty('u-1')]) });
    await rankAnchor(h.job, h.deps);
    expect(h.record().message).toBe('1 property could not be read and was not scored. Press Rank again.');
  });

  it('never throws: an assemble that throws fails the job with the plain message', async () => {
    const h = harness({ result: async () => { throw new Error('dynamo exploded'); } });
    await expect(rankAnchor(h.job, h.deps)).resolves.toBeUndefined();
    expect(h.record()).toMatchObject({ status: 'failed', message: MSG_ERROR });
  });

  it('never throws: a driver that throws (a contract break) fails only its batch', async () => {
    const h = harness({ driver: { throwFor: (ids) => ids.includes('t-1') } });
    await expect(rankAnchor(h.job, h.deps)).resolves.toBeUndefined();
    expect(h.record().status).toBe('done');
    expect(h.record().failedBatches).toEqual([{ index: 0, candidateIds: ['t-1', 't-2'], failure: 'error' }]);
  });

  it('a superseded job exits quietly: no run, no match, no finish - and its paid call is logged at WARN with usage and cost', async () => {
    const gate = deferred();
    const h = harness({ batchSize: 5, driver: { gate: () => gate.promise, model: PRICED_MODEL } });
    h.deps.config = { ...h.deps.config, aiPriceTable: PRICE_TABLE };
    const running = rankAnchor(h.job, h.deps);
    await flush();
    expect(h.driver.calls).toHaveLength(1);
    h.record().generation = 'gen-takeover';
    gate.resolve();
    await running;
    expect(h.runs.runs.size).toBe(0);
    expect(h.matches.puts).toEqual([]);
    expect(h.record()).toMatchObject({ status: 'running', generation: 'gen-takeover' });
    expect(h.capture.lines.some((l) => l['msg'] === 'ranking job superseded - exiting quietly')).toBe(true);
    // Code review R1 A1-2 (FW1-2): spec D7 leaves the run unwritten once the
    // generation is not this job's, but the call was paid for - the spend
    // shows in this WARN line (PR36's remedy for a lost run).
    expect(paidCallLine(h.capture.lines)).toMatchObject({
      level: 40,
      anchorKind: 'unit',
      anchorId: ANCHOR_UNIT,
      batchIndex: 0,
      candidates: 5,
      runId: 'id-1',
      model: PRICED_MODEL,
      usage: { inputTokens: 1000, outputTokens: 500 },
      costUsd: 0.007,
    });
  });

  it('renews the lease every RANKING_LEASE_MS / 3 on its generation, and clears the timer at the end', async () => {
    const gate = deferred();
    const h = harness({ batchSize: 5, driver: { gate: () => gate.promise } });
    const running = rankAnchor(h.job, h.deps);
    await flush();
    expect(h.intervals).toHaveLength(1);
    expect(h.intervals[0]!.ms).toBe(30_000);
    h.intervals[0]!.fn();
    await flush();
    expect(h.record().leaseExpiresAt).toBe(isoAt(91_000));
    gate.resolve();
    await running;
    expect(h.intervals[0]!.cleared).toBe(true);
  });

  it('a renewal that fails stops the job before its next write; the paid call is logged at WARN with usage and cost', async () => {
    const gate = deferred();
    const h = harness({ batchSize: 5, driver: { gate: () => gate.promise, model: PRICED_MODEL } });
    h.deps.config = { ...h.deps.config, aiPriceTable: PRICE_TABLE };
    h.runs.repo.renewLease = async () => false;
    const running = rankAnchor(h.job, h.deps);
    await flush();
    h.intervals[0]!.fn();
    await flush();
    gate.resolve();
    await running;
    expect(h.runs.runs.size).toBe(0);
    expect(h.record().status).toBe('running');
    // FW1-2: no run record, so the WARN line is where the spend shows.
    expect(paidCallLine(h.capture.lines)).toMatchObject({
      level: 40,
      runId: 'id-1',
      model: PRICED_MODEL,
      usage: { inputTokens: 1000, outputTokens: 500 },
      costUsd: 0.007,
    });
  });

  it('every ranking.updated payload is exactly the six keys (WI16), running then done', async () => {
    const h = harness();
    await rankAnchor(h.job, h.deps);
    for (const payload of h.emitted) {
      expect(Object.keys(payload).sort()).toEqual(['anchorId', 'anchorKind', 'batchCount', 'batchesDone', 'generation', 'status']);
    }
    expect(h.emitted.map((e) => e.status)).toEqual(['running', 'running', 'running', 'running', 'done']);
    expect(h.emitted.at(-1)).toMatchObject({ batchesDone: 3, batchCount: 3 });
  });

  it('logs ids and counts only - no display name, card text or score', async () => {
    const h = harness();
    await rankAnchor(h.job, h.deps);
    const text = JSON.stringify(h.capture.lines);
    expect(text).not.toContain('Tenant t-1');
    expect(text).not.toContain('voucher size fits');
  });
});
