// pool_numbers repo - the lifecycle store for relay-group pool numbers (M1.7,
// burn-multiplexing revision).
//
// A pool number is MULTIPLEXED across many relay groups. Its lifecycle:
//   - active     in service; hosts any number of groups (concurrently and over
//                time) whose rosters do not overlap its burn history.
//   - releasing  TRANSITIONAL (W2 TOCTOU fence): the retirement sweep has
//                claimed this number for release. burnClaim (conditions on
//                active) refuses it and listActive no longer returns it, so no
//                NEW group can land while it is handed back to Twilio; the sweep
//                either finalizes it to released or aborts it back to active.
//   - released   handed back to Twilio after the 180-day retirement grace; the
//                record (and its burn history) is kept forever as our audit.
//
// The invariant is a permanent (number, phone) BURN: `burned_phones` is a
// DynamoDB string set of every E.164 ever rostered on this number. Assignment
// is an atomic burn-as-claim (burnClaim): one conditional UpdateItem ADDs the
// new roster to burned_phones ONLY IF none of them is already present (and the
// number is active). Two overlapping claims cannot both win - the loser's
// condition fails. There is no assigned/available exclusivity and no
// quarantine: closing a group keeps its number.
//
// The byLifecycleState GSI (HASH lifecycle_state, RANGE quarantine_until) is
// queried for listActive() and the retirement sweep. quarantine_until is
// RETAINED as a fixed past-time sentinel on EVERY item (the quarantine
// mechanism is gone, but the attr stays as the GSI range key so items still
// index) - see lib/tables.ts.
//
// PII: a phone number is PII (doc section 9). Log lifecycle_state + counts only,
// never a poolNumber or a rostered phone - these lines are correlated via the
// pino mixin.
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

/**
 * Pool-number lifecycle states (burn-multiplexing revision). `releasing` is a
 * transitional state the retirement sweep claims before dropping a number at
 * Twilio (W2 TOCTOU fence) - byLifecycleState keys on the attribute value, so a
 * releasing number simply vanishes from the 'active' partition (listActive /
 * burnClaim) until the sweep finalizes (released) or aborts (active).
 *
 * `warming` (A2P warm-pool revision) is a number that has been bought and
 * attached to the Messaging Service but is NOT YET A2P-registered - it must
 * never send. It is EXCLUDED from listActive + burnClaim (both gate on
 * 'active'), so no group can land on it. The ONLY writer of warming->active is
 * promoteToActive, called solely from the Event Streams registration webhook
 * (never a timer). Like every other item a warming row carries the retained
 * quarantine_until sentinel, so byLifecycleState indexes it in a 'warming'
 * partition (listWarming) with no GSI reshape.
 */
export type PoolNumberLifecycleState = 'active' | 'warming' | 'releasing' | 'released';

/**
 * Which messaging driver obtained the number (M1.7 kill-switch). A flexible doc
 * field (NOT a key/GSI attr): 'console' numbers are local/test fakes written
 * into the shared dev table; 'twilio' numbers are real purchases. The live
 * twilio path must NEVER reuse a 'console' fake (and vice-versa) - the service
 * filters reuse by the CURRENT driver.
 */
export type PoolNumberProvisionedVia = 'console' | 'twilio';

/**
 * Retirement grace (D7): a number is release-eligible only once its newest
 * group closed at least this long ago (the late-text interception window).
 * 180 days.
 */
export const RELEASE_GRACE_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * A past-time sentinel written to quarantine_until on EVERY item so it still
 * appears in the byLifecycleState GSI (DynamoDB indexes an item only when both
 * key attrs are present). Quarantine is gone; this attr is retained purely as
 * the GSI range key and is never compared against.
 */
const NOT_QUARANTINED_SENTINEL = '0000-00-00T00:00:00.000Z';

/**
 * The contractual + commonly read attributes; the item stays a flexible
 * document (only keys/GSI attrs are contractual - lib/tables.ts).
 */
