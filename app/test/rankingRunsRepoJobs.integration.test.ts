// rankingRunsRepo, the JOB family (WP1 B2a spec D7; plan PR5). Every
// conditional write exactly as the spec states it, against DynamoDB Local so
// the engine - not a stand-in - decides the conditions, the sparse index keys
// and the list_append races.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { rankingExpiresAt } from '../src/repos/matchesRepo.js';
import {
  RANKING_JOBS_QUEUED_ENTITY,
  RANKING_JOBS_RUNNING_ENTITY,
  createRankingRunsRepo,
  rankingJobItemId,
  type RankingJobClaim,
  type RankingJobRecord,
  type RankingJobRef,
} from '../src/repos/rankingRunsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(`[rankingRunsRepoJobs.integration] DynamoDB Local is required at ${endpoint}`);
}

const T0 = '2026-10-28T12:00:00.000Z';
const at = (ms: number, base = T0): string => new Date(Date.parse(base) + ms).toISOString();
const EXPIRES = rankingExpiresAt(T0, 180);

describe('ranking job keys', () => {
  it('rjob#<anchorKind>#<anchorId> and the two sparse index partitions', () => {
    expect(rankingJobItemId('unit', 'unit-1')).toBe('rjob#unit#unit-1');
    expect(rankingJobItemId('tenant', 'contact-1')).toBe('rjob#tenant#contact-1');
    expect(RANKING_JOBS_QUEUED_ENTITY).toBe('rankjobs#queued');
    expect(RANKING_JOBS_RUNNING_ENTITY).toBe('rankjobs#running');
  });
});

