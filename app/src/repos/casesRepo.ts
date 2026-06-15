// cases repo (M1.10) — "one deal, tour-interest → move-in" (doc §5). A case is
// the spine the boards hang off and the anchor a placement's relay group links
// back to (group_thread ↔ conversationId).
//
// Items stay FLEXIBLE documents — only the key (caseId) and the GSI key
// attributes are contractual (lib/tables.ts):
//   PK caseId
//   byTenant       (tenantId)
//   byUnit         (unitId)
//   byStage        (stage)               — the kanban column
//   byTourDate     (tour_date, SPARSE)   — YYYY-MM-DD; only when a tour is set
//   byNextDeadline (next_deadline_type + next_deadline_at, SPARSE composite)
//                                         — "what needs attention right now?"
// Everything else (tour history, the four-rung application ladder, RTA/approval
// data, lease/move-in dates, the attention flag) is a free-form attribute, so
// schema churn during the build needs no migration — exactly the §5 posture.
//
// SPARSE-KEY DISCIPLINE (what the in-memory fakes can't catch — the lesson from
// the broadcasts overlap bug): a sparse GSI key attribute must be ABSENT (not
// null/empty) to drop out of its index, and a COMPOSITE sparse key
// (next_deadline_type + next_deadline_at) must be set/cleared BOTH-or-NEITHER or
// the index row is malformed. So `update` maps an explicit `null` to a REMOVE
// (clears tour_date → drops from byTourDate), and the next_deadline pair only
// moves through `setNextDeadline`, which writes or removes both atomically.
//
// PII (doc §9): NEVER log names/phones/bodies — caseId/tenantId/unitId/stage/
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
import type { RepoDeps } from './conversationsRepo.js';

/**
 * The stage ladder (doc §5): one deal from tour-interest to move-in. `porting`
 * is the branch opened only when a match is MATCH_WITH_PORTABILITY_REQUIRED;
 * `moved_in` is the happy terminal and `lost` the negative one (reachable from
 * any stage). Phase 1 is MANUAL — the operator sets the stage; the route
 * allowlists these values so the byStage GSI partition key never takes an
 * arbitrary string. This is an ordered list, not a strict state machine: the
 * porting branch and an any-stage `lost` make a hard transition graph the wrong
 * model for hand-touched parity work.
 */
export const CASE_STAGES = [
  'interested',
  'porting',
  'touring',
  'applied',
  'rta_submitted',
  'inspection',
  'rent_determined',
  'lease',
  'moved_in',
  'lost',
] as const;

export type CaseStage = (typeof CASE_STAGES)[number];

const CASE_STAGE_SET: ReadonlySet<string> = new Set(CASE_STAGES);

/** Type guard: is `x` a known case stage (route allowlist for the byStage key)? */
export function isCaseStage(x: unknown): x is CaseStage {
  return typeof x === 'string' && CASE_STAGE_SET.has(x);
}

/** Terminal stages — a case here is no longer "active" on the boards. */
export const TERMINAL_STAGES: ReadonlySet<CaseStage> = new Set<CaseStage>(['moved_in', 'lost']);

/**
 * The business-clock deadline types (doc §5: "voucher expiration, the RTA
 * 48-hour window, stuck-case alerts, tour reminders"). A case carries at most
 * ONE next_deadline — the single most-urgent pending clock — so the
 * byNextDeadline GSI answers "what needs attention right now?" in one query per
 * type. Bounded so the GSI partition key stays queryable. (Escalation from a
 * failed send is a separate `attention` flag, not a deadline — see CaseItem.)
 */
export const CASE_DEADLINE_TYPES = [
  'tour_reminder',
  'rta_window',
  'voucher_expiration',
  'stuck_case',
  'follow_up',
] as const;

export type CaseDeadlineType = (typeof CASE_DEADLINE_TYPES)[number];

const CASE_DEADLINE_TYPE_SET: ReadonlySet<string> = new Set(CASE_DEADLINE_TYPES);

/** Type guard: is `x` a known deadline type (route allowlist for the GSI key)? */
export function isCaseDeadlineType(x: unknown): x is CaseDeadlineType {
  return typeof x === 'string' && CASE_DEADLINE_TYPE_SET.has(x);
}

/** A scheduled tour, current or historical. */
export interface CaseTour {
  /** YYYY-MM-DD (the byTourDate key shape when this is the current tour). */
  date: string;
  /** Free-form outcome once the tour happens (e.g. 'attended', 'no_show'). */
  outcome?: string;
  notes?: string;
}

/** Escalation flag (doc §7.1): a failed send on an ACTIVE case → a human calls. */
export interface CaseAttention {
  reason: string;
  /** ISO 8601 — when the flag was raised. */
  at: string;
}

/** The next business-clock deadline (the byNextDeadline composite key pair). */
export interface CaseDeadline {
  type: CaseDeadlineType;
  /** ISO 8601. */
  at: string;
}

