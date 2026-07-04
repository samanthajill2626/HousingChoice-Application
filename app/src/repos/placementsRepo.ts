// placements repo (M1.10) — "one deal, tour-interest → move-in" (doc §5). A
// placement is the spine the boards hang off and the anchor a placement's relay
// group links back to (group_thread ↔ conversationId).
//
// Items stay FLEXIBLE documents — only the key (placementId) and the GSI key
// attributes are contractual (lib/tables.ts):
//   PK placementId
//   byTenant       (tenantId)
//   byUnit         (unitId)
//   byStage        (stage)               — the kanban column
//   byTourDate     (tour_date, SPARSE)   — YYYY-MM-DD; only when a tour is set
// Everything else (tour history, the four-rung application ladder, RTA/approval
// data, lease/move-in dates, the attention flag) is a free-form attribute, so
// schema churn during the build needs no migration — exactly the §5 posture.
//
// DEADLINES ARE FIRST-CLASS ITEMS NOW (placement-deadline-model refactor): the
// overloaded single next_deadline slot + its byNextDeadline GSI were RETIRED.
// Real due-dates live in the placementDeadlines table (one item per
// (placement, type); see placementDeadlinesRepo), and the internal "stuck"
// signal is DERIVED from stage_entered_at — the two no longer compete for one
// slot.
//
// SPARSE-KEY DISCIPLINE (what the in-memory fakes can't catch — the lesson from
// the broadcasts overlap bug): a sparse GSI key attribute must be ABSENT (not
// null/empty) to drop out of its index. So `update` maps an explicit `null` to a
// REMOVE (clears tour_date → drops from byTourDate).
//
// PII (doc §9): NEVER log names/phones/bodies — placementId/tenantId/unitId/stage/
// counts only.
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
import {
  TERMINAL_STAGES,
  type InspectionOutcome,
  type LostReason,
  type PlacementStage,
  type TransitionSource,
} from '../lib/statusModel.js';
import type { RepoDeps } from './conversationsRepo.js';

export { TERMINAL_STAGES };

/**
 * The real business-clock deadline types (placement-deadline-model refactor).
 * Each is a hard clock where something must actually be done by an instant:
 *   - rta_window          the landlord must submit the RTA within 48h
 *   - voucher_expiration  the tenant's voucher expires
 *   - follow_up           a staff "come back to this by X" reminder
 * Materialized as first-class placementDeadlines items (one per (placement,
 * type)). The former `tour_reminder` deadline is RETIRED (tours are first-class);
 * the former `stuck_placement` "resurface this" hook is no longer a deadline —
 * it is DERIVED from time-in-stage (see today.ts). Escalation from a failed send
 * is a separate `attention` flag, not a deadline (see PlacementItem).
 */
export const PLACEMENT_DEADLINE_TYPES = [
  'rta_window',
  'voucher_expiration',
  'follow_up',
] as const;

export type PlacementDeadlineType = (typeof PLACEMENT_DEADLINE_TYPES)[number];

const PLACEMENT_DEADLINE_TYPE_SET: ReadonlySet<string> = new Set(PLACEMENT_DEADLINE_TYPES);

/** Type guard: is `x` a known deadline type (route/repo allowlist)? */
export function isPlacementDeadlineType(x: unknown): x is PlacementDeadlineType {
  return typeof x === 'string' && PLACEMENT_DEADLINE_TYPE_SET.has(x);
}

// PlacementTour has been removed — tours are now first-class entities in the
// `tours` table (see toursRepo.ts). The placement.tours[] field had no real
// data and is retired with no migration needed.

/** Escalation flag (doc §7.1): a failed send on an ACTIVE placement → a human calls. */
export interface PlacementAttention {
  reason: string;
  /** ISO 8601 — when the flag was raised. */
  at: string;
}

/**
 * The contractual + commonly-read attributes; items stay flexible documents
 * (only placementId + the GSI keys are contractual). tenantId/unitId/stage are
 * required (the deal's parties + its board column); everything else is optional
 * and may be filled in over the life of the placement.
 */
