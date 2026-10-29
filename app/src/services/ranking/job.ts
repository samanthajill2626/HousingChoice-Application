// The ranking job (WP1 B2a spec D7; charter 10.2): the press's claim, the
// ranking poll (runDueRankings) with its queue expiry, lease, renewal and
// one takeover, and the run of one anchor (rankAnchor). Ranking runs on its
// OWN worker poll over job records in the AI runs table, never on the SQS
// jobs queue: that consumer awaits a whole receive batch, so a
// one-to-two-minute ranking there would hold up group-text fan-out and sends
// (charter 10.2, the extraction precedent).
//
// One record per anchor, `rjob#<anchorKind>#<anchorId>` (rankingRunsRepo.ts).
// Every state change is a CONDITIONAL write on the record's status and
// generation (S2's primitives). Poll ticks overlap (jobs/pollLoop.ts never
// awaits a tick), so those conditions - and the in-process job slots below -
// are the only things that keep one anchor from running twice.
//
// The messages here are staff-facing page text (the Rankings page shows
// them), not automated messages to a tenant or landlord, so they are not in
// the message catalog. PII: log ids and counts only - never a name, a card,
// a reason or a score.
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../lib/config.js';
import { runWithContext, type CorrelationContext } from '../../lib/context.js';
import type { EventBus } from '../../lib/events.js';
import type { Logger } from '../../lib/logger.js';
import { rankingExpiresAt, type MatchesRepo } from '../../repos/matchesRepo.js';
import type {
  RankingFailedBatch,
  RankingJobClaim,
  RankingJobRecord,
  RankingJobStatus,
  RankingNotScored,
  RankingRunsRepo,
} from '../../repos/rankingRunsRepo.js';
import type { AssembleResult, AssembledCandidate, VerifiedCandidate } from './assemble.js';
import type { RankingDriver } from './driverTypes.js';
import { mapWithConcurrency } from './pool.js';
import type { buildRankingPrompt, RankingPrompt } from './prompt.js';
import { emitRankingEvent, runBatch, type BatchContext, type BatchOutcome } from './runBatch.js';
import type { AnchorKind, AnchorRef } from './types.js';

export const MSG_RUNNING = 'A ranking is running for this record. Try again when it finishes.';
export const MSG_NOT_PICKED_UP = 'The ranking was not picked up. Press Rank again.';
export const MSG_STOPPED = 'The ranking stopped before it finished. Press Rank again.';
export const MSG_ERROR = 'The ranking could not finish. Press Rank again.';

function noun(count: number, kind: AnchorKind): string {
  return kind === 'unit' ? (count === 1 ? 'tenant' : 'tenants') : count === 1 ? 'property' : 'properties';
}

/** D2.3: "2 tenants could not be read and were not scored. Press Rank again." */
export function unreadableMessage(count: number, kind: AnchorKind): string {
  return `${count} ${noun(count, kind)} could not be read and ${count === 1 ? 'was' : 'were'} not scored. Press Rank again.`;
}

/** PR13: candidates the model did not return. */
export function omittedMessage(count: number, kind: AnchorKind): string {
  return `${count} ${noun(count, kind)} ${count === 1 ? 'was' : 'were'} not scored by the model. Press Rank again.`;
}

/** PR42: candidates a failed model call (or an unbuildable prompt, or an errored batch) left unscored. */
export function unscoredMessage(count: number, kind: AnchorKind): string {
  return `${count} ${noun(count, kind)} could not be scored. Press Rank again.`;
}

/** PR42: candidates whose score was not confirmed saved (a run or match write, 'repo'). */
export function unsavedMessage(count: number): string {
  return `${count} ${count === 1 ? 'score' : 'scores'} could not be saved. Press Rank again.`;
}

/** Narrows S3's candidate union (IR6). */
export function isVerified(candidate: AssembledCandidate): candidate is VerifiedCandidate {
  return !candidate.unverified;
}

/**
 * The in-process job limit (RANKING_MAX_CONCURRENT_JOBS). ONE per process:
 * ticks overlap, so the poll RESERVES a slot before its conditional claim and
 * releases it when the claim loses or the job ends. A release is idempotent.
 */
export interface RankingSlots {
  tryAcquire(): (() => void) | undefined;
  inUse(): number;
}

