// tours repo — first-class Tour entity (Tours feature).
//
// A Tour is a scheduled visit by a tenant to a unit. Tours are INDEPENDENT of
// placements: a tenant stays `searching` during the touring process; no touring
// stage. Tour status starts as 'scheduled' (if scheduledAt is provided) or
// 'requested' (if scheduledAt is absent — a time-less tour request). The exit
// gate captures `outcome`, `moveForward`, and `convertible` and leaves
// placement creation to the operator.
//
// GSIs:
//   byTenant      — all tours for a tenant (contact-file tours card)
//   byUnit        — all tours for a unit (property-file tours card)
//   byScheduledAt — time-windowed queries (today's tours, reminder/no-show clock).
//                   Hash key is the constant '_schedPartition = "tours"' so a
//                   datetime-range BETWEEN Query works without scatter-gather.
//                   Sparse: items without scheduledAt never appear here.
//   byStatus      — list all tours by status (e.g. all 'requested' tours for the
//                   dashboard queue). Hash key is 'status', range key is
//                   'createdAt' (ISO 8601, newest-last for BETWEEN pagination).
//
// Mirror of unitsRepo.ts conventions: RepoDeps DI, tableName(), PutCommand with
// existence guard, UpdateCommand SET/REMOVE loop, QueryCommand helpers.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three ways a tour can be conducted. */
export type TourType = 'self_guided' | 'landlord_led' | 'pm_team';

/** Tour status — mirrors TOUR_STATUSES in lib/toursModel.ts. */
export type TourStatus = string;

/** Exit-gate outcome (mirrors lib/toursModel.ts TOUR_OUTCOMES). */
export type TourOutcome = 'move_forward' | 'not_a_fit';

/**
 * One scheduled (or completed) tour: a tenant visiting a unit.
 *
 * Key/GSI attributes (contractual — changing these is a schema change):
 *   tourId           — table PK
 *   tenantId         — byTenant GSI hash
 *   unitId           — byUnit GSI hash
 *   _schedPartition  — byScheduledAt GSI hash (constant 'tours')
 *   scheduledAt      — byScheduledAt GSI range (sparse: absent → not indexed)
 *   status           — byStatus GSI hash
 *   createdAt        — byStatus GSI range
 */
