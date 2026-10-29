// WP1 B2a ranking records in the AI runs table (spec D7, D10, D11; plan PR5).
// The ranking families share `ai_runs` with the extraction run log and never
// collide with it (plan WI2):
//   rjob#<anchorKind>#<anchorId>               the ranking job, one per anchor
//   rrun#<runId>                               one ranking run per model call
//   ptr#rankings#<scope>#<startedAt>#<runId>   run pointers (global, per anchor)
//   uflag#<unitId>#<field>                     an unlawful-flag property record
// The extraction readers read run#<id> and the byEntity scopes global /
// outcome# / conversations# / contacts#, so none of these is ever returned
// by GET /api/ai-runs, its detail route or aiRunsRepo.listByEntity (pinned by
// rankingRunsExtractionLogExclusion.integration.test.ts).
//
// REPOSITORY PRIMITIVES only - each conditional write exactly as spec D7
// states it. When to claim, join, take over, renew or finish is
// services/ranking/job.ts. Every TTL is computed by the caller
// (matchesRepo.rankingExpiresAt with RANKING_PAIR_TTL_DAYS); flags carry none.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';
import type { RankingAnchorKind } from './matchesRepo.js';

interface FamilyCtx {
  doc: DynamoDBDocumentClient;
  table: string;
  log: Logger;
}

/** A conditional UpdateItem: the ALL_NEW item, or undefined when the condition failed. */
async function updateOrUndefined<T = Record<string, unknown>>(
  ctx: FamilyCtx,
  input: Omit<UpdateCommandInput, 'TableName' | 'ReturnValues'>,
): Promise<T | undefined> {
  try {
    const { Attributes } = await ctx.doc.send(
      new UpdateCommand({ ...input, TableName: ctx.table, ReturnValues: 'ALL_NEW' }),
    );
    return Attributes as unknown as T | undefined;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return undefined;
    throw err;
  }
}

// --- The job family (spec D7) -------------------------------------------------

export const rankingJobItemId = (anchorKind: RankingAnchorKind, anchorId: string): string =>
  `rjob#${anchorKind}#${anchorId}`;
/** Sparse byEntity partitions: a queued record sorts by requestedAt, a running one by leaseExpiresAt. */
export const RANKING_JOBS_QUEUED_ENTITY = 'rankjobs#queued';
export const RANKING_JOBS_RUNNING_ENTITY = 'rankjobs#running';

export type RankingJobStatus = 'queued' | 'running' | 'done' | 'failed';

/**
 * A batch that left candidates without a new match through a FAILURE (PR42):
 * the model call (`refusal` | `parse` | `truncated` | `timeout` | `driver`),
 * the run write or the match write (`repo`), or an unexpected exception in
 * the batch (`error`). `candidateIds` lists EXACTLY the candidates that got
 * no match: the whole batch for a failed call, run write or exception, only
 * the not-confirmed-written pairs' candidates for a partial match write
 * (PR37). A batch may appear here AND in `batchesDone` (a partial write: its
 * other rows landed).
 */
export interface RankingFailedBatch {
  index: number;
  candidateIds: string[];
  failure: string;
}

/**
 * A candidate left unscored by something OTHER than a failure (PR13): the
 * model did not return it in a call that succeeded (`omitted`), or its reads
 * were incomplete so it was never sent (`unreadable`).
 */
export interface RankingNotScored {
  candidateId: string;
  reason: 'omitted' | 'unreadable';
}

export interface RankingJobRecord {
  itemId: string;
  anchorKind: RankingAnchorKind;
  anchorId: string;
  status: RankingJobStatus;
  generation: string;
  includeOlder: boolean;
  requestedBy: string;
  requestedAt: string;
  /** The press's request id; the job's log lines carry it (spec D7). */
  requestId: string;
  traceparent?: string;
  attempts: number;
  queuedExpiresAt: string;
  leaseExpiresAt?: string;
  poolSize?: number;
  batchCount?: number;
  batchesDone: number[];
  /** Every batch that left candidates unmatched through a failure, with exactly those candidates (PR42). */
  failedBatches: RankingFailedBatch[];
  /** Candidates unscored by something other than a failure: omitted or unreadable (PR13). */
  notScored: RankingNotScored[];
  message?: string;
  runIds: string[];
  startedAt?: string;
  finishedAt?: string;
  expires_at: number;
  /** Present only while queued or running (sparse index keys). */
  entityKey?: string;
  sortKey?: string;
}

/** Which job a write is for: the anchor plus the generation the caller holds. */
export interface RankingJobRef {
  anchorKind: RankingAnchorKind;
  anchorId: string;
  generation: string;
}

