// broadcasts repo (M1.8a) — the filtered share-broadcast ("Share Properties")
// record: a draft → sending → sent/failed lifecycle row carrying the audience
// filter snapshot, the per-recipient delivery map, and rolled-up stats the
// results view reads.
//
// Items stay FLEXIBLE documents — only the key (broadcastId) and the GSI key
// attributes (_listPartition + created_at for the team-wide byCreated list;
// unitId for the sparse byUnit lookup) are contractual (lib/tables.ts).
// Everything else (body_template, audience_filter snapshot, recipients map,
// stats) is a free-form attribute, so schema churn needs no migration —
// exactly the §5 posture.
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
  DeleteCommand,
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

/** Broadcast lifecycle status (the byCreated GSI's FilterExpression key). */
export type BroadcastStatus = 'draft' | 'sending' | 'sent' | 'failed';

/** How preview/send derive candidates: 'filter' resolves the audience filter
 *  (and unions any seeds); 'seeds_only' uses ONLY seed_contact_ids (the seeded
 *  1:1 entry - the default filter would otherwise propose every tenant).
 *  Absent on legacy rows = 'filter'. */
export type BroadcastAudienceMode = 'filter' | 'seeds_only';

/**
 * The byCreated GSI's constant partition value (the tours `_schedPartition`
 * convention): every broadcast stamps `_listPartition = LIST_PARTITION` so the
 * team-wide list is ONE newest-first query. Rows created before this attribute
 * existed need the backfill script or they drop out of the list views.
 */
export const LIST_PARTITION = 'broadcasts';

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
  /**
   * A2P/CTIA (spec §4): recipients skipped because they have NO recorded SMS
   * consent (no token spent, no send). Surfaced separately from
   * skipped_opted_out so the results view can prompt staff to record consent
   * (which re-includes them on a re-send).
   */
  skipped_no_consent: number;
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
  /** The acting user's userId (audit/attribution; no longer an index key). */
  created_by: string;
  /** byCreated GSI range (ISO 8601). */
  created_at: string;
  /**
   * byCreated GSI hash — the constant LIST_PARTITION, stamped by create().
   * Optional in the type because rows written before the byCreated migration
   * lack it until backfilled.
   */
  _listPartition?: typeof LIST_PARTITION;
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
  /** Explicit recipients attached to the draft (entry-point seed or the
   *  review step's hand-picked additions). Independent of audience_filter. */
  seed_contact_ids?: string[];
  audience_mode?: BroadcastAudienceMode;
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

/**
 * S4 (broadcast live progress): the SINGLE SOURCE OF TRUTH for the disjoint stat
 * buckets, derived from the recipients map so a recipient is counted in EXACTLY
 * ONE bucket and the buckets always sum to the audience (the map size).
 *
 * - EMPTY map (drafts, or a legacy row without a map): return the persisted
 *   stats UNCHANGED (drafts show the audience estimate + zero buckets, today's
 *   behavior). Same object reference - a pure passthrough.
 * - NON-EMPTY map: compute every field from the slots:
 *     audience  = number of slots
 *     queued    = slots with status 'queued'
 *     sent      = slots with status 'sent'
 *     delivered = slots with status 'delivered'
 *     failed    = slots with status 'failed'
 *     skipped_no_consent = 'skipped' slots with errorCode 'no_consent'
 *     skipped_opted_out  = every remaining 'skipped' slot
 *   Legacy cumulative persisted stats are IGNORED when the map is present, so
 *   historical broadcasts (whose persisted counters double-counted delivered)
 *   still DISPLAY correctly. Same BroadcastStats shape as the persisted counters.
 */
export function deriveBroadcastStats(
  b: Pick<BroadcastItem, 'recipients' | 'stats'>,
): BroadcastStats {
  const recipients = b.recipients ?? {};
  const keys = Object.keys(recipients);
  if (keys.length === 0) return b.stats;
  let queued = 0;
  let sent = 0;
  let delivered = 0;
  let failed = 0;
  let skipped_no_consent = 0;
  let skipped_opted_out = 0;
  for (const key of keys) {
    const slot = recipients[key]!;
    switch (slot.status) {
      case 'queued':
        queued += 1;
        break;
      case 'sent':
        sent += 1;
        break;
      case 'delivered':
        delivered += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'skipped':
        if (slot.errorCode === 'no_consent') skipped_no_consent += 1;
        else skipped_opted_out += 1;
        break;
    }
  }
  return {
    audience: keys.length,
    queued,
    sent,
    delivered,
    failed,
    skipped_opted_out,
    skipped_no_consent,
  };
}

