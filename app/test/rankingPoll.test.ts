// runDueRankings (WP1 B2a spec D7): each tick first fails every queued record
// past its expiry (a conditional update that can never fail a record another
// tick just claimed), then claims queued records oldest first and takes over
// expired leases, up to the free in-process slots. Ticks overlap, so the
// slots and the conditional claims are tested with overlapping ticks and with
// two pollers (WI15). Each job runs in a FRESH context carrying the press's
// requestId and traceparent, so its log lines correlate to the press (WI14).
import { describe, expect, it } from 'vitest';
import { newPollRunId, runWithContext } from '../src/lib/context.js';
import type { RankingUpdatedEvent } from '../src/lib/events.js';
import { createLogger } from '../src/lib/logger.js';
import { rankingJobItemId } from '../src/repos/rankingRunsRepo.js';
import {
  createRankingSlots,
  MSG_NOT_PICKED_UP,
  MSG_STOPPED,
  runDueRankings,
  type RankingJobDeps,
  type RankingSlots,
} from '../src/services/ranking/job.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  ANCHOR_UNIT,
  assembled,
  deferred,
  flush,
  isoAt,
  PRESS_REQUEST_ID,
  PRESS_TRACEPARENT,
  queuedJob,
  runningJob,
  stubBuildPrompt,
  stubDriver,
  tenantCandidate,
  unitAnchor,
  type StubDriverOptions,
} from './helpers/rankingJobFixtures.js';
import { createMatchesFake, createRankingRunsFake, type RankingRunsFake } from './helpers/rankingRunsFake.js';

const NOW = isoAt(60_000);

function makeDeps(runs: RankingRunsFake, opts: { slots?: RankingSlots; driver?: StubDriverOptions } = {}) {
  const matches = createMatchesFake();
  const driver = stubDriver(opts.driver);
  const emitted: RankingUpdatedEvent[] = [];
  const capture = createLogCapture();
  let ids = 0;
  const deps: RankingJobDeps = {
    jobs: runs.repo,
    matches: matches.repo,
    driver,
    assemble: async () => assembled(unitAnchor(), [tenantCandidate('t-1'), tenantCandidate('t-2')]),
    buildPrompt: stubBuildPrompt,
    events: { emit: (_n, p) => emitted.push(p as RankingUpdatedEvent) },
    slots: opts.slots ?? createRankingSlots(2),
    config: {
      rankingBatchSize: 40,
      rankingBatchConcurrency: 4,
      rankingLeaseMs: 90_000,
      rankingPairTtlDays: 180,
      rankingLandlordCard: false,
      aiPriceTable: {},
      appEnv: 'local',
    },
    logger: createLogger({ level: 'info', destination: capture.stream }),
    now: () => NOW,
    newId: () => `id-${++ids}`,
    timers: { setInterval: () => 0, clearInterval: () => undefined },
  };
  return { deps, matches, driver, emitted, capture };
}

function seed(runs: RankingRunsFake, ...records: ReturnType<typeof queuedJob>[]) {
  for (const record of records) runs.jobs.set(record.itemId, record);
}