export interface RankingJobClaim {
  anchorKind: RankingAnchorKind;
  anchorId: string;
  /** A new uuid per press. */
  generation: string;
  includeOlder: boolean;
  requestedBy: string;
  /** The press time; it is also the "now" the expiry condition compares. */
  requestedAt: string;
  requestId: string;
  traceparent?: string;
  /** requestedAt + RANKING_QUEUE_EXPIRY_MS. */
  queuedExpiresAt: string;
  /** Epoch seconds: rankingExpiresAt(requestedAt, RANKING_PAIR_TTL_DAYS). */
  expiresAt: number;
}

/** One progress write; any subset. The four list fields APPEND (parallel batches). */
export interface RankingJobProgress {
  poolSize?: number;
  batchCount?: number;
  batchDone?: number;
  failedBatch?: RankingFailedBatch;
  notScored?: RankingNotScored[];
  runIds?: string[];
}

export interface RankingJobFamily {
  getJob(
    anchorKind: RankingAnchorKind,
    anchorId: string,
    opts: { consistent: boolean },
  ): Promise<RankingJobRecord | undefined>;
  /**
   * The press's claim (spec D7): ONE conditional put that succeeds when no
   * record exists, or the record is done or failed, or it is queued with
   * queuedExpiresAt <= requestedAt. Writes a fresh queued record (every old
   * field replaced) with the queued index keys.
   */
  putJobClaim(claim: RankingJobClaim): Promise<{ ok: true; job: RankingJobRecord } | { ok: false }>;
  /** Queued records, oldest requestedAt first (byEntity, eventually consistent). */
  listQueued(limit: number): Promise<RankingJobRecord[]>;
  /** Running records whose leaseExpiresAt is before `nowIso`, oldest lease first. */
  listExpiredLeases(nowIso: string, limit: number): Promise<RankingJobRecord[]>;
  /**
   * A poller claims a listed queued record: condition status = queued AND
   * generation = the listed one AND queuedExpiresAt > now; sets running,
   * startedAt, leaseExpiresAt and the running index keys.
   */
  claimQueued(
    ref: RankingJobRef,
    opts: { nowIso: string; leaseExpiresAt: string },
  ): Promise<RankingJobRecord | undefined>;
  /**
   * Takeover of a dead job (spec D7): condition running AND the listed
   * generation AND leaseExpiresAt <= now AND attempts < 1. A NEW generation,
   * attempts + 1, a fresh start and lease; the progress fields reset
   * (poolSize, batchCount, batchesDone, failedBatches, notScored, message) -
   * the job runs again from the start; runIds are kept (those runs happened,
   * IR23).
   */
  takeOver(
    ref: RankingJobRef,
    opts: { nowIso: string; newGeneration: string; leaseExpiresAt: string },
  ): Promise<RankingJobRecord | undefined>;
  /** The second expiry: running, the generation, leaseExpiresAt <= now, attempts >= 1 -> failed. */
  markLeaseFailed(ref: RankingJobRef, opts: { nowIso: string; message: string }): Promise<boolean>;
  /** Lease renewal: running AND the generation; extends leaseExpiresAt and its sort key. */
  renewLease(ref: RankingJobRef, leaseExpiresAt: string): Promise<boolean>;
  /**
   * A tick fails a queued record past its expiry: queued AND the listed
   * generation AND queuedExpiresAt <= now; removes the index keys.
   */
  markExpiredQueued(ref: RankingJobRef, opts: { nowIso: string; message: string }): Promise<boolean>;
  /** A progress write on the running generation (undefined when superseded). */
  updateJobProgress(ref: RankingJobRef, progress: RankingJobProgress): Promise<RankingJobRecord | undefined>;
  /** done or failed, on the running generation; removes the index keys. */
  finishJob(
    ref: RankingJobRef,
    outcome: { status: 'done' | 'failed'; finishedAt: string; message?: string },
  ): Promise<RankingJobRecord | undefined>;
}

