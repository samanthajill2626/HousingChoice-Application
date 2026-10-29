// The press's claim (WP1 B2a spec D7): one conditional put that wins on no
// record, a done or failed record, or a queued record past its expiry; a
// losing press reads the record and either retries once (it finished in
// between), JOINS a live job with the same window, or is refused 409 - never
// for a tenant anchor, where the window does not apply. Plus the job view's
// derived `expired` and notScored list, the verified guard and the slots.
import { describe, expect, it, vi } from 'vitest';
import {
  claimRanking,
  createRankingSlots,
  isVerified,
  jobView,
  MSG_NOT_PICKED_UP,
  type ClaimDeps,
} from '../src/services/ranking/job.js';
import { RANKING_JOBS_QUEUED_ENTITY, rankingJobItemId } from '../src/repos/rankingRunsRepo.js';
import {
  ANCHOR_TENANT,
  ANCHOR_UNIT,
  isoAt,
  PRESS_REQUEST_ID,
  PRESS_TRACEPARENT,
  queuedJob,
  runningJob,
  T0,
  T0_MS,
  tenantCandidate,
  unverifiedTenant,
} from './helpers/rankingJobFixtures.js';
import { createRankingRunsFake } from './helpers/rankingRunsFake.js';

const UNIT = { kind: 'unit' as const, id: ANCHOR_UNIT };
const TENANT = { kind: 'tenant' as const, id: ANCHOR_TENANT };
const PRESS = { includeOlder: false, requestedBy: 'usr-va', requestId: PRESS_REQUEST_ID, traceparent: PRESS_TRACEPARENT };

function harness(opts: { exists?: boolean; now?: string } = {}) {
  const fake = createRankingRunsFake();
  let gen = 0;
  const deps: ClaimDeps = {
    jobs: fake.repo,
    anchorExists: async () => opts.exists ?? true,
    config: { rankingQueueExpiryMs: 600_000, rankingPairTtlDays: 180 },
    now: () => opts.now ?? T0,
    newGeneration: () => `gen-new-${++gen}`,
  };
  return { fake, deps };
}

describe('claimRanking', () => {
  it('a fresh press hands S2 the claim (new generation, the press ids, the expiry, the TTL) and answers the stored record', async () => {
    const { fake, deps } = harness();
    const spy = vi.spyOn(fake.repo, 'putJobClaim');
    const result = await claimRanking(UNIT, { ...PRESS, includeOlder: true }, deps);
    expect(spy).toHaveBeenCalledWith({
      anchorKind: 'unit',
      anchorId: ANCHOR_UNIT,
      generation: 'gen-new-1',
      includeOlder: true,
      requestedBy: 'usr-va',
      requestedAt: T0,
      requestId: PRESS_REQUEST_ID,
      traceparent: PRESS_TRACEPARENT,
      queuedExpiresAt: isoAt(600_000),
      expiresAt: Math.floor(T0_MS / 1000) + 180 * 86_400,
    });
    const stored = fake.jobs.get(rankingJobItemId('unit', ANCHOR_UNIT))!;
    expect(result).toEqual({ status: 202, joined: false, job: stored });
    expect(stored).toMatchObject({ status: 'queued', attempts: 0, notScored: [], runIds: [], entityKey: RANKING_JOBS_QUEUED_ENTITY, sortKey: T0 });
  });

  it('omits traceparent when the press has none', async () => {
    const { fake, deps } = harness();
    const spy = vi.spyOn(fake.repo, 'putJobClaim');
    await claimRanking(UNIT, { includeOlder: false, requestedBy: 'u', requestId: 'r' }, deps);
    expect('traceparent' in spy.mock.calls[0]![0]).toBe(false);
  });

  it.each([
    ['done', queuedJob({ status: 'done', generation: 'gen-old', entityKey: undefined, sortKey: undefined })],
    ['failed', queuedJob({ status: 'failed', generation: 'gen-old', entityKey: undefined, sortKey: undefined })],
    ['queued past its expiry', queuedJob({ generation: 'gen-old', requestedAt: isoAt(-700_000) })],
  ])('re-claims a %s record with a new generation', async (_label, existing) => {
    const { fake, deps } = harness();
    fake.jobs.set(existing.itemId, existing);
    expect(await claimRanking(UNIT, PRESS, deps)).toMatchObject({ status: 202, joined: false });
    expect(fake.jobs.get(existing.itemId)).toMatchObject({ generation: 'gen-new-1', status: 'queued' });
  });

  it('JOINS a live queued job with the same window (202, joined, the current record)', async () => {
    const { fake, deps } = harness();
    const live = queuedJob({ generation: 'gen-live', requestedAt: isoAt(-60_000) });
    fake.jobs.set(live.itemId, live);
    expect(await claimRanking(UNIT, PRESS, deps)).toEqual({ status: 202, joined: true, job: live });
    expect(fake.jobs.get(live.itemId)?.generation).toBe('gen-live');
  });

  it('JOINS a running job with the same window', async () => {
    const { fake, deps } = harness();
    const live = runningJob({ generation: 'gen-run' });
    fake.jobs.set(live.itemId, live);
    expect(await claimRanking(UNIT, PRESS, deps)).toMatchObject({ status: 202, joined: true, job: { generation: 'gen-run' } });
  });

  it('refuses 409 ranking_running when a live property job has a different window', async () => {
    const { fake, deps } = harness();
    const live = runningJob({ generation: 'gen-run', includeOlder: true });
    fake.jobs.set(live.itemId, live);
    expect(await claimRanking(UNIT, PRESS, deps)).toEqual({ status: 409, error: 'ranking_running' });
  });

  it('never refuses a tenant anchor for the window: includeOlder is claimed false and the press joins', async () => {
    const { fake, deps } = harness();
    expect(await claimRanking(TENANT, { ...PRESS, includeOlder: true }, deps)).toMatchObject({ status: 202, joined: false });
    expect(fake.jobs.get(rankingJobItemId('tenant', ANCHOR_TENANT))?.includeOlder).toBe(false);
    expect(await claimRanking(TENANT, { ...PRESS, includeOlder: true }, deps)).toMatchObject({ status: 202, joined: true });
  });

  it('a losing press that reads a job finished in between retries the claim once and wins', async () => {
    const { fake, deps } = harness();
    const live = runningJob({ generation: 'gen-run', includeOlder: true });
    fake.jobs.set(live.itemId, live);
    // The put loses against the running record; by the read, it has finished.
    fake.onGetJob = () => {
      const current = fake.jobs.get(live.itemId)!;
      if (current.status === 'running') {
        current.status = 'done';
        delete current.entityKey;
        delete current.sortKey;
      }
    };
    expect(await claimRanking(UNIT, PRESS, deps)).toMatchObject({ status: 202, joined: false, job: { generation: 'gen-new-2' } });
  });

  it('404 when the anchor does not exist, with no write', async () => {
    const { fake, deps } = harness({ exists: false });
    expect(await claimRanking(UNIT, PRESS, deps)).toEqual({ status: 404 });
    expect(fake.jobs.size).toBe(0);
  });
});

