// units repo (M1.5) — landlord properties: the listings the share-broadcast
// (M1.6) fans out and the flyer endpoint exposes a safe subset of (doc §5).
//
// Items stay FLEXIBLE documents — only keys + GSI key attributes are
// contractual (lib/tables.ts): PK unitId, plus the byLandlord (landlordId),
// byStatus (status) and byJurisdiction (jurisdiction) GSIs. Everything else
// (rents, beds, the never-standardized per-property tour/application processes)
// is a free-form attribute, so schema churn during the build needs no
// migration — exactly the §5 posture.
//
// NO GEOCODING (kickoff "no geocoding — out of scope"): `address` is free text
// and `jurisdiction` is a plain string the operator sets; §5's "geocoded
// address" is intentionally NOT implemented here (README deviation row).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  ScanCommand,
  type ScanCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

/**
 * Unit lifecycle status (byStatus GSI hash; also gates the public flyer). The
 * doc gives examples, not a closed enum (units are flexible documents), but the
 * codebase WRITES exactly these — the route allowlists them so the GSI
 * partition key never takes an arbitrary value. 'available' is the only
 * publicly shareable status (see SHAREABLE_STATUSES).
 */
export type UnitStatus = 'available' | 'placed' | 'inactive';

export const UNIT_STATUSES: readonly UnitStatus[] = ['available', 'placed', 'inactive'] as const;

/** Statuses whose unit may be exposed by the public flyer endpoint. */
export const SHAREABLE_STATUSES: ReadonlySet<string> = new Set<UnitStatus>(['available']);

/**
 * The contractual + commonly read attributes; items stay flexible documents
 * (only unitId + the three GSI keys are contractual). All listing facts are
 * optional — a unit can be created as a stub and filled in over time, exactly
 * like a contact.
 */
export interface UnitItem {
  unitId: string;
  /** byLandlord GSI: the owning landlord's contactId (a contacts row). */
  landlordId: string;
  /** byStatus GSI: lifecycle status (UNIT_STATUSES). */
  status: string;
  /** byJurisdiction GSI: the primary HCV jurisdiction string (free text, no geocoding). */
  jurisdiction?: string;
  /** Free-text street address — NO geocoding (out of scope, kickoff). */
  address?: string;
  /** HCV programs this unit accepts (e.g. GHV, Step Up); §13 question pending. */
  accepted_programs?: string[];
  beds?: number;
  baths?: number;
  /** Sub-market / neighborhood label (free text). */
  area?: string;
  subzone?: string;
  rent_min?: number;
  rent_max?: number;
  payment_standard?: number;
  deposit?: number;
  /** Landlord incentive fee (LIF). */
  lif?: number;
  /** Utilities arrangement — free-form (string). */
  utilities?: string;
  /** Accessibility notes — free-form. */
  accessibility?: string;
  /** Pets policy — free-form (string or boolean). */
  pets?: string | boolean;
  /** Listing priority — free-form. */
  priority?: string;
  /** Photo/media references — S3 keys or URLs. */
  media?: string[];
  /** Public flyer link. */
  listing_link?: string;
  /** The never-standardized per-property tour process (free text). INTERNAL. */
  tour_process?: string;
  /** The never-standardized per-property application process (free text). INTERNAL. */
  application_process?: string;
  /**
   * Per-property primary voice contact for masked calling (CO1): the
   * landlord-side person a masked tenant→landlord call routes to. Stored as a
   * contactId. PENDING FOUNDER CONFIRMATION — may move to per-placement (CO1
   * notes routing comes "from the per-property process" today; a later change
   * order may relocate this onto the case/placement). INTERNAL — never exposed
   * by the public flyer.
   */
  primary_voice_contact?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** One page of a list query (opaque cursor handled at the route). */
export interface UnitsPage {
  items: UnitItem[];
  lastEvaluatedKey?: Record<string, unknown>;
}

export interface ListUnitsOpts {
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
}

/**
 * Create input: landlordId + status are required (the owning landlord and the
 * lifecycle/GSI status); everything else is optional and flows through as a
 * flexible-document attribute. unitId/created_at are repo-generated unless
 * supplied (tests pass fixed ids).
 */
export type CreateUnitInput = Partial<UnitItem> & { landlordId: string; status: string };

export interface UnitsRepo {
  /** Create a unit (generates unitId); returns the stored item. */
  create(input: CreateUnitInput): Promise<UnitItem>;
  getById(unitId: string): Promise<UnitItem | undefined>;
  /**
   * SET-merge update: only the supplied fields are written; omitted fields are
   * LEFT as stored (never blanked) — the same no-overwrite contract as
   * contactsRepo.update. Returns the post-update item (ALL_NEW). Throws
   * ConditionalCheckFailedException for unknown units.
   */
  update(unitId: string, patch: Record<string, unknown>): Promise<UnitItem>;
  /** All units for a landlord via the byLandlord GSI. */
  listByLandlord(landlordId: string, opts?: ListUnitsOpts): Promise<UnitsPage>;
  /** All units in a status via the byStatus GSI. */
  listByStatus(status: string, opts?: ListUnitsOpts): Promise<UnitsPage>;
  /** All units in a jurisdiction via the byJurisdiction GSI. */
  listByJurisdiction(jurisdiction: string, opts?: ListUnitsOpts): Promise<UnitsPage>;
  /**
   * Unfiltered list — a paginated Scan. ACCEPTED at this scale (doc §5.1: the
   * whole active-units working set is hundreds to low thousands of small
   * items). When a status filter is supplied the route uses listByStatus (a
   * Query) instead; this Scan is only the no-filter fallback. The upgrade path
   * if units ever exceed tens of thousands is the same as the matching engine's
   * (§5.1): stream-fed indexes. Commented so the Scan is a known, bounded
   * choice, not an oversight.
   */
  list(opts?: ListUnitsOpts): Promise<UnitsPage>;
}

export function createUnitsRepo(deps: RepoDeps = {}): UnitsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('units', deps.env);
  const log = deps.logger ?? defaultLogger;

