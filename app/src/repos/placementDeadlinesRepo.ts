// Placement deadlines repo — first-class placement DEADLINE rows (the
// placement-deadline-model refactor). Each row is one real due-date on a
// placement: { deadlineId, placementId, type, at (ISO), _deadlinePartition }.
//
// deadlineId is DETERMINISTIC — `${placementId}#${type}` — so a placement has
// AT MOST ONE deadline per type: arming is an idempotent upsert (a PutItem
// overwrites), retiring is a DeleteItem by key (no read-before-write, no
// duplicates). Arming/retiring one type NEVER touches another (each is its own
// item) — the old "don't clobber the single next_deadline slot" arbitration is
// gone entirely.
//
// GSI byPlacement: hash=placementId — all deadlines for a placement (card/detail
// display + terminal clear).
// GSI byDueAt: hash='deadlines' (fixed partition _deadlinePartition),
// range=at (ISO) — "all due deadlines" in ONE soonest-first Query (the Today
// queue). Clones the placementNudges/tours byDueAt shape.
//
// PII (doc §9): logs are placementId/type/at/counts only — never names/phones.
import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { PlacementDeadlineType } from './placementsRepo.js';
import type { RepoDeps } from './conversationsRepo.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlacementDeadlineItem {
  /** PK — DETERMINISTIC `${placementId}#${type}`. */
  deadlineId: string;
  /** byPlacement GSI hash key. */
  placementId: string;
  type: PlacementDeadlineType;
  /** ISO 8601 — byDueAt GSI range key (the due instant). */
  at: string;
  /** byDueAt GSI hash key (fixed value 'deadlines'). */
  _deadlinePartition: 'deadlines';
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/** The soonest of a placement's deadlines (the computed card/SSE shape). */
export interface SoonestDeadline {
  type: PlacementDeadlineType;
  /** ISO 8601. */
  at: string;
}

/** byDueAt query options: bound the range, cap, and page. */
export interface ListDueOpts {
  /** Sort by `at`; default ascending (soonest first). */
  scanIndexForward?: boolean;
  limit?: number;
}

/** The deterministic PK for a (placement, type) deadline. */
export function deadlineIdFor(placementId: string, type: PlacementDeadlineType): string {
  return `${placementId}#${type}`;
}

/**
 * Pure helper: the SOONEST of a placement's deadline items (min by Date.parse of
 * `at`; ties break by type for a deterministic total order), or null when the
 * placement has no deadlines. The card/detail serializer + SSE event source this.
 */
export function soonestDeadline(items: readonly PlacementDeadlineItem[]): SoonestDeadline | null {
  let best: PlacementDeadlineItem | undefined;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const ms = Date.parse(item.at);
    if (Number.isNaN(ms)) continue; // never let a junk `at` win
    if (ms < bestMs || (ms === bestMs && (best === undefined || item.type < best.type))) {
      best = item;
      bestMs = ms;
    }
  }
  return best === undefined ? null : { type: best.type, at: best.at };
}

export interface PlacementDeadlinesRepo {
  /** Arm (idempotent upsert) a (placement, type) deadline at `at` (ISO). */
  arm(placementId: string, type: PlacementDeadlineType, at: string): Promise<PlacementDeadlineItem>;
  /** Retire a (placement, type) deadline — no-op if absent. */
  retire(placementId: string, type: PlacementDeadlineType): Promise<void>;
  /** All deadline rows for a placement (byPlacement GSI). */
  listByPlacement(placementId: string): Promise<PlacementDeadlineItem[]>;
  /** Delete ALL of a placement's deadlines (terminal close). */
  clearForPlacement(placementId: string): Promise<void>;
  /** Every deadline due AT or BEFORE `now`, soonest-first (byDueAt). Paginated. */
  listDue(nowIso: string, opts?: ListDueOpts): Promise<PlacementDeadlineItem[]>;
  /** Every pending deadline in the partition, soonest-first (byDueAt). Paginated. */
  listAllPending(opts?: ListDueOpts): Promise<PlacementDeadlineItem[]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlacementDeadlinesRepo(deps: RepoDeps = {}): PlacementDeadlinesRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('placementDeadlines', deps.env);
  const log = deps.logger ?? defaultLogger;

