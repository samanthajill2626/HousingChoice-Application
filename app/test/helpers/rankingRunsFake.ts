// In-memory stand-ins for S2's ranking job store (rankingRunsRepo) and
// matches store (matchesRepo), with S2's SIGNATURES (IR2) and the CONDITIONS
// the real writes carry - status and generation on every job write, the
// expiry on the claim and the mark-failed step, the lease and the attempt
// count on a takeover and a second expiry, the text hash on a flag write -
// because the job's correctness under overlapping ticks rests on exactly
// those conditions. Each method body runs without an await, so a condition
// and its write are atomic here as in DynamoDB. rankingJob.integration.test.ts
// runs the same flows against the real repositories.
import {
  RANKING_JOBS_QUEUED_ENTITY,
  RANKING_JOBS_RUNNING_ENTITY,
  rankingJobItemId,
  rankingRunItemId,
  unlawfulFlagEntityKey,
  unlawfulFlagItemId,
  withRankingRunSizeGuard,
  type RankingJobRecord,
  type RankingJobRef,
  type RankingRunRecord,
  type RankingRunsRepo,
  type UnlawfulFlagRecord,
} from '../../src/repos/rankingRunsRepo.js';
import {
  matchPairKey,
  type MatchPairKey,
  type MatchRow,
  type MatchesRepo,
} from '../../src/repos/matchesRepo.js';

export type RankingRunsApi = Pick<
  RankingRunsRepo,
  | 'getJob'
  | 'putJobClaim'
  | 'listQueued'
  | 'listExpiredLeases'
  | 'claimQueued'
  | 'takeOver'
  | 'markLeaseFailed'
  | 'renewLease'
  | 'markExpiredQueued'
  | 'updateJobProgress'
  | 'finishJob'
  | 'putRun'
  | 'markMatchesWritten'
  | 'getRun'
  | 'getOpenCandidateFlags'
  | 'putFlagIfAbsentOrClosed'
>;

export interface RankingRunsFake {
  repo: RankingRunsApi;
  jobs: Map<string, RankingJobRecord>;
  runs: Map<string, RankingRunRecord>;
  flags: Map<string, UnlawfulFlagRecord>;
  /** Called first in every getJob - the race seam. */
  onGetJob?: () => void;
  /** Every write, in order, as `<method>:<detail>`. */
  writes: string[];
}

const clone = <T>(value: T): T => structuredClone(value);
const ms = (iso: string): number => Date.parse(iso);

