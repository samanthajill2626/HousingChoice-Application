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
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';
import type { MatchFairHousingFlag, MatchMissing, MatchReason, RankingAnchorKind } from './matchesRepo.js';

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

// --- The run and pointer family (spec D11) ---------------------------------------

export const rankingRunItemId = (runId: string): string => `rrun#${runId}`;
const runIdOfRankingItemId = (itemId: string): string => itemId.slice('rrun#'.length);
export const RANKING_RUNS_GLOBAL_ENTITY = 'rankings#global';
/** The run listing's pointer partition: global, or one anchor's. */
export function rankingRunEntityKey(anchor?: { kind: RankingAnchorKind; id: string }): string {
  return anchor === undefined ? RANKING_RUNS_GLOBAL_ENTITY : `rankings#${anchor.kind}#${anchor.id}`;
}
export function rankingRunSortKey(startedAt: string, runId: string): string {
  return `${startedAt}#${runId}`;
}
export const rankingPointerItemId = (entityKey: string, startedAt: string, runId: string): string =>
  `ptr#${entityKey}#${rankingRunSortKey(startedAt, runId)}`;

/** A run item over this size drops its inputGzip (spec D11's 350 KB guard; DynamoDB caps an item at 400 KB). */
export const RANKING_RUN_ITEM_MAX_BYTES = 350 * 1024;
export const RANKING_RUN_DEFAULT_PAGE_SIZE = 25;
const RUN_BATCH_GET_MAX_KEYS = 100;
const RUN_READ_MAX_ATTEMPTS = 4;
const RUN_BACKOFF_MS = 25;
/** The highest sort-key suffix: a `to` day covers every time on that day. */
const SORT_KEY_CEILING = String.fromCharCode(0xffff);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type RankingDirection = 'tenants_for_property' | 'properties_for_tenant';
export type RankingRunFailure = 'refusal' | 'parse' | 'truncated' | 'timeout' | 'driver';

export interface RankingRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
}

/** A handle as sent: `c<n>` with its candidate id and display (name or label). */
export interface RankingRunHandle {
  handle: string;
  candidateId: string;
  display: string;
}

/**
 * THIS run's own parsed output for one candidate sent (spec D11; IR3, IR19,
 * PR14), never the current match. A candidate the model did not return is
 * recorded with `returned: false` and NO score (charter 7.4: a default or
 * guessed score is never written); the scored fields are present only when
 * `returned` is true.
 */
export interface RankingRunResult {
  handle: string;
  candidateId: string;
  /** The display (name or label) as sent. */
  display: string;
  returned: boolean;
  score?: number;
  for?: MatchReason[];
  against?: MatchReason[];
  unknowns?: string[];
  /** The pair's MERGED missing list (code flags, then the model's unknowns; spec D3). */
  missing?: MatchMissing[];
  failedRequirements?: string[];
  fairHousingFlags?: MatchFairHousingFlag[];
  /** The cap as computed when the run finished, from its own output and the flags open then. */
  cappedAtRun?: { capped: boolean; capReason: 'requirement not met' | null };
}

export interface RankingRunRecord {
  itemId: string;
  runId: string;
  kind: 'ranking';
  anchorKind: RankingAnchorKind;
  anchorId: string;
  direction: RankingDirection;
  jobGeneration: string;
  batchIndex: number;
  candidateCount: number;
  driver: 'anthropic' | 'console' | 'fake';
  model: string;
  rubricVersion: string;
  examplesVersion: string;
  promptFingerprint: string;
  usage?: RankingRunUsage;
  costUsd: number;
  latencyMs: number;
  startedAt: string;
  finishedAt: string;
  outcome: 'scored' | 'failed';
  failure?: RankingRunFailure;
  message?: string;
  rawText?: string;
  /** gzipBase64 of the batch's user message; dropped by the 350 KB guard. */
  inputGzip?: string;
  inputOmitted?: true;
  handles: RankingRunHandle[];
  results: RankingRunResult[];
  /** Set by markMatchesWritten after the batch's match write; absent = the write did not finish. */
  matchesWritten?: { count: number; at: string };
  droppedUnlawfulFlags: number;
  /** The deployment's environment name (config.appEnv). */
  environment: string;
  /** rankingExpiresAt(startedAt, RANKING_PAIR_TTL_DAYS). */
  expires_at: number;
}

export type RankingRunRecordInput = Omit<RankingRunRecord, 'itemId' | 'kind' | 'inputOmitted' | 'matchesWritten'>;

export interface RankingRunPointer {
  itemId: string;
  entityKey: string;
  sortKey: string;
  runId: string;
  expires_at: number;
}

/**
 * PR34: the ONLY attributes a listing reads (the runs list and the cost
 * totals). Never `rawText`, `inputGzip`, `handles` or `results` - only getRun
 * reads the whole item.
 */
export const RANKING_RUN_SUMMARY_FIELDS = [
  'runId',
  'kind',
  'anchorKind',
  'anchorId',
  'direction',
  'jobGeneration',
  'batchIndex',
  'candidateCount',
  'driver',
  'model',
  'usage',
  'costUsd',
  'latencyMs',
  'startedAt',
  'finishedAt',
  'outcome',
  'failure',
  'message',
  'environment',
] as const satisfies ReadonlyArray<keyof RankingRunRecord>;

