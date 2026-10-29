// WP1 B2a matches store (spec D8, D8.1; charter 10.1; plan PR5). The first
// repository on the `matches` table (lib/tables.ts: hash tenantId, range
// unitId, GSI byUnit, TTL expires_at). ONE row per tenant-property pair,
// written only by the ranking job and read by the ranking read, the Rankings
// page run detail and tests (plan WI1). Band, cap state, priority effect,
// chips and sort position are NEVER stored - all are derived on read.
//
// A row without `schema: 2` is a LEGACY row (the shape the old lean seed
// carried) and is ignored by every reader here: getPairs leaves it out of the
// map and the two lists drop it.
import { gunzipSync, gzipSync } from 'node:zlib';
import { BatchGetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { queryAll } from '../lib/dynamoPaging.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { IncompleteBatchReadError } from './contactsRepo.js';
import type { RepoDeps } from './conversationsRepo.js';

/** Which side a ranking was asked from; the same two values as the anchor kind. */
export type RankingAnchorKind = 'unit' | 'tenant';

export const MATCH_SCHEMA = 2;

export interface MatchReason {
  text: string;
  source: string;
}

/** A missing-input flag: a code flag carries its stable key; a model unknown has text only. */
export interface MatchMissing {
  key?: string;
  text: string;
}

export interface MatchFairHousingFlag {
  kind: 'unlawful' | 'accommodation';
  field: string;
}

export interface MatchFingerprints {
  tenantCard: string;
  unitCard: string;
  pairHistory: string;
}

export interface MatchRow {
  tenantId: string;
  unitId: string;
  schema: 2;
  score: number;
  for: MatchReason[];
  against: MatchReason[];
  missing: MatchMissing[];
  failedRequirements: string[];
  /** The pair's flags as the model returned them (spec D8). */
  fairHousingFlags: MatchFairHousingFlag[];
  stage: 1;
  rubricVersion: string;
  examplesVersion: string;
  /**
   * sha256 over the call's system text, a newline and the stable JSON of the
   * schema sent on that call (spec D4, D8.1; plan PR18 - prompt.ts
   * rankingPromptFingerprint).
   */
  promptFingerprint: string;
  /** The driver actually used: the model id, or the literal `fake` / `console` (spec D6). */
  model: string;
  runId: string;
  jobGeneration: string;
  computedAt: string;
  /** Which side's call produced the row (for the run log only). */
  anchorSide: RankingAnchorKind;
  fingerprints: MatchFingerprints;
  /** encodeSnapshot of the exact JSON the pair was scored from (spec D8.1). */
  inputSnapshot: string;
  /** Epoch seconds: rankingExpiresAt(computedAt, RANKING_PAIR_TTL_DAYS). */
  expires_at: number;
}

export interface MatchPairKey {
  tenantId: string;
  unitId: string;
}

/**
 * PR37: the outcome of one putMatches. `written` counts the distinct pairs
 * CONFIRMED written; `unwritten` names every pair NOT CONFIRMED written (in
 * the order given), so `written + unwritten.length` is the number of distinct
 * pairs. A pair of a chunk whose request threw is "not confirmed written": a
 * timeout or socket error after the commit may already have applied it.
 */
export interface MatchWriteResult {
  written: number;
  unwritten: MatchPairKey[];
}

export interface MatchesRepo {
  /**
   * BatchWrite (25 per request) of whole rows. A pair given twice is written
   * once (the last copy wins; BatchWrite rejects a request with a repeated
   * key). Unprocessed items are retried with backoff (5 attempts); items
   * still unprocessed after that, and every not-yet-confirmed row of a chunk
   * whose request THROWS (not retried; such rows are "not confirmed
   * written" - the request may have applied before the error), are REPORTED
   * in `unwritten` and the remaining chunks are still written - it NEVER
   * throws on a DynamoDB failure (PR37: rows that landed are real scores of
   * this run and stay; the caller marks only the unwritten pairs failed). It
   * throws only on a programming error: a row that is not schema 2.
   */
  putMatches(rows: MatchRow[]): Promise<MatchWriteResult>;
  /**
   * Read pairs by primary key from the BASE table, consistent (never the
   * byUnit index). Complete or nothing: an unprocessed key after 4 attempts
   * throws IncompleteBatchReadError, a failed request rethrows - an unread
   * pair never reads as "no match" (the batch-read ambiguity rule). Keyed
   * matchPairKey(tenantId, unitId); a legacy row is absent.
   */
  getPairs(keys: MatchPairKey[], opts: { requireComplete: true }): Promise<Map<string, MatchRow>>;
  /** Every current row for a unit, via byUnit (eventually consistent). The Rankings page only. */
  listByUnit(unitId: string): Promise<MatchRow[]>;
  /** Every current row for a tenant, base-table query, consistent. The Rankings page only. */
  listByTenant(tenantId: string): Promise<MatchRow[]>;
}

const BATCH_WRITE_MAX_ITEMS = 25;
const BATCH_GET_MAX_KEYS = 100;
const WRITE_MAX_ATTEMPTS = 5;
const READ_MAX_ATTEMPTS = 4;
const BACKOFF_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function matchPairKey(tenantId: string, unitId: string): string {
  return `${tenantId}#${unitId}`;
}

/** True only for a schema 2 row; the legacy shape (no schema) is not current. */
export function isCurrentMatchRow(item: unknown): item is MatchRow {
  return typeof item === 'object' && item !== null && (item as { schema?: unknown }).schema === MATCH_SCHEMA;
}

/**
 * Epoch seconds `ttlDays` after `fromIso` - the TTL every ranking record
 * carries (matches, runs, pointers, jobs: RANKING_PAIR_TTL_DAYS). Throws on a
 * time that does not parse.
 */
export function rankingExpiresAt(fromIso: string, ttlDays: number): number {
  const ms = Date.parse(fromIso);
  if (!Number.isFinite(ms)) throw new Error(`rankingExpiresAt: not an ISO time: ${fromIso}`);
  return Math.floor(ms / 1000) + ttlDays * 24 * 60 * 60;
}

/** gzip then base64 (a run's `inputGzip`, the snapshot's transport). */
export function gzipBase64(text: string): string {
  return gzipSync(Buffer.from(text, 'utf8')).toString('base64');
}

export function gunzipBase64(b64: string): string {
  return gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
}

/** The input snapshot (spec D8.1): JSON, gzipped, base64-encoded. */
export function encodeSnapshot(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('encodeSnapshot: the value is not JSON');
  return gzipBase64(json);
}

export function decodeSnapshot(b64: string): unknown {
  return JSON.parse(gunzipBase64(b64));
}

export function createMatchesRepo(deps: RepoDeps = {}): MatchesRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('matches', deps.env);
  const log = deps.logger ?? defaultLogger;

  return {
    async putMatches(rows) {
      for (const row of rows) {
        if (row.schema !== MATCH_SCHEMA) {
          throw new Error(`matchesRepo.putMatches writes schema ${MATCH_SCHEMA} rows only`);
        }
      }
      const byPair = new Map<string, MatchRow>();
      for (const row of rows) byPair.set(matchPairKey(row.tenantId, row.unitId), row);
      const unique = [...byPair.values()];
      const unwritten: MatchPairKey[] = [];
      for (let i = 0; i < unique.length; i += BATCH_WRITE_MAX_ITEMS) {
        const chunk = unique.slice(i, i + BATCH_WRITE_MAX_ITEMS);
        let requests: Array<{ PutRequest: { Item: MatchRow } }> = chunk.map((Item) => ({ PutRequest: { Item } }));
        try {
          for (let attempt = 0; attempt < WRITE_MAX_ATTEMPTS && requests.length > 0; attempt += 1) {
            if (attempt > 0) await sleep(BACKOFF_MS * 2 ** (attempt - 1));
            const response = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: requests } }));
            requests = (response.UnprocessedItems?.[table] ?? []) as unknown as typeof requests;
          }
        } catch (err) {
          // A request that throws is not retried: every row of this chunk not
          // yet confirmed is reported in `unwritten` as NOT CONFIRMED written
          // (the request may have applied before the error). Counts and the
          // error only.
          log.warn({ err, chunkRows: requests.length }, 'matches: BatchWrite chunk failed');
        }
        for (const request of requests) {
          unwritten.push({ tenantId: request.PutRequest.Item.tenantId, unitId: request.PutRequest.Item.unitId });
        }
      }
      if (unwritten.length > 0) {
        // Counts only - never a contact or unit id.
        log.warn({ unwritten: unwritten.length, requested: unique.length }, 'matches: BatchWrite left rows unwritten');
      }
      const written = unique.length - unwritten.length;
      if (written > 0) log.debug({ written }, 'matches written');
      return { written, unwritten };
    },

    async getPairs(keys, opts) {
      if (opts.requireComplete !== true) {
        throw new Error('matchesRepo.getPairs is a complete read only: pass { requireComplete: true }');
      }
      const found = new Map<string, MatchRow>();
      const byPair = new Map<string, { tenantId: string; unitId: string }>();
      for (const k of keys) byPair.set(matchPairKey(k.tenantId, k.unitId), { tenantId: k.tenantId, unitId: k.unitId });
      const unique = [...byPair.values()];
      for (let i = 0; i < unique.length; i += BATCH_GET_MAX_KEYS) {
        let pending = unique.slice(i, i + BATCH_GET_MAX_KEYS);
        for (let attempt = 0; attempt < READ_MAX_ATTEMPTS && pending.length > 0; attempt += 1) {
          if (attempt > 0) await sleep(BACKOFF_MS * 2 ** (attempt - 1));
          // A request that throws is an unread chunk: it propagates (complete-only).
          const response = await doc.send(
            new BatchGetCommand({ RequestItems: { [table]: { Keys: pending, ConsistentRead: true } } }),
          );
          for (const item of (response.Responses?.[table] ?? []) as unknown[]) {
            if (isCurrentMatchRow(item)) found.set(matchPairKey(item.tenantId, item.unitId), item);
          }
          pending = (response.UnprocessedKeys?.[table]?.Keys ?? []) as Array<{ tenantId: string; unitId: string }>;
        }
        if (pending.length > 0) {
          throw new IncompleteBatchReadError(pending.length, unique.length, 'matches');
        }
      }
      return found;
    },

    // Both lists walk every page with the house queryAll (page cap + WARN,
    // lib/dynamoPaging.ts) and drop legacy rows.
    async listByUnit(unitId) {
      const items = await queryAll<unknown>(
        doc,
        {
          TableName: table,
          IndexName: 'byUnit',
          KeyConditionExpression: '#unitId = :unitId',
          ExpressionAttributeNames: { '#unitId': 'unitId' },
          ExpressionAttributeValues: { ':unitId': unitId },
        },
        { logger: log },
      );
      return items.filter(isCurrentMatchRow);
    },

    async listByTenant(tenantId) {
      const items = await queryAll<unknown>(
        doc,
        {
          TableName: table,
          KeyConditionExpression: '#tenantId = :tenantId',
          ExpressionAttributeNames: { '#tenantId': 'tenantId' },
          ExpressionAttributeValues: { ':tenantId': tenantId },
          ConsistentRead: true,
        },
        { logger: log },
      );
      return items.filter(isCurrentMatchRow);
    },
  };
}