/**
 * The contractual + commonly-read attributes; items stay flexible documents
 * (only caseId + the GSI keys are contractual). tenantId/unitId/stage are
 * required (the deal's parties + its board column); everything else is optional
 * and may be filled in over the life of the case.
 */
export interface CaseItem {
  caseId: string;
  /** byTenant GSI: the tenant contact this deal is for. */
  tenantId: string;
  /** byUnit GSI: the unit this deal is on. */
  unitId: string;
  /** byStage GSI: the stage ladder position (CASE_STAGES). */
  stage: CaseStage;
  /**
   * byTourDate GSI (SPARSE): the CURRENT scheduled tour date, YYYY-MM-DD. Absent
   * when no tour is scheduled (cleared via update({ tour_date: null })).
   */
  tour_date?: string;
  /** byNextDeadline GSI (SPARSE composite hash): set/cleared via setNextDeadline. */
  next_deadline_type?: CaseDeadlineType;
  /** byNextDeadline GSI (SPARSE composite range), ISO 8601: set via setNextDeadline. */
  next_deadline_at?: string;
  /** The placement's relay group conversationId (set when the relay is set up). */
  group_thread?: string;
  /** Operator label, mirrored onto the relay pool number (poolNumbers tag). */
  placement_tag?: string;
  /** Tour history (the current tour is also reflected in tour_date). */
  tours?: CaseTour[];
  /** The four-rung application ladder — free-form object (doc §5). */
  application?: Record<string, unknown>;
  /** RTA/approval data: inspection, rent_determined + tenant_portion, LIF, denial. */
  rta?: Record<string, unknown>;
  /** Why a `lost` case was lost (e.g. 'changed_mind') — powers the placement calendar. */
  lost_reason?: string;
  lease_date?: string;
  move_in_date?: string;
  /** Free-text case-level note the operator keeps on the board. */
  notes?: string;
  /** Escalation flag (doc §7.1) — surfaced on the boards; cleared via update({ attention: null }). */
  attention?: CaseAttention;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** One page of a list query (opaque cursor handled at the route). */
export interface CasesPage {
  items: CaseItem[];
  lastEvaluatedKey?: Record<string, unknown>;
}

export interface ListCasesOpts {
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
}

/** byNextDeadline query options: bound the range to "due by" a cutoff. */
export interface ListByNextDeadlineOpts extends ListCasesOpts {
  /** Only deadlines AT or BEFORE this ISO 8601 instant (the "due now" window). */
  beforeAt?: string;
  /** Sort by next_deadline_at; default ascending (soonest first). */
  scanIndexForward?: boolean;
}

/**
 * Create input: tenantId + unitId + stage are required; everything else flows
 * through as a flexible-document attribute. caseId/created_at are repo-generated
 * unless supplied (tests pass fixed ids).
 */
export type CreateCaseInput = Partial<CaseItem> & {
  tenantId: string;
  unitId: string;
  stage: CaseStage;
};

export interface CasesRepo {
  /** Create a case (generates caseId); returns the stored item. */
  create(input: CreateCaseInput): Promise<CaseItem>;
  getById(caseId: string): Promise<CaseItem | undefined>;
  /**
   * SET-merge update: supplied fields are written, omitted fields LEFT as stored
   * (no-overwrite, same contract as units/contacts). An explicit `null` value
   * REMOVEs that attribute — the only safe way to clear a SPARSE GSI key
   * (tour_date) or the attention flag, since a key attribute must be ABSENT, not
   * null, to drop from its index. updated_at is always bumped. Returns ALL_NEW.
   * Throws ConditionalCheckFailedException for unknown cases.
   *
   * THROWS if `patch` contains next_deadline_type/next_deadline_at: the
   * byNextDeadline COMPOSITE key must move both-or-neither, so it only goes
   * through setNextDeadline. A half-set key is a silently-unqueryable index row
   * (a deadline clock that never fires) — so this is a hard guard, not a
   * convention. (The route still owns the stage/key allowlist, like unitsRepo.)
   */
  update(caseId: string, patch: Record<string, unknown>): Promise<CaseItem>;
  /**
   * Set or clear the next-deadline composite key atomically (both attributes or
   * neither). Passing `null` REMOVEs both (drops the case from byNextDeadline).
   * Returns ALL_NEW. Throws ConditionalCheckFailedException for unknown cases.
   */
  setNextDeadline(caseId: string, deadline: CaseDeadline | null): Promise<CaseItem>;
  /** All cases for a tenant via the byTenant GSI. */
  listByTenant(tenantId: string, opts?: ListCasesOpts): Promise<CasesPage>;
  /** All cases on a unit via the byUnit GSI. */
  listByUnit(unitId: string, opts?: ListCasesOpts): Promise<CasesPage>;
  /** All cases in a stage via the byStage GSI (one kanban column / RTA board). */
  listByStage(stage: CaseStage, opts?: ListCasesOpts): Promise<CasesPage>;
  /** All cases whose CURRENT tour is on a given date via the byTourDate GSI. */
  listByTourDate(tourDate: string, opts?: ListCasesOpts): Promise<CasesPage>;
  /**
   * Cases with a pending deadline of a given type, soonest-first, via the
   * byNextDeadline GSI — "what needs attention right now?" (doc §5). Optionally
   * bounded to those due AT or BEFORE a cutoff (opts.beforeAt).
   */
  listByNextDeadline(
    type: CaseDeadlineType,
    opts?: ListByNextDeadlineOpts,
  ): Promise<CasesPage>;
  /**
   * Unfiltered paginated Scan — the board's "all cases" fallback. ACCEPTED at
   * this scale (doc §5.1: the working set is hundreds of small items). Targeted
   * views use the GSIs (a Query) instead; this Scan is the no-filter fallback.
   */
  list(opts?: ListCasesOpts): Promise<CasesPage>;
}

export function createCasesRepo(deps: RepoDeps = {}): CasesRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('cases', deps.env);
  const log = deps.logger ?? defaultLogger;

