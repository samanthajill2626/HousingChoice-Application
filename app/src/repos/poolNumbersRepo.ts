// pool_numbers repo — the lifecycle store for relay-group pool numbers (M1.7).
//
// A pool number moves available → assigned → quarantined → available:
//   - available   provisioned, free to claim. claim() flips it to assigned.
//   - assigned    fronting exactly one active relay_group conversation.
//   - quarantined released (relay closed) but NOT reusable until
//                 quarantine_until passes — carriers recycle freed numbers and
//                 a prior conversant might still text it (the
//                 quarantine-reuse-collision guard). reclaimExpired() flips it
//                 back to available once the window lapses.
//
// The byLifecycleState GSI (HASH lifecycle_state, RANGE quarantine_until) is
// queried for findAvailable() and the reclaim sweep. quarantine_until is
// written on EVERY item (a past-time sentinel for non-quarantined states, the
// real release deadline once quarantined) so available items still index —
// see lib/tables.ts for why the GSI is not sparse.
//
// PII: a phone number is PII (doc §9). Log lifecycle_state + counts only,
// never the poolNumber itself — these lines are correlated via the pino mixin.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

/** Pool-number lifecycle states (doc §5 M1.7 deviation). */
export type PoolNumberLifecycleState = 'available' | 'assigned' | 'quarantined';

/**
 * Which messaging driver obtained the number (M1.7 kill-switch). A flexible doc
 * field (NOT a key/GSI attr): 'console' numbers are local/test fakes written
 * into the shared dev table; 'twilio' numbers are real purchases. The live
 * twilio path must NEVER reuse a 'console' fake (and vice-versa) — the service
 * filters reuse by the CURRENT driver.
 */
export type PoolNumberProvisionedVia = 'console' | 'twilio';

/** Quarantine window before a released number may be reclaimed (30 days). */
export const QUARANTINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A past-time sentinel written to quarantine_until for non-quarantined items
 * so they still appear in the byLifecycleState GSI (DynamoDB indexes an item
 * only when both key attrs are present). It is never compared against — the
 * reclaim sweep only reads the 'quarantined' partition.
 */
const NOT_QUARANTINED_SENTINEL = '0000-00-00T00:00:00.000Z';

/**
 * The contractual + commonly read attributes; the item stays a flexible
 * document (only keys/GSI attrs are contractual — lib/tables.ts).
 */
export interface PoolNumberItem {
  /** E.164 pool number (PK). */
  poolNumber: string;
  /** byLifecycleState GSI HASH. */
  lifecycle_state: PoolNumberLifecycleState;
  /** byLifecycleState GSI RANGE — real deadline when quarantined, sentinel otherwise. */
  quarantine_until: string;
  voice_capable: boolean;
  sms_capable: boolean;
  /**
   * Driver that obtained this number (M1.7 kill-switch source tag). Flexible
   * doc field; absent on legacy items (treated as unknown — never reused by the
   * source-isolation filter).
   */
  provisioned_via?: PoolNumberProvisionedVia;
  /** The relay_group conversation currently fronted by this number (assigned). */
  assigned_conversation_id?: string;
  /** Operator placement label carried through provisioning. */
  placement_tag?: string;
  provisioned_at: string;
  assigned_at?: string;
  released_at?: string;
  [key: string]: unknown;
}

export interface CreatePoolNumberInput {
  poolNumber: string;
  voiceCapable: boolean;
  smsCapable: boolean;
  /** Defaults to 'available'. */
  lifecycleState?: PoolNumberLifecycleState;
  /** Source driver tag (M1.7 kill-switch) — 'console' fakes vs 'twilio' real. */
  provisionedVia?: PoolNumberProvisionedVia;
}

export interface PoolNumbersRepo {
  get(poolNumber: string): Promise<PoolNumberItem | undefined>;
  /**
   * Conditionally create a pool-number record (attribute_not_exists guard).
   * quarantine_until is set to the sentinel so the new (available) item
   * indexes on byLifecycleState. Returns the stored item.
   */
  create(input: CreatePoolNumberInput): Promise<PoolNumberItem>;
  /**
   * First 'available' number on the byLifecycleState GSI, or undefined when
   * the pool is empty. ONE Query (never a Scan). The caller still races to
   * claim() it — the GSI read is the candidate, claim() is the arbiter.
   */
  findAvailable(): Promise<PoolNumberItem | undefined>;
  /**
   * Race-safe claim: available → assigned, conditional on
   * lifecycle_state='available'. Returns the post-update item on success;
   * undefined when the conditional failed (someone else claimed it first /
   * it is no longer available) so the caller can try the next candidate.
   */
  claim(
    poolNumber: string,
    conversationId: string,
    tag?: string,
  ): Promise<PoolNumberItem | undefined>;
  /**
   * Point an already-assigned number at its real conversation id (M1.7
   * create flow): provisionForPlacement claims under a provisional id before
   * the conversation row exists, then this stamps the real id. Conditional on
   * the number being 'assigned' (never reassigns an available/quarantined one).
   */
  reassign(poolNumber: string, conversationId: string): Promise<void>;
  /**
   * Release a number to quarantine: lifecycle_state='quarantined',
   * released_at=now, quarantine_until=now+QUARANTINE_WINDOW. Idempotent on the
   * existence guard. Returns the post-update item.
   */
  release(poolNumber: string): Promise<PoolNumberItem>;
  /**
   * Reclaim sweep: flip quarantined → available for every number whose
   * quarantine_until <= now (ONE Query on the 'quarantined' partition +
   * conditional updates). Resets quarantine_until to the sentinel + clears
   * assignment. Returns the count reclaimed.
   */
  reclaimExpired(now: Date): Promise<number>;
}