  /**
   * Shared byDueAt query walk. `beforeAt` bounds the range to due-now; absent =
   * the whole partition. Pages via LastEvaluatedKey so rows beyond the 1 MB
   * DynamoDB page limit are not silently dropped (mirrors placementNudges.listDue).
   */
  async function queryByDueAt(
    beforeAt: string | undefined,
    opts: ListDueOpts,
  ): Promise<PlacementDeadlineItem[]> {
    const hasBefore = typeof beforeAt === 'string';
    const baseInput: QueryCommandInput = {
      TableName: table,
      IndexName: 'byDueAt',
      KeyConditionExpression: hasBefore ? '#dp = :dp AND #at <= :now' : '#dp = :dp',
      ExpressionAttributeNames: hasBefore
        ? { '#dp': '_deadlinePartition', '#at': 'at' }
        : { '#dp': '_deadlinePartition' },
      ExpressionAttributeValues: hasBefore
        ? { ':dp': 'deadlines', ':now': beforeAt }
        : { ':dp': 'deadlines' },
      ScanIndexForward: opts.scanIndexForward ?? true,
      ...(opts.limit !== undefined && { Limit: opts.limit }),
    };
    const items: PlacementDeadlineItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await doc.send(
        new QueryCommand({
          ...baseInput,
          ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
        }),
      );
      items.push(...((page.Items as PlacementDeadlineItem[] | undefined) ?? []));
      exclusiveStartKey = page.LastEvaluatedKey;
      // Respect an explicit cap across pages (bounded worklist read).
      if (opts.limit !== undefined && items.length >= opts.limit) {
        return items.slice(0, opts.limit);
      }
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  async function listByPlacement(placementId: string): Promise<PlacementDeadlineItem[]> {
    const input: QueryCommandInput = {
      TableName: table,
      IndexName: 'byPlacement',
      KeyConditionExpression: '#p = :p',
      ExpressionAttributeNames: { '#p': 'placementId' },
      ExpressionAttributeValues: { ':p': placementId },
    };
    const { Items } = await doc.send(new QueryCommand(input));
    return (Items ?? []) as PlacementDeadlineItem[];
  }

  return {
    async arm(placementId, type, at) {
      const now = new Date().toISOString();
      const item: PlacementDeadlineItem = {
        deadlineId: deadlineIdFor(placementId, type),
        placementId,
        type,
        at,
        _deadlinePartition: 'deadlines',
        createdAt: now,
        updatedAt: now,
      };
      // Idempotent upsert (NO condition): re-arming a type overwrites its single
      // deterministic-id row — never a duplicate.
      await doc.send(new PutCommand({ TableName: table, Item: item }));
      log.info({ placementId, type, at }, 'placement deadline armed');
      return item;
    },

    async retire(placementId, type) {
      await doc.send(
        new DeleteCommand({
          TableName: table,
          Key: { deadlineId: deadlineIdFor(placementId, type) },
        }),
      );
      log.info({ placementId, type }, 'placement deadline retired');
    },

    listByPlacement,

    async clearForPlacement(placementId) {
      const rows = await listByPlacement(placementId);
      // Promise.allSettled so one lost delete does not abort the rest (mirrors
      // placementNudgesRepo.cancelForPlacement).
      const results = await Promise.allSettled(
        rows.map((r) =>
          doc.send(new DeleteCommand({ TableName: table, Key: { deadlineId: r.deadlineId } })),
        ),
      );
      let cleared = 0;
      for (const result of results) {
        if (result.status === 'fulfilled') cleared += 1;
        else log.error({ err: result.reason, placementId }, 'placement deadline clear: row delete failed');
      }
      log.info({ placementId, cleared }, 'placement deadlines cleared for placement');
    },

    async listDue(nowIso, opts = {}) {
      return queryByDueAt(nowIso, opts);
    },

    async listAllPending(opts = {}) {
      return queryByDueAt(undefined, opts);
    },
  };
}