export function createRankingSlots(max: number): RankingSlots {
  let inUse = 0;
  return {
    tryAcquire() {
      if (inUse >= max) return undefined;
      inUse += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inUse -= 1;
      };
    },
    inUse: () => inUse,
  };
}

/** Lease-renewal timer seam (tests capture the callback). */
export interface LeaseTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RankingJobDeps {
  jobs: Pick<
    RankingRunsRepo,
    | 'getJob'
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
    | 'getOpenCandidateFlags'
    | 'putFlagIfAbsentOrClosed'
  >;
  matches: Pick<MatchesRepo, 'putMatches'>;
  driver: RankingDriver;
  /** assembleRanking bound to its deps (jobWiring.ts); a stub in the job's tests. */
  assemble(anchor: AnchorRef, opts: { includeOlder: boolean; now: Date }): Promise<AssembleResult>;
  /** Test seam (IR14); prompt.ts's buildRankingPrompt otherwise. */
  buildPrompt?: (input: Parameters<typeof buildRankingPrompt>[0]) => RankingPrompt;
  events: Pick<EventBus, 'emit'>;
  /** ONE per process. */
  slots: RankingSlots;
  config: Pick<
    AppConfig,
    | 'rankingBatchSize'
    | 'rankingBatchConcurrency'
    | 'rankingLeaseMs'
    | 'rankingPairTtlDays'
    | 'rankingLandlordCard'
    | 'aiPriceTable'
    | 'appEnv'
  >;
  logger: Logger;
  /** Real wall clock, ISO; injected so tests pin it. */
  now(): string;
  /** Run ids and takeover generations; randomUUID otherwise. */
  newId?(): string;
  /** An unref'd setInterval otherwise. */
  timers?: LeaseTimers;
  /** R2B5: the guard's retry pause; a setTimeout promise otherwise. */
  sleep?(ms: number): Promise<void>;
}

// --- the claim (POST .../rank) -------------------------------------------

export interface RankingPress {
  includeOlder: boolean;
  requestedBy: string;
  requestId: string;
  traceparent?: string;
}

export type ClaimResult =
  | { status: 202; job: RankingJobRecord; joined: boolean }
  | { status: 409; error: 'ranking_running' }
  | { status: 404 };

export interface ClaimDeps {
  jobs: Pick<RankingRunsRepo, 'getJob' | 'putJobClaim'>;
  /** S3's one anchor-exists rule (PR21), bound to the repos by the route. */
  anchorExists(anchor: AnchorRef): Promise<boolean>;
  config: Pick<AppConfig, 'rankingQueueExpiryMs' | 'rankingPairTtlDays'>;
  now(): string;
  newGeneration?(): string;
}

/** A record a new press may overwrite: finished, or queued past its expiry. */
function isClaimable(record: RankingJobRecord, nowIso: string): boolean {
  return (
    record.status === 'done' ||
    record.status === 'failed' ||
    (record.status === 'queued' && Date.parse(record.queuedExpiresAt) <= Date.parse(nowIso))
  );
}

function claimOf(anchor: AnchorRef, press: RankingPress, nowIso: string, deps: ClaimDeps): RankingJobClaim {
  return {
    anchorKind: anchor.kind,
    anchorId: anchor.id,
    generation: (deps.newGeneration ?? randomUUID)(),
    includeOlder: press.includeOlder,
    requestedBy: press.requestedBy,
    requestedAt: nowIso,
    requestId: press.requestId,
    ...(press.traceparent !== undefined && { traceparent: press.traceparent }),
    queuedExpiresAt: new Date(Date.parse(nowIso) + deps.config.rankingQueueExpiryMs).toISOString(),
    // The job record outlives every match its lists flag (charter 10.2).
    expiresAt: rankingExpiresAt(nowIso, deps.config.rankingPairTtlDays),
  };
}

/**
 * D7's claim: ONE conditional put (S2 putJobClaim) that wins on no record, a
 * done or failed record, or a queued record past its expiry. A press that
 * loses reads the record (consistent): finished in between -> retry the claim
 * ONCE; live with the same window -> JOIN it (202, joined); live with another
 * window -> 409. A tenant anchor ignores the window (claimed false), so it
 * always joins.
 */
