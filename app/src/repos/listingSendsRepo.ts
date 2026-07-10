// listing-sends repo (BE4/C4) -- the "Sent to tenants" / "Properties sent" record.
//
// ONE row per unit<->contact pairing captures that a property (a `unit`, the
// tenant-facing "home") was sent to a tenant. Two read directions share these
// rows:
//   - listByUnit(unitId)       -> the unit's "Sent to tenants" roster (base table).
//   - listByContact(contactId) -> the tenant's "Properties sent" (byContact GSI,
//     newest-first by sentAt).
//
// KEY shape (lib/tables.ts): PK unitId, SK contactId -- one upsert-keyed row per
// pairing, so a re-send can never duplicate. The byContact GSI inverts it (PK
// contactId, SK sentAt) for the reverse direction.
//
// IDEMPOTENCY / NO-RESET INVARIANT: recordSend is an UPSERT. On the FIRST send it
// stamps sentAt/via/broadcastId + created_at; a RE-SEND refreshes sentAt/via/
// broadcastId + updated_at but LEAVES created_at untouched (if_not_exists), so a
// re-send never rewrites the first-write furniture. The ledger fields
// (sentAt/via/broadcastId) are always refreshed to the latest send.
//
// Items stay flexible documents; only the two key attrs + the byContact GSI key
// attrs (contactId, sentAt) are contractual (lib/tables.ts).
//
// PII (doc section 9): NEVER log names/phones -- IDs/type only.
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

/** How the property reached the tenant (C4 `ListingSendRow.via`). */
export type ListingSendVia = 'broadcast' | 'individual';

/** One stored listing-send row. Flexible document — these are the read fields. */
export interface ListingSendItem {
  /** PK — the unit (property) that was sent. */
  unitId: string;
  /** SK — the tenant the unit was sent to. */
  contactId: string;
  /** byContact GSI range (ISO 8601) — when the property was (most recently) sent. */
  sentAt: string;
  via: ListingSendVia;
  /** The broadcast that sent it, when via='broadcast'. */
  broadcastId?: string;
  /** ISO 8601 — when the row was first written (audit furniture). */
  created_at: string;
  /** ISO 8601 — last touched (audit furniture). */
  updated_at: string;
  [key: string]: unknown;
}

/**
 * The C4 wire shape (`ListingSendRow`, VERBATIM — the frontend imports it).
 * created_at/updated_at are dropped; broadcastId is included only when present.
 */
export interface ListingSendRow {
  contactId: string;
  unitId: string;
  sentAt: string;
  via: ListingSendVia;
  broadcastId?: string;
}

/** recordSend() input — sentAt defaults to now. */
export interface RecordSendInput {
  contactId: string;
  unitId: string;
  via: ListingSendVia;
  broadcastId?: string;
  /** ISO 8601 override (defaults to now). */
  sentAt?: string;
}

export interface ListingSendsRepo {
  /**
   * UPSERT a listing-send keyed by (unitId, contactId). CREATE stamps
   * sentAt/via/broadcastId + created_at; RE-SEND refreshes sentAt/via/broadcastId
   * (created_at is preserved). Returns the stored row (ALL_NEW).
   */
  recordSend(input: RecordSendInput): Promise<ListingSendItem>;
  /** Point read of a single row by its full key (PK+SK). */
  getByKey(unitId: string, contactId: string): Promise<ListingSendItem | undefined>;
  /** The unit's recipients (base-table Query, PK=unitId). */
  listByUnit(unitId: string): Promise<ListingSendItem[]>;
  /** The contact's listings-sent (byContact GSI, newest-first by sentAt). */
  listByContact(contactId: string): Promise<ListingSendItem[]>;
}

/**
 * Pure serializer to the C4 wire shape. Drops the audit furniture
 * (created_at/updated_at); includes broadcastId only when present.
 */
export function toListingSendRow(item: ListingSendItem): ListingSendRow {
  return {
    contactId: item.contactId,
    unitId: item.unitId,
    sentAt: item.sentAt,
    via: item.via,
    ...(item.broadcastId !== undefined && { broadcastId: item.broadcastId }),
  };
}

export function createListingSendsRepo(deps: RepoDeps = {}): ListingSendsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('listing_sends', deps.env);
  const log = deps.logger ?? defaultLogger;

  const getByKey = async (
    unitId: string,
    contactId: string,
  ): Promise<ListingSendItem | undefined> => {
    const { Item } = await doc.send(
      new GetCommand({ TableName: table, Key: { unitId, contactId } }),
    );
    return Item as ListingSendItem | undefined;
  };

  return {
    async recordSend(input) {
      const now = new Date().toISOString();
      const sentAt = input.sentAt ?? now;
      // Idempotent UPSERT. A re-send (the row already exists) refreshes
      // sentAt/via/broadcastId + updated_at; created_at is stamped only on the
      // first write (if_not_exists). broadcastId is set when supplied, else
      // REMOVEd (an individual re-send clears a prior broadcast attribution
      // rather than leaving a stale id).
      const sets = [
        'sentAt = :sentAt',
        'via = :via',
        'updated_at = :now',
        'created_at = if_not_exists(created_at, :now)',
      ];
      const removes: string[] = [];
      const values: Record<string, unknown> = {
        ':sentAt': sentAt,
        ':via': input.via,
        ':now': now,
      };
      if (input.broadcastId !== undefined) {
        sets.push('broadcastId = :bid');
        values[':bid'] = input.broadcastId;
      } else {
        removes.push('broadcastId');
      }
      const updateExpression =
        `SET ${sets.join(', ')}` + (removes.length > 0 ? ` REMOVE ${removes.join(', ')}` : '');
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { unitId: input.unitId, contactId: input.contactId },
          UpdateExpression: updateExpression,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info(
        { unitId: input.unitId, contactId: input.contactId, via: input.via },
        'listing send recorded',
      );
      return Attributes as ListingSendItem;
    },

    getByKey,

    async listByUnit(unitId) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'unitId = :u',
          ExpressionAttributeValues: { ':u': unitId },
        }),
      );
      return (Items ?? []) as ListingSendItem[];
    },

    async listByContact(contactId) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byContact',
          KeyConditionExpression: 'contactId = :c',
          ExpressionAttributeValues: { ':c': contactId },
          ScanIndexForward: false, // newest-first by sentAt
        }),
      );
      return (Items ?? []) as ListingSendItem[];
    },
  };
}