  /** Shared GSI query (one partition, optional pagination). */
  async function queryIndex(
    indexName: string,
    keyName: string,
    keyValue: string,
    opts: ListUnitsOpts,
  ): Promise<UnitsPage> {
    const input: QueryCommandInput = {
      TableName: table,
      IndexName: indexName,
      KeyConditionExpression: '#k = :v',
      ExpressionAttributeNames: { '#k': keyName },
      ExpressionAttributeValues: { ':v': keyValue },
      ...(opts.limit !== undefined && { Limit: opts.limit }),
      ...(opts.exclusiveStartKey !== undefined && {
        ExclusiveStartKey: opts.exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
      }),
    };
    const { Items, LastEvaluatedKey } = await doc.send(new QueryCommand(input));
    return {
      items: (Items ?? []) as UnitItem[],
      ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
    };
  }

  return {
    async create(input) {
      const now = new Date().toISOString();
      const createdAt = typeof input.created_at === 'string' ? input.created_at : now;
      const item: UnitItem = {
        ...input,
        unitId: input.unitId ?? `unit-${randomUUID()}`,
        created_at: createdAt,
        updated_at: now,
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          // Defensive: never silently overwrite an existing unit on create.
          ConditionExpression: 'attribute_not_exists(unitId)',
        }),
      );
      log.info({ unitId: item.unitId, landlordId: item.landlordId }, 'unit created');
      return item;
    },

    async getById(unitId) {
      const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { unitId } }));
      return Item as UnitItem | undefined;
    },

    async update(unitId, patch) {
      // SET-only merge: each supplied field is written; omitted fields are
      // untouched. Names are expression-aliased so reserved words (`status`,
      // `priority`, `media`) are always legal. updated_at is always bumped.
      const sets: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      let i = 0;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const nameKey = `#k${i}`;
        const valueKey = `:v${i}`;
        names[nameKey] = key;
        values[valueKey] = value;
        sets.push(`${nameKey} = ${valueKey}`);
        i += 1;
      }
      names['#updatedAt'] = 'updated_at';
      values[':updatedAt'] = new Date().toISOString();
      sets.push('#updatedAt = :updatedAt');

      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { unitId },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(unitId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ unitId, fields: Object.keys(values).length - 1 }, 'unit updated');
      return Attributes as UnitItem;
    },

    async listByLandlord(landlordId, opts = {}) {
      return queryIndex('byLandlord', 'landlordId', landlordId, opts);
    },

    async listByStatus(status, opts = {}) {
      return queryIndex('byStatus', 'status', status, opts);
    },

    async listByJurisdiction(jurisdiction, opts = {}) {
      return queryIndex('byJurisdiction', 'jurisdiction', jurisdiction, opts);
    },

    async list(opts = {}) {
      // Paginated Scan — the no-filter fallback only (see the interface note on
      // why a Scan is acceptable at this scale, doc §5.1).
      const input: ScanCommandInput = {
        TableName: table,
        ...(opts.limit !== undefined && { Limit: opts.limit }),
        ...(opts.exclusiveStartKey !== undefined && {
          ExclusiveStartKey: opts.exclusiveStartKey as ScanCommandInput['ExclusiveStartKey'],
        }),
      };
      const { Items, LastEvaluatedKey } = await doc.send(new ScanCommand(input));
      return {
        items: (Items ?? []) as UnitItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },
  };
}

/** Re-export so callers needn't import ConditionalCheckFailedException separately. */
export { ConditionalCheckFailedException };
