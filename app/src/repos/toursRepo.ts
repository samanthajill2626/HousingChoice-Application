// tours repo — first-class Tour entity (Tours feature).
//
// A Tour is a scheduled visit by a tenant to a unit. Tours are INDEPENDENT of
// placements: a tenant stays `searching` during the touring process; no touring
// stage. Tour status starts as 'scheduled' and evolves via the status model
// (Task 2 adds the full enum + guards; for now the field is a plain string so
// the repo compiles independently). The exit gate captures `outcome`,
// `moveForward`, and `convertible` and leaves placement creation to the
// operator.
//
// GSIs:
//   byTenant      — all tours for a tenant (contact-file tours card)
//   byUnit        — all tours for a unit (property-file tours card)
//   byScheduledAt — time-windowed queries (today's tours, reminder/no-show clock).
//                   Hash key is the constant '_schedPartition = "tours"' so a
//                   datetime-range BETWEEN Query works without scatter-gather.
//                   Sparse: items without scheduledAt never appear here.
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

/** Tour status — string-typed for now; Task 2 adds the full enum + guards. */
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
  /** Lifecycle status (string for now; Task 2 narrows to TourStatus enum). */
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
 * optional (omitted for a timeless `requested` tour); status defaults to
 * 'scheduled' when not supplied.
 */
export type CreateTourInput = Partial<TourItem> & {
  tenantId: string;
  unitId: string;
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
   * SET-merge patch: only supplied fields are written; omitted fields are LEFT as
   * stored (no-overwrite contract). updatedAt is always bumped. Throws
   * ConditionalCheckFailedException when the tourId does not exist.
   * Returns the post-patch item (ALL_NEW).
   */
  patch(tourId: string, updates: PatchTourInput): Promise<TourItem>;
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
      const item: TourItem = {
        ...input,
        tourId: input.tourId ?? `tour-${randomUUID()}`,
        _schedPartition: 'tours',
        status: input.status ?? 'scheduled',
        createdAt,
        updatedAt: now,
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
  };
}

/** Re-export so callers needn't import ConditionalCheckFailedException separately. */
export { ConditionalCheckFailedException };
