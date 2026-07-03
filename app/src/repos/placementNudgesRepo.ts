// Placement nudges repo — durable nudge rows for the placement-nudge poll job.
//
// Each row: { nudgeId, placementId, kind, dueAt (ISO), sentAt?, canceledAt? }
//
// GSI byDueAt: hash='nudges' (fixed partition key _nudgePartition),
// range=dueAt (ISO) — allows the poll to query "due now" with dueAt <= now.
//
// GSI byPlacement: hash=placementId — allows bulk cancel on stage move.
//
// PII: never log a phone number. Log only nudgeId/placementId/kind.
//
// This is a rename-clone of tourRemindersRepo.ts — the claim-before-send
// conditional-expression semantics are IDENTICAL by design.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
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

export type NudgeKind =
  | 'receipt_check'
  | 'completion_check'
  | 'approval_check'
  | 'rta_window_closing';

export interface PlacementNudgeItem {
  /** PK */
  nudgeId: string;
  /** byPlacement GSI hash key */
  placementId: string;
  kind: NudgeKind;
  /** ISO 8601 — byDueAt GSI range key */
  dueAt: string;
  /** byDueAt GSI hash key (fixed value 'nudges') */
  _nudgePartition: 'nudges';
  /** ISO — set when sent */
  sentAt?: string;
  /** ISO — set when canceled */
  canceledAt?: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface PlacementNudgesRepo {
  create(input: { placementId: string; kind: NudgeKind; dueAt: string }): Promise<PlacementNudgeItem>;
  /** All nudge rows for a placement (any state). */
  listByPlacement(placementId: string): Promise<PlacementNudgeItem[]>;
  /** Returns pending nudges due at or before `now` (no sentAt, no canceledAt). */
  listDue(nowIso: string): Promise<PlacementNudgeItem[]>;
  /**
   * Atomically claim a nudge row BEFORE sending (claim-before-send pattern).
   * Sets `sentAt` with a condition that neither `sentAt` NOR `canceledAt` already
   * exists — so a concurrent poll tick or a race with cancelForPlacement both lose.
   * Returns `true` if this call won the claim, `false` if already claimed/canceled
   * (benign no-op; caller skips the send).
   */
  claimSend(nudgeId: string, nowIso: string): Promise<boolean>;
  /** Cancel all pending (not yet sent or canceled) nudges for this placement. */
  cancelForPlacement(placementId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlacementNudgesRepo(deps: RepoDeps = {}): PlacementNudgesRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('placementNudges', deps.env);
  const log = deps.logger ?? defaultLogger;

  return {
    async create(input) {
      const now = new Date().toISOString();
      const item: PlacementNudgeItem = {
        nudgeId: `nudge-${randomUUID()}`,
        placementId: input.placementId,
        kind: input.kind,
        dueAt: input.dueAt,
        _nudgePartition: 'nudges',
        createdAt: now,
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(nudgeId)',
        }),
      );
      log.info({ nudgeId: item.nudgeId, placementId: item.placementId, kind: item.kind, dueAt: item.dueAt }, 'placement nudge created');
      return item;
    },

    async listByPlacement(placementId) {
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byPlacement',
        KeyConditionExpression: '#placementId = :placementId',
        ExpressionAttributeNames: { '#placementId': 'placementId' },
        ExpressionAttributeValues: { ':placementId': placementId },
      };
      const { Items } = await doc.send(new QueryCommand(input));
      return (Items ?? []) as PlacementNudgeItem[];
    },

    async listDue(nowIso) {
      // Query the byDueAt GSI: all rows in the 'nudges' partition with dueAt <= now.
      // FilterExpression removes rows that already have sentAt or canceledAt.
      // Paginate with LastEvaluatedKey so rows beyond the 1 MB DynamoDB page limit
      // are not silently dropped (mirrors usersRepo.listAll / broadcastsRepo pattern).
      const baseInput: QueryCommandInput = {
        TableName: table,
        IndexName: 'byDueAt',
        KeyConditionExpression: '#np = :np AND #dueAt <= :now',
        FilterExpression: 'attribute_not_exists(#sentAt) AND attribute_not_exists(#canceledAt)',
        ExpressionAttributeNames: {
          '#np': '_nudgePartition',
          '#dueAt': 'dueAt',
          '#sentAt': 'sentAt',
          '#canceledAt': 'canceledAt',
        },
        ExpressionAttributeValues: {
          ':np': 'nudges',
          ':now': nowIso,
        },
      };
      const items: PlacementNudgeItem[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(
          new QueryCommand({
            ...baseInput,
            ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        items.push(...((page.Items as PlacementNudgeItem[] | undefined) ?? []));
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
      return items;
    },

    async claimSend(nudgeId, nowIso) {
      // Atomically claim the row BEFORE sending (claim-before-send pattern).
      // Condition: neither sentAt nor canceledAt may exist — so two concurrent
      // poll ticks over the same row, and a cancel-then-poll race, both result in
      // exactly one send. Returns true if this call won the claim, false (benign
      // no-op) if the row was already claimed, already sent, or already canceled.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { nudgeId },
            UpdateExpression: 'SET #sentAt = :sentAt',
            ConditionExpression:
              'attribute_not_exists(#sentAt) AND attribute_not_exists(#canceledAt)',
            ExpressionAttributeNames: {
              '#sentAt': 'sentAt',
              '#canceledAt': 'canceledAt',
            },
            ExpressionAttributeValues: { ':sentAt': nowIso },
          }),
        );
        log.info({ nudgeId, claimedAt: nowIso }, 'placement nudge claimed for send');
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Benign: another poll tick or a cancel won the race. Not an error.
          log.debug({ nudgeId }, 'placement nudge claim lost (already claimed/canceled) — skipping');
          return false;
        }
        throw err;
      }
    },

    async cancelForPlacement(placementId) {
      const rows = await this.listByPlacement(placementId);
      const pending = rows.filter((r) => r.sentAt === undefined && r.canceledAt === undefined);
      const canceledAt = new Date().toISOString();
      // Promise.allSettled so one lost conditional-update race (e.g., the poll
      // claimed sentAt between listByPlacement and now) does not abort the
      // remaining cancellations.
      const results = await Promise.allSettled(
        pending.map((r) =>
          doc.send(
            new UpdateCommand({
              TableName: table,
              Key: { nudgeId: r.nudgeId },
              UpdateExpression: 'SET #canceledAt = :canceledAt',
              ConditionExpression: 'attribute_not_exists(#sentAt) AND attribute_not_exists(#canceledAt)',
              ExpressionAttributeNames: {
                '#canceledAt': 'canceledAt',
                '#sentAt': 'sentAt',
              },
              ExpressionAttributeValues: { ':canceledAt': canceledAt },
            }),
          ),
        ),
      );
      // Log per-row races as debug (benign no-ops); rethrow unexpected errors.
      let canceled = 0;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          canceled++;
        } else if (result.reason instanceof ConditionalCheckFailedException) {
          log.debug({ placementId }, 'placement nudge cancel: row already claimed/canceled — skipping');
        } else {
          log.error({ err: result.reason, placementId }, 'placement nudge cancel: unexpected error on row');
        }
      }
      log.info({ placementId, canceled }, 'placement nudges canceled for placement');
    },
  };
}