function createJobFamily(ctx: FamilyCtx): RankingJobFamily {
  const { doc, table, log } = ctx;
  const keyOf = (ref: { anchorKind: RankingAnchorKind; anchorId: string }) => ({
    itemId: rankingJobItemId(ref.anchorKind, ref.anchorId),
  });

  async function queryPartition(
    entityKey: string,
    opts: { before?: string; limit: number },
  ): Promise<RankingJobRecord[]> {
    const { Items } = await doc.send(
      new QueryCommand({
        TableName: table,
        IndexName: 'byEntity',
        KeyConditionExpression: opts.before === undefined ? '#ek = :ek' : '#ek = :ek AND #sk < :before',
        ExpressionAttributeNames: { '#ek': 'entityKey', ...(opts.before !== undefined && { '#sk': 'sortKey' }) },
        ExpressionAttributeValues: { ':ek': entityKey, ...(opts.before !== undefined && { ':before': opts.before }) },
        ScanIndexForward: true,
        Limit: opts.limit,
      }),
    );
    return (Items ?? []) as RankingJobRecord[];
  }

  return {
    async getJob(anchorKind, anchorId, opts) {
      const { Item } = await doc.send(
        new GetCommand({
          TableName: table,
          Key: keyOf({ anchorKind, anchorId }),
          ...(opts.consistent && { ConsistentRead: true }),
        }),
      );
      return Item as RankingJobRecord | undefined;
    },

    async putJobClaim(claim) {
      const job: RankingJobRecord = {
        itemId: rankingJobItemId(claim.anchorKind, claim.anchorId),
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
        entityKey: RANKING_JOBS_QUEUED_ENTITY,
        sortKey: claim.requestedAt,
        expires_at: claim.expiresAt,
      };
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: job,
            ConditionExpression:
              'attribute_not_exists(#itemId) OR #status IN (:done, :failed) OR (#status = :queued AND #qexp <= :now)',
            ExpressionAttributeNames: { '#itemId': 'itemId', '#status': 'status', '#qexp': 'queuedExpiresAt' },
            ExpressionAttributeValues: {
              ':done': 'done',
              ':failed': 'failed',
              ':queued': 'queued',
              ':now': claim.requestedAt,
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return { ok: false };
        throw err;
      }
      log.debug({ anchorKind: claim.anchorKind, anchorId: claim.anchorId }, 'ranking job queued');
      return { ok: true, job };
    },

    async listQueued(limit) {
      return queryPartition(RANKING_JOBS_QUEUED_ENTITY, { limit });
    },

    async listExpiredLeases(nowIso, limit) {
      return queryPartition(RANKING_JOBS_RUNNING_ENTITY, { before: nowIso, limit });
    },

    async claimQueued(ref, opts) {
      return updateOrUndefined<RankingJobRecord>(ctx, {
        Key: keyOf(ref),
        UpdateExpression: 'SET #status = :running, #startedAt = :now, #lease = :lease, #ek = :ek, #sk = :lease',
        ConditionExpression: '#status = :queued AND #gen = :gen AND #qexp > :now',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#startedAt': 'startedAt',
          '#lease': 'leaseExpiresAt',
          '#ek': 'entityKey',
          '#sk': 'sortKey',
          '#gen': 'generation',
          '#qexp': 'queuedExpiresAt',
        },
        ExpressionAttributeValues: {
          ':running': 'running',
          ':queued': 'queued',
          ':now': opts.nowIso,
          ':lease': opts.leaseExpiresAt,
          ':ek': RANKING_JOBS_RUNNING_ENTITY,
          ':gen': ref.generation,
        },
      });
    },

    async takeOver(ref, opts) {
      return updateOrUndefined<RankingJobRecord>(ctx, {
        Key: keyOf(ref),
        UpdateExpression:
          'SET #gen = :newGen, #attempts = #attempts + :one, #startedAt = :now, #lease = :lease, ' +
          '#sk = :lease, #bd = :empty, #fb = :empty, #ns = :empty REMOVE #poolSize, #batchCount, #message',
        ConditionExpression: '#status = :running AND #gen = :gen AND #lease <= :now AND #attempts < :one',
        ExpressionAttributeNames: {
          '#gen': 'generation',
          '#attempts': 'attempts',
          '#startedAt': 'startedAt',
          '#lease': 'leaseExpiresAt',
          '#sk': 'sortKey',
          '#bd': 'batchesDone',
          '#fb': 'failedBatches',
          '#ns': 'notScored',
          '#poolSize': 'poolSize',
          '#batchCount': 'batchCount',
          '#message': 'message',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':newGen': opts.newGeneration,
          ':one': 1,
          ':now': opts.nowIso,
          ':lease': opts.leaseExpiresAt,
          ':empty': [],
          ':running': 'running',
          ':gen': ref.generation,
        },
      });
    },

    async markLeaseFailed(ref, opts) {
      const updated = await updateOrUndefined(ctx, {
        Key: keyOf(ref),
        UpdateExpression: 'SET #status = :failed, #message = :message, #finishedAt = :now REMOVE #ek, #sk',
        ConditionExpression: '#status = :running AND #gen = :gen AND #lease <= :now AND #attempts >= :one',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#message': 'message',
          '#finishedAt': 'finishedAt',
          '#ek': 'entityKey',
          '#sk': 'sortKey',
          '#gen': 'generation',
          '#lease': 'leaseExpiresAt',
          '#attempts': 'attempts',
        },
        ExpressionAttributeValues: {
          ':failed': 'failed',
          ':message': opts.message,
          ':now': opts.nowIso,
          ':running': 'running',
          ':gen': ref.generation,
          ':one': 1,
        },
      });
      return updated !== undefined;
    },

    async renewLease(ref, leaseExpiresAt) {
      const updated = await updateOrUndefined(ctx, {
        Key: keyOf(ref),
        UpdateExpression: 'SET #lease = :lease, #sk = :lease',
        ConditionExpression: '#status = :running AND #gen = :gen',
        ExpressionAttributeNames: {
          '#lease': 'leaseExpiresAt',
          '#sk': 'sortKey',
          '#status': 'status',
          '#gen': 'generation',
        },
        ExpressionAttributeValues: { ':lease': leaseExpiresAt, ':running': 'running', ':gen': ref.generation },
      });
      return updated !== undefined;
    },

    async markExpiredQueued(ref, opts) {
      const updated = await updateOrUndefined(ctx, {
        Key: keyOf(ref),
        UpdateExpression: 'SET #status = :failed, #message = :message, #finishedAt = :now REMOVE #ek, #sk',
        ConditionExpression: '#status = :queued AND #gen = :gen AND #qexp <= :now',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#message': 'message',
          '#finishedAt': 'finishedAt',
          '#ek': 'entityKey',
          '#sk': 'sortKey',
          '#gen': 'generation',
          '#qexp': 'queuedExpiresAt',
        },
        ExpressionAttributeValues: {
          ':failed': 'failed',
          ':message': opts.message,
          ':now': opts.nowIso,
          ':queued': 'queued',
          ':gen': ref.generation,
        },
      });
      return updated !== undefined;
    },

    async updateJobProgress(ref, progress) {
      const sets: string[] = [];
      const names: Record<string, string> = { '#status': 'status', '#gen': 'generation' };
      const values: Record<string, unknown> = { ':running': 'running', ':gen': ref.generation };
      if (progress.poolSize !== undefined) {
        sets.push('#poolSize = :poolSize');
        names['#poolSize'] = 'poolSize';
        values[':poolSize'] = progress.poolSize;
      }
      if (progress.batchCount !== undefined) {
        sets.push('#batchCount = :batchCount');
        names['#batchCount'] = 'batchCount';
        values[':batchCount'] = progress.batchCount;
      }
      const append = (alias: string, attribute: string, value: unknown[]): void => {
        sets.push(`${alias} = list_append(if_not_exists(${alias}, :empty), :${attribute})`);
        names[alias] = attribute;
        values[`:${attribute}`] = value;
        values[':empty'] = [];
      };
      if (progress.batchDone !== undefined) append('#bd', 'batchesDone', [progress.batchDone]);
      if (progress.failedBatch !== undefined) append('#fb', 'failedBatches', [progress.failedBatch]);
      if (progress.notScored !== undefined && progress.notScored.length > 0) {
        append('#ns', 'notScored', progress.notScored);
      }
      if (progress.runIds !== undefined && progress.runIds.length > 0) append('#runIds', 'runIds', progress.runIds);
      if (sets.length === 0) throw new Error('rankingRunsRepo.updateJobProgress: empty progress');
      return updateOrUndefined<RankingJobRecord>(ctx, {
        Key: keyOf(ref),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: '#status = :running AND #gen = :gen',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      });
    },

    async finishJob(ref, outcome) {
      const finished = await updateOrUndefined<RankingJobRecord>(ctx, {
        Key: keyOf(ref),
        UpdateExpression:
          outcome.message === undefined
            ? 'SET #status = :status, #finishedAt = :at REMOVE #ek, #sk'
            : 'SET #status = :status, #finishedAt = :at, #message = :message REMOVE #ek, #sk',
        ConditionExpression: '#status = :running AND #gen = :gen',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#finishedAt': 'finishedAt',
          '#ek': 'entityKey',
          '#sk': 'sortKey',
          '#gen': 'generation',
          ...(outcome.message !== undefined && { '#message': 'message' }),
        },
        ExpressionAttributeValues: {
          ':status': outcome.status,
          ':at': outcome.finishedAt,
          ':running': 'running',
          ':gen': ref.generation,
          ...(outcome.message !== undefined && { ':message': outcome.message }),
        },
      });
      if (finished !== undefined) {
        log.debug({ anchorKind: ref.anchorKind, anchorId: ref.anchorId, status: outcome.status }, 'ranking job finished');
      }
      return finished;
    },
  };
}

// --- The repository ---

export type RankingRunsRepo = RankingJobFamily;

export function createRankingRunsRepo(deps: RepoDeps = {}): RankingRunsRepo {
  const ctx: FamilyCtx = {
    doc: deps.doc ?? getDocumentClient(),
    table: tableName('ai_runs', deps.env),
    log: deps.logger ?? defaultLogger,
  };
  return { ...createJobFamily(ctx) };
}