export async function claimRanking(anchor: AnchorRef, press: RankingPress, deps: ClaimDeps): Promise<ClaimResult> {
  if (!(await deps.anchorExists(anchor))) return { status: 404 };
  const effective: RankingPress = { ...press, includeOlder: anchor.kind === 'unit' ? press.includeOlder : false };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const won = await deps.jobs.putJobClaim(claimOf(anchor, effective, deps.now(), deps));
    if (won.ok) return { status: 202, job: won.job, joined: false };
    const current = await deps.jobs.getJob(anchor.kind, anchor.id, { consistent: true });
    if (current === undefined || isClaimable(current, deps.now())) continue;
    if (current.includeOlder === effective.includeOlder) return { status: 202, job: current, joined: true };
    return { status: 409, error: 'ranking_running' };
  }
  return { status: 409, error: 'ranking_running' };
}

// --- the job view (GET .../job and the read's job block) -----------------

export type RankingJobViewStatus = RankingJobStatus | 'expired';

export interface RankingJobView {
  status: RankingJobViewStatus;
  generation: string;
  includeOlder: boolean;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  poolSize?: number;
  batchCount: number;
  batchesDone: number[];
  failedBatches: RankingFailedBatch[];
  /** PR13: candidates with no new match outside a failed call. */
  notScored: RankingNotScored[];
  message?: string;
}

/**
 * The record as the page reads it. `expired` is DERIVED for an unclaimed
 * queued record past queuedExpiresAt (D7, D9): between the expiry and the
 * poll's mark-failed step the page reads the same message and stops polling,
 * and a press reclaims the record.
 */
export function jobView(record: RankingJobRecord, nowIso: string): RankingJobView {
  const expired = record.status === 'queued' && Date.parse(record.queuedExpiresAt) <= Date.parse(nowIso);
  const message = expired ? MSG_NOT_PICKED_UP : record.message;
  return {
    status: expired ? 'expired' : record.status,
    generation: record.generation,
    includeOlder: record.includeOlder,
    requestedAt: record.requestedAt,
    ...(record.startedAt !== undefined && { startedAt: record.startedAt }),
    ...(record.finishedAt !== undefined && { finishedAt: record.finishedAt }),
    ...(record.poolSize !== undefined && { poolSize: record.poolSize }),
    batchCount: record.batchCount ?? 0,
    batchesDone: record.batchesDone ?? [],
    failedBatches: record.failedBatches ?? [],
    notScored: record.notScored ?? [],
    ...(message !== undefined && { message }),
  };
}

// --- the run of one anchor ------------------------------------------------

/** PR38: the tenant anchor's own card could not be read (the job is done, nothing scored). */
export const MSG_TENANT_UNREADABLE = "Could not read this tenant's record. Press Rank again.";
/** PR43: the property anchor's own reads failed after its pool (the job is done, nothing scored). */
export const MSG_PROPERTY_UNREADABLE = "Could not read this property's record. Press Rank again.";
/** R2B5: the pause before the guard's one retry. */
export const GUARD_RETRY_MS = 500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

