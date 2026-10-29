// One batch of a ranking job (WP1 B2a spec D7, D8, D8.1, D10, D11).
//
// Order, as D7 sets it: the generation check, the prompt and the model call
// (one per batch, with the driver's per-call timeout), then - each behind its
// own generation check - the run (runLog.ts; S2's putRun adds key, kind,
// pointers and the 350 KB guard), the batch's matches (one BatchWrite; rows
// that land stay, PR37; candidates whose rows are not confirmed written fail
// as 'repo' and read as out of date), matchesWritten (a second conditional
// update of the run), the unlawful flags this batch newly raised, and finally
// the progress write (batchesDone; failedBatches for a batch that left
// candidates unmatched through a failure - the call, the run write or the
// match write - listing exactly those candidates, PR42; notScored for the
// candidates the model did not return, PR13) with the ranking.updated event.
//
// The generation check is not atomic with the write after it: a superseded
// job can still write the batch it had in flight, and the newer job rewrites
// every pair (accepted, charter 10.2).
//
// A default or guessed score is never written (charter 7.4): a candidate the
// model did not return, and every candidate of a failed call, gets NO row.
import { randomUUID } from 'node:crypto';
import type { RankingUpdatedEvent } from '../../lib/events.js';
import { encodeSnapshot, matchPairKey, rankingExpiresAt, type MatchRow } from '../../repos/matchesRepo.js';
import type {
  RankingFailedBatch,
  RankingJobProgress,
  RankingJobRecord,
  UnlawfulFlagInput,
  UnlawfulFlagRecord,
} from '../../repos/rankingRunsRepo.js';
import type { AssembledAnchor, AssembledRanking, VerifiedCandidate } from './assemble.js';
import { EXAMPLES_VERSION } from './examples.js';
import { mergeRaisedFlags, openFlagFields } from './flags.js';
import type { RankingJobDeps } from './job.js';
import type { ParsedCandidate } from './parse.js';
import { buildRankingPrompt, RankingPromptError, type RankingPrompt } from './prompt.js';
import { RUBRIC_VERSION } from './rubric.js';
import { buildRankingRun, pairMissing } from './runLog.js';
import type { Direction } from './types.js';

export interface BatchContext {
  /** The job record as this run holds it (its generation is the guard's). */
  job: RankingJobRecord;
  anchor: AssembledAnchor;
  direction: Direction;
  homes: AssembledRanking['homes'];
  /** The job-wide unlawful-flag merge (D10), keyed `${unitId}#${field}`. */
  raised: Map<string, UnlawfulFlagInput>;
  /** Each property's stored flag records, read once per job. */
  storedFlags: Map<string, Promise<UnlawfulFlagRecord[]>>;
  /** The generation check (D7): false once this job is superseded or stopped. */
  guard(): Promise<boolean>;
}

export type BatchOutcome =
  | { kind: 'scored'; omitted: number; written: number }
  /**
   * PR42: `unscored` = the candidates this batch's failedBatches entry lists
   * (no match through a failure); `omitted` = the model left out (notScored);
   * `written` = rows confirmed written.
   */
  | { kind: 'failed'; failure: string; unscored: number; omitted: number; written: number }
  | { kind: 'stopped' };

const STOPPED: BatchOutcome = { kind: 'stopped' };

/** Finished batches - scored or failed - as distinct indexes. */
export function finishedBatchCount(record: Pick<RankingJobRecord, 'batchesDone' | 'failedBatches'>): number {
  const indexes = new Set<number>();
  for (const index of record.batchesDone ?? []) indexes.add(index);
  for (const failed of record.failedBatches ?? []) indexes.add(failed.index);
  return indexes.size;
}

/** D12's payload: ids, the status and two counts - never a score or a name. */
export function toRankingEvent(record: RankingJobRecord): RankingUpdatedEvent {
  return {
    anchorKind: record.anchorKind,
    anchorId: record.anchorId,
    generation: record.generation,
    status: record.status,
    batchesDone: finishedBatchCount(record),
    batchCount: record.batchCount ?? 0,
  };
}