export interface PlacementItem {
  placementId: string;
  /** byTenant GSI: the tenant contact this deal is for. */
  tenantId: string;
  /** byUnit GSI: the unit this deal is on. */
  unitId: string;
  /** byStage GSI: the stage ladder position (PLACEMENT_STAGES). */
  stage: PlacementStage;
  /**
   * byTourDate GSI (SPARSE): the CURRENT scheduled tour date, YYYY-MM-DD. Absent
   * when no tour is scheduled (cleared via update({ tour_date: null })).
   */
  tour_date?: string;
  /** The placement's relay group conversationId (set when the relay is set up). */
  group_thread?: string;
  /** Operator label, mirrored onto the relay pool number (poolNumbers tag). */
  placement_tag?: string;
  /** The four-rung application ladder — free-form object (doc §5). */
  application?: Record<string, unknown>;
  /** RTA/approval data: inspection, rent_determined + tenant_portion, LIF, denial. */
  rta?: Record<string, unknown>;
  /**
   * Status-model (§4): the inspection's first-class pass/fail OUTCOME, written
   * by the transition service on the inspection-complete move (OUT of
   * `awaiting_inspection`). A flexible-doc attribute (snake_case), NOT a GSI key
   * — no migration. The model is not a strict state machine: a `fail` does NOT
   * force a next stage (the admin routes the card).
   */
  inspection_outcome?: InspectionOutcome;
  /**
   * Status-model (§8): when the placement ENTERED its current `stage` (ISO
   * 8601) — drives time-in-stage + the "stuck too long" nudge. Stamped by the
   * transition service on every stage move.
   */
  stage_entered_at?: string;
  /** Status-model (§8): the source of the current `stage` write (provenance/precedence). */
  stage_source?: TransitionSource;
  /**
   * Why a `lost` placement was lost (STATUS-MODEL.md §7) — STRUCTURED:
   * `{ category, text }` (pick a category AND/OR free-write text). NOTE: the
   * legacy `lost_reason` was a free string; it is now this object (all readers
   * /seed/tests updated). Powers the placement calendar + surfaces on the
   * tenant.
   */
  lost_reason?: LostReason;
  /** Approval & Move-in — the LANDLORD-scheduled HQS inspection date (ISO date). */
  inspection_date?: string;
  /** Approval & Move-in — the authority's DETERMINED rent (pre-acceptance; distinct
   *  from the accepted final_rent written onto the unit on rent acceptance). */
  rent_determined?: number;
  /** Approval & Move-in — Complete-paperwork checklist (unordered). lease_signed +
   *  move_in_details are required; lif is conditional on the tenant's lifEligible
   *  and optional even then. */
  lease_signed?: boolean;
  lif?: boolean;
  move_in_details?: boolean;
  lease_date?: string;
  move_in_date?: string;
  /** Free-text placement-level note the operator keeps on the board. */
  notes?: string;
  /** Escalation flag (doc §7.1) — surfaced on the boards; cleared via update({ attention: null }). */
  attention?: PlacementAttention;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** One page of a list query (opaque cursor handled at the route). */
export interface PlacementsPage {
  items: PlacementItem[];
  lastEvaluatedKey?: Record<string, unknown>;
}

export interface ListPlacementsOpts {
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
}

/**
 * Create input: tenantId + unitId + stage are required; everything else flows
 * through as a flexible-document attribute. placementId/created_at are
 * repo-generated unless supplied (tests pass fixed ids).
 */
export type CreatePlacementInput = Partial<PlacementItem> & {
  tenantId: string;
  unitId: string;
  stage: PlacementStage;
};

export interface PlacementsRepo {
  /** Create a placement (generates placementId); returns the stored item. */
  create(input: CreatePlacementInput): Promise<PlacementItem>;
  getById(placementId: string): Promise<PlacementItem | undefined>;
  /**
   * SET-merge update: supplied fields are written, omitted fields LEFT as stored
   * (no-overwrite, same contract as units/contacts). An explicit `null` value
   * REMOVEs that attribute — the only safe way to clear a SPARSE GSI key
   * (tour_date) or the attention flag, since a key attribute must be ABSENT, not
   * null, to drop from its index. updated_at is always bumped. Returns ALL_NEW.
   * Throws ConditionalCheckFailedException for unknown placements.
   */
  update(placementId: string, patch: Record<string, unknown>): Promise<PlacementItem>;
  /** All placements for a tenant via the byTenant GSI. */
  listByTenant(tenantId: string, opts?: ListPlacementsOpts): Promise<PlacementsPage>;
  /** All placements on a unit via the byUnit GSI. */
  listByUnit(unitId: string, opts?: ListPlacementsOpts): Promise<PlacementsPage>;
  /** All placements in a stage via the byStage GSI (one kanban column / RTA board). */
  listByStage(stage: PlacementStage, opts?: ListPlacementsOpts): Promise<PlacementsPage>;
  /** All placements whose CURRENT tour is on a given date via the byTourDate GSI. */
  listByTourDate(tourDate: string, opts?: ListPlacementsOpts): Promise<PlacementsPage>;
  /**
   * Unfiltered paginated Scan — the board's "all placements" fallback. ACCEPTED
   * at this scale (doc §5.1: the working set is hundreds of small items).
   * Targeted views use the GSIs (a Query) instead; this Scan is the no-filter
   * fallback.
   */
  list(opts?: ListPlacementsOpts): Promise<PlacementsPage>;
}

export function createPlacementsRepo(deps: RepoDeps = {}): PlacementsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('placements', deps.env);
  const log = deps.logger ?? defaultLogger;