export interface TourItem {
  tourId: string;
  /** byTenant GSI hash: the tenant's contactId. */
  tenantId: string;
  /** byUnit GSI hash: the unit being toured. */
  unitId: string;
  /**
   * ISO 8601 datetime of the scheduled visit. byScheduledAt GSI range.
   * Absent on a `requested` (timeless) tour — the attribute is OMITTED, never
   * written as undefined/null, so the sparse GSI does not index it.
   */
  scheduledAt?: string;
  /** Fixed constant 'tours' — byScheduledAt GSI hash partition key. */
  _schedPartition: 'tours';
  tourType: TourType;
  /** Lifecycle status. */
  status: TourStatus;
  /** Optional: the relay group conversationId for the tour thread. */
  groupThreadId?: string;
  /** Post-tour outcome. Absent until the tour resolves. */
  outcome?: TourOutcome;
  /** Navigator decision: move forward toward placement? Absent until exit gate. */
  moveForward?: boolean;
  /** Navigator note: convertible to a placement? Absent until exit gate. */
  convertible?: boolean;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/**
 * Input for creating a tour. tourId/createdAt/updatedAt/_schedPartition are
 * repo-generated. tenantId, unitId, and tourType are required; scheduledAt is
 * optional (absent → status 'requested'; present → status 'scheduled'); a
 * caller-supplied status always wins.
 */
export type CreateTourInput = Partial<TourItem> & {
  tenantId: string;
  unitId: string;
  /** Optional: absent → status defaults to 'requested'; present → 'scheduled'. */
  scheduledAt?: string;
  tourType: TourType;
};

/** Patch input: all fields optional except tourId (supplied as the first arg). */
export type PatchTourInput = Partial<
  Omit<TourItem, 'tourId' | '_schedPartition' | 'createdAt' | 'updatedAt'>
>;

export interface ToursRepo {
  /** Create a tour (generates tourId); returns the stored item. */
  create(input: CreateTourInput): Promise<TourItem>;
  /** Get a tour by id; undefined when not found. */
  get(tourId: string): Promise<TourItem | undefined>;
  /** All tours for a tenant via the byTenant GSI. */
  listByTenant(tenantId: string): Promise<TourItem[]>;
  /** All tours for a unit via the byUnit GSI. */
  listByUnit(unitId: string): Promise<TourItem[]>;
  /**
   * Tours whose scheduledAt is in [from, to] (inclusive ISO 8601 range) via
   * the byScheduledAt GSI. Powers "tours today", reminder sweeps, no-show checks.
   */
  listByScheduledRange(from: string, to: string): Promise<TourItem[]>;
  /**
   * All tours with the given status via the byStatus GSI (hash=status,
   * range=createdAt). Returns all pages concatenated (no cursor — dashboard
   * use; volumes are expected to remain low in Phase 1).
   */
  listByStatus(status: string): Promise<TourItem[]>;
  /**
   * SET-merge patch: only supplied fields are written; omitted fields are LEFT as
   * stored (no-overwrite contract). updatedAt is always bumped. Throws
   * ConditionalCheckFailedException when the tourId does not exist.
   * Returns the post-patch item (ALL_NEW).
   */
  patch(tourId: string, updates: PatchTourInput): Promise<TourItem>;
  /**
   * Atomically CLAIM the tour's group-thread slot (relay provisioning): sets
   * groupThreadId to `value` ONLY when none exists yet. Throws
   * ConditionalCheckFailedException when the slot is already taken (or the
   * tour is missing) — the atomic half of the one-thread-per-tour guard, so
   * two concurrent provisions can never both buy a pool number.
   */
  claimGroupThread(tourId: string, value: string): Promise<void>;
  /**
   * Release a claim made by claimGroupThread when provisioning FAILS: removes
   * groupThreadId ONLY while it still equals `value` (never clobbers a real
   * conversation id written since). Best-effort — a lost condition is a no-op.
   */
  releaseGroupThreadClaim(tourId: string, value: string): Promise<void>;
  /**
   * Atomically CLAIM the tour's conversion slot (Post-Tour → placement): sets
   * convertedPlacementId to `value` ONLY when none exists yet. Throws
   * ConditionalCheckFailedException when the slot is already taken (or the tour
   * is missing) — the atomic half of the one-placement-per-tour guard, so two
   * concurrent POST /from-tour requests can never both create a placement
   * (mirror of claimGroupThread).
   */
  claimConversion(tourId: string, value: string): Promise<void>;
  /**
   * Release a conversion claim made by claimConversion when the conversion
   * FAILS before finalize: removes convertedPlacementId ONLY while it still
   * equals `value` (never clobbers the finalized placementId, or a newer claim,
   * written since). Best-effort — a lost condition is a no-op.
   */
  releaseConversionClaim(tourId: string, value: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createToursRepo(deps: RepoDeps = {}): ToursRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('tours', deps.env);
  const log = deps.logger ?? defaultLogger;

  /** Shared single-partition GSI query (no range). */
  async function queryGsi(
    indexName: string,
    hashKeyName: string,
    hashKeyValue: string,
  ): Promise<TourItem[]> {
    const input: QueryCommandInput = {
      TableName: table,
      IndexName: indexName,
      KeyConditionExpression: '#hk = :hv',
      ExpressionAttributeNames: { '#hk': hashKeyName },
      ExpressionAttributeValues: { ':hv': hashKeyValue },
    };
    const { Items } = await doc.send(new QueryCommand(input));
    return (Items ?? []) as TourItem[];
  }

  return {
    async create(input) {
      const now = new Date().toISOString();
      const createdAt = typeof input.createdAt === 'string' ? input.createdAt : now;
      // Default status: 'requested' when no scheduledAt is provided (time-less
      // tour request); 'scheduled' when scheduledAt is supplied. A caller-supplied
      // status always wins (repo tests may pass an explicit status for seeding).
      const defaultStatus = typeof input.scheduledAt === 'string' ? 'scheduled' : 'requested';
      // Build the item WITHOUT scheduledAt when it is absent so the sparse
      // byScheduledAt GSI never indexes a 'requested' tour.
      const { scheduledAt: rawScheduledAt, ...restInput } = input;
      const item: TourItem = {
        ...restInput,
        tourId: input.tourId ?? `tour-${randomUUID()}`,
        _schedPartition: 'tours',
        status: input.status ?? defaultStatus,
        createdAt,
        updatedAt: now,
        // Only include scheduledAt when it is a non-empty string.
        ...(typeof rawScheduledAt === 'string' ? { scheduledAt: rawScheduledAt } : {}),
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          // Defensive: never silently overwrite an existing tour on create.
          ConditionExpression: 'attribute_not_exists(tourId)',
        }),
      );
      log.info({ tourId: item.tourId, tenantId: item.tenantId, unitId: item.unitId }, 'tour created');
      return item;
    },