export function emitRankingEvent(deps: Pick<RankingJobDeps, 'events' | 'logger'>, record: RankingJobRecord): void {
  try {
    deps.events.emit('ranking.updated', toRankingEvent(record));
  } catch (err) {
    deps.logger.warn({ err, anchorKind: record.anchorKind, anchorId: record.anchorId }, 'ranking.updated emit failed');
  }
}

function idsOf(candidates: readonly VerifiedCandidate[]): string[] {
  return candidates.map((candidate) => candidate.candidateId);
}

async function progress(ctx: BatchContext, deps: RankingJobDeps, patch: RankingJobProgress): Promise<boolean> {
  if (!(await ctx.guard())) return false;
  const updated = await deps.jobs.updateJobProgress(ctx.job, patch);
  if (updated === undefined) return false;
  emitRankingEvent(deps, updated);
  return true;
}

/** One stored-flags read per property per job; a failed read reads as none (it only informs cappedAtRun). */
function storedFlagsOf(ctx: BatchContext, deps: RankingJobDeps, unitId: string): Promise<UnlawfulFlagRecord[]> {
  let pending = ctx.storedFlags.get(unitId);
  if (pending === undefined) {
    pending = deps.jobs.getOpenCandidateFlags(unitId).catch((err: unknown) => {
      deps.logger.warn({ err, unitId }, "ranking batch: stored flag read failed - cappedAtRun uses this job's flags only");
      return [];
    });
    ctx.storedFlags.set(unitId, pending);
  }
  return pending;
}

function matchRowOf(
  candidate: VerifiedCandidate,
  result: ParsedCandidate,
  m: { ctx: BatchContext; prompt: RankingPrompt; runId: string; model: string; computedAt: string; ttlDays: number },
): MatchRow {
  return {
    tenantId: candidate.tenantId,
    unitId: candidate.unitId,
    schema: 2,
    score: result.score,
    for: result.for,
    against: result.against,
    missing: pairMissing(m.ctx.anchor, candidate, result),
    failedRequirements: result.failedRequirements,
    fairHousingFlags: result.fairHousingFlags,
    stage: 1,
    rubricVersion: RUBRIC_VERSION,
    examplesVersion: EXAMPLES_VERSION,
    promptFingerprint: m.prompt.promptFingerprint,
    model: m.model,
    runId: m.runId,
    jobGeneration: m.ctx.job.generation,
    computedAt: m.computedAt,
    anchorSide: m.ctx.job.anchorKind,
    fingerprints: candidate.fingerprints,
    inputSnapshot: encodeSnapshot(m.prompt.snapshotOf(candidate.candidateId)),
    expires_at: rankingExpiresAt(m.computedAt, m.ttlDays),
  };
}