const DEFAULT_TIMERS: LeaseTimers = {
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function finishJob(
  job: RankingJobRecord,
  deps: RankingJobDeps,
  status: 'done' | 'failed',
  message: string | undefined,
): Promise<void> {
  const updated = await deps.jobs.finishJob(job, {
    status,
    finishedAt: deps.now(),
    ...(message !== undefined && { message }),
  });
  if (updated === undefined) return;
  emitRankingEvent(deps, updated);
  deps.logger.info(
    { anchorKind: job.anchorKind, anchorId: job.anchorId, generation: job.generation, status },
    `ranking job ${status}`,
  );
}

async function runBatchSafely(
  batch: VerifiedCandidate[],
  index: number,
  ctx: BatchContext,
  deps: RankingJobDeps,
): Promise<BatchOutcome> {
  try {
    return await runBatch(batch, index, ctx, deps);
  } catch (err) {
    const { job } = ctx;
    deps.logger.error({ anchorKind: job.anchorKind, anchorId: job.anchorId, batchIndex: index, err }, 'ranking batch errored');
    try {
      if (!(await ctx.guard())) return { kind: 'stopped' };
      const updated = await deps.jobs.updateJobProgress(job, {
        failedBatch: { index, candidateIds: batch.map((candidate) => candidate.candidateId), failure: 'error' },
      });
      if (updated !== undefined) emitRankingEvent(deps, updated);
    } catch (progressErr) {
      deps.logger.error(
        { anchorKind: job.anchorKind, anchorId: job.anchorId, batchIndex: index, err: progressErr },
        'ranking batch failure could not be recorded',
      );
    }
    return { kind: 'failed', failure: 'error', unscored: batch.length, omitted: 0, written: 0 };
  }
}

async function runJob(
  job: RankingJobRecord,
  deps: RankingJobDeps,
  guard: () => Promise<boolean>,
  isStopped: () => boolean,
): Promise<void> {
  const where = { anchorKind: job.anchorKind, anchorId: job.anchorId, generation: job.generation };
  const result = await deps.assemble(
    { kind: job.anchorKind, id: job.anchorId },
    { includeOlder: job.includeOlder, now: new Date(deps.now()) },
  );
  if (!result.ok) {
    if (result.reason === 'anchor_unreadable' && result.candidateIds !== undefined) {
      // PR38 (spec D2.3) / PR43: the anchor's own card could not be read
      // after its pool was computed, so no candidate is scored - the job is
      // DONE with every pool candidate listed not scored ("not scored -
      // retry" rows on the read) and the anchor kind's message.
      const ids = result.candidateIds;
      deps.logger.warn({ ...where, poolSize: ids.length }, 'ranking job: the anchor could not be read');
      if (!(await guard())) return;
      const listed = await deps.jobs.updateJobProgress(job, {
        poolSize: ids.length,
        batchCount: 0,
        ...(ids.length > 0 && {
          notScored: ids.map((candidateId) => ({ candidateId, reason: 'unreadable' as const })),
        }),
      });
      if (listed === undefined) return;
      emitRankingEvent(deps, listed);
      // R2B5: no guard read before the finish - S2 conditions it on the generation.
      await finishJob(job, deps, 'done', job.anchorKind === 'tenant' ? MSG_TENANT_UNREADABLE : MSG_PROPERTY_UNREADABLE);
      return;
    }
    deps.logger.warn(
      { ...where, reason: result.reason, ...('size' in result && result.size !== undefined && { size: result.size }) },
      'ranking job could not build its pool',
    );
    if (await guard()) await finishJob(job, deps, 'failed', result.message);
    return;
  }

  // D2.3 / PR13: a candidate whose card needed an incomplete read is left out
  // of the call and listed in notScored ("not scored - retry").
  const unreadable = result.candidates.filter((candidate) => candidate.unverified);
  const readable = result.candidates.filter(isVerified);
  const batches = chunk(readable, Math.max(1, deps.config.rankingBatchSize));

  if (!(await guard())) return;
  const started = await deps.jobs.updateJobProgress(job, {
    poolSize: result.candidates.length,
    batchCount: batches.length,
    ...(unreadable.length > 0 && {
      notScored: unreadable.map((candidate) => ({ candidateId: candidate.candidateId, reason: 'unreadable' as const })),
    }),
  });
  if (started === undefined) return;
  emitRankingEvent(deps, started);
  deps.logger.info(
    { ...where, poolSize: result.candidates.length, batchCount: batches.length, unreadable: unreadable.length },
    'ranking job pool built',
  );

  const ctx: BatchContext = {
    job,
    anchor: result.anchor,
    direction: result.direction,
    homes: result.homes,
    raised: new Map(),
    storedFlags: new Map(),
    guard,
  };
  const outcomes = await mapWithConcurrency(batches, Math.max(1, deps.config.rankingBatchConcurrency), (batch, index) =>
    runBatchSafely(batch, index, ctx, deps),
  );
  if (isStopped() || outcomes.some((outcome) => outcome.kind === 'stopped')) return;

  // PR42: the message counts CANDIDATES (failedBatches + notScored), never batches.
  let omitted = 0;
  let unscored = 0;
  let unsaved = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === 'scored') omitted += outcome.omitted;
    if (outcome.kind === 'failed') {
      omitted += outcome.omitted;
      if (outcome.failure === 'repo') unsaved += outcome.unscored;
      else unscored += outcome.unscored;
    }
  }
  const messages: string[] = [];
  if (unreadable.length > 0) messages.push(unreadableMessage(unreadable.length, job.anchorKind));
  if (omitted > 0) messages.push(omittedMessage(omitted, job.anchorKind));
  if (unscored > 0) messages.push(unscoredMessage(unscored, job.anchorKind));
  if (unsaved > 0) messages.push(unsavedMessage(unsaved));
  // R2B5: NO guard read here. finishJob is conditioned on running AND this
  // generation (S2), so a superseded job's finish is refused, and a guard
  // read that fails now can never turn a fully scored job into failed.
  await finishJob(job, deps, 'done', messages.length > 0 ? messages.join(' ') : undefined);
}

