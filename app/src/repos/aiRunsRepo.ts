// AI run log repository. The ai_runs table stores full run rows and sparse
// adjacency pointers; pointer rows are the only rows indexed by byEntity.
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type {
  DecisionTarget,
  RunDecision,
  RunWindow,
  Verdict,
} from '../services/extraction/runTypes.js';
import type { RepoDeps } from './conversationsRepo.js';

export type RunTrigger = 'sms' | 'voice' | 'triage' | 'email' | 'manual';
export type RunOutcome = 'applied' | 'no_op' | 'skipped' | 'failed';
export type SkipReason = 'no_contact' | 'ineligible_type' | 'no_new_client' | 'empty_window';
export type RunErrorKind = 'refusal' | 'parse' | 'truncated' | 'driver' | 'complete' | 'repo';

export interface RunError {
  kind: RunErrorKind;
  message: string;
  attempts: number;
  parked: boolean;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiRunRecord {
  itemId: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  conversationId: string;
  contactId?: string;
  trigger: RunTrigger;
  outcome: RunOutcome;
  skipReason?: SkipReason;
  error?: RunError;
  driver: 'anthropic' | 'console' | 'fake';
  model?: string;
  promptFingerprint?: string;
  usage?: RunUsage;
  window?: RunWindow;
  profileFieldsPopulated?: string[];
  rawText?: string;
  rawResult?: unknown;
  decisions: Partial<Record<DecisionTarget, RunDecision>>;
  notedLines: number;
  expires_at: number;
}

export type AiRunRecordInput = Omit<AiRunRecord, 'itemId' | 'expires_at'>;

export interface AiRunPointer {
  itemId: string;
  entityKey: string;
  sortKey: string;
  runId: string;
  expires_at: number;
}

interface FinalizationVerdict { verdict: Verdict; at: string; by?: string }
interface FinalizationMarker {
  itemId: string;
  runId: string;
  version: number;
  verdicts: Partial<Record<DecisionTarget, FinalizationVerdict>>;
  expires_at: number;
}

/**
 * ONE non-live member with an OPTIONAL `unavailable` discriminant, not two
 * members: the renderers narrow on `expired` and then read `unavailable`
 * truthily, which only typechecks while the flag is present-optional on the
 * single non-live shape. The hand-kept wire duplicate in
 * dashboard/src/api/types.ts moves with this type.
 */
export type AiRunListEntry =
  | { runId: string; sortKey: string; expired: false; run: AiRunRecord }
  | { runId: string; sortKey: string; expired: true; unavailable?: true };

export interface ListByEntityOptions {
  limit?: number;
  before?: string;
  from?: string;
  to?: string;
}

export interface AiRunsRepo {
  beginFinalization(runId: string, startedAt: string): Promise<boolean>;
  putRun(input: AiRunRecordInput): Promise<AiRunRecord>;
  getRun(runId: string): Promise<AiRunRecord | undefined>;
  listByEntity(
    entityKey: string,
    opts?: ListByEntityOptions,
  ): Promise<{ entries: AiRunListEntry[]; nextBefore?: string }>;
  setVerdict(
    runId: string,
    target: DecisionTarget,
    verdict: Verdict,
    opts?: { at?: string; by?: string; expectedVerdict?: Verdict; freshSuggestionCreatedAt?: string },
  ): Promise<boolean>;
}

export const RUN_TTL_DAYS = 90;
export const DEFAULT_PAGE_SIZE = 25;
const SORT_KEY_CEILING = '\uffff';
const MAX_BATCH_ATTEMPTS = 4;
const BATCH_BACKOFF_MS = 25;
/** BatchGetItem caps at 100 keys per request; more is a ValidationException. */
const BATCH_GET_MAX_KEYS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * DynamoDB's ValidationException is NOT a modeled exception class in
 * @aws-sdk/client-dynamodb - it arrives as a DynamoDBServiceException whose
 * `name` is 'ValidationException'. Same detection as suggestionResolutionRepo.
 */
function isValidationFailure(err: unknown): boolean {
  return err instanceof Error && err.name === 'ValidationException';
}

export const runItemId = (runId: string): string => `run#${runId}`;
export const runIdOfItemId = (itemId: string): string => itemId.slice('run#'.length);
export const inflightItemId = (runId: string): string => `inflight#${runId}`;
export const runSortKey = (startedAt: string, runId: string): string => `${startedAt}#${runId}`;
export const pointerItemId = (entityKey: string, startedAt: string, runId: string): string =>
  `ptr#${entityKey}#${runSortKey(startedAt, runId)}`;

export function pointerEntityKeys(
  input: Pick<AiRunRecordInput, 'outcome' | 'conversationId' | 'contactId'>,
): string[] {
  return [
    'global',
    `outcome#${input.outcome}`,
    `conversations#${input.conversationId}`,
    ...(input.contactId !== undefined ? [`contacts#${input.contactId}`] : []),
  ];
}

export function runExpiresAt(startedAt: string): number {
  return Math.floor(Date.parse(startedAt) / 1000) + RUN_TTL_DAYS * 24 * 60 * 60;
}

export function createAiRunsRepo(deps: RepoDeps = {}): AiRunsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('ai_runs', deps.env);
  const log = deps.logger ?? defaultLogger;