export async function runBatch(
  batch: VerifiedCandidate[],
  index: number,
  ctx: BatchContext,
  deps: RankingJobDeps,
): Promise<BatchOutcome> {
  const { job } = ctx;
  const log = deps.logger;
  const where = { anchorKind: job.anchorKind, anchorId: job.anchorId, batchIndex: index, candidates: batch.length };

  if (!(await ctx.guard())) return STOPPED;
  let prompt: RankingPrompt;
  try {
    prompt = (deps.buildPrompt ?? buildRankingPrompt)({
      direction: ctx.direction,
      batchIndex: index,
      landlordCard: deps.config.rankingLandlordCard,
      anchor: { card: ctx.anchor.card, missing: ctx.anchor.missing },
      candidates: batch,
      homes: ctx.homes,
    });
  } catch (err) {
    if (!(err instanceof RankingPromptError)) throw err;
    // IR34: no model call was made, so no run; the batch failed as 'driver'.
    log.error({ ...where, err }, 'ranking batch: the prompt could not be built');
    const failedBatch: RankingFailedBatch = { index, candidateIds: idsOf(batch), failure: 'driver' };
    return (await progress(ctx, deps, { failedBatch }))
      ? { kind: 'failed', failure: 'driver', unscored: batch.length, omitted: 0, written: 0 }
      : STOPPED;
  }
  const runId = (deps.newId ?? randomUUID)();
  const startedAt = deps.now();
  const call = await deps.driver.rankBatch(prompt.batchInput);
  const finishedAt = deps.now();

  const byCandidate = new Map<string, ParsedCandidate>();
  if (call.ok) {
    for (const h of prompt.handles) {
      const result = call.output.byHandle.get(h.handle);
      if (result !== undefined) byCandidate.set(h.candidateId, result);
    }
  }
  const scored = batch.filter((candidate) => byCandidate.has(candidate.candidateId));
  const omitted = call.ok ? batch.filter((candidate) => !byCandidate.has(candidate.candidateId)) : [];

  // D10: merge this batch's raises into the job's map FIRST, so cappedAtRun
  // sees the flags open when this run finished, its own included.
  const newlyRaised = mergeRaisedFlags(
    ctx.raised,
    scored.map((candidate) => ({
      unitId: candidate.unitId,
      freeTextByField: candidate.propertyFacts.freeTextByField,
      result: byCandidate.get(candidate.candidateId) as ParsedCandidate,
    })),
    { runId, raisedAt: finishedAt },
  );
  const openByUnit = new Map<string, string[]>();
  for (const candidate of scored) {
    if (openByUnit.has(candidate.unitId)) continue;
    const stored = await storedFlagsOf(ctx, deps, candidate.unitId);
    const fields = new Set(openFlagFields(stored, candidate.propertyFacts.freeTextByField));
    for (const flag of ctx.raised.values()) if (flag.unitId === candidate.unitId) fields.add(flag.field);
    openByUnit.set(candidate.unitId, [...fields]);
  }

  const run = buildRankingRun({
    runId,
    job,
    anchor: ctx.anchor,
    direction: ctx.direction,
    batchIndex: index,
    candidates: batch,
    prompt,
    call,
    byCandidate,
    openByUnit,
    startedAt,
    finishedAt,
    config: deps.config,
  });
  if (!(await ctx.guard())) {
    // D7: a job that is no longer this generation (or was stopped) writes
    // nothing more - its run included. But the call is paid for, and the
    // cost totals read runs only, so the usage and cost go to this WARN line
    // with the fields of the putRun-failure line below: the spend is never
    // invisible (PR36; code review R1 A1-2).
    log.warn(
      {
        ...where,
        runId,
        model: run.model,
        usage: run.usage,
        costUsd: run.costUsd,
        ...(!call.ok && { callFailure: call.failure }),
      },
      'ranking run not written - the job stopped after the call; usage and cost logged here',
    );
    return STOPPED;
  }
  try {
    await deps.jobs.putRun(run);
  } catch (err) {
    // PR36: the call is paid for; a lost run must never hide the spend.
    // R2B7: a FAILED call keeps its own failure kind; 'repo' only when it succeeded.
    const failure = call.ok ? 'repo' : call.failure;
    log.error(
      {
        ...where,
        err,
        runId,
        model: run.model,
        usage: run.usage,
        costUsd: run.costUsd,
        ...(!call.ok && { callFailure: call.failure }),
      },
      'ranking run write failed - usage and cost logged here',
    );
    // WL-S5-2: this batch writes no flag, so drop the flags it newly raised from
    // the job's merge (by the key mergeRaisedFlags uses): a later batch raising
    // the same property and field then writes it, and no later cappedAtRun
    // counts a flag no record holds. A putFlagIfAbsentOrClosed that THROWS
    // (below) keeps its entry and is only logged.
    for (const flag of newlyRaised) ctx.raised.delete(`${flag.unitId}#${flag.field}`);
    const failedBatch: RankingFailedBatch = { index, candidateIds: idsOf(batch), failure };
    return (await progress(ctx, deps, { failedBatch }))
      ? { kind: 'failed', failure, unscored: batch.length, omitted: 0, written: 0 }
      : STOPPED;
  }

  if (!call.ok) {
    log.warn({ ...where, runId, failure: call.failure }, 'ranking batch failed');
    const failedBatch: RankingFailedBatch = { index, candidateIds: idsOf(batch), failure: call.failure };
    return (await progress(ctx, deps, { failedBatch, runIds: [runId] }))
      ? { kind: 'failed', failure: call.failure, unscored: batch.length, omitted: 0, written: 0 }
      : STOPPED;
  }

  const rows = scored.map((candidate) =>
    matchRowOf(candidate, byCandidate.get(candidate.candidateId) as ParsedCandidate, {
      ctx,
      prompt,
      runId,
      model: call.meta.model,
      computedAt: finishedAt,
      ttlDays: deps.config.rankingPairTtlDays,
    }),
  );
  // PR37: the candidates whose match is not confirmed written (R2F5; none when every row landed).
  let unwrittenIds: string[] = [];
  let written = 0;
  if (rows.length > 0) {
    if (!(await ctx.guard())) return STOPPED;
    try {
      const result = await deps.matches.putMatches(rows);
      written = result.written;
      const unwrittenPairs = new Set(result.unwritten.map((key) => matchPairKey(key.tenantId, key.unitId)));
      unwrittenIds = scored
        .filter((candidate, i) => unwrittenPairs.has(matchPairKey(rows[i]!.tenantId, rows[i]!.unitId)))
        .map((candidate) => candidate.candidateId);
      if (unwrittenIds.length > 0) {
        log.error({ ...where, runId, written, unwritten: unwrittenIds.length }, 'ranking batch match write: rows not confirmed written');
      }
    } catch (err) {
      // S2: putMatches throws only on a programming error. Caught so the job never throws.
      unwrittenIds = idsOf(scored);
      log.error({ ...where, runId, err, rows: rows.length }, 'ranking batch match write threw');
    }
    if (written > 0) {
      // BA6: markMatchesWritten is a write, so it has its own generation check.
      if (!(await ctx.guard())) return STOPPED;
      try {
        const marked = await deps.jobs.markMatchesWritten(runId, { count: written, at: deps.now() });
        if (!marked) log.warn({ ...where, runId }, 'ranking run matchesWritten update found no run');
      } catch (err) {
        log.warn({ ...where, runId, err }, 'ranking run matchesWritten update failed');
      }
    }
  }

  for (const flag of newlyRaised) {
    if (!(await ctx.guard())) return STOPPED;
    try {
      await deps.jobs.putFlagIfAbsentOrClosed(flag);
    } catch (err) {
      // Logged only: the flag keeps its ctx.raised entry, so this job's later
      // batches do not raise it again (WL-S5-2); a later press can.
      log.error({ ...where, runId, err, unitId: flag.unitId, field: flag.field }, 'ranking unlawful flag write failed');
    }
  }

  if (omitted.length > 0) log.warn({ ...where, runId, omitted: omitted.length }, 'ranking batch: candidates not returned');
  const notScored =
    omitted.length > 0
      ? { notScored: omitted.map((candidate) => ({ candidateId: candidate.candidateId, reason: 'omitted' as const })) }
      : {};
  if (unwrittenIds.length > 0) {
    // PR37 / PR42: only the not-confirmed-written candidates are the batch's failure; the landed rows stay.
    // A batch whose call succeeded and some of whose rows landed is ALSO in
    // batchesDone (its index then appears in both lists; finishedBatchCount
    // de-dups indexes). A batch with no row written is in failedBatches only.
    const failedBatch: RankingFailedBatch = { index, candidateIds: unwrittenIds, failure: 'repo' };
    return (await progress(ctx, deps, { ...(written > 0 && { batchDone: index }), failedBatch, runIds: [runId], ...notScored }))
      ? { kind: 'failed', failure: 'repo', unscored: unwrittenIds.length, omitted: omitted.length, written }
      : STOPPED;
  }
  const patch: RankingJobProgress = { batchDone: index, runIds: [runId], ...notScored };
  return (await progress(ctx, deps, patch)) ? { kind: 'scored', omitted: omitted.length, written: rows.length } : STOPPED;
}