  async function getById(placementId: string): Promise<PlacementItem | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { placementId } }));
    return Item as PlacementItem | undefined;
  }

  /** Shared single-key GSI query (one partition, optional pagination). */
  async function queryIndex(
    indexName: string,
    keyName: string,
    keyValue: string,
    opts: ListPlacementsOpts,
  ): Promise<PlacementsPage> {
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
      items: (Items ?? []) as PlacementItem[],
      ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
    };
  }

  return {
    async create(input) {
      const now = new Date().toISOString();
      const createdAt = typeof input.created_at === 'string' ? input.created_at : now;
      const item: PlacementItem = {
        ...input,
        placementId: input.placementId ?? `placement-${randomUUID()}`,
        created_at: createdAt,
        updated_at: now,
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          // Defensive: never silently overwrite an existing placement on create.
          ConditionExpression: 'attribute_not_exists(placementId)',
        }),
      );
      log.info(
        { placementId: item.placementId, tenantId: item.tenantId, unitId: item.unitId, stage: item.stage },
        'placement created',
      );
      return item;
    },

    getById,

    async update(placementId, patch) {
      // SET each supplied non-null field; REMOVE each explicit-null field (the
      // only way to clear a sparse GSI key / the attention flag — a key
      // attribute must be ABSENT, not null, to drop from its index). Names are
      // expression-aliased so reserved words (`status`, etc.) are always legal.
      // updated_at is always bumped.
      const sets: string[] = [];
      const removes: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      let i = 0;
      for (const [key, value] of Object.entries(patch)) {
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
      names['#updatedAt'] = 'updated_at';
      values[':updatedAt'] = new Date().toISOString();
      sets.push('#updatedAt = :updatedAt');

      const clauses = [`SET ${sets.join(', ')}`];
      if (removes.length > 0) clauses.push(`REMOVE ${removes.join(', ')}`);

      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { placementId },
          UpdateExpression: clauses.join(' '),
          ConditionExpression: 'attribute_exists(placementId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ placementId, setFields: sets.length - 1, removedFields: removes.length }, 'placement updated');
      return Attributes as PlacementItem;
    },

    async listByTenant(tenantId, opts = {}) {
      return queryIndex('byTenant', 'tenantId', tenantId, opts);
    },

    async listByUnit(unitId, opts = {}) {
      return queryIndex('byUnit', 'unitId', unitId, opts);
    },

    async listByStage(stage, opts = {}) {
      return queryIndex('byStage', 'stage', stage, opts);
    },

    async listByTourDate(tourDate, opts = {}) {
      return queryIndex('byTourDate', 'tour_date', tourDate, opts);
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
        items: (Items ?? []) as PlacementItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },
  };
}

/** Re-export so callers needn't import ConditionalCheckFailedException separately. */
export { ConditionalCheckFailedException };