/**
 * Run one claimed job to its end (D7). NEVER throws: a model, batch, pool or
 * organization-list failure is recorded on the record and the job finishes.
 * Before every model call and every write it re-reads the record
 * (consistent) and exits quietly once the generation is not its own; a lease
 * renewal every RANKING_LEASE_MS / 3 extends the lease on that generation, and
 * a refused or failed renewal stops the job the same way.
 *
 * `rankAnchor(job, deps)` is the one entry point, so a later scheduled caller
 * is configuration, not a redesign (charter 10.2).
 */
export async function rankAnchor(job: RankingJobRecord, deps: RankingJobDeps): Promise<void> {
  const log = deps.logger;
  const where = { anchorKind: job.anchorKind, anchorId: job.anchorId, generation: job.generation };
  let stopped = false;

  const readJob = () => deps.jobs.getJob(job.anchorKind, job.anchorId, { consistent: true });
  const guard = async (): Promise<boolean> => {
    if (stopped) return false;
    let current: RankingJobRecord | undefined;
    try {
      current = await readJob();
    } catch (first) {
      // PR36 / R2B5: a transient read error (throttling, usually) is retried once, after a pause.
      log.warn({ ...where, err: first }, 'ranking job generation check failed - retrying once');
      try {
        await (deps.sleep ?? defaultSleep)(GUARD_RETRY_MS);
        current = await readJob();
      } catch (err) {
        if (stopped) return false;
        stopped = true;
        // PR36: still failing - finish the job failed by S2's generation-
        // conditioned write (a newer generation is never touched); the slot
        // is released by startClaimedJob's finally.
        log.error({ ...where, err }, 'ranking job generation check failed twice - failing the job');
        try {
          await finishJob(job, deps, 'failed', MSG_ERROR);
        } catch (finishErr) {
          log.error({ ...where, err: finishErr }, 'ranking job failure could not be recorded');
        }
        return false;
      }
    }
    if (stopped) return false;
    if (current === undefined || current.generation !== job.generation || current.status !== 'running') {
      stopped = true;
      log.info(where, 'ranking job superseded - exiting quietly');
    }
    return !stopped;
  };

  const leaseMs = deps.config.rankingLeaseMs;
  const renew = async (): Promise<void> => {
    if (stopped) return;
    try {
      const leaseExpiresAt = new Date(Date.parse(deps.now()) + leaseMs).toISOString();
      if (!(await deps.jobs.renewLease(job, leaseExpiresAt))) {
        stopped = true;
        log.warn(where, 'ranking job lease renewal refused - stopping');
      }
    } catch (err) {
      stopped = true;
      log.error({ ...where, err }, 'ranking job lease renewal failed - stopping');
    }
  };
  const timers = deps.timers ?? DEFAULT_TIMERS;
  const handle = timers.setInterval(() => {
    void renew();
  }, Math.max(1, Math.floor(leaseMs / 3)));

  try {
    log.info({ ...where, attempts: job.attempts }, 'ranking job started');
    await runJob(job, deps, guard, () => stopped);
  } catch (err) {
    log.error({ ...where, err }, 'ranking job failed unexpectedly');
    try {
      if (await guard()) await finishJob(job, deps, 'failed', MSG_ERROR);
    } catch (finishErr) {
      log.error({ ...where, err: finishErr }, 'ranking job failure could not be recorded');
    }
  } finally {
    timers.clearInterval(handle);
  }
}

// --- the ranking poll ------------------------------------------------------

/** Records read per index family per tick. */
export const RANKING_POLL_LIST_LIMIT = 25;

export interface RankingPollSummary {
  expired: number;
  claimed: number;
  tookOver: number;
  failedStale: number;
}

/**
 * Start one claimed job in a FRESH context (D7): not nested in the tick's -
 * runWithContext replaces the store - so the job's lines carry no pollRunId
 * and no jobRunId, and the logger's correlation id
 * (`jobRunId ?? pollRunId ?? requestId ?? bootId`, lib/logger.ts) is the
 * press's requestId. The traceparent is restored the way dispatchJob restores
 * an envelope's (jobs/jobs.ts); whether OTel spans parent on it is that path's
 * behavior, not a B2a claim. The slot is released when the job ends.
 */
