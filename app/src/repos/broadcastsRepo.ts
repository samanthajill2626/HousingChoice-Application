// broadcasts repo (M1.8a) — the filtered share-broadcast ("Share Listings")
// record: a draft → sending → sent/failed lifecycle row carrying the audience
// filter snapshot, the per-recipient delivery map, and rolled-up stats the
// results view reads.
//
// Items stay FLEXIBLE documents — only the key (broadcastId) and the two GSI
// key attributes (status, created_by + created_at) are contractual
// (lib/tables.ts). Everything else (body_template, audience_filter snapshot,
// recipients map, stats) is a free-form attribute, so schema churn needs no
// migration — exactly the §5 posture.
//
// ITEM SIZE: the `recipients` map lives ON the item. A DynamoDB item is capped
// at 400KB, so this only holds a BOUNDED audience — the Phase-1 filtered tenant
// set is low hundreds, each slot a handful of short fields (~150 bytes), well
// under the ceiling. A future unbounded-audience broadcast would move recipients
// to their own partition (one item per recipient); flagged so the bound is a
// known choice, not an oversight.
//
// PII (doc §9): NEVER log phones/names/bodies — IDs/keys/counts/SIDs only,
// correlated via the pino mixin (relayFanOut precedent).
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

/** Broadcast lifecycle status (byStatus GSI hash). */
export type BroadcastStatus = 'draft' | 'sending' | 'sent' | 'failed';

/**
 * Hard cap on a broadcast's recipient count.
 *
 * The `recipients` map lives ON the broadcast item, and a DynamoDB item is
 * capped at 400KB. Each recipient slot is contactKey (~40B) + a small object
 * {status, conversationId, tsMsgId, errorCode?} (~110-160B) → budget ~150-200
 * bytes/slot. 1500 slots × ~200B ≈ 300KB, leaving comfortable headroom under
 * 400KB for the rest of the item (audience_filter, body_template, stats, etc.).
 * The /send route REFUSES an audience over this cap (audience_too_large) so the
 * recipients map can never overflow the item — narrow the filter, or move to a
 * one-item-per-recipient layout if Phase-2 ever needs unbounded audiences.
 */
export const MAX_BROADCAST_RECIPIENTS = 1500;

/**
 * The audience filter SNAPSHOT persisted on the broadcast (M1.8a): tenant
 * contacts, optionally narrowed by housing authority and exact bedroom size.
 * contact_type is fixed 'tenant' for M1.8 (never relay-group rosters); opt-out
 * + unreachable are ALWAYS excluded (the booleans record the intent for the
 * audit trail / future flexibility).
 */
export interface AudienceFilter {
  contact_type: 'tenant';
  housing_authority?: string;
  bedroomSize?: number;
  excludeOptedOut: boolean;
  excludeUnreachable: boolean;
}

/** Rolled-up send/delivery counters the results view renders. */
export interface BroadcastStats {
  /** Resolved audience size at send time (the snapshot's length). */
  audience: number;
  /** Provider-accepted sends (queued/sent at the adapter). */
  sent: number;
  /** Delivery callbacks that reached `delivered`. */
  delivered: number;
  /** Sends that failed (carrier filter / invalid number / cap). */
  failed: number;
  /** Recipients skipped at send time for opt-out/unreachable (no token spent). */
  skipped_opted_out: number;
  /** Recipients still queued (pre-send seed / transient deferral). */
  queued: number;
}

/** Per-recipient delivery slot on the broadcast (keyed by contactKey). */
export interface BroadcastRecipient {
  /** The tenant's 1:1 conversation the message landed in (set at send). */
  conversationId?: string;
  /** The persisted message's SK (delivery-callback rollup target). */
  tsMsgId?: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped';
  errorCode?: string;
}