  async function getById(caseId: string): Promise<CaseItem | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { caseId } }));
    return Item as CaseItem | undefined;
  }

  /** Shared single-key GSI query (one partition, optional pagination). */
  async function queryIndex(
    indexName: string,
    keyName: string,
    keyValue: string,
    opts: ListCasesOpts,
  ): Promise<CasesPage> {
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
      items: (Items ?? []) as CaseItem[],
      ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
    };
  }

  return {
    async create(input) {
      const now = new Date().toISOString();
      const createdAt = typeof input.created_at === 'string' ? input.created_at : now;
      const item: CaseItem = {
        ...input,
        caseId: input.caseId ?? `case-${randomUUID()}`,
        created_at: createdAt,
        updated_at: now,
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          // Defensive: never silently overwrite an existing case on create.
          ConditionExpression: 'attribute_not_exists(caseId)',
        }),
      );
      log.info(
        { caseId: item.caseId, tenantId: item.tenantId, unitId: item.unitId, stage: item.stage },
        'case created',
      );
      return item;
    },

    getById,

    async update(caseId, patch) {
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
        if (key === 'next_deadline_type' || key === 'next_deadline_at') {
          // Both-or-neither composite key — never a half-set (silently
          // unqueryable) index row. Fail fast; callers use setNextDeadline.
          throw new Error(
            'casesRepo.update: set next_deadline via setNextDeadline (composite key must move both-or-neither)',
          );
        }
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
          Key: { caseId },
          UpdateExpression: clauses.join(' '),
          ConditionExpression: 'attribute_exists(caseId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ caseId, setFields: sets.length - 1, removedFields: removes.length }, 'case updated');
      return Attributes as CaseItem;
    },

    async setNextDeadline(caseId, deadline) {
      // Both-or-neither: SET both composite-key attributes together, or REMOVE
      // both — never a half-set key (which would be an unqueryable index row).
      const names: Record<string, string> = {
        '#t': 'next_deadline_type',
        '#a': 'next_deadline_at',
        '#updatedAt': 'updated_at',
      };
      const values: Record<string, unknown> = { ':now': new Date().toISOString() };
      let updateExpression: string;
      if (deadline === null) {
        updateExpression = 'SET #updatedAt = :now REMOVE #t, #a';
      } else {
        values[':t'] = deadline.type;
        values[':a'] = deadline.at;
        updateExpression = 'SET #t = :t, #a = :a, #updatedAt = :now';
      }
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { caseId },
          UpdateExpression: updateExpression,
          ConditionExpression: 'attribute_exists(caseId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info(
        { caseId, deadlineType: deadline?.type ?? null },
        deadline === null ? 'case next-deadline cleared' : 'case next-deadline set',
      );
      return Attributes as CaseItem;
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

    async listByNextDeadline(type, opts = {}) {
      const hasBefore = typeof opts.beforeAt === 'string';
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byNextDeadline',
        KeyConditionExpression: hasBefore
          ? '#t = :t AND #a <= :before'
          : '#t = :t',
        ExpressionAttributeNames: hasBefore
          ? { '#t': 'next_deadline_type', '#a': 'next_deadline_at' }
          : { '#t': 'next_deadline_type' },
        ExpressionAttributeValues: hasBefore
          ? { ':t': type, ':before': opts.beforeAt }
          : { ':t': type },
        // Soonest-first by default (the range key is next_deadline_at).
        ScanIndexForward: opts.scanIndexForward ?? true,
        ...(opts.limit !== undefined && { Limit: opts.limit }),
        ...(opts.exclusiveStartKey !== undefined && {
          ExclusiveStartKey: opts.exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
        }),
      };
      const { Items, LastEvaluatedKey } = await doc.send(new QueryCommand(input));
      return {
        items: (Items ?? []) as CaseItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
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
        items: (Items ?? []) as CaseItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },
  };
}

/** Re-export so callers needn't import ConditionalCheckFailedException separately. */
export { ConditionalCheckFailedException };