export function createPoolNumbersRepo(deps: RepoDeps = {}): PoolNumbersRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('pool_numbers', deps.env);
  const log = deps.logger ?? defaultLogger;

  async function get(poolNumber: string): Promise<PoolNumberItem | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { poolNumber } }));
    return Item as PoolNumberItem | undefined;
  }

  return {
    get,

    async create(input) {
      const now = new Date().toISOString();
      const item: PoolNumberItem = {
        poolNumber: input.poolNumber,
        lifecycle_state: input.lifecycleState ?? 'available',
        quarantine_until: NOT_QUARANTINED_SENTINEL,
        voice_capable: input.voiceCapable,
        sms_capable: input.smsCapable,
        ...(input.provisionedVia !== undefined && { provisioned_via: input.provisionedVia }),
        provisioned_at: now,
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(poolNumber)',
        }),
      );
      log.info({ lifecycleState: item.lifecycle_state }, 'pool number created');
      return item;
    },

    async findAvailable() {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byLifecycleState',
          KeyConditionExpression: 'lifecycle_state = :s',
          ExpressionAttributeValues: { ':s': 'available' },
          Limit: 1,
        }),
      );
      return (Items as PoolNumberItem[] | undefined)?.[0];
    },

    async claim(poolNumber, conversationId, tag) {
      const now = new Date().toISOString();
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { poolNumber },
            UpdateExpression:
              'SET lifecycle_state = :assigned, assigned_conversation_id = :cid, assigned_at = :now' +
              (tag !== undefined ? ', placement_tag = :tag' : ''),
            // Race-safe: only an 'available' number can be claimed.
            ConditionExpression: 'lifecycle_state = :available',
            ExpressionAttributeValues: {
              ':assigned': 'assigned',
              ':available': 'available',
              ':cid': conversationId,
              ':now': now,
              ...(tag !== undefined && { ':tag': tag }),
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ conversationId }, 'pool number claimed');
        return Attributes as PoolNumberItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return undefined;
        throw err;
      }
    },

    async reassign(poolNumber, conversationId) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { poolNumber },
          UpdateExpression: 'SET assigned_conversation_id = :cid',
          ConditionExpression: 'lifecycle_state = :assigned',
          ExpressionAttributeValues: { ':cid': conversationId, ':assigned': 'assigned' },
        }),
      );
      log.info({ conversationId }, 'pool number reassigned to conversation');
    },

    async release(poolNumber) {
      const now = new Date();
      const releasedAt = now.toISOString();
      const quarantineUntil = new Date(now.getTime() + QUARANTINE_WINDOW_MS).toISOString();
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { poolNumber },
          UpdateExpression:
            'SET lifecycle_state = :q, released_at = :rel, quarantine_until = :qu REMOVE assigned_conversation_id',
          ConditionExpression: 'attribute_exists(poolNumber)',
          ExpressionAttributeValues: {
            ':q': 'quarantined',
            ':rel': releasedAt,
            ':qu': quarantineUntil,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ quarantineUntil }, 'pool number released to quarantine');
      return Attributes as PoolNumberItem;
    },

    async reclaimExpired(now) {
      const cutoff = now.toISOString();
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byLifecycleState',
          KeyConditionExpression: 'lifecycle_state = :q AND quarantine_until <= :now',
          ExpressionAttributeValues: { ':q': 'quarantined', ':now': cutoff },
        }),
      );
      const expired = (Items as PoolNumberItem[] | undefined) ?? [];
      let reclaimed = 0;
      for (const item of expired) {
        try {
          await doc.send(
            new UpdateCommand({
              TableName: table,
              Key: { poolNumber: item.poolNumber },
              UpdateExpression: 'SET lifecycle_state = :available, quarantine_until = :sentinel',
              // Re-check state+deadline at write time: a concurrent claim or a
              // fresh release must not be clobbered (forward-only reclaim).
              ConditionExpression:
                'lifecycle_state = :q AND quarantine_until <= :now',
              ExpressionAttributeValues: {
                ':available': 'available',
                ':sentinel': NOT_QUARANTINED_SENTINEL,
                ':q': 'quarantined',
                ':now': cutoff,
              },
            }),
          );
          reclaimed += 1;
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
          // Lost a race — leave it; the next sweep re-evaluates.
        }
      }
      if (reclaimed > 0) log.info({ reclaimed }, 'pool numbers reclaimed from quarantine');
      return reclaimed;
    },
  };
}