    async get(tourId) {
      const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { tourId } }));
      return Item as TourItem | undefined;
    },

    async listByTenant(tenantId) {
      return queryGsi('byTenant', 'tenantId', tenantId);
    },

    async listByUnit(unitId) {
      return queryGsi('byUnit', 'unitId', unitId);
    },

    async listByScheduledRange(from, to) {
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byScheduledAt',
        KeyConditionExpression: '#sp = :sp AND #sat BETWEEN :from AND :to',
        ExpressionAttributeNames: {
          '#sp': '_schedPartition',
          '#sat': 'scheduledAt',
        },
        ExpressionAttributeValues: {
          ':sp': 'tours',
          ':from': from,
          ':to': to,
        },
      };
      const { Items } = await doc.send(new QueryCommand(input));
      return (Items ?? []) as TourItem[];
    },

    async listByStatus(status) {
      // Paginate the byStatus GSI (hash=status, range=createdAt). DynamoDB
      // returns at most 1 MB per page; follow ExclusiveStartKey until exhausted.
      const all: TourItem[] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const input: QueryCommandInput = {
          TableName: table,
          IndexName: 'byStatus',
          KeyConditionExpression: '#st = :st',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':st': status },
          ...(lastKey !== undefined && { ExclusiveStartKey: lastKey }),
        };
        const { Items, LastEvaluatedKey } = await doc.send(new QueryCommand(input));
        all.push(...((Items ?? []) as TourItem[]));
        lastKey = LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey !== undefined);
      return all;
    },

    async patch(tourId, updates) {
      // SET each supplied non-null field; REMOVE each explicit-null field
      // (the only way to truly clear an attribute). Omitted (undefined) fields
      // are LEFT untouched. Names are expression-aliased so reserved words are
      // always legal. updatedAt is always bumped.
      const sets: string[] = [];
      const removes: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      let i = 0;
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) continue; // omitted → untouched
        const nameKey = `#k${i}`;
        names[nameKey] = key;
        if (value === null) {
          removes.push(nameKey);
        } else {
          const valueKey = `:v${i}`;
          values[valueKey] = value;
          sets.push(`${nameKey} = ${valueKey}`);
        }
        i += 1;
      }
      names['#updatedAt'] = 'updatedAt';
      values[':updatedAt'] = new Date().toISOString();
      sets.push('#updatedAt = :updatedAt');

      const clauses = [`SET ${sets.join(', ')}`];
      if (removes.length > 0) clauses.push(`REMOVE ${removes.join(', ')}`);

      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { tourId },
          UpdateExpression: clauses.join(' '),
          ConditionExpression: 'attribute_exists(tourId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ tourId, fields: sets.length - 1 + removes.length }, 'tour patched');
      return Attributes as TourItem;
    },

    async claimGroupThread(tourId, value) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { tourId },
          UpdateExpression: 'SET #gt = :v, #updatedAt = :now',
          // Atomic one-thread-per-tour: only the FIRST claimant wins; a
          // concurrent provision loses here BEFORE any pool number is bought.
          ConditionExpression: 'attribute_exists(tourId) AND attribute_not_exists(#gt)',
          ExpressionAttributeNames: { '#gt': 'groupThreadId', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':v': value, ':now': new Date().toISOString() },
        }),
      );
      log.info({ tourId }, 'tour group-thread slot claimed');
    },

    async releaseGroupThreadClaim(tourId, value) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { tourId },
            UpdateExpression: 'REMOVE #gt SET #updatedAt = :now',
            // Only release OUR claim — never clobber a real conversation id
            // (or another claimant) written since.
            ConditionExpression: '#gt = :v',
            ExpressionAttributeNames: { '#gt': 'groupThreadId', '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: { ':v': value, ':now': new Date().toISOString() },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ tourId }, 'group-thread claim release lost (superseded) — no-op');
          return;
        }
        throw err;
      }
      log.info({ tourId }, 'tour group-thread claim released (provisioning failed)');
    },

    async claimConversion(tourId, value) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { tourId },
          UpdateExpression: 'SET #cp = :v, #updatedAt = :now',
          // Atomic one-placement-per-tour: only the FIRST claimant wins; a
          // concurrent /from-tour POST loses here BEFORE any placement row is
          // created (mirrors claimGroupThread).
          ConditionExpression: 'attribute_exists(tourId) AND attribute_not_exists(#cp)',
          ExpressionAttributeNames: { '#cp': 'convertedPlacementId', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':v': value, ':now': new Date().toISOString() },
        }),
      );
      log.info({ tourId }, 'tour conversion slot claimed');
    },

    async releaseConversionClaim(tourId, value) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { tourId },
            UpdateExpression: 'REMOVE #cp SET #updatedAt = :now',
            // Only release OUR sentinel — never clobber the finalized
            // placementId (or a newer claim) written since.
            ConditionExpression: '#cp = :v',
            ExpressionAttributeNames: { '#cp': 'convertedPlacementId', '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: { ':v': value, ':now': new Date().toISOString() },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ tourId }, 'conversion claim release lost (superseded) — no-op');
          return;
        }
        throw err;
      }
      log.info({ tourId }, 'tour conversion claim released (conversion failed)');
    },
  };
}

/** Re-export so callers needn't import ConditionalCheckFailedException separately. */
export { ConditionalCheckFailedException };