export type RankingRunSummary = Pick<RankingRunRecord, (typeof RANKING_RUN_SUMMARY_FIELDS)[number]>;

/**
 * A listing entry. A pointer whose run is gone (TTL lag) reads expired; one
 * whose run could not be read after the retries reads expired with
 * `unavailable` - and the page then says `incomplete: true` (PR34).
 */
export type RankingRunListEntry =
  | { runId: string; sortKey: string; expired: false; run: RankingRunSummary }
  | { runId: string; sortKey: string; expired: true; unavailable?: true };

export interface RankingRunListPage {
  entries: RankingRunListEntry[];
  nextCursor?: string;
  /** PR34: present (true) only when a run of this page stayed unread after the retries. */
  incomplete?: true;
}

export interface ListRankingRunsOptions {
  /** rankingRunEntityKey() or rankingRunEntityKey({ kind, id }). */
  entityKey: string;
  /** Inclusive day bounds, YYYY-MM-DD, compared against the sort key. */
  from?: string;
  to?: string;
  /** The last sortKey already returned (exclusive). */
  cursor?: string;
  limit?: number;
}

export function rankingRunItemBytes(record: object): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}

/** Spec D11: an item that would exceed 350 KB keeps everything but inputGzip, marked inputOmitted. */
export function withRankingRunSizeGuard(record: RankingRunRecord): RankingRunRecord {
  if (record.inputGzip === undefined || rankingRunItemBytes(record) <= RANKING_RUN_ITEM_MAX_BYTES) return record;
  const { inputGzip: _dropped, ...rest } = record;
  return { ...rest, inputOmitted: true };
}

export interface RankingRunFamily {
  /**
   * The run and its two pointers (rankings#global and the anchor's) in ONE
   * transaction; the run put is conditioned on a new id. Applies the 350 KB
   * guard and returns the record as stored.
   */
  putRun(input: RankingRunRecordInput): Promise<RankingRunRecord>;
  /** The second write of a run (spec D11), conditioned on the run existing. */
  markMatchesWritten(runId: string, written: { count: number; at: string }): Promise<boolean>;
  getRun(runId: string): Promise<RankingRunRecord | undefined>;
  /**
   * Pointers newest first, then ONE BatchGet of the rrun# items PROJECTED to
   * RANKING_RUN_SUMMARY_FIELDS (PR34). A run still unread after 4 attempts is
   * an `unavailable` entry and the page carries `incomplete: true` - never a
   * silent drop. Used by the runs list and the cost totals.
   */
  listRuns(opts: ListRankingRunsOptions): Promise<RankingRunListPage>;
}

/** The summary projection, every name aliased (several are reserved words). */
const SUMMARY_PROJECTION = {
  ProjectionExpression: RANKING_RUN_SUMMARY_FIELDS.map((_field, i) => `#f${i}`).join(', '),
  ExpressionAttributeNames: Object.fromEntries(RANKING_RUN_SUMMARY_FIELDS.map((field, i) => [`#f${i}`, field])),
};

