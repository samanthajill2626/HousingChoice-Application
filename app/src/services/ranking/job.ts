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
import type { buildRankingPrompt, RankingPrompt } from './prompt.js';
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
