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
  createdAt: string;
}

export interface TourRemindersRepo {
  create(input: { tourId: string; kind: ReminderKind; dueAt: string }): Promise<TourReminderItem>;
  listByTour(tourId: string): Promise<TourReminderItem[]>;
  /** Returns pending reminders due at or before `now` (no sentAt, no canceledAt). */
  listDue(now: string): Promise<TourReminderItem[]>;
  markSent(reminderId: string, sentAt: string): Promise<void>;
  /** Cancel all pending (not yet sent or canceled) reminders for this tour. */
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
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byDueAt',
        KeyConditionExpression: '#rp = :rp AND #dueAt <= :now',
        FilterExpression: 'attribute_not_exists(#sentAt) AND attribute_not_exists(#canceledAt)',
        ExpressionAttributeNames: {
          '#rp': '_reminderPartition',
          '#dueAt': 'dueAt',
          '#sentAt': 'sentAt',
          '#canceledAt': 'canceledAt',
        },
        ExpressionAttributeValues: {
          ':rp': 'reminders',
          ':now': now,
        },
      };
      const { Items } = await doc.send(new QueryCommand(input));
      return (Items ?? []) as TourReminderItem[];
    },

    async markSent(reminderId, sentAt) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { reminderId },
          UpdateExpression: 'SET #sentAt = :sentAt',
          // Belt+suspenders idempotency: only write if not already sent.
          ConditionExpression: 'attribute_not_exists(#sentAt)',
          ExpressionAttributeNames: { '#sentAt': 'sentAt' },
          ExpressionAttributeValues: { ':sentAt': sentAt },
        }),
      );
      log.info({ reminderId, sentAt }, 'tour reminder marked sent');
    },

    async cancelForTour(tourId) {
      const rows = await this.listByTour(tourId);
      const pending = rows.filter((r) => r.sentAt === undefined && r.canceledAt === undefined);
      const canceledAt = new Date().toISOString();
      await Promise.all(
        pending.map((r) =>
          doc.send(
            new UpdateCommand({
              TableName: table,
              Key: { reminderId: r.reminderId },
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
      log.info({ tourId, canceled: pending.length }, 'tour reminders canceled for tour');
    },
  };
}