export interface BroadcastItem {
  broadcastId: string;
  /** byCreatedAt GSI hash: the acting user's userId. */
  created_by: string;
  /** byCreatedAt GSI range (ISO 8601). */
  created_at: string;
  /** byStatus GSI hash. */
  status: BroadcastStatus;
  /** The unit whose flyer + merge fields this broadcast shares (optional draft). */
  unitId?: string;
  /** The audience filter snapshot (resolved at send to the recipients map). */
  audience_filter: AudienceFilter;
  /** The operator's message template (merge tokens rendered per recipient). */
  body_template: string;
  /** The unit's public flyer URL, snapshotted at send. */
  flyer_url?: string;
  stats: BroadcastStats;
  /**
   * contactKey → per-recipient delivery slot. contactKey = contactId else
   * `phone#<E164>` (the relay convention). Bounded (see the item-size note).
   */
  recipients: Record<string, BroadcastRecipient>;
  last_error?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** One page of a broadcasts list query (opaque cursor handled at the route). */
export interface BroadcastsPage {
  items: BroadcastItem[];
  lastEvaluatedKey?: Record<string, unknown>;
}

export interface ListBroadcastsOpts {
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
}

/** Zero-valued stats for a fresh draft. */
export function zeroStats(): BroadcastStats {
  return { audience: 0, sent: 0, delivered: 0, failed: 0, skipped_opted_out: 0, queued: 0 };
}

/** Create input: created_by + body_template + audience_filter are required. */
export interface CreateBroadcastInput {
  broadcastId?: string;
  created_by: string;
  audience_filter: AudienceFilter;
  body_template: string;
  unitId?: string;
  flyer_url?: string;
  /** Estimated audience computed at draft time (stats.audience seed). */
  estimatedAudience?: number;
}

export interface BroadcastsRepo {
  /** Create a DRAFT broadcast (generates broadcastId); returns the stored item. */
  create(input: CreateBroadcastInput): Promise<BroadcastItem>;
  getById(broadcastId: string): Promise<BroadcastItem | undefined>;
  /** List by lifecycle status via the byStatus GSI. */
  listByStatus(status: BroadcastStatus, opts?: ListBroadcastsOpts): Promise<BroadcastsPage>;
  /** List a creator's broadcasts newest-first via the byCreatedAt GSI. */
  listByCreatedBy(createdBy: string, opts?: ListBroadcastsOpts): Promise<BroadcastsPage>;
  /**
   * Persist the resolved recipients map + audience count, then flip to
   * `sending` — one conditional write, gated on the broadcast still being a
   * draft (so a double-send can't re-seed mid-flight). Throws
   * ConditionalCheckFailedException when the broadcast is missing or not a
   * draft.
   */
  markSending(
    broadcastId: string,
    recipients: Record<string, BroadcastRecipient>,
  ): Promise<BroadcastItem>;
  /**
   * Set one recipient's delivery slot on the nested `recipients` map.
   *
   * Without `allowedPriorStatuses` this is a blind SET (the send job seeds the
   * slot the first time). WITH it, the write is CONDITIONAL on the slot's
   * current nested `status` being one of the allowed predecessors — an atomic
   * forward-only transition that two concurrent callbacks can't both win.
   * Returns `true` when the write applied, `false` on a
   * ConditionalCheckFailedException (another writer already transitioned the
   * slot) so the caller can gate exactly-once side effects (e.g. stats).
   */
  setRecipient(
    broadcastId: string,
    contactKey: string,
    recipient: BroadcastRecipient,
    allowedPriorStatuses?: ReadonlyArray<BroadcastRecipient['status']>,
  ): Promise<boolean>;
  /** Atomically add a delta to stats counters (ADD on each present field). */
  bumpStats(broadcastId: string, delta: Partial<BroadcastStats>): Promise<BroadcastItem>;
  /** Flip to `sent` (terminal). */
  markSent(broadcastId: string): Promise<BroadcastItem>;
  /** Flip to `failed` (terminal); records last_error. */
  markFailed(broadcastId: string, lastError?: string): Promise<BroadcastItem>;
}

export function createBroadcastsRepo(deps: RepoDeps = {}): BroadcastsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('broadcasts', deps.env);
  const log = deps.logger ?? defaultLogger;

