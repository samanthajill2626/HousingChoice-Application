// Tour reminders repo — durable reminder rows for the tour-reminder poll job.
//
// Each row: { reminderId, tourId, kind, dueAt (ISO), sentAt?, canceledAt? }
//
// GSI byDueAt: hash='reminders' (fixed partition key _reminderPartition),
// range=dueAt (ISO) — allows the poll to query "due now" with dueAt <= now.
//
// GSI byTour: hash=tourId — allows bulk cancel on reschedule/cancel.
//
// PII: never log a phone number. Log only reminderId/tourId/tenantId/kind.
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

export type ReminderKind =
  | 'confirmation'
  | 'day_before'
  | 'morning_of'
  | 'en_route'
  | 'no_show_checkin';

/** Why the poll retired a rung WITHOUT sending (claim-skip; terminal, like
 *  sent/canceled — a later poll never retries it). */
export type ReminderSkipReason =
  | 'no_conversation'
  | 'contact_missing'
  | 'contact_no_phone'
  | 'tour_missing';

export interface TourReminderItem {
  /** PK */
  reminderId: string;
  /** byTour GSI hash key */
  tourId: string;
  kind: ReminderKind;
  /** ISO 8601 — byDueAt GSI range key */
  dueAt: string;
  /** byDueAt GSI hash key (fixed value 'reminders') */
  _reminderPartition: 'reminders';
  /** ISO — set when sent */
  sentAt?: string;
  /** ISO — set when canceled */
  canceledAt?: string;
  /** ISO — set when the poll retired the rung unsent (see skipReason). Without
   *  this stamp a skipped row stayed in listDue FOREVER: re-listed and
   *  re-skipped every poll, panel chip a permanent "sending shortly"
   *  (docs/issues/tour-reminder-unclaimed-skip-no-conversation.md). */
  skippedAt?: string;
  skipReason?: ReminderSkipReason;
  createdAt: string;
}

export interface TourRemindersRepo {
  create(input: { tourId: string; kind: ReminderKind; dueAt: string }): Promise<TourReminderItem>;
  listByTour(tourId: string): Promise<TourReminderItem[]>;
  /** Returns pending reminders due at or before `now` (no sentAt, no canceledAt). */
  listDue(now: string): Promise<TourReminderItem[]>;
  /**
   * Atomically claim a reminder row BEFORE sending (claim-before-send pattern).
   * Sets `sentAt` with a condition that neither `sentAt` NOR `canceledAt` already
   * exists — so a concurrent poll tick or a race with cancelForTour both lose.
   * Returns `true` if this call won the claim, `false` if already claimed/canceled
   * (benign no-op; caller skips the send).
   */
  claimSend(reminderId: string, claimedAt: string): Promise<boolean>;
  /**
   * Atomically retire a rung WITHOUT sending (claim-skip): stamps skippedAt +
   * skipReason under the same no-sentAt/no-canceledAt/no-skippedAt condition
   * claimSend uses, so a skipped row leaves listDue exactly once and can never
   * be sent later. Returns `true` when this call won the claim.
   */
  claimSkip(reminderId: string, skippedAt: string, reason: ReminderSkipReason): Promise<boolean>;
  /**
   * Cancel ONE pending rung (operator action, 2026-07-14). Same atomic
   * no-terminal condition as claimSend/claimSkip, so a cancel racing the
   * poll's send claim resolves to exactly one outcome. Returns true when this
   * call won (the rung is now canceled), false when it was already
   * sent/canceled/skipped (benign — the caller reports the honest state).
   */
  cancel(reminderId: string, canceledAt: string): Promise<boolean>;
  /**
   * Restore ONE canceled rung to pending (operator un-cancel). Conditional on
   * canceledAt existing AND no sentAt/skippedAt — restoring a sent or
   * never-canceled rung is a benign false. A restored PAST-DUE rung fires on
   * the next poll tick (the panel shows "sending shortly" — deliberate: an
   * un-canceled confirmation means "send it after all").
   */
  uncancel(reminderId: string): Promise<boolean>;
  /** Cancel all pending (not yet sent, canceled, or skipped) reminders for this tour. */
  cancelForTour(tourId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTourRemindersRepo(deps: RepoDeps = {}): TourRemindersRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('tourReminders', deps.env);
  const log = deps.logger ?? defaultLogger;

  return {
    async create(input) {
      const now = new Date().toISOString();
      const item: TourReminderItem = {
        reminderId: `reminder-${randomUUID()}`,
        tourId: input.tourId,
        kind: input.kind,
        dueAt: input.dueAt,
        _reminderPartition: 'reminders',
        createdAt: now,
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(reminderId)',
        }),
      );
      log.info({ reminderId: item.reminderId, tourId: item.tourId, kind: item.kind, dueAt: item.dueAt }, 'tour reminder created');
      return item;
    },