describe('runDueRankings', () => {
  it('claims a queued record (running, startedAt, lease = now + RANKING_LEASE_MS) and runs it to done', async () => {
    const runs = createRankingRunsFake();
    seed(runs, queuedJob());
    const { deps, driver } = makeDeps(runs);
    expect(await runDueRankings(NOW, deps)).toEqual({ expired: 0, claimed: 1, tookOver: 0, failedStale: 0 });
    expect(driver.calls).toEqual([['t-1', 't-2']]);
    expect(runs.jobs.get(rankingJobItemId('unit', ANCHOR_UNIT))).toMatchObject({ status: 'done', startedAt: NOW, leaseExpiresAt: isoAt(150_000) });
    expect(runs.writes[0]).toBe('claimQueued:gen-1');
  });

  it('first fails a queued record past its expiry with the not-picked-up message, never runs it, and emits', async () => {
    const runs = createRankingRunsFake();
    seed(runs, queuedJob({ requestedAt: isoAt(-700_000) }));
    const { deps, driver, emitted } = makeDeps(runs);
    expect(await runDueRankings(NOW, deps)).toEqual({ expired: 1, claimed: 0, tookOver: 0, failedStale: 0 });
    expect(driver.calls).toEqual([]);
    expect(runs.jobs.get(rankingJobItemId('unit', ANCHOR_UNIT))).toMatchObject({ status: 'failed', message: MSG_NOT_PICKED_UP });
    expect(emitted).toEqual([
      { anchorKind: 'unit', anchorId: ANCHOR_UNIT, generation: 'gen-1', status: 'failed', batchesDone: 0, batchCount: 0 },
    ]);
  });

  it('claims oldest first when slots are short', async () => {
    const runs = createRankingRunsFake();
    const older = queuedJob({ anchorId: 'unit-old', requestedAt: isoAt(-30_000) });
    const newer = queuedJob({ anchorId: 'unit-new', requestedAt: isoAt(-10_000) });
    seed(runs, newer, older);
    const { deps } = makeDeps(runs, { slots: createRankingSlots(1) });
    await runDueRankings(NOW, deps);
    expect(runs.jobs.get(older.itemId)?.status).toBe('done');
    expect(runs.jobs.get(newer.itemId)?.status).toBe('queued');
  });

  it('a claim lost between the listing and the write runs nothing and frees its slot', async () => {
    const runs = createRankingRunsFake();
    const record = queuedJob();
    seed(runs, record);
    const slots = createRankingSlots(1);
    const { deps, driver } = makeDeps(runs, { slots });
    const listed = runs.repo.listQueued;
    runs.repo.listQueued = async (limit) => {
      const rows = await listed(limit);
      runs.jobs.get(record.itemId)!.generation = 'gen-repressed';
      return rows;
    };
    expect((await runDueRankings(NOW, deps)).claimed).toBe(0);
    expect(driver.calls).toEqual([]);
    expect(slots.inUse()).toBe(0);
  });

  it("takes over an expired lease ONCE: new generation, attempts 1, run again from the start; the dead attempt's run ids are kept (IR23)", async () => {
    const runs = createRankingRunsFake();
    seed(runs, runningJob({ leaseExpiresAt: isoAt(-1), batchCount: 3, batchesDone: [0], runIds: ['old-run'] }));
    const { deps, driver, matches } = makeDeps(runs);
    expect(await runDueRankings(NOW, deps)).toEqual({ expired: 0, claimed: 0, tookOver: 1, failedStale: 0 });
    const record = runs.jobs.get(rankingJobItemId('unit', ANCHOR_UNIT))!;
    expect(record).toMatchObject({ status: 'done', attempts: 1, batchCount: 1, batchesDone: [0] });
    expect(record.generation).not.toBe('gen-1');
    expect(record.runIds[0]).toBe('old-run');
    expect(record.runIds).toHaveLength(2);
    expect(driver.calls).toHaveLength(1);
    expect(matches.rows.get(`t-1#${ANCHOR_UNIT}`)?.jobGeneration).toBe(record.generation);
  });

  it('a second expiry marks the job failed with the stopped message (markLeaseFailed) and runs nothing', async () => {
    const runs = createRankingRunsFake();
    seed(runs, runningJob({ attempts: 1, leaseExpiresAt: isoAt(-1) }));
    const { deps, driver, emitted } = makeDeps(runs);
    expect(await runDueRankings(NOW, deps)).toEqual({ expired: 0, claimed: 0, tookOver: 0, failedStale: 1 });
    expect(driver.calls).toEqual([]);
    expect(runs.jobs.get(rankingJobItemId('unit', ANCHOR_UNIT))).toMatchObject({ status: 'failed', message: MSG_STOPPED });
    expect(runs.writes).toContain('markLeaseFailed:gen-1');
    expect(emitted.at(-1)?.status).toBe('failed');
  });

  it('leaves a running record with a live lease alone', async () => {
    const runs = createRankingRunsFake();
    seed(runs, runningJob({ leaseExpiresAt: isoAt(120_000) }));
    const { deps, driver } = makeDeps(runs);
    expect(await runDueRankings(NOW, deps)).toEqual({ expired: 0, claimed: 0, tookOver: 0, failedStale: 0 });
    expect(driver.calls).toEqual([]);
  });

  it('a tick with no free slot claims nothing', async () => {
    const runs = createRankingRunsFake();
    seed(runs, queuedJob());
    const slots = createRankingSlots(1);
    slots.tryAcquire();
    const { deps, driver } = makeDeps(runs, { slots });
    expect((await runDueRankings(NOW, deps)).claimed).toBe(0);
    expect(driver.calls).toEqual([]);
    expect(runs.jobs.get(rankingJobItemId('unit', ANCHOR_UNIT))?.status).toBe('queued');
  });

  it('WI15: overlapping ticks never run more than RANKING_MAX_CONCURRENT_JOBS jobs in one process', async () => {
    const runs = createRankingRunsFake();
    seed(
      runs,
      queuedJob({ anchorId: 'unit-a', requestedAt: isoAt(-3_000) }),
      queuedJob({ anchorId: 'unit-b', requestedAt: isoAt(-2_000) }),
      queuedJob({ anchorId: 'unit-c', requestedAt: isoAt(-1_000) }),
    );
    const gate = deferred();
    const slots = createRankingSlots(2);
    const { deps, driver } = makeDeps(runs, { slots, driver: { gate: () => gate.promise } });
    // Two ticks started without awaiting, as pollLoop.ts's setInterval does.
    const tick1 = runDueRankings(NOW, deps);
    const tick2 = runDueRankings(NOW, deps);
    await flush();
    expect(driver.calls).toHaveLength(2);
    expect(slots.inUse()).toBe(2);
    expect([...runs.jobs.values()].filter((r) => r.status === 'running')).toHaveLength(2);
    expect(runs.jobs.get(rankingJobItemId('unit', 'unit-c'))?.status).toBe('queued');
    gate.resolve();
    const [s1, s2] = await Promise.all([tick1, tick2]);
    expect(s1.claimed + s2.claimed).toBe(2);
    expect(slots.inUse()).toBe(0);
    await runDueRankings(NOW, deps);
    expect(runs.jobs.get(rankingJobItemId('unit', 'unit-c'))?.status).toBe('done');
  });

  it('WI15: two pollers (two processes) racing one queued record - one claim, one run', async () => {
    const runs = createRankingRunsFake();
    seed(runs, queuedJob());
    const a = makeDeps(runs);
    const b = makeDeps(runs);
    const [sa, sb] = await Promise.all([runDueRankings(NOW, a.deps), runDueRankings(NOW, b.deps)]);
    expect(sa.claimed + sb.claimed).toBe(1);
    expect(a.driver.calls.length + b.driver.calls.length).toBe(1);
    expect(runs.jobs.get(rankingJobItemId('unit', ANCHOR_UNIT))?.status).toBe('done');
  });

  it("WI14: every job line carries the press's requestId as its correlationId - no pollRunId, no jobRunId", async () => {
    const runs = createRankingRunsFake();
    seed(runs, queuedJob());
    const { deps, capture } = makeDeps(runs);
    const pollRunId = newPollRunId();
    await runWithContext({ bootId: 'boot-1', pollRunId }, () => runDueRankings(NOW, deps));
    const jobLines = capture.lines.filter((l) => String(l['msg']).startsWith('ranking job'));
    expect(jobLines.length).toBeGreaterThanOrEqual(3);
    for (const line of jobLines) {
      expect(line['correlationId']).toBe(PRESS_REQUEST_ID);
      expect(line['requestId']).toBe(PRESS_REQUEST_ID);
      expect(line['traceparent']).toBe(PRESS_TRACEPARENT);
      expect('pollRunId' in line).toBe(false);
      expect('jobRunId' in line).toBe(false);
      expect('bootId' in line).toBe(false);
    }
    expect(capture.lines.find((l) => l['msg'] === 'ranking poll pass')?.['correlationId']).toBe(pollRunId);
  });

  it('a record with no traceparent runs with the requestId alone', async () => {
    const runs = createRankingRunsFake();
    const record = queuedJob();
    delete record.traceparent;
    seed(runs, record);
    const { deps, capture } = makeDeps(runs);
    await runDueRankings(NOW, deps);
    const started = capture.lines.find((l) => l['msg'] === 'ranking job started')!;
    expect(started['correlationId']).toBe(PRESS_REQUEST_ID);
    expect('traceparent' in started).toBe(false);
  });
});