function createRunFamily(ctx: FamilyCtx): RankingRunFamily {
  const { doc, table, log } = ctx;

  async function batchGetRuns(runIds: string[]): Promise<{ found: Map<string, RankingRunSummary>; unread: Set<string> }> {
    const found = new Map<string, RankingRunSummary>();
    const unread = new Set<string>();
    const unique = [...new Set(runIds)];
    for (let i = 0; i < unique.length; i += RUN_BATCH_GET_MAX_KEYS) {
      let keys = unique.slice(i, i + RUN_BATCH_GET_MAX_KEYS).map((runId) => ({ itemId: rankingRunItemId(runId) }));
      for (let attempt = 0; attempt < RUN_READ_MAX_ATTEMPTS && keys.length > 0; attempt += 1) {
        if (attempt > 0) await sleep(RUN_BACKOFF_MS * 2 ** (attempt - 1));
        const response = await doc.send(
          new BatchGetCommand({ RequestItems: { [table]: { Keys: keys, ...SUMMARY_PROJECTION } } }),
        );
        for (const item of (response.Responses?.[table] ?? []) as RankingRunSummary[]) found.set(item.runId, item);
        keys = (response.UnprocessedKeys?.[table]?.Keys ?? []) as Array<{ itemId: string }>;
      }
      for (const k of keys) unread.add(runIdOfRankingItemId(k.itemId));
    }
    if (unread.size > 0) {
      log.warn({ unread: unread.size }, 'ranking runs: BatchGet left keys unprocessed after retries');
    }
    return { found, unread };
  }

  return {
    async putRun(input) {
      const record = withRankingRunSizeGuard({ ...input, itemId: rankingRunItemId(input.runId), kind: 'ranking' });
      const sortKey = rankingRunSortKey(input.startedAt, input.runId);
      const pointers: RankingRunPointer[] = [
        rankingRunEntityKey(),
        rankingRunEntityKey({ kind: input.anchorKind, id: input.anchorId }),
      ].map((entityKey) => ({
        itemId: rankingPointerItemId(entityKey, input.startedAt, input.runId),
        entityKey,
        sortKey,
        runId: input.runId,
        expires_at: input.expires_at,
      }));
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: table,
                Item: record,
                ConditionExpression: 'attribute_not_exists(#itemId)',
                ExpressionAttributeNames: { '#itemId': 'itemId' },
              },
            },
            ...pointers.map((Item) => ({ Put: { TableName: table, Item } })),
          ],
        }),
      );
      log.debug(
        { runId: input.runId, outcome: input.outcome, inputOmitted: record.inputOmitted === true },
        'ranking run recorded',
      );
      return record;
    },

    async markMatchesWritten(runId, written) {
      const updated = await updateOrUndefined(ctx, {
        Key: { itemId: rankingRunItemId(runId) },
        UpdateExpression: 'SET #mw = :mw',
        ConditionExpression: 'attribute_exists(#itemId)',
        ExpressionAttributeNames: { '#mw': 'matchesWritten', '#itemId': 'itemId' },
        ExpressionAttributeValues: { ':mw': { count: written.count, at: written.at } },
      });
      return updated !== undefined;
    },

    async getRun(runId) {
      const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { itemId: rankingRunItemId(runId) } }));
      return Item as RankingRunRecord | undefined;
    },

    async listRuns(opts) {
      const limit = opts.limit ?? RANKING_RUN_DEFAULT_PAGE_SIZE;
      // ONE sort-key condition only (a KeyConditionExpression takes at most
      // one): the cursor and the `to` ceiling both bound the top, so the upper
      // bound is their lexicographic min (the aiRunsRepo.listByEntity rule).
      const toCeiling = opts.to !== undefined ? `${opts.to}${SORT_KEY_CEILING}` : undefined;
      const upper =
        opts.cursor !== undefined && (toCeiling === undefined || opts.cursor <= toCeiling)
          ? { value: opts.cursor, exclusive: true }
          : toCeiling !== undefined
            ? { value: toCeiling, exclusive: false }
            : undefined;
      // An inverted range matches nothing; DynamoDB would reject the BETWEEN.
      if (opts.from !== undefined && upper !== undefined && opts.from > upper.value) return { entries: [] };
      const sortCondition =
        upper !== undefined && opts.from !== undefined
          ? '#sk BETWEEN :lower AND :upper'
          : upper !== undefined
            ? upper.exclusive
              ? '#sk < :upper'
              : '#sk <= :upper'
            : opts.from !== undefined
              ? '#sk >= :lower'
              : undefined;
      // BETWEEN is inclusive: with an exclusive cursor as its top, over-fetch by
      // one and drop the boundary row (sort keys are unique).
      const trimsBoundary = sortCondition === '#sk BETWEEN :lower AND :upper' && upper !== undefined && upper.exclusive;
      const page = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byEntity',
          KeyConditionExpression: sortCondition === undefined ? '#ek = :ek' : `#ek = :ek AND ${sortCondition}`,
          ExpressionAttributeNames: { '#ek': 'entityKey', ...(sortCondition !== undefined && { '#sk': 'sortKey' }) },
          ExpressionAttributeValues: {
            ':ek': opts.entityKey,
            ...(upper !== undefined && { ':upper': upper.value }),
            ...(opts.from !== undefined && { ':lower': opts.from }),
          },
          ScanIndexForward: false,
          Limit: trimsBoundary ? limit + 1 : limit,
        }),
      );
      const items = (page.Items ?? []) as RankingRunPointer[];
      const kept = trimsBoundary && upper !== undefined ? items.filter((p) => p.sortKey < upper.value) : items;
      const hasMore = kept.length > limit || page.LastEvaluatedKey !== undefined;
      const pointers = kept.slice(0, limit);
      if (pointers.length === 0) return { entries: [] };
      const { found, unread } = await batchGetRuns(pointers.map((p) => p.runId));
      const entries: RankingRunListEntry[] = pointers.map((p) => {
        const run = found.get(p.runId);
        if (run !== undefined) return { runId: p.runId, sortKey: p.sortKey, expired: false, run };
        return unread.has(p.runId)
          ? { runId: p.runId, sortKey: p.sortKey, expired: true, unavailable: true }
          : { runId: p.runId, sortKey: p.sortKey, expired: true };
      });
      const last = entries[entries.length - 1];
      const nextCursor = entries.length === limit && hasMore && last !== undefined ? last.sortKey : undefined;
      return {
        entries,
        ...(nextCursor !== undefined && { nextCursor }),
        ...(unread.size > 0 && { incomplete: true as const }),
      };
    },
  };
}

// --- The repository ---

export type RankingRunsRepo = RankingJobFamily & RankingRunFamily;

export function createRankingRunsRepo(deps: RepoDeps = {}): RankingRunsRepo {
  const ctx: FamilyCtx = {
    doc: deps.doc ?? getDocumentClient(),
    table: tableName('ai_runs', deps.env),
    log: deps.logger ?? defaultLogger,
  };
  return { ...createJobFamily(ctx), ...createRunFamily(ctx) };
}