/** Zero-valued stats for a fresh draft. */
export function zeroStats(): BroadcastStats {
  return {
    audience: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    skipped_opted_out: 0,
    skipped_no_consent: 0,
    queued: 0,
  };
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
  seedContactIds?: string[];
  audienceMode?: BroadcastAudienceMode;
}

export interface BroadcastsRepo {
  /** Create a DRAFT broadcast (generates broadcastId); returns the stored item. */
  create(input: CreateBroadcastInput): Promise<BroadcastItem>;
  getById(broadcastId: string): Promise<BroadcastItem | undefined>;
  /** ALL broadcasts (team-wide), newest-first, via the byCreated GSI. */
  list(opts?: ListBroadcastsOpts): Promise<BroadcastsPage>;
  /**
   * Team-wide broadcasts in one lifecycle status, newest-first: the byCreated
   * GSI + a FilterExpression on status. DynamoDB applies Limit BEFORE the
   * filter, so a page can return fewer than `limit` items (even zero) while
   * still carrying a lastEvaluatedKey — callers page until the cursor is gone,
   * never until a short page.
   */
  listByStatus(status: BroadcastStatus, opts?: ListBroadcastsOpts): Promise<BroadcastsPage>;
  /**
   * List the broadcasts targeting a unit via the sparse byUnit GSI (only
   * broadcasts WITH a unitId index here). One page per call; the route's
   * prior-recipients lookup walks them.
   */
  listByUnit(unitId: string, opts?: ListBroadcastsOpts): Promise<BroadcastsPage>;
  /**
   * The set of contactKeys already sent a broadcast for this unit — the union
   * of every sent/sending broadcast's `recipients` map KEYS for the unit. The
   * composer flags these (soft, opt-in resend; never a server-side exclusion).
   * Degrades SAFELY: if the byUnit GSI is absent (an un-applied env) or the
   * query throws/returns nothing, returns an EMPTY set (nothing flagged) — the
   * already-sent protection is best-effort until the operator applies the GSI.
   */
  priorRecipientContactIds(unitId: string): Promise<Set<string>>;
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
   * Replace the draft's hand-picked seed_contact_ids (the review step's curated
   * additions / the seeded 1:1 entry). One conditional write gated on the
   * broadcast still being a `draft` (a sent/sending broadcast's recipients are
   * frozen). An EMPTY array is VALID here — it CLEARS the seed list. Throws
   * ConditionalCheckFailedException when the broadcast is missing or not a
   * draft (mirrors markSending's conditional shape).
   */
  setSeedContactIds(broadcastId: string, seedContactIds: string[]): Promise<BroadcastItem>;
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
  /**
   * Delete a broadcast — ONLY when it is still a draft (a sending/sent/failed
   * broadcast is permanent). One conditional DeleteCommand gated on
   * `attribute_exists(broadcastId) AND status='draft'`: the condition is the
   * race guard — a concurrent send that flipped draft→sending between the
   * route's read and this delete fails the condition (never a silent delete of
   * a sent broadcast). Returns a discriminated result the route maps to
   * 200 / 404 / 409 (on the conditional failure a follow-up getById tells
   * `not_found` from `not_draft`).
   */
  delete(broadcastId: string): Promise<DeleteBroadcastResult>;
}

/** Outcome of a draft-only delete (the route maps it to 200 / 404 / 409). */
export type DeleteBroadcastResult =
  | { deleted: true }
  | { deleted: false; reason: 'not_found' | 'not_draft' };