describe.skipIf(!reachable)('rankingRunsRepo job family against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repo = createRankingRunsRepo({ doc, env: testEnv, logger });
  const table = tableName('ai_runs', testEnv);

  const anchor = (): string => `unit-${randomUUID().slice(0, 8)}`;
  const gen = (): string => `gen-${randomUUID().slice(0, 8)}`;

  function claim(anchorId: string, over: Partial<RankingJobClaim> = {}): RankingJobClaim {
    return {
      anchorKind: 'unit',
      anchorId,
      generation: gen(),
      includeOlder: false,
      requestedBy: 'user-va',
      requestedAt: T0,
      requestId: 'req-press-1',
      queuedExpiresAt: at(600_000),
      expiresAt: EXPIRES,
      ...over,
    };
  }

  const ref = (job: Pick<RankingJobRecord, 'anchorKind' | 'anchorId' | 'generation'>): RankingJobRef => ({
    anchorKind: job.anchorKind,
    anchorId: job.anchorId,
    generation: job.generation,
  });

  async function raw(anchorId: string): Promise<Record<string, unknown> | undefined> {
    const { Item } = await doc.send(
      new GetCommand({ TableName: table, Key: { itemId: rankingJobItemId('unit', anchorId) }, ConsistentRead: true }),
    );
    return Item as Record<string, unknown> | undefined;
  }

  /** Queued at T0, claimed by a poller at T0 + 1 s with a 90 s lease. */
  async function running(anchorId: string): Promise<RankingJobRecord> {
    const queued = await repo.putJobClaim(claim(anchorId));
    if (!queued.ok) throw new Error('setup: the claim lost');
    const job = await repo.claimQueued(ref(queued.job), { nowIso: at(1_000), leaseExpiresAt: at(91_000) });
    if (job === undefined) throw new Error('setup: claimQueued lost');
    return job;
  }

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('ai_runs'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  // --- the claim (the press) ---------------------------------------------------

  it('a fresh claim writes the queued record with every D7 field and the queued index keys', async () => {
    const anchorId = anchor();
    const input = claim(anchorId, { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' });

    const result = await repo.putJobClaim(input);

    expect(result.ok).toBe(true);
    const stored = await repo.getJob('unit', anchorId, { consistent: true });
    expect(stored).toEqual({
      itemId: `rjob#unit#${anchorId}`,
      anchorKind: 'unit',
      anchorId,
      status: 'queued',
      generation: input.generation,
      includeOlder: false,
      requestedBy: 'user-va',
      requestedAt: T0,
      requestId: 'req-press-1',
      traceparent: input.traceparent,
      attempts: 0,
      queuedExpiresAt: at(600_000),
      batchesDone: [],
      failedBatches: [],
      notScored: [],
      runIds: [],
      entityKey: 'rankjobs#queued',
      sortKey: T0,
      expires_at: EXPIRES,
    });
    expect(result.ok && result.job).toEqual(stored);
  });

  it('no traceparent is stored when the press carried none', async () => {
    const anchorId = anchor();
    await repo.putJobClaim(claim(anchorId));
    expect(await raw(anchorId)).not.toHaveProperty('traceparent');
  });

  it('a second claim LOSES while the record is queued and unexpired; the first generation stands', async () => {
    const anchorId = anchor();
    const first = claim(anchorId);
    await repo.putJobClaim(first);

    expect(await repo.putJobClaim(claim(anchorId, { requestedAt: at(5_000) }))).toEqual({ ok: false });
    expect((await repo.getJob('unit', anchorId, { consistent: true }))!.generation).toBe(first.generation);
  });

  it('a claim WINS over a queued record past its queuedExpiresAt', async () => {
    const anchorId = anchor();
    await repo.putJobClaim(claim(anchorId));
    const late = claim(anchorId, { requestedAt: at(600_000), queuedExpiresAt: at(1_200_000) });

    expect((await repo.putJobClaim(late)).ok).toBe(true);
    expect((await repo.getJob('unit', anchorId, { consistent: true }))!.generation).toBe(late.generation);
  });

  it('a claim LOSES while the record is running', async () => {
    const anchorId = anchor();
    await running(anchorId);
    expect(await repo.putJobClaim(claim(anchorId, { requestedAt: at(700_000), queuedExpiresAt: at(1_300_000) }))).toEqual({
      ok: false,
    });
  });

  it('a claim WINS over a done record and over a failed one, replacing every old field', async () => {
    for (const status of ['done', 'failed'] as const) {
      const anchorId = anchor();
      const job = await running(anchorId);
      await repo.finishJob(ref(job), { status, finishedAt: at(30_000), message: 'Two tenants were not scored.' });

      const next = claim(anchorId, { requestedAt: at(60_000), queuedExpiresAt: at(660_000) });
      expect((await repo.putJobClaim(next)).ok, status).toBe(true);
      const stored = await raw(anchorId);
      expect(stored, status).toMatchObject({ status: 'queued', generation: next.generation, attempts: 0 });
      expect(stored, status).not.toHaveProperty('message');
      expect(stored, status).not.toHaveProperty('finishedAt');
      expect(stored, status).not.toHaveProperty('startedAt');
    }
  });

  it('getJob answers undefined for an anchor with no record', async () => {
    expect(await repo.getJob('tenant', 'contact-none', { consistent: true })).toBeUndefined();
    expect(await repo.getJob('tenant', 'contact-none', { consistent: false })).toBeUndefined();
  });

  // --- the poll: listing ---------------------------------------------------------

  it('listQueued answers queued records oldest first, up to the limit; a running record is not listed', async () => {
    // 2020 dates: older than every other record in this table, so they head the partition.
    const ids = [anchor(), anchor(), anchor(), anchor()];
    await repo.putJobClaim(claim(ids[2]!, { requestedAt: '2020-01-01T00:00:03.000Z', queuedExpiresAt: '2030-01-01T00:00:00.000Z' }));
    await repo.putJobClaim(claim(ids[0]!, { requestedAt: '2020-01-01T00:00:01.000Z', queuedExpiresAt: '2030-01-01T00:00:00.000Z' }));
    await repo.putJobClaim(claim(ids[1]!, { requestedAt: '2020-01-01T00:00:02.000Z', queuedExpiresAt: '2030-01-01T00:00:00.000Z' }));
    const runningOne = await repo.putJobClaim(
      claim(ids[3]!, { requestedAt: '2020-01-01T00:00:00.000Z', queuedExpiresAt: '2030-01-01T00:00:00.000Z' }),
    );
    if (!runningOne.ok) throw new Error('setup');
    await repo.claimQueued(ref(runningOne.job), { nowIso: '2020-01-01T00:00:05.000Z', leaseExpiresAt: '2031-01-01T00:00:00.000Z' });

    const listed = await repo.listQueued(3);

    expect(listed.map((j) => j.anchorId)).toEqual([ids[0], ids[1], ids[2]]);
    expect(listed.every((j) => j.status === 'queued')).toBe(true);
  });

  it('listExpiredLeases answers running records whose lease is before now, oldest lease first', async () => {
    const expired = anchor();
    const live = anchor();
    for (const [anchorId, lease] of [
      [expired, '2020-02-01T00:01:30.000Z'],
      [live, '2020-02-01T00:10:00.000Z'],
    ] as const) {
      const queued = await repo.putJobClaim(
        claim(anchorId, { requestedAt: '2020-02-01T00:00:00.000Z', queuedExpiresAt: '2020-02-01T00:10:00.000Z' }),
      );
      if (!queued.ok) throw new Error('setup');
      await repo.claimQueued(ref(queued.job), { nowIso: '2020-02-01T00:00:01.000Z', leaseExpiresAt: lease });
    }

    const listed = await repo.listExpiredLeases('2020-02-01T00:02:00.000Z', 10);

    expect(listed.map((j) => j.anchorId)).toEqual([expired]);
    expect(listed[0]).toMatchObject({ status: 'running', sortKey: '2020-02-01T00:01:30.000Z' });
  });

  // --- the poll: claiming a queued record -------------------------------------------

  it('claimQueued moves the listed generation to running with the lease and the running index keys', async () => {
    const anchorId = anchor();
    const queued = await repo.putJobClaim(claim(anchorId));
    if (!queued.ok) throw new Error('setup');

    const job = await repo.claimQueued(ref(queued.job), { nowIso: at(1_000), leaseExpiresAt: at(91_000) });

    expect(job).toMatchObject({
      status: 'running',
      startedAt: at(1_000),
      leaseExpiresAt: at(91_000),
      entityKey: 'rankjobs#running',
      sortKey: at(91_000),
      generation: queued.job.generation,
    });
  });

  it('two pollers claiming the same record: exactly one wins', async () => {
    const anchorId = anchor();
    const queued = await repo.putJobClaim(claim(anchorId));
    if (!queued.ok) throw new Error('setup');

    const results = await Promise.all([
      repo.claimQueued(ref(queued.job), { nowIso: at(1_000), leaseExpiresAt: at(91_000) }),
      repo.claimQueued(ref(queued.job), { nowIso: at(1_000), leaseExpiresAt: at(91_000) }),
    ]);

    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
  });

  it('claimQueued loses on a different generation, and at or past queuedExpiresAt', async () => {
    const anchorId = anchor();
    const queued = await repo.putJobClaim(claim(anchorId));
    if (!queued.ok) throw new Error('setup');

    expect(
      await repo.claimQueued({ ...ref(queued.job), generation: 'gen-other' }, { nowIso: at(1_000), leaseExpiresAt: at(91_000) }),
    ).toBeUndefined();
    expect(
      await repo.claimQueued(ref(queued.job), { nowIso: at(600_000), leaseExpiresAt: at(690_000) }),
    ).toBeUndefined();
    expect((await raw(anchorId))!['status']).toBe('queued');
  });

  // --- expiry of a queued record --------------------------------------------------

  it('markExpiredQueued fails a queued record only at or past its expiry, and drops its index keys', async () => {
    const anchorId = anchor();
    const queued = await repo.putJobClaim(claim(anchorId));
    if (!queued.ok) throw new Error('setup');
    const message = 'The ranking was not picked up. Press Rank again.';

    expect(await repo.markExpiredQueued(ref(queued.job), { nowIso: at(599_999), message })).toBe(false);
    expect(await repo.markExpiredQueued(ref(queued.job), { nowIso: at(600_000), message })).toBe(true);

    const stored = await raw(anchorId);
    expect(stored).toMatchObject({ status: 'failed', message, finishedAt: at(600_000) });
    expect(stored).not.toHaveProperty('entityKey');
    expect(stored).not.toHaveProperty('sortKey');
  });

  it('markExpiredQueued never fails a record another tick just claimed (generation and status guard)', async () => {
    const anchorId = anchor();
    const listed = await repo.putJobClaim(claim(anchorId));
    if (!listed.ok) throw new Error('setup');
    // A press re-claimed it after expiry: a new generation is now queued.
    const reclaimed = claim(anchorId, { requestedAt: at(600_000), queuedExpiresAt: at(1_200_000) });
    await repo.putJobClaim(reclaimed);

    expect(await repo.markExpiredQueued(ref(listed.job), { nowIso: at(700_000), message: 'x' })).toBe(false);
    expect((await raw(anchorId))!['status']).toBe('queued');

    // And a record a poller claimed is running, so the queued guard refuses too.
    const job = await repo.claimQueued(
      { anchorKind: 'unit', anchorId, generation: reclaimed.generation },
      { nowIso: at(700_000), leaseExpiresAt: at(790_000) },
    );
    expect(job).toBeDefined();
    expect(
      await repo.markExpiredQueued(ref(job!), { nowIso: at(1_300_000), message: 'x' }),
    ).toBe(false);
  });

  // --- the lease --------------------------------------------------------------

  it('renewLease extends the lease and its sort key on the running generation only', async () => {
    const anchorId = anchor();
    const job = await running(anchorId);

    expect(await repo.renewLease(ref(job), at(121_000))).toBe(true);
    expect(await raw(anchorId)).toMatchObject({ leaseExpiresAt: at(121_000), sortKey: at(121_000) });

    expect(await repo.renewLease({ ...ref(job), generation: 'gen-other' }, at(151_000))).toBe(false);
    await repo.finishJob(ref(job), { status: 'done', finishedAt: at(130_000) });
    expect(await repo.renewLease(ref(job), at(151_000))).toBe(false);
  });

  it('takeOver re-claims an expired lease ONCE with a new generation; the old generation is then stale', async () => {
    const anchorId = anchor();
    const job = await running(anchorId);
    await repo.updateJobProgress(ref(job), {
      poolSize: 3,
      batchCount: 1,
      batchDone: 0,
      runIds: ['run-dead-1'],
      notScored: [{ candidateId: 'contact-dead', reason: 'omitted' }],
    });
    const newGeneration = gen();

    // Not yet expired: refused.
    expect(
      await repo.takeOver(ref(job), { nowIso: at(90_999), newGeneration, leaseExpiresAt: at(180_999) }),
    ).toBeUndefined();

    const taken = await repo.takeOver(ref(job), { nowIso: at(91_000), newGeneration, leaseExpiresAt: at(181_000) });

    expect(taken).toMatchObject({
      status: 'running',
      generation: newGeneration,
      attempts: 1,
      startedAt: at(91_000),
      leaseExpiresAt: at(181_000),
      sortKey: at(181_000),
      entityKey: 'rankjobs#running',
      batchesDone: [],
      failedBatches: [],
      notScored: [],
      runIds: ['run-dead-1'],
    });
    expect(taken).not.toHaveProperty('poolSize');
    expect(taken).not.toHaveProperty('batchCount');
    expect(await repo.renewLease(ref(job), at(200_000))).toBe(false);

    // A second expiry is never taken over again ...
    expect(
      await repo.takeOver(ref(taken!), { nowIso: at(181_000), newGeneration: gen(), leaseExpiresAt: at(271_000) }),
    ).toBeUndefined();
    // ... it is marked failed.
    const message = 'The ranking stopped before it finished. Press Rank again.';
    expect(await repo.markLeaseFailed(ref(taken!), { nowIso: at(181_000), message })).toBe(true);
    const stored = await raw(anchorId);
    expect(stored).toMatchObject({ status: 'failed', message, finishedAt: at(181_000) });
    expect(stored).not.toHaveProperty('entityKey');
    expect(stored).not.toHaveProperty('sortKey');
  });

  it('markLeaseFailed refuses a first expiry (attempts 0) and a lease not yet expired', async () => {
    const anchorId = anchor();
    const job = await running(anchorId);
    expect(await repo.markLeaseFailed(ref(job), { nowIso: at(91_000), message: 'x' })).toBe(false);

    const taken = await repo.takeOver(ref(job), { nowIso: at(91_000), newGeneration: gen(), leaseExpiresAt: at(181_000) });
    expect(await repo.markLeaseFailed(ref(taken!), { nowIso: at(180_999), message: 'x' })).toBe(false);
    expect((await raw(anchorId))!['status']).toBe('running');
  });

  // --- progress and the finish ----------------------------------------------------

  it('updateJobProgress sets the counts and APPENDS batches, failed batches, not-scored candidates and run ids - parallel appends all land', async () => {
    const anchorId = anchor();
    const job = await running(anchorId);

    await repo.updateJobProgress(ref(job), { poolSize: 120, batchCount: 3 });
    await Promise.all([
      repo.updateJobProgress(ref(job), {
        batchDone: 0,
        runIds: ['run-a'],
        notScored: [{ candidateId: 'contact-3', reason: 'omitted' }],
      }),
      // Batch 2 scored, but one pair's match write was not confirmed (PR37):
      // done AND a failed entry listing only that candidate (PR42).
      repo.updateJobProgress(ref(job), {
        batchDone: 2,
        runIds: ['run-c'],
        failedBatch: { index: 2, candidateIds: ['contact-15'], failure: 'repo' },
      }),
      repo.updateJobProgress(ref(job), {
        failedBatch: { index: 1, candidateIds: ['contact-9', 'contact-10'], failure: 'timeout' },
        runIds: ['run-b'],
      }),
      repo.updateJobProgress(ref(job), {
        notScored: [
          { candidateId: 'contact-20', reason: 'unreadable' },
          { candidateId: 'contact-21', reason: 'unreadable' },
        ],
      }),
    ]);

    const stored = (await repo.getJob('unit', anchorId, { consistent: true }))!;
    expect(stored.poolSize).toBe(120);
    expect(stored.batchCount).toBe(3);
    expect([...stored.batchesDone].sort()).toEqual([0, 2]);
    // PR42: every batch that left candidates unmatched through a failure, each
    // with exactly those candidates - a failed call (the whole batch) and a
    // partial match write (the one unwritten pair). An omitted or unreadable
    // candidate never lands here (notScored, PR13).
    expect([...stored.failedBatches].sort((a, b) => a.index - b.index)).toEqual([
      { index: 1, candidateIds: ['contact-9', 'contact-10'], failure: 'timeout' },
      { index: 2, candidateIds: ['contact-15'], failure: 'repo' },
    ]);
    expect([...stored.notScored].sort((a, b) => a.candidateId.localeCompare(b.candidateId))).toEqual([
      { candidateId: 'contact-20', reason: 'unreadable' },
      { candidateId: 'contact-21', reason: 'unreadable' },
      { candidateId: 'contact-3', reason: 'omitted' },
    ]);
    expect([...stored.runIds].sort()).toEqual(['run-a', 'run-b', 'run-c']);
  });

  it('updateJobProgress with only an empty notScored list is an empty patch: it throws and writes nothing', async () => {
    const anchorId = anchor();
    const job = await running(anchorId);

    await expect(repo.updateJobProgress(ref(job), { notScored: [] })).rejects.toThrow(/empty progress/);
    expect((await repo.getJob('unit', anchorId, { consistent: true }))!.notScored).toEqual([]);
  });

  it('updateJobProgress refuses a superseded generation and an empty patch', async () => {
    const anchorId = anchor();
    const job = await running(anchorId);

    expect(await repo.updateJobProgress({ ...ref(job), generation: 'gen-other' }, { batchDone: 0 })).toBeUndefined();
    await expect(repo.updateJobProgress(ref(job), {})).rejects.toThrow(/empty progress/);
  });

  it('finishJob ends a running job, drops its index keys, and refuses another generation or a queued record', async () => {
    const anchorId = anchor();
    const job = await running(anchorId);

    expect(await repo.finishJob({ ...ref(job), generation: 'gen-other' }, { status: 'done', finishedAt: at(40_000) })).toBeUndefined();
    const done = await repo.finishJob(ref(job), {
      status: 'done',
      finishedAt: at(40_000),
      message: '2 tenants could not be read and were not scored. Press Rank again.',
    });

    expect(done).toMatchObject({
      status: 'done',
      finishedAt: at(40_000),
      message: '2 tenants could not be read and were not scored. Press Rank again.',
    });
    expect(done).not.toHaveProperty('entityKey');
    expect(done).not.toHaveProperty('sortKey');

    const queuedAnchor = anchor();
    const queued = await repo.putJobClaim(claim(queuedAnchor));
    if (!queued.ok) throw new Error('setup');
    expect(await repo.finishJob(ref(queued.job), { status: 'failed', finishedAt: at(1_000) })).toBeUndefined();
  });
});
