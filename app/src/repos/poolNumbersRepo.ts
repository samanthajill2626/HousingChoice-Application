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
 */
export type PoolNumberLifecycleState = 'active' | 'releasing' | 'released';

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
}

export interface PoolNumbersRepo {
  get(poolNumber: string): Promise<PoolNumberItem | undefined>;
  /**
   * Create an ACTIVE record with burned_phones seeded from `burn` (the roster
   * of the first group). attribute_not_exists guard. burned_phones is written
   * ONLY when the roster is non-empty (DynamoDB forbids empty string sets).
   */
  create(input: CreatePoolNumberInput): Promise<PoolNumberItem>;
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