export function createBroadcastsRepo(deps: RepoDeps = {}): BroadcastsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('broadcasts', deps.env);
  const log = deps.logger ?? defaultLogger;

  async function getById(broadcastId: string): Promise<BroadcastItem | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { broadcastId } }));
    return Item as BroadcastItem | undefined;
  }

  /** Shared GSI query (one partition, optional status filter + pagination). */
  async function queryIndex(
    indexName: string,
    keyName: string,
    keyValue: string,
    opts: ListBroadcastsOpts,
    scanIndexForward = true,
    statusFilter?: BroadcastStatus,
  ): Promise<BroadcastsPage> {
    // `status` is a DynamoDB reserved word → expression-aliased.
    const input: QueryCommandInput = {
      TableName: table,
      IndexName: indexName,
      KeyConditionExpression: '#k = :v',
      ExpressionAttributeNames: {
        '#k': keyName,
        ...(statusFilter !== undefined && { '#s': 'status' }),
      },
      ExpressionAttributeValues: {
        ':v': keyValue,
        ...(statusFilter !== undefined && { ':s': statusFilter }),
      },
      // Limit applies BEFORE the filter (see listByStatus's contract note).
      ...(statusFilter !== undefined && { FilterExpression: '#s = :s' }),
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
        _listPartition: LIST_PARTITION, // byCreated GSI membership
        status: 'draft',
        audience_filter: input.audience_filter,
        body_template: input.body_template,
        stats,
        recipients: {},
        updated_at: now,
        ...(input.unitId !== undefined && { unitId: input.unitId }),
        ...(input.flyer_url !== undefined && { flyer_url: input.flyer_url }),
        ...(input.seedContactIds !== undefined &&
          input.seedContactIds.length > 0 && { seed_contact_ids: input.seedContactIds }),
        ...(input.audienceMode !== undefined && { audience_mode: input.audienceMode }),
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

    async list(opts = {}) {
      // Newest-first: byCreated sorts on created_at; descending.
      return queryIndex('byCreated', '_listPartition', LIST_PARTITION, opts, false);
    },

    async listByStatus(status, opts = {}) {
      // Same partition, post-Query status filter (see the interface's paging note).
      return queryIndex('byCreated', '_listPartition', LIST_PARTITION, opts, false, status);
    },

    async listByUnit(unitId, opts = {}) {
      // Sparse byUnit GSI (unit-less broadcasts never index here).
      return queryIndex('byUnit', 'unitId', unitId, opts);
    },

    async priorRecipientContactIds(unitId) {
      // Best-effort union of every sent/sending broadcast's recipients KEYS for
      // this unit. The byUnit GSI keeps this O(matches) not a Scan. Degrade
      // SAFELY: a missing GSI (un-applied env) or any query error → empty set
      // (nothing flagged); log IDs/counts only (NEVER recipient phones/keys).
      const prior = new Set<string>();
      try {
        let exclusiveStartKey: Record<string, unknown> | undefined;
        do {
          const page = await queryIndex('byUnit', 'unitId', unitId, {
            ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
          });
          for (const b of page.items) {
            if (b.status !== 'sent' && b.status !== 'sending') continue;
            for (const key of Object.keys(b.recipients ?? {})) prior.add(key);
          }
          exclusiveStartKey = page.lastEvaluatedKey;
        } while (exclusiveStartKey !== undefined);
      } catch (err) {
        // Index missing on an un-applied env (or a transient query error): the
        // already-sent annotation degrades to "nothing flagged" per the spec.
        log.warn({ unitId, err }, 'priorRecipientContactIds: byUnit query failed — degrading to empty');
        return new Set<string>();
      }
      log.info({ unitId, priorCount: prior.size }, 'broadcast prior-recipients resolved');
      return prior;
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

    async setSeedContactIds(broadcastId, seedContactIds) {
      // Only a DRAFT may have its seeds re-picked — a sending/sent broadcast's
      // recipients are frozen, so the same status='draft' condition markSending
      // uses guards this write. An EMPTY array is a valid CLEAR (SET seeds to
      // []). A missing/non-draft broadcast fails the condition and surfaces the
      // ConditionalCheckFailedException for the route to map to 404/409.
      const now = new Date().toISOString();
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { broadcastId },
          UpdateExpression: 'SET seed_contact_ids = :s, updated_at = :now',
          ConditionExpression: 'attribute_exists(broadcastId) AND #s = :draft',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': seedContactIds, ':draft': 'draft', ':now': now },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ broadcastId, seedCount: seedContactIds.length }, 'broadcast seeds replaced');
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

    async delete(broadcastId) {
      // Conditional delete: only a DRAFT may be deleted. The condition is the
      // race guard — a concurrent send that flipped draft→sending between the
      // route's read and here fails the condition (no silent delete of a sent
      // broadcast). On ConditionalCheckFailedException a follow-up getById
      // distinguishes a missing broadcast (404) from a non-draft one (409),
      // mirroring markSending's CCF handling.
      try {
        await doc.send(
          new DeleteCommand({
            TableName: table,
            Key: { broadcastId },
            ConditionExpression: 'attribute_exists(broadcastId) AND #s = :draft',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':draft': 'draft' },
          }),
        );
        log.info({ broadcastId }, 'broadcast draft deleted');
        return { deleted: true };
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          const existing = await getById(broadcastId);
          return existing === undefined
            ? { deleted: false, reason: 'not_found' }
            : { deleted: false, reason: 'not_draft' };
        }
        throw err;
      }
    },
  };
}