  /**
   * Reports the keys it could NOT read separately from the ones it did: a run
   * left unprocessed after the full retry budget is unread, not reaped, and
   * `listByEntity` must not render it as expired.
   */
  async function batchGetRuns(
    runIds: string[],
  ): Promise<{ found: Map<string, AiRunRecord>; unprocessedRunIds: Set<string> }> {
    const found = new Map<string, AiRunRecord>();
    const unprocessedRunIds = new Set<string>();
    // Chunk OUTSIDE, retry INSIDE - each chunk gets its own fresh key list and
    // its own full backoff budget (messagesRepo.getManyByTsMsgIds chunks the
    // same way). listByEntity only stays under the ceiling today because the
    // route caps ?limit at 100, a coupling nothing in this repo enforces.
    for (let i = 0; i < runIds.length; i += BATCH_GET_MAX_KEYS) {
      let keys = runIds
        .slice(i, i + BATCH_GET_MAX_KEYS)
        .map((runId) => ({ itemId: runItemId(runId) }));
      for (let attempt = 0; attempt < MAX_BATCH_ATTEMPTS && keys.length > 0; attempt += 1) {
        if (attempt > 0) await sleep(BATCH_BACKOFF_MS * 2 ** (attempt - 1));
        const res = await doc.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }));
        for (const item of (res.Responses?.[table] ?? []) as AiRunRecord[]) found.set(item.runId, item);
        keys = (res.UnprocessedKeys?.[table]?.Keys ?? []) as Array<{ itemId: string }>;
      }
      // `keys` is chunk-local and rebound on the next iteration, so the
      // leftovers have to be accumulated here or the earlier chunks' are lost.
      for (const k of keys) unprocessedRunIds.add(runIdOfItemId(k.itemId));
    }
    // Warn ONCE per call rather than once per chunk.
    if (unprocessedRunIds.size > 0) {
      log.warn(
        { unprocessed: unprocessedRunIds.size },
        'ai run log: BatchGet left keys unprocessed after retries',
      );
    }
    return { found, unprocessedRunIds };
  }

  return {
    async beginFinalization(runId, startedAt) {
      try {
        await doc.send(new UpdateCommand({
          TableName: table,
          Key: { itemId: inflightItemId(runId) },
          UpdateExpression: 'SET #runId = :runId, #version = :zero, #verdicts = :verdicts, #expiresAt = :expiresAt',
          ConditionExpression: 'attribute_not_exists(itemId)',
          ExpressionAttributeNames: { '#runId': 'runId', '#version': 'version', '#verdicts': 'verdicts', '#expiresAt': 'expires_at' },
          ExpressionAttributeValues: { ':runId': runId, ':zero': 0, ':verdicts': {}, ':expiresAt': runExpiresAt(startedAt) },
        }));
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },
    async putRun(input) {
      const expires_at = runExpiresAt(input.startedAt);
      const record: AiRunRecord = { ...input, itemId: runItemId(input.runId), expires_at };
      const pointers: AiRunPointer[] = pointerEntityKeys(input).map((entityKey) => ({
        itemId: pointerItemId(entityKey, input.startedAt, input.runId),
        entityKey,
        sortKey: runSortKey(input.startedAt, input.runId),
        runId: input.runId,
        expires_at,
      }));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const marker = (await doc.send(new GetCommand({
          TableName: table,
          Key: { itemId: inflightItemId(input.runId) },
          ConsistentRead: true,
        }))).Item as FinalizationMarker | undefined;
        const merged: AiRunRecord = marker === undefined ? record : {
          ...record,
          decisions: Object.fromEntries(Object.entries(record.decisions).map(([target, decision]) => {
            const terminal = marker.verdicts[target as DecisionTarget];
            return [target, decision?.verdict === 'pending' && terminal !== undefined
              ? { ...decision, verdict: terminal.verdict, verdictAt: terminal.at, ...(terminal.by !== undefined && { verdictBy: terminal.by }) }
              : decision];
          })),
        };
        try {
          await doc.send(new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: table, Item: merged } },
              ...pointers.map((Item) => ({ Put: { TableName: table, Item } })),
              ...(marker === undefined ? [{ ConditionCheck: {
                TableName: table,
                Key: { itemId: inflightItemId(input.runId) },
                ConditionExpression: 'attribute_not_exists(itemId)',
              } }] : [{ Delete: {
                TableName: table,
                Key: { itemId: inflightItemId(input.runId) },
                ConditionExpression: '#version = :version',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':version': marker.version },
              } }]),
            ],
          }));
          log.debug({ runId: input.runId, conversationId: input.conversationId, outcome: input.outcome }, 'ai run recorded');
          return merged;
        } catch (err) {
          // The marker can appear after an absent read or change after a present
          // read. CancellationReasons are optional, so retry either bounded
          // marker race and re-read before the next all-or-nothing transaction.
          if (!(err instanceof TransactionCanceledException) || attempt === 2) throw err;
        }
      }
      throw new Error('unreachable');
    },

    async getRun(runId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { itemId: runItemId(runId) } }),
      );
      return Item as AiRunRecord | undefined;
    },

    async listByEntity(entityKey, opts = {}) {
      const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
      // A KeyConditionExpression may carry AT MOST ONE condition on the sort
      // key - two is a ValidationException, not a conjunction (design 5.3: date
      // ranges are a BETWEEN on sortKey). `before` (the exclusive paging cursor)
      // and `to` (the inclusive day ceiling) both constrain that one key, so the
      // upper bound is their LEXICOGRAPHIC MIN: a caller-supplied `before` past
      // the `to` ceiling must not silently drop the ceiling and over-return.
      const toCeiling = opts.to !== undefined ? `${opts.to}${SORT_KEY_CEILING}` : undefined;
      const upper =
        opts.before !== undefined && (toCeiling === undefined || opts.before <= toCeiling)
          ? { value: opts.before, exclusive: true }
          : toCeiling !== undefined
            ? { value: toCeiling, exclusive: false }
            : undefined;
      // An INVERTED range matches nothing, and DynamoDB says so by rejecting the
      // query: "the BETWEEN operator requires upper bound to be greater than or
      // equal to lower bound" (a ValidationException, i.e. a 500 on the route).
      // The dashboard's From and To are independent date inputs, so From later
      // than To is one click away; a hand-supplied `before` below `from` is the
      // same shape. Answer the empty page truthfully instead of querying.
      if (opts.from !== undefined && upper !== undefined && opts.from > upper.value) {
        return { entries: [] };
      }
      const usesSortKey = upper !== undefined || opts.from !== undefined;
      const sortCondition =
        upper !== undefined && opts.from !== undefined
          ? '#sk BETWEEN :lower AND :upper'
          : upper !== undefined
            ? (upper.exclusive ? '#sk < :upper' : '#sk <= :upper')
            : opts.from !== undefined
              ? '#sk >= :lower'
              : undefined;
      // BETWEEN is inclusive on BOTH ends, but `before` is the last sortKey
      // ALREADY returned. When it becomes the BETWEEN upper, over-fetch by one
      // and drop the boundary row here - sortKeys are unique (`<ISO>#<uuid>`),
      // so that is at most one row.
      const trimsBoundary = sortCondition === '#sk BETWEEN :lower AND :upper' && upper!.exclusive;
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byEntity',
        KeyConditionExpression: ['#ek = :ek', ...(sortCondition !== undefined ? [sortCondition] : [])].join(' AND '),
        ExpressionAttributeNames: {
          '#ek': 'entityKey',
          ...(usesSortKey ? { '#sk': 'sortKey' } : {}),
        },
        ExpressionAttributeValues: {
          ':ek': entityKey,
          ...(upper !== undefined && { ':upper': upper.value }),
          ...(opts.from !== undefined && { ':lower': opts.from }),
        },
        ScanIndexForward: false,
        Limit: trimsBoundary ? limit + 1 : limit,
      };
      const page = await doc.send(new QueryCommand(input));
      const items = (page.Items as AiRunPointer[] | undefined) ?? [];
      const kept = trimsBoundary ? items.filter((p) => p.sortKey < upper!.value) : items;
      const hasMore = kept.length > limit || page.LastEvaluatedKey !== undefined;
      const pointers = kept.slice(0, limit).map((p) => ({
        runId: p.runId,
        sortKey: p.sortKey,
      }));
      if (pointers.length === 0) return { entries: [] };

      const { found: byRunId, unprocessedRunIds } = await batchGetRuns(pointers.map((p) => p.runId));
      const entries: AiRunListEntry[] = pointers.map((p) => {
        const run = byRunId.get(p.runId);
        if (run !== undefined) return { runId: p.runId, sortKey: p.sortKey, expired: false, run };
        // Unprocessed-after-4-attempts is sustained pressure, NOT a TTL
        // reap - the forensic surface must not call a throttled row expired.
        return unprocessedRunIds.has(p.runId)
          ? { runId: p.runId, sortKey: p.sortKey, expired: true, unavailable: true }
          : { runId: p.runId, sortKey: p.sortKey, expired: true };
      });
      const nextBefore =
        entries.length === limit && hasMore ? entries[entries.length - 1]!.sortKey : undefined;
      return { entries, ...(nextBefore !== undefined && { nextBefore }) };
    },

    /**
     * PRECONDITION: decisions.<target> must already exist. The conditional
     * guard intentionally protects only the run row, preserving the frozen
     * best-effort boundary for a missing parent decision map. When that
     * precondition is violated the SET targets an invalid document path, which
     * DynamoDB rejects with a ValidationException - caught below and reported as
     * `false`, because this method's contract is a boolean and every caller
     * treats it as best-effort observability.
     */
    async setVerdict(runId, target, verdict, opts = {}) {
      const at = opts.at ?? new Date().toISOString();
      const sets = ['#d.#t.#v = :v', '#d.#t.#va = :at'];
      const values: Record<string, unknown> = { ':v': verdict, ':at': at };
      const names: Record<string, string> = {
        '#d': 'decisions', '#t': target, '#v': 'verdict', '#va': 'verdictAt',
      };
      if (opts.by !== undefined) {
        sets.push('#d.#t.#vb = :by');
        values[':by'] = opts.by;
        names['#vb'] = 'verdictBy';
      }
      if (opts.expectedVerdict !== undefined) {
        names['#expectedVerdict'] = 'verdict';
        values[':expectedVerdict'] = opts.expectedVerdict;
      }
      /**
       * A ValidationException is reported as `false` because this method's
       * contract is a boolean and the missing-`decisions.<target>` path is a
       * legitimate best-effort miss. But it is also DynamoDB's catch-all for
       * EVERY malformed expression (a reserved word, an unreferenced alias, a
       * type mismatch), and no caller inspects the boolean - so without this
       * line a future expression bug would silently stop stamping every verdict
       * in production with the run log showing `pending` and no error anywhere.
       * Ids and the error only: never the value under review.
       */
      const rejected = (err: unknown): false => {
        log.warn({ runId, target, err }, 'ai run verdict stamp rejected (ValidationException)');
        return false;
      };
      const markerNames = { '#verdicts': 'verdicts', '#target': target, '#version': 'version' };
      const markerValues = { ':verdict': { verdict, at, ...(opts.by !== undefined && { by: opts.by }) }, ':one': 1 };
      const writeRunVerdict = async (): Promise<boolean> => {
        try {
          await doc.send(new UpdateCommand({
            TableName: table,
            Key: { itemId: runItemId(runId) },
            UpdateExpression: `SET ${sets.join(', ')}`,
            ConditionExpression: opts.expectedVerdict === undefined
              ? 'attribute_exists(itemId)'
              : 'attribute_exists(itemId) AND #d.#t.#expectedVerdict = :expectedVerdict',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }));
          return true;
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) return false;
          if (isValidationFailure(err)) return rejected(err);
          throw err;
        }
      };
      const writeMarkerVerdict = async (): Promise<boolean> => {
        try {
          await doc.send(new UpdateCommand({
            TableName: table,
            Key: { itemId: inflightItemId(runId) },
            UpdateExpression: 'SET #verdicts.#target = :verdict ADD #version :one',
            ConditionExpression: 'attribute_exists(itemId) AND attribute_not_exists(#verdicts.#target)',
            ExpressionAttributeNames: markerNames,
            ExpressionAttributeValues: markerValues,
          }));
          return true;
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) return false;
          if (isValidationFailure(err)) return rejected(err);
          throw err;
        }
      };
      if (await writeRunVerdict()) {
        log.debug({ runId, target, verdict }, 'ai run verdict stamped');
        return true;
      }
      if (await writeMarkerVerdict()) return true;
      if (await writeRunVerdict()) return true;

      const freshAt = opts.freshSuggestionCreatedAt;
      const freshAtMs = freshAt === undefined ? Number.NaN : Date.parse(freshAt);
      if (!Number.isFinite(freshAtMs)) return false;
      const expiresAt = runExpiresAt(freshAt!);
      if (expiresAt <= Math.floor(Date.now() / 1000)) return false;
      const fallbackMarker: FinalizationMarker = {
        itemId: inflightItemId(runId),
        runId,
        version: 0,
        verdicts: { [target]: { verdict, at, ...(opts.by !== undefined && { by: opts.by }) } },
        expires_at: expiresAt,
      };
      try {
        await doc.send(new TransactWriteCommand({
          TransactItems: [
            { ConditionCheck: {
              TableName: table,
              Key: { itemId: runItemId(runId) },
              ConditionExpression: 'attribute_not_exists(itemId)',
            } },
            { Put: {
              TableName: table,
              Item: fallbackMarker,
              ConditionExpression: 'attribute_not_exists(itemId)',
            } },
          ],
        }));
        return true;
      } catch (err) {
        if (isValidationFailure(err)) return rejected(err);
        if (!(err instanceof TransactionCanceledException)) throw err;
      }
      if (await writeRunVerdict()) return true;
      return writeMarkerVerdict();
    },
  };
}