export function createRankingRunsFake(): RankingRunsFake {
  const jobs = new Map<string, RankingJobRecord>();
  const runs = new Map<string, RankingRunRecord>();
  const flags = new Map<string, UnlawfulFlagRecord>();
  const writes: string[] = [];
  const fake = { jobs, runs, flags, writes } as RankingRunsFake;
  const at = (ref: Pick<RankingJobRef, 'anchorKind' | 'anchorId'>): RankingJobRecord | undefined =>
    jobs.get(rankingJobItemId(ref.anchorKind, ref.anchorId));
  const live = (ref: RankingJobRef): RankingJobRecord | undefined => {
    const current = at(ref);
    return current !== undefined && current.status === 'running' && current.generation === ref.generation ? current : undefined;
  };
  const dropIndexKeys = (record: RankingJobRecord): void => {
    delete record.entityKey;
    delete record.sortKey;
  };
  fake.repo = {
    async getJob(anchorKind, anchorId) {
      fake.onGetJob?.();
      const current = jobs.get(rankingJobItemId(anchorKind, anchorId));
      return current === undefined ? undefined : clone(current);
    },
    async putJobClaim(claim) {
      const itemId = rankingJobItemId(claim.anchorKind, claim.anchorId);
      const current = jobs.get(itemId);
      const claimable =
        current === undefined ||
        current.status === 'done' ||
        current.status === 'failed' ||
        (current.status === 'queued' && ms(current.queuedExpiresAt) <= ms(claim.requestedAt));
      if (!claimable) return { ok: false };
      const job: RankingJobRecord = {
        itemId,
        anchorKind: claim.anchorKind,
        anchorId: claim.anchorId,
        status: 'queued',
        generation: claim.generation,
        includeOlder: claim.includeOlder,
        requestedBy: claim.requestedBy,
        requestedAt: claim.requestedAt,
        requestId: claim.requestId,
        ...(claim.traceparent !== undefined && { traceparent: claim.traceparent }),
        attempts: 0,
        queuedExpiresAt: claim.queuedExpiresAt,
        batchesDone: [],
        failedBatches: [],
        notScored: [],
        runIds: [],
        expires_at: claim.expiresAt,
        entityKey: RANKING_JOBS_QUEUED_ENTITY,
        sortKey: claim.requestedAt,
      };
      jobs.set(itemId, job);
      writes.push(`putJobClaim:${claim.generation}`);
      return { ok: true, job: clone(job) };
    },
    async listQueued(limit) {
      return [...jobs.values()]
        .filter((r) => r.entityKey === RANKING_JOBS_QUEUED_ENTITY)
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
        .slice(0, limit)
        .map(clone);
    },
    async listExpiredLeases(nowIso, limit) {
      return [...jobs.values()]
        .filter((r) => r.entityKey === RANKING_JOBS_RUNNING_ENTITY && r.leaseExpiresAt !== undefined && ms(r.leaseExpiresAt) < ms(nowIso))
        .slice(0, limit)
        .map(clone);
    },
    async claimQueued(ref, opts) {
      const current = at(ref);
      if (
        current === undefined ||
        current.status !== 'queued' ||
        current.generation !== ref.generation ||
        ms(current.queuedExpiresAt) <= ms(opts.nowIso)
      ) {
        return undefined;
      }
      Object.assign(current, {
        status: 'running',
        startedAt: opts.nowIso,
        leaseExpiresAt: opts.leaseExpiresAt,
        entityKey: RANKING_JOBS_RUNNING_ENTITY,
        sortKey: opts.leaseExpiresAt,
      });
      writes.push(`claimQueued:${current.generation}`);
      return clone(current);
    },
    async takeOver(ref, opts) {
      const current = live(ref);
      if (
        current === undefined ||
        current.leaseExpiresAt === undefined ||
        ms(current.leaseExpiresAt) > ms(opts.nowIso) ||
        current.attempts >= 1
      ) {
        return undefined;
      }
      Object.assign(current, {
        generation: opts.newGeneration,
        attempts: current.attempts + 1,
        startedAt: opts.nowIso,
        leaseExpiresAt: opts.leaseExpiresAt,
        sortKey: opts.leaseExpiresAt,
        batchesDone: [],
        failedBatches: [],
        notScored: [],
      });
      // runIds are KEPT (S2: the dead attempt's runs happened, IR23).
      delete current.poolSize;
      delete current.batchCount;
      delete current.message;
      writes.push(`takeOver:${opts.newGeneration}`);
      return clone(current);
    },
    async markLeaseFailed(ref, opts) {
      const current = live(ref);
      if (
        current === undefined ||
        current.leaseExpiresAt === undefined ||
        ms(current.leaseExpiresAt) > ms(opts.nowIso) ||
        current.attempts < 1
      ) {
        return false;
      }
      Object.assign(current, { status: 'failed', message: opts.message, finishedAt: opts.nowIso });
      dropIndexKeys(current);
      writes.push(`markLeaseFailed:${current.generation}`);
      return true;
    },
    async renewLease(ref, leaseExpiresAt) {
      const current = live(ref);
      if (current === undefined) return false;
      current.leaseExpiresAt = leaseExpiresAt;
      current.sortKey = leaseExpiresAt;
      writes.push(`renewLease:${leaseExpiresAt}`);
      return true;
    },
    async markExpiredQueued(ref, opts) {
      const current = at(ref);
      if (
        current === undefined ||
        current.status !== 'queued' ||
        current.generation !== ref.generation ||
        ms(current.queuedExpiresAt) > ms(opts.nowIso)
      ) {
        return false;
      }
      Object.assign(current, { status: 'failed', message: opts.message, finishedAt: opts.nowIso });
      dropIndexKeys(current);
      writes.push(`markExpiredQueued:${current.generation}`);
      return true;
    },
    async updateJobProgress(ref, progress) {
      const current = live(ref);
      if (current === undefined) return undefined;
      if (progress.poolSize !== undefined) current.poolSize = progress.poolSize;
      if (progress.batchCount !== undefined) current.batchCount = progress.batchCount;
      if (progress.batchDone !== undefined) current.batchesDone = [...current.batchesDone, progress.batchDone];
      if (progress.failedBatch !== undefined) current.failedBatches = [...current.failedBatches, progress.failedBatch];
      if (progress.notScored !== undefined) current.notScored = [...current.notScored, ...progress.notScored];
      if (progress.runIds !== undefined) current.runIds = [...current.runIds, ...progress.runIds];
      writes.push(`updateJobProgress:${JSON.stringify(progress)}`);
      return clone(current);
    },
    async finishJob(ref, outcome) {
      const current = live(ref);
      if (current === undefined) return undefined;
      current.status = outcome.status;
      current.finishedAt = outcome.finishedAt;
      if (outcome.message !== undefined) current.message = outcome.message;
      dropIndexKeys(current);
      writes.push(`finishJob:${outcome.status}`);
      return clone(current);
    },
    async putRun(input) {
      const record = withRankingRunSizeGuard({ ...input, itemId: rankingRunItemId(input.runId), kind: 'ranking' });
      runs.set(record.runId, clone(record));
      writes.push(`putRun:${record.runId}`);
      return clone(record);
    },
    async markMatchesWritten(runId, written) {
      const run = runs.get(runId);
      if (run === undefined) return false;
      run.matchesWritten = written;
      writes.push(`markMatchesWritten:${runId}:${written.count}`);
      return true;
    },
    async getRun(runId) {
      const run = runs.get(runId);
      return run === undefined ? undefined : clone(run);
    },
    async getOpenCandidateFlags(unitId) {
      return [...flags.values()].filter((f) => f.unitId === unitId).map(clone);
    },
    async putFlagIfAbsentOrClosed(input) {
      const itemId = unlawfulFlagItemId(input.unitId, input.field);
      const current = flags.get(itemId);
      if (current !== undefined && current.textHash === input.textHash) return false;
      flags.set(itemId, { ...input, itemId, entityKey: unlawfulFlagEntityKey(input.unitId), sortKey: input.field });
      writes.push(`putFlag:${itemId}:${input.runId}`);
      return true;
    },
  };
  return fake;
}