export interface PoolNumberItem {
  /** E.164 pool number (PK). */
  poolNumber: string;
  /** byLifecycleState GSI HASH. */
  lifecycle_state: PoolNumberLifecycleState;
  /** byLifecycleState GSI RANGE - retained sentinel (quarantine is gone). */
  quarantine_until: string;
  voice_capable: boolean;
  sms_capable: boolean;
  /**
   * Driver that obtained this number (M1.7 kill-switch source tag). Flexible
   * doc field; absent on legacy items (treated as unknown - never reused by the
   * source-isolation filter).
   */
  provisioned_via?: PoolNumberProvisionedVia;
  /**
   * Every E.164 ever rostered on this number - the permanent burn set (a
   * DynamoDB string set). Absent on a number created with an empty roster
   * (DynamoDB forbids empty sets); reads back as a JS Set<string>.
   */
  burned_phones?: Set<string> | string[];
  /** Monotonic max of group-close times on this number (retirement clock). */
  last_group_closed_at?: string;
  /** Operator placement label carried through provisioning. */
  placement_tag?: string;
  /**
   * When this number entered the `warming` state (ISO). Present only while
   * warming; promoteToActive REMOVEs it. The stuck-warming alert compares it
   * against relayWarmingMaxWaitMs.
   */
  warming_started_at?: string;
  /**
   * The purchased number's Twilio PN SID. Persisted so the Event Streams
   * registration webhook can correlate the event to this record BY SID (decision
   * D2) - the event payload's phone number is non-E.164 and fragile, the PN SID
   * maps 1:1. Absent on legacy items (created before the warm-pool revision).
   */
  sid?: string;
  /**
   * The conversation awaiting this number (connect-when-ready). Stamped when a
   * warming number is bought FOR a specific connecting group so the promotion
   * routes back to it (D6). A promoted (active) number that still carries this
   * is momentarily active+empty-burn but is NOT a free spare (countFreshSpares
   * excludes it) - it is earmarked for its connecting group.
   */
  pending_conversation_id?: string;
  provisioned_at: string;
  released_at?: string;
  [key: string]: unknown;
}

export interface CreatePoolNumberInput {
  poolNumber: string;
  voiceCapable: boolean;
  smsCapable: boolean;
  /** Source driver tag (M1.7 kill-switch) - 'console' fakes vs 'twilio' real. */
  provisionedVia?: PoolNumberProvisionedVia;
  /** The first group's roster - seeds burned_phones (may be empty in tests). */
  burn: string[];
  /** Operator placement label. */
  tag?: string;
  /**
   * The purchased number's Twilio PN SID (D2 correlation key). Optional on the
   * active path (an active number is never registration-correlated); written
   * only when provided.
   */
  sid?: string;
  /** Connecting-group tag - written as pending_conversation_id when provided. */
  conversationId?: string;
}

/**
 * Input for createWarming - a bought+attached number parked in the `warming`
 * state until the Event Streams registration event promotes it. Unlike create
 * there is NO `burn` (a warming number hosts no group yet - empty burn), and
 * `sid` is REQUIRED: the registration webhook correlates the event to this
 * record by its PN SID (decision D2), not the (non-E.164) phone number.
 */
export interface CreateWarmingInput {
  poolNumber: string;
  /** The purchased number's Twilio PN SID - the D2 correlation key. */
  sid: string;
  voiceCapable: boolean;
  smsCapable: boolean;
  /** Source driver tag (M1.7 kill-switch) - 'console' fakes vs 'twilio' real. */
  provisionedVia?: PoolNumberProvisionedVia;
  /** Operator placement label. */
  tag?: string;
  /**
   * The conversation awaiting this number (connect-when-ready). When given it is
   * persisted as pending_conversation_id so the promotion routes back to the
   * connecting group (D6); a promoted number still carrying it is NOT counted as
   * a free spare.
   */
  conversationId?: string;
}

