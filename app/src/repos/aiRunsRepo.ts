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
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
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

export type RunTrigger = 'sms' | 'voice' | 'triage' | 'email';
export type RunOutcome = 'applied' | 'no_op' | 'skipped' | 'failed';
export type SkipReason = 'no_contact' | 'ineligible_type' | 'no_new_client' | 'empty_window';
export type RunErrorKind = 'refusal' | 'parse' | 'driver' | 'complete' | 'repo';

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

export type AiRunListEntry =
  | { runId: string; sortKey: string; expired: false; run: AiRunRecord }
  | { runId: string; sortKey: string; expired: true };

export interface ListByEntityOptions {
  limit?: number;
  before?: string;
  from?: string;
  to?: string;
}

export interface AiRunsRepo {
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
    opts?: { at?: string; by?: string },
  ): Promise<boolean>;
}

export const RUN_TTL_DAYS = 90;
export const DEFAULT_PAGE_SIZE = 25;
const SORT_KEY_CEILING = '\uffff';
const MAX_BATCH_ATTEMPTS = 4;
const BATCH_BACKOFF_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const runItemId = (runId: string): string => `run#${runId}`;
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

  async function batchGetRuns(runIds: string[]): Promise<Map<string, AiRunRecord>> {
    const found = new Map<string, AiRunRecord>();
    let keys = runIds.map((runId) => ({ itemId: runItemId(runId) }));
    for (let attempt = 0; attempt < MAX_BATCH_ATTEMPTS && keys.length > 0; attempt += 1) {
      if (attempt > 0) await sleep(BATCH_BACKOFF_MS * 2 ** (attempt - 1));
      const res = await doc.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }));
      for (const item of (res.Responses?.[table] ?? []) as AiRunRecord[]) found.set(item.runId, item);
      keys = (res.UnprocessedKeys?.[table]?.Keys ?? []) as Array<{ itemId: string }>;
    }
    if (keys.length > 0) {
      log.warn({ unprocessed: keys.length }, 'ai run log: BatchGet left keys unprocessed after retries');
    }
    return found;
  }

  return {
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
      await doc.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: table, Item: record } },
          ...pointers.map((Item) => ({ Put: { TableName: table, Item } })),
        ],
      }));
      log.debug(
        { runId: input.runId, conversationId: input.conversationId, outcome: input.outcome },
        'ai run recorded',
      );
      return record;
    },

    async getRun(runId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { itemId: runItemId(runId) } }),
      );
      return Item as AiRunRecord | undefined;
    },

    async listByEntity(entityKey, opts = {}) {
      const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
      const upper =
        opts.before !== undefined
          ? { expr: '#sk < :upper', value: opts.before }
          : opts.to !== undefined
            ? { expr: '#sk <= :upper', value: `${opts.to}${SORT_KEY_CEILING}` }
            : undefined;
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byEntity',
        KeyConditionExpression: [
          '#ek = :ek',
          ...(upper !== undefined ? [upper.expr] : []),
          ...(opts.from !== undefined ? ['#sk >= :lower'] : []),
        ].join(' AND '),
        ExpressionAttributeNames: { '#ek': 'entityKey', '#sk': 'sortKey' },
        ExpressionAttributeValues: {
          ':ek': entityKey,
          ...(upper !== undefined && { ':upper': upper.value }),
          ...(opts.from !== undefined && { ':lower': opts.from }),
        },
        ScanIndexForward: false,
        Limit: limit,
      };
      const page = await doc.send(new QueryCommand(input));
      const pointers = ((page.Items as AiRunPointer[] | undefined) ?? []).map((p) => ({
        runId: p.runId,
        sortKey: p.sortKey,
      }));
      if (pointers.length === 0) return { entries: [] };

      const byRunId = await batchGetRuns(pointers.map((p) => p.runId));
      const entries: AiRunListEntry[] = pointers.map((p) => {
        const run = byRunId.get(p.runId);
        return run !== undefined
          ? { runId: p.runId, sortKey: p.sortKey, expired: false, run }
          : { runId: p.runId, sortKey: p.sortKey, expired: true };
      });
      const nextBefore =
        entries.length === limit && page.LastEvaluatedKey !== undefined
          ? entries[entries.length - 1]!.sortKey
          : undefined;
      return { entries, ...(nextBefore !== undefined && { nextBefore }) };
    },

    /**
     * PRECONDITION: decisions.<target> must already exist. The conditional
     * guard intentionally protects only the run row, preserving the frozen
     * best-effort boundary for a missing parent decision map.
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
      try {
        await doc.send(new UpdateCommand({
          TableName: table,
          Key: { itemId: runItemId(runId) },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(itemId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }));
        log.debug({ runId, target, verdict }, 'ai run verdict stamped');
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ runId, target }, 'ai run verdict skipped (run row expired)');
          return false;
        }
        throw err;
      }
    },
  };
}