    async listByTour(tourId) {
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byTour',
        KeyConditionExpression: '#tourId = :tourId',
        ExpressionAttributeNames: { '#tourId': 'tourId' },
        ExpressionAttributeValues: { ':tourId': tourId },
      };
      const { Items } = await doc.send(new QueryCommand(input));
      return (Items ?? []) as TourReminderItem[];
    },

    async listDue(now) {
      // Query the byDueAt GSI: all rows in the 'reminders' partition with dueAt <= now.
      // FilterExpression removes rows that already have sentAt or canceledAt.
      // Paginate with LastEvaluatedKey so rows beyond the 1 MB DynamoDB page limit
      // are not silently dropped (mirrors usersRepo.listAll / broadcastsRepo pattern).
      const baseInput: QueryCommandInput = {
        TableName: table,
        IndexName: 'byDueAt',
        KeyConditionExpression: '#rp = :rp AND #dueAt <= :now',
        FilterExpression:
          'attribute_not_exists(#sentAt) AND attribute_not_exists(#canceledAt) AND attribute_not_exists(#skippedAt)',
        ExpressionAttributeNames: {
          '#rp': '_reminderPartition',
          '#dueAt': 'dueAt',
          '#sentAt': 'sentAt',
          '#canceledAt': 'canceledAt',
          '#skippedAt': 'skippedAt',
        },
        ExpressionAttributeValues: {
          ':rp': 'reminders',
          ':now': now,
        },
      };
      const items: TourReminderItem[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(
          new QueryCommand({
            ...baseInput,
            ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        items.push(...((page.Items as TourReminderItem[] | undefined) ?? []));
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
      return items;
    },

    async claimSend(reminderId, claimedAt) {
      // Atomically claim the row BEFORE sending (claim-before-send pattern).
      // Condition: neither sentAt nor canceledAt may exist — so two concurrent
      // poll ticks over the same row, and a cancel-then-poll race, both result in
      // exactly one send. Returns true if this call won the claim, false (benign
      // no-op) if the row was already claimed, already sent, or already canceled.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { reminderId },
            UpdateExpression: 'SET #sentAt = :sentAt',
            ConditionExpression:
              'attribute_not_exists(#sentAt) AND attribute_not_exists(#canceledAt) AND attribute_not_exists(#skippedAt)',
            ExpressionAttributeNames: {
              '#sentAt': 'sentAt',
              '#canceledAt': 'canceledAt',
              '#skippedAt': 'skippedAt',
            },
            ExpressionAttributeValues: { ':sentAt': claimedAt },
          }),
        );
        log.info({ reminderId, claimedAt }, 'tour reminder claimed for send');
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Benign: another poll tick or a cancel won the race. Not an error.
          log.debug({ reminderId }, 'tour reminder claim lost (already claimed/canceled) — skipping');
          return false;
        }
        throw err;
      }
    },

    async claimSkip(reminderId, skippedAt, reason) {
      // Claim-retire without sending — the skip twin of claimSend above. Same
      // atomic condition so a concurrent send/cancel/skip race resolves to
      // exactly one terminal state.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { reminderId },
            UpdateExpression: 'SET #skippedAt = :skippedAt, #skipReason = :reason',
            ConditionExpression:
              'attribute_not_exists(#sentAt) AND attribute_not_exists(#canceledAt) AND attribute_not_exists(#skippedAt)',
            ExpressionAttributeNames: {
              '#sentAt': 'sentAt',
              '#canceledAt': 'canceledAt',
              '#skippedAt': 'skippedAt',
              '#skipReason': 'skipReason',
            },
            ExpressionAttributeValues: { ':skippedAt': skippedAt, ':reason': reason },
          }),
        );
        log.info({ reminderId, skippedAt, reason }, 'tour reminder claim-skipped (retired unsent)');
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ reminderId }, 'tour reminder skip-claim lost (already terminal) — skipping');
          return false;
        }
        throw err;
      }
    },

    async cancel(reminderId, canceledAt) {
      // The per-rung twin of cancelForTour's row update — same atomic
      // no-terminal condition, so a race with claimSend/claimSkip resolves to
      // exactly one outcome.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { reminderId },
            UpdateExpression: 'SET #canceledAt = :canceledAt',
            ConditionExpression:
              'attribute_not_exists(#sentAt) AND attribute_not_exists(#canceledAt) AND attribute_not_exists(#skippedAt)',
            ExpressionAttributeNames: {
              '#canceledAt': 'canceledAt',
              '#sentAt': 'sentAt',
              '#skippedAt': 'skippedAt',
            },
            ExpressionAttributeValues: { ':canceledAt': canceledAt },
          }),
        );
        log.info({ reminderId, canceledAt }, 'tour reminder canceled (operator)');
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ reminderId }, 'tour reminder cancel lost (already terminal) — skipping');
          return false;
        }
        throw err;
      }
    },

    async uncancel(reminderId) {
      // REMOVE canceledAt, conditional on the row actually being canceled and
      // NOT sent/skipped — so an un-cancel can never resurrect a fired rung.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { reminderId },
            UpdateExpression: 'REMOVE #canceledAt',
            ConditionExpression:
              'attribute_exists(#canceledAt) AND attribute_not_exists(#sentAt) AND attribute_not_exists(#skippedAt)',
            ExpressionAttributeNames: {
              '#canceledAt': 'canceledAt',
              '#sentAt': 'sentAt',
              '#skippedAt': 'skippedAt',
            },
          }),
        );
        log.info({ reminderId }, 'tour reminder restored (operator un-cancel)');
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ reminderId }, 'tour reminder un-cancel lost (not canceled / already terminal) — skipping');
          return false;
        }
        throw err;
      }
    },

    async cancelForTour(tourId) {
      const rows = await this.listByTour(tourId);
      const pending = rows.filter(
        (r) => r.sentAt === undefined && r.canceledAt === undefined && r.skippedAt === undefined,
      );
      const canceledAt = new Date().toISOString();
      // Promise.allSettled so one lost conditional-update race (e.g., the poll
      // claimed sentAt between listByTour and now) does not abort the remaining
      // cancellations.
      const results = await Promise.allSettled(
        pending.map((r) =>
          doc.send(
            new UpdateCommand({
              TableName: table,
              Key: { reminderId: r.reminderId },
              UpdateExpression: 'SET #canceledAt = :canceledAt',
              ConditionExpression:
                'attribute_not_exists(#sentAt) AND attribute_not_exists(#canceledAt) AND attribute_not_exists(#skippedAt)',
              ExpressionAttributeNames: {
                '#canceledAt': 'canceledAt',
                '#sentAt': 'sentAt',
                '#skippedAt': 'skippedAt',
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
          log.debug({ tourId }, 'tour reminder cancel: row already claimed/canceled — skipping');
        } else {
          log.error({ err: result.reason, tourId }, 'tour reminder cancel: unexpected error on row');
        }
      }
      log.info({ tourId, canceled }, 'tour reminders canceled for tour');
    },
  };
}