export interface PoolNumbersRepo {
  get(poolNumber: string): Promise<PoolNumberItem | undefined>;
  /**
   * Create an ACTIVE record with burned_phones seeded from `burn` (the roster
   * of the first group). attribute_not_exists guard. burned_phones is written
   * ONLY when the roster is non-empty (DynamoDB forbids empty string sets).
   */
  create(input: CreatePoolNumberInput): Promise<PoolNumberItem>;
  /**
   * Create a WARMING record (bought+attached, not yet A2P-registered) with an
   * EMPTY burn and the stored PN `sid` (D2). Same attribute_not_exists guard and
   * quarantine_until sentinel as create (so byLifecycleState indexes it in the
   * 'warming' partition). `conversationId`, if given, is stored as
   * pending_conversation_id (the connect-when-ready earmark). It is excluded from
   * listActive + burnClaim for free (both gate on 'active').
   */
  createWarming(input: CreateWarmingInput): Promise<PoolNumberItem>;
  /**
   * Promote warming -> active, conditional on the number being `warming`, and
   * REMOVE warming_started_at. Returns true on success; false if the number is
   * not warming (already active/releasing/released, or missing) - idempotent for
   * a redelivered registration event. pending_conversation_id is left INTACT (the
   * webhook reads it from the pre-promote record to route the ready signal).
   * The ONLY warming->active writer; called solely from onNumberRegistered.
   */
  promoteToActive(poolNumber: string): Promise<boolean>;
  /** All WARMING numbers (paged Query on byLifecycleState 'warming'). */
  listWarming(): Promise<PoolNumberItem[]>;
  /**
   * The D2 correlation primitive: find the warming record whose stored PN `sid`
   * matches. Iterates listWarming (the warming set is tiny - K spares + any
   * connecting numbers; no new GSI). undefined if none matches (unknown/already
   * promoted).
   */
  findWarmingBySid(sid: string): Promise<PoolNumberItem | undefined>;
  /**
   * Count FRESH SPARES: active numbers with an empty burn AND no
   * pending_conversation_id earmark. Un-burned uses the Set-or-array-safe count
   * (D7) - NOT `!burned_phones?.size` (unsafe for the string[] arm). A promoted
   * connecting number (active + empty burn + pending_conversation_id) is momentarily
   * active but is NOT a free spare, so it is excluded. Feeds the buffer refill calc.
   */
  countFreshSpares(): Promise<number>;
  /** Count WARMING numbers (listWarming length) - the buffer refill debounce. */
  countWarming(): Promise<number>;
  /**
   * Every pool record (WARMING or ACTIVE) still earmarked to a connecting group
   * via pending_conversation_id. Scans the two small pre-open partitions (warming +
   * active) and filters - no new GSI (a connecting group's number lives in exactly
   * one of these until the group opens). Feeds (a) the warmOneNumber DEDUP (never
   * buy a SECOND number for a group that already has one warming/active) and (b) the
   * earmark reclaim when the group opens. Returns [] when none is earmarked.
   */
  findByPendingConversationId(conversationId: string): Promise<PoolNumberItem[]>;
  /**
   * REMOVE the pending_conversation_id earmark from a pool record. Called when a
   * connecting group opens: the assigned number now carries a REAL burn, and any
   * duplicate number left earmarked must be reclaimed as a usable fresh spare
   * (countFreshSpares excludes an earmarked record, so a stranded duplicate would
   * never be counted, assigned, or retired). Idempotent + best-effort: a record
   * without the attribute is a no-op, and a missing record is swallowed.
   */
  clearPendingConversation(poolNumber: string): Promise<void>;
  /** All ACTIVE numbers (paged Query on byLifecycleState 'active'). */
  listActive(): Promise<PoolNumberItem[]>;
  /**
   * All numbers in ONE lifecycle state (paged Query on byLifecycleState).
   * Generalizes listActive (which delegates to listByState('active')).
   * releasing/released rows stay queryable because quarantine_until is retained
   * as a fixed sentinel on EVERY item, so the GSI is deliberately non-sparse.
   */
  listByState(state: PoolNumberLifecycleState): Promise<PoolNumberItem[]>;
  /**
   * THE atomic burn-as-claim. ADDs `phones` to burned_phones conditional on the
   * number being active AND none of them already burned here. Returns the
   * post-update item (ALL_NEW), or undefined on condition failure (overlap or
   * not active) OR an empty roster. `tag` (optional) stamps placement_tag.
   */
  burnClaim(
    poolNumber: string,
    phones: string[],
    tag?: string,
  ): Promise<PoolNumberItem | undefined>;
  /**
   * Stamp last_group_closed_at = max(existing, closedAt) - the retirement
   * clock. Never throws: an older timestamp (or a missing record) is a
   * swallowed conditional no-op (best-effort caller - the group is already
   * closed).
   */
  noteGroupClosed(poolNumber: string, closedAt: string): Promise<void>;
  /**
   * W2 TOCTOU fence, step 1: CLAIM a number for release (active -> releasing),
   * conditional on active. Once releasing, burnClaim refuses it and listActive
   * skips it, so no NEW group can land while the sweep drops it at Twilio.
   * Returns the post-update item, or undefined on condition failure (already
   * releasing/released, or a lost race).
   */
  beginRelease(poolNumber: string): Promise<PoolNumberItem | undefined>;
  /**
   * W2 TOCTOU fence, ROLLBACK: return a claimed number to service (releasing ->
   * active), conditional on releasing. Called when the re-verify finds an open
   * group or the Twilio drop fails - the number stays fully reusable. Returns
   * the post-update item, or undefined on condition failure (not releasing).
   */
  abortRelease(poolNumber: string): Promise<PoolNumberItem | undefined>;
  /**
   * W2 TOCTOU fence, FINALIZER: releasing -> released (+released_at), conditional
   * on releasing (NOT active - beginRelease must claim first). Idempotent: a
   * condition failure (already released / not releasing / missing) returns
   * undefined.
   */
  releaseNumber(poolNumber: string): Promise<PoolNumberItem | undefined>;
}