function startClaimedJob(record: RankingJobRecord, release: () => void, deps: RankingJobDeps): Promise<void> {
  const ctx: CorrelationContext = {
    requestId: record.requestId,
    ...(record.traceparent !== undefined && { traceparent: record.traceparent }),
  };
  return runWithContext(ctx, () => rankAnchor(record, deps)).finally(release);
}

/**
 * ONE ranking poll pass (worker.ts's poll every tick; POST /__dev/ranking/tick
 * on the hermetic lane). Resolves when every job it claimed has finished.
 *
 * 1. Every listed queued record past its expiry is marked failed ("The
 *    ranking was not picked up") by S2's markExpiredQueued, conditioned on
 *    status, the listed generation and the expiry, so it can never fail a
 *    record another tick has just claimed.
 * 2. Queued records, oldest first, are claimed while a slot is free: the slot
 *    is RESERVED before the conditional claim and released when the claim
 *    loses, so overlapping ticks cannot exceed RANKING_MAX_CONCURRENT_JOBS.
 * 3. Running records past their lease: attempts < 1 is taken over (a new
 *    generation, attempts + 1, run from the start - enough to cover a
 *    redeploy); otherwise S2's markLeaseFailed fails it with "The ranking
 *    stopped before it finished". A new press clears either.
 */
export async function runDueRankings(nowIso: string, deps: RankingJobDeps): Promise<RankingPollSummary> {
  const log = deps.logger;
  const summary: RankingPollSummary = { expired: 0, claimed: 0, tookOver: 0, failedStale: 0 };
  const nowMs = Date.parse(nowIso);
  const leaseExpiresAt = new Date(nowMs + deps.config.rankingLeaseMs).toISOString();
  const started: Promise<void>[] = [];

  const queued = await deps.jobs.listQueued(RANKING_POLL_LIST_LIMIT);
  const due: RankingJobRecord[] = [];
  for (const record of queued) {
    if (Date.parse(record.queuedExpiresAt) > nowMs) {
      due.push(record);
      continue;
    }
    try {
      if (await deps.jobs.markExpiredQueued(record, { nowIso, message: MSG_NOT_PICKED_UP })) {
        summary.expired += 1;
        emitRankingEvent(deps, { ...record, status: 'failed' });
      }
    } catch (err) {
      log.error({ anchorKind: record.anchorKind, anchorId: record.anchorId, err }, 'ranking poll: expiry mark failed');
    }
  }

  for (const record of due) {
    const release = deps.slots.tryAcquire();
    if (release === undefined) break;
    try {
      const claimed = await deps.jobs.claimQueued(record, { nowIso, leaseExpiresAt });
      if (claimed === undefined) {
        release();
        continue;
      }
      summary.claimed += 1;
      started.push(startClaimedJob(claimed, release, deps));
    } catch (err) {
      release();
      log.error({ anchorKind: record.anchorKind, anchorId: record.anchorId, err }, 'ranking poll: claim failed');
    }
  }

  const stale = await deps.jobs.listExpiredLeases(nowIso, RANKING_POLL_LIST_LIMIT);
  for (const record of stale) {
    // Declared outside the try, as in the queued loop, so a takeOver that
    // THROWS returns its slot in the catch: a slot lost there would stay lost
    // for the life of the process (code review R1 A1-1).
    let release: (() => void) | undefined;
    try {
      if (record.attempts >= 1) {
        if (await deps.jobs.markLeaseFailed(record, { nowIso, message: MSG_STOPPED })) {
          summary.failedStale += 1;
          emitRankingEvent(deps, { ...record, status: 'failed' });
        }
        continue;
      }
      release = deps.slots.tryAcquire();
      if (release === undefined) continue;
      const taken = await deps.jobs.takeOver(record, {
        nowIso,
        newGeneration: (deps.newId ?? randomUUID)(),
        leaseExpiresAt,
      });
      if (taken === undefined) {
        release();
        continue;
      }
      summary.tookOver += 1;
      started.push(startClaimedJob(taken, release, deps));
    } catch (err) {
      release?.();
      log.error({ anchorKind: record.anchorKind, anchorId: record.anchorId, err }, 'ranking poll: stale lease step failed');
    }
  }

  if (summary.expired + summary.claimed + summary.tookOver + summary.failedStale > 0) {
    log.info({ ...summary }, 'ranking poll pass');
  }
  await Promise.all(started);
  return summary;
}