describe('jobView', () => {
  it('derives expired for an unclaimed queued record past queuedExpiresAt, with the not-picked-up message', () => {
    const record = queuedJob();
    expect(jobView(record, isoAt(600_000))).toMatchObject({ status: 'expired', message: MSG_NOT_PICKED_UP });
    expect(jobView(record, isoAt(599_999)).status).toBe('queued');
    expect('message' in jobView(record, isoAt(599_999))).toBe(false);
  });

  it('passes the progress fields through, notScored included (PR13)', () => {
    const record = runningJob({
      poolSize: 5,
      batchCount: 3,
      batchesDone: [0, 2],
      failedBatches: [{ index: 1, candidateIds: ['t-3'], failure: 'timeout' }],
      notScored: [{ candidateId: 't-9', reason: 'omitted' }],
      message: 'm',
    });
    expect(jobView(record, T0)).toEqual({
      status: 'running',
      generation: 'gen-1',
      includeOlder: false,
      requestedAt: T0,
      startedAt: T0,
      poolSize: 5,
      batchCount: 3,
      batchesDone: [0, 2],
      failedBatches: [{ index: 1, candidateIds: ['t-3'], failure: 'timeout' }],
      notScored: [{ candidateId: 't-9', reason: 'omitted' }],
      message: 'm',
    });
  });

  it('batchCount reads 0 before the pool is built', () => {
    expect(jobView(queuedJob(), T0).batchCount).toBe(0);
  });
});

describe('isVerified', () => {
  it('narrows the S3 candidate union', () => {
    expect([tenantCandidate('a'), unverifiedTenant('b')].filter(isVerified).map((c) => c.candidateId)).toEqual(['a']);
  });
});

describe('createRankingSlots', () => {
  it('admits up to max, a release frees one, a double release is a no-op', () => {
    const slots = createRankingSlots(2);
    const a = slots.tryAcquire();
    const b = slots.tryAcquire();
    expect(a).toBeTypeOf('function');
    expect(b).toBeTypeOf('function');
    expect(slots.tryAcquire()).toBeUndefined();
    a!();
    a!();
    expect(slots.inUse()).toBe(1);
    expect(slots.tryAcquire()).toBeTypeOf('function');
    expect(slots.inUse()).toBe(2);
  });
});