export function createPoolNumbersRepo(deps: RepoDeps = {}): PoolNumbersRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('pool_numbers', deps.env);
  const log = deps.logger ?? defaultLogger;

  async function get(poolNumber: string): Promise<PoolNumberItem | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { poolNumber } }));
    return Item as PoolNumberItem | undefined;
  }

  async function listByState(state: PoolNumberLifecycleState): Promise<PoolNumberItem[]> {
    // Paged Query on ONE lifecycle_state partition (the pool is small, but never
    // truncate silently). quarantine_until (RANGE) is a fixed sentinel written on
    // EVERY item and never removed, so the GSI is non-sparse: releasing/released
    // rows stay indexed here and remain queryable. Order is arbitrary-but-stable.
    const items: PoolNumberItem[] = [];
    let exclusiveStartKey: QueryCommandInput['ExclusiveStartKey'];
    do {
      const { Items, LastEvaluatedKey } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byLifecycleState',
          KeyConditionExpression: 'lifecycle_state = :s',
          ExpressionAttributeValues: { ':s': state },
          ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
        }),
      );
      items.push(...((Items ?? []) as PoolNumberItem[]));
      exclusiveStartKey = LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  return {
    get,
    listByState,

    async create(input) {
      const now = new Date().toISOString();
      const item: PoolNumberItem = {
        poolNumber: input.poolNumber,
        lifecycle_state: 'active',
        quarantine_until: NOT_QUARANTINED_SENTINEL,
        voice_capable: input.voiceCapable,
        sms_capable: input.smsCapable,
        ...(input.provisionedVia !== undefined && { provisioned_via: input.provisionedVia }),
        // DynamoDB forbids empty string sets - only write burned_phones when the
        // roster has at least one phone.
        ...(input.burn.length > 0 && { burned_phones: new Set(input.burn) }),
        ...(input.tag !== undefined && { placement_tag: input.tag }),
        // Threaded for consistency (the active path rarely sets these); a
        // registration correlation SID and/or a connecting-group earmark ride
        // along only when the caller supplies them.
        ...(input.sid !== undefined && { sid: input.sid }),
        ...(input.conversationId !== undefined && {
          pending_conversation_id: input.conversationId,
        }),
        provisioned_at: now,
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(poolNumber)',
        }),
      );
      log.info(
        { lifecycleState: item.lifecycle_state, burnCount: input.burn.length },
        'pool number created',
      );
      return item;
    },

    async createWarming(input) {
      // Mirror create, but land in the WARMING state with an EMPTY burn (a
      // warming number hosts no group yet) and the required PN sid for D2
      // correlation. The quarantine_until sentinel is written exactly as create
      // writes it, so byLifecycleState indexes this row in the 'warming'
      // partition (listWarming). attribute_not_exists(poolNumber) guards against
      // clobbering an existing record.
      const now = new Date().toISOString();
      const item: PoolNumberItem = {
        poolNumber: input.poolNumber,
        lifecycle_state: 'warming',
        quarantine_until: NOT_QUARANTINED_SENTINEL,
        voice_capable: input.voiceCapable,
        sms_capable: input.smsCapable,
        sid: input.sid,
        warming_started_at: now,
        ...(input.provisionedVia !== undefined && { provisioned_via: input.provisionedVia }),
        ...(input.tag !== undefined && { placement_tag: input.tag }),
        // The connect-when-ready earmark - routes the promotion back to its group.
        ...(input.conversationId !== undefined && {
          pending_conversation_id: input.conversationId,
        }),
        // No burned_phones: DynamoDB forbids empty string sets, and a warming
        // number carries no roster until a group is assigned on promotion.
        provisioned_at: now,
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(poolNumber)',
        }),
      );
      // PII: no poolNumber/sid (sid maps 1:1 to a number) - state + a boolean only.
      log.info(
        {
          lifecycleState: item.lifecycle_state,
          hasPendingConversation: input.conversationId !== undefined,
        },
        'pool number created (warming)',
      );
      return item;
    },

    async promoteToActive(poolNumber) {
      // The SOLE warming->active writer (called only from onNumberRegistered).
      // Conditional on lifecycle_state='warming' so a redelivered registration
      // event, or an event for a non-warming number, is an idempotent no-op
      // (false). Leaves pending_conversation_id intact - the webhook reads it
      // from the pre-promote record to route the ready signal back to the group.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { poolNumber },
            UpdateExpression: 'SET lifecycle_state = :active REMOVE warming_started_at',
            ConditionExpression: 'lifecycle_state = :warming',
            ExpressionAttributeValues: { ':active': 'active', ':warming': 'warming' },
          }),
        );
        log.info({ lifecycleState: 'active' }, 'pool number promoted (warming -> active)');
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },

    async listWarming() {
      // All WARMING numbers (the tiny pre-registration set). Delegates to
      // listByState; kept named so the service + webhook read clearly.
      return listByState('warming');
    },

    async findWarmingBySid(sid) {
      // D2 correlation: the Event Streams registration event carries the PN SID;
      // resolve it to the warming record. The warming set is tiny (K spares + any
      // connecting numbers), so an in-memory scan beats a new GSI.
      return (await listByState('warming')).find((rec) => rec.sid === sid);
    },

    async countFreshSpares() {
      // Fresh spare = active AND empty-burn AND not earmarked for a connecting
      // group. D7: the un-burned check MUST be Set-or-array-safe (burned_phones
      // reads back as a Set, but the type admits string[]) - never `!x?.size`.
      const actives = await listByState('active');
      return actives.filter((rec) => {
        const burned = rec.burned_phones;
        const burnedCount =
          burned instanceof Set ? burned.size : Array.isArray(burned) ? burned.length : 0;
        return burnedCount === 0 && rec.pending_conversation_id === undefined;
      }).length;
    },

    async countWarming() {
      return (await listByState('warming')).length;
    },

    async findByPendingConversationId(conversationId) {
      // Scan the two pre-open partitions (both tiny) and filter by the earmark. A
      // connecting group's number is WARMING before its A2P registration and ACTIVE
      // after promotion (until the group opens), so both must be checked.
      const [warming, active] = await Promise.all([
        listByState('warming'),
        listByState('active'),
      ]);
      return [...warming, ...active].filter(
        (rec) => rec.pending_conversation_id === conversationId,
      );
    },

    async clearPendingConversation(poolNumber) {
      // Idempotent REMOVE, conditioned only on the record existing so a missing
      // number is never phantom-created. REMOVE of an absent attribute succeeds, so
      // a record already un-earmarked is a benign no-op. A missing record fails the
      // condition and is swallowed (best-effort reclaim). PII (doc section 9):
      // poolNumber is PII - log a marker only, never the number.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { poolNumber },
            UpdateExpression: 'REMOVE pending_conversation_id',
            ConditionExpression: 'attribute_exists(poolNumber)',
          }),
        );
        log.info({ event: 'pool_earmark_cleared' }, 'pool number connect-when-ready earmark cleared');
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return;
        throw err;
      }
    },

    async listActive() {
      // All ACTIVE numbers - the hot reuse/sweep path. Delegates to listByState;
      // kept as its own named method so callers (services/poolNumbers.ts) read
      // clearly and the contract is unchanged.
      return listByState('active');
    },

    async burnClaim(poolNumber, phones, tag) {
      // Never claim with an empty roster - an unburnable group would silently
      // match every number (attribute_not_exists(#bp) short-circuits the guard).
      if (phones.length === 0) return undefined;
      const names: Record<string, string> = { '#bp': 'burned_phones' };
      const values: Record<string, unknown> = {
        ':phones': new Set(phones),
        ':active': 'active',
      };
      if (tag !== undefined) values[':tag'] = tag;
      const notContains = phones
        .map((p, i) => {
          values[`:p${i}`] = p;
          return `NOT contains(#bp, :p${i})`;
        })
        .join(' AND ');
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { poolNumber },
            UpdateExpression:
              'ADD #bp :phones' + (tag !== undefined ? ' SET placement_tag = :tag' : ''),
            // The whole invariant in ONE condition: the number is active AND no
            // roster phone was ever burned here. attribute_not_exists(#bp)
            // covers a number created with an empty roster (no set yet). This
            // is the race-safe claim - never weaken it to a read-then-write.
            ConditionExpression:
              `lifecycle_state = :active AND (attribute_not_exists(#bp) OR (${notContains}))`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ burnCount: phones.length }, 'pool number burn-claimed');
        return Attributes as PoolNumberItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return undefined;
        throw err;
      }
    },

    async noteGroupClosed(poolNumber, closedAt) {
      // Monotonic max: only advance last_group_closed_at. Conditioned on the
      // record existing (so a missing number is never phantom-created) AND the
      // new timestamp being strictly newer. Both an older timestamp and a
      // missing record fail the condition and are swallowed - best-effort.
      //
      // AF-11: distinguish the two condition-failure causes.
      // ReturnValuesOnConditionCheckFailure 'ALL_OLD' makes the exception carry
      // `Item` when the record EXISTS (the older-timestamp no-op - stay silent,
      // expected) and NO `Item` when the record is MISSING (the retirement clock
      // is silently never stamped). A missing record here is unexpected, so WARN
      // it. PII (doc section 9): poolNumber is PII - log hasRecord only, NEVER
      // the number.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { poolNumber },
            UpdateExpression: 'SET last_group_closed_at = :t',
            ConditionExpression:
              'attribute_exists(poolNumber) AND ' +
              '(attribute_not_exists(last_group_closed_at) OR last_group_closed_at < :t)',
            ExpressionAttributeValues: { ':t': closedAt },
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          }),
        );
        log.info({ noted: true }, 'pool number group-close noted');
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // No Item on the exception => the record is MISSING (not the benign
          // older-timestamp no-op). Best-effort still returns (the group is
          // already closed), but the missing pool record is worth noticing.
          if (err.Item === undefined) {
            log.warn(
              { hasRecord: false },
              'noteGroupClosed: pool record missing - retirement clock not stamped',
            );
          }
          return;
        }
        throw err;
      }
    },

    async beginRelease(poolNumber) {
      // W2 fence step 1: atomically claim active -> releasing. The number leaves
      // the 'active' partition (listActive) and burnClaim refuses it instantly.
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { poolNumber },
            UpdateExpression: 'SET lifecycle_state = :releasing',
            ConditionExpression: 'lifecycle_state = :active',
            ExpressionAttributeValues: { ':releasing': 'releasing', ':active': 'active' },
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ lifecycleState: 'releasing' }, 'pool number release claimed');
        return Attributes as PoolNumberItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return undefined;
        throw err;
      }
    },

    async abortRelease(poolNumber) {
      // W2 fence rollback: releasing -> active. Restores full reusability when a
      // re-verify finds an open group or the Twilio drop fails.
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { poolNumber },
            UpdateExpression: 'SET lifecycle_state = :active',
            ConditionExpression: 'lifecycle_state = :releasing',
            ExpressionAttributeValues: { ':active': 'active', ':releasing': 'releasing' },
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ lifecycleState: 'active' }, 'pool number release aborted (back in service)');
        return Attributes as PoolNumberItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return undefined;
        throw err;
      }
    },

    async releaseNumber(poolNumber) {
      const now = new Date().toISOString();
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { poolNumber },
            UpdateExpression: 'SET lifecycle_state = :released, released_at = :now',
            // W2: finalize from RELEASING (the sweep's beginRelease claim), never
            // straight from active - so a release cannot skip the fence.
            ConditionExpression: 'lifecycle_state = :releasing',
            ExpressionAttributeValues: {
              ':released': 'released',
              ':releasing': 'releasing',
              ':now': now,
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ lifecycleState: 'released' }, 'pool number released to Twilio');
        return Attributes as PoolNumberItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return undefined;
        throw err;
      }
    },
  };
}