export interface MatchesFake {
  repo: Pick<MatchesRepo, 'putMatches' | 'getPairs'>;
  rows: Map<string, MatchRow>;
  /** Make every putMatches THROW (S2: only a programming error does; S5 still must not throw). */
  failPuts: boolean;
  /** PR37: these pairs (matchPairKey) stay unwritten and are reported in `unwritten`; the rest land. */
  failPairs: Set<string>;
  /** Make every getPairs throw (an unprocessed key under requireComplete). */
  failGets: boolean;
  /** Each putMatches call's LANDED rows, in order. */
  puts: MatchRow[][];
}

export function createMatchesFake(seed: MatchRow[] = []): MatchesFake {
  const rows = new Map<string, MatchRow>(seed.map((row) => [matchPairKey(row.tenantId, row.unitId), clone(row)]));
  const fake = { rows, failPuts: false, failPairs: new Set<string>(), failGets: false, puts: [] } as unknown as MatchesFake;
  fake.repo = {
    async putMatches(batch) {
      if (fake.failPuts) throw new Error('matchesRepo.putMatches writes schema 2 rows only');
      // S2 PR37 shape: never throws on a DynamoDB failure; reports what did not land.
      const unwritten: MatchPairKey[] = batch
        .filter((row) => fake.failPairs.has(matchPairKey(row.tenantId, row.unitId)))
        .map((row) => ({ tenantId: row.tenantId, unitId: row.unitId }));
      const landed = batch.filter((row) => !fake.failPairs.has(matchPairKey(row.tenantId, row.unitId)));
      fake.puts.push(clone(landed));
      for (const row of landed) rows.set(matchPairKey(row.tenantId, row.unitId), clone(row));
      return { written: landed.length, unwritten };
    },
    async getPairs(keys) {
      if (fake.failGets) throw new Error('matches batch read incomplete');
      const out = new Map<string, MatchRow>();
      for (const key of keys) {
        const row = rows.get(matchPairKey(key.tenantId, key.unitId));
        if (row !== undefined && row.schema === 2) out.set(matchPairKey(key.tenantId, key.unitId), clone(row));
      }
      return out;
    },
  };
  return fake;
}