  async function getById(broadcastId: string): Promise<BroadcastItem | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { broadcastId } }));
    return Item as BroadcastItem | undefined;
  }

  /** Shared GSI query (one partition, optional pagination). */
  async function queryIndex(
    indexName: string,
    keyName: string,
    keyValue: string,
    opts: ListBroadcastsOpts,
    scanIndexForward = true,
  ): Promise<BroadcastsPage> {
    // `status` is a DynamoDB reserved word → expression-aliased.
    const input: QueryCommandInput = {
      TableName: table,
      IndexName: indexName,
      KeyConditionExpression: '#k = :v',
      ExpressionAttributeNames: { '#k': keyName },
      ExpressionAttributeValues: { ':v': keyValue },
      ScanIndexForward: scanIndexForward,
      ...(opts.limit !== undefined && { Limit: opts.limit }),
      ...(opts.exclusiveStartKey !== undefined && {
        ExclusiveStartKey: opts.exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
      }),
    };
    const { Items, LastEvaluatedKey } = await doc.send(new QueryCommand(input));
    return {
      items: (Items ?? []) as BroadcastItem[],
      ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
    };
  }

  /** SET a terminal status + updated_at, returning ALL_NEW. */
  async function flipStatus(
    broadcastId: string,
    status: BroadcastStatus,
    lastError?: string,
  ): Promise<BroadcastItem> {
    const now = new Date().toISOString();
    const sets = ['#s = :status', 'updated_at = :now'];
    const names: Record<string, string> = { '#s': 'status' };
    const values: Record<string, unknown> = { ':status': status, ':now': now };
    if (lastError !== undefined) {
      sets.push('last_error = :err');
      values[':err'] = lastError;
    }
    const { Attributes } = await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { broadcastId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(broadcastId)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    log.info({ broadcastId, status }, 'broadcast status set');
    return Attributes as BroadcastItem;
  }

  return {
    getById,

    async create(input) {
      const now = new Date().toISOString();
      const stats = zeroStats();
      if (typeof input.estimatedAudience === 'number') stats.audience = input.estimatedAudience;
      const item: BroadcastItem = {
        broadcastId: input.broadcastId ?? `bcast-${randomUUID()}`,
        created_by: input.created_by,
        created_at: now,
        status: 'draft',
        audience_filter: input.audience_filter,
        body_template: input.body_template,
        stats,
        recipients: {},
        updated_at: now,
        ...(input.unitId !== undefined && { unitId: input.unitId }),
        ...(input.flyer_url !== undefined && { flyer_url: input.flyer_url }),
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(broadcastId)',
        }),
      );
      log.info({ broadcastId: item.broadcastId, createdBy: item.created_by }, 'broadcast draft created');
      return item;
    },

    async listByStatus(status, opts = {}) {
      return queryIndex('byStatus', 'status', status, opts);
    },

    async listByCreatedBy(createdBy, opts = {}) {
      // Newest-first: byCreatedAt sorts on created_at; descending.
      return queryIndex('byCreatedAt', 'created_by', createdBy, opts, false);
    },

    async markSending(broadcastId, recipients) {
      const now = new Date().toISOString();
      const audience = Object.keys(recipients).length;
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { broadcastId },
          UpdateExpression:
            'SET #s = :sending, recipients = :r, stats.audience = :aud, stats.queued = :aud, updated_at = :now',
          // Only a DRAFT may be sent — a concurrent/duplicate send fails here
          // and the route no-ops (idempotent), so recipients are never re-seeded
          // mid-flight (which would reset the per-recipient delivery map).
          ConditionExpression: 'attribute_exists(broadcastId) AND #s = :draft',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':sending': 'sending',
            ':draft': 'draft',
            ':r': recipients,
            ':aud': audience,
            ':now': now,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ broadcastId, audience }, 'broadcast marked sending');
      return Attributes as BroadcastItem;
    },

    async setRecipient(broadcastId, contactKey, recipient, allowedPriorStatuses) {
      // CHILD-ONLY SET of the recipient slot. The parent `recipients` map is
      // always pre-seeded by markSending (`SET ... recipients = :r ...`), and
      // the /send route only enqueues the fan-out AFTER markSending succeeds —
      // so `recipients` always exists when this runs. DynamoDB rejects an
      // UpdateExpression that SETs both a map and a child of that map in one
      // statement (overlapping document paths), so we must NOT also seed the
      // parent here. contactKey may contain `#` (phone keys) — bind as an
      // aliased name (dotted-path safe).
      const names: Record<string, string> = { '#ck': contactKey };
      const values: Record<string, unknown> = { ':rec': recipient };
      let condition = 'attribute_exists(broadcastId)';
      if (allowedPriorStatuses !== undefined) {
        // Atomic forward-only transition: only apply when the slot's NESTED
        // `status` is one of the allowed predecessors (dotted-path on the map
        // entry via aliased names). Two concurrent callbacks racing the same
        // transition: exactly ONE passes the condition; the loser throws
        // ConditionalCheckFailedException → returns false (no stat double-bump).
        names['#status'] = 'status';
        const statusPlaceholders = allowedPriorStatuses.map((s, i) => {
          const k = `:ps${i}`;
          values[k] = s;
          return k;
        });
        condition += ` AND recipients.#ck.#status IN (${statusPlaceholders.join(', ')})`;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { broadcastId },
            UpdateExpression: 'SET recipients.#ck = :rec',
            ConditionExpression: condition,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
        return true;
      } catch (err) {
        if (allowedPriorStatuses !== undefined && err instanceof ConditionalCheckFailedException) {
          // The slot was no longer in an allowed prior state — another writer
          // already transitioned it. Treat as a no-op (caller skips the bump).
          return false;
        }
        throw err;
      }
    },

    async bumpStats(broadcastId, delta) {
      // ADD each present counter (atomic increment). stats fields pre-exist
      // (create/markSending seed them), so ADD on a nested numeric attribute is
      // safe. updated_at is bumped alongside.
      const adds: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      let i = 0;
      for (const [key, value] of Object.entries(delta)) {
        if (typeof value !== 'number' || value === 0) continue;
        const nameKey = `#sk${i}`;
        const valueKey = `:sv${i}`;
        names[nameKey] = key;
        values[valueKey] = value;
        adds.push(`stats.${nameKey} ${valueKey}`);
        i += 1;
      }
      if (adds.length === 0) {
        const existing = await getById(broadcastId);
        if (!existing) {
          throw new ConditionalCheckFailedException({
            message: `bumpStats: broadcast ${broadcastId} not found`,
            $metadata: {},
          });
        }
        return existing;
      }
      names['#updatedAt'] = 'updated_at';
      values[':now'] = new Date().toISOString();
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { broadcastId },
          UpdateExpression: `ADD ${adds.join(', ')} SET #updatedAt = :now`,
          ConditionExpression: 'attribute_exists(broadcastId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return Attributes as BroadcastItem;
    },

    async markSent(broadcastId) {
      return flipStatus(broadcastId, 'sent');
    },

    async markFailed(broadcastId, lastError) {
      return flipStatus(broadcastId, 'failed', lastError);
    },
  };
}
