// listing-sends repo (BE4/C4) — the "Sent to tenants" / "Listings sent" record.
//
// ONE row per unit↔contact pairing captures that a listing (a `unit`, the
// tenant-facing "home") was sent to a tenant and the tenant's RESPONSE. Two read
// directions share these rows:
//   - listByUnit(unitId)    → the unit's "Sent to tenants" roster (base table).
//   - listByContact(contactId) → the tenant's "Listings sent" (byContact GSI,
//     newest-first by sentAt).
//
// KEY shape (lib/tables.ts): PK unitId, SK contactId — one upsert-keyed row per
// pairing, so a re-send can never duplicate. The byContact GSI inverts it (PK
// contactId, SK sentAt) for the reverse direction.
//
// IDEMPOTENCY / NO-RESET INVARIANT: recordSend is an UPSERT. On the FIRST send
// it seeds response='no_reply'; on a RE-SEND it refreshes sentAt/via/broadcastId
// but MUST NOT touch `response` (a re-send must never wipe a tenant's recorded
// interest). The single UpdateCommand sets response only via if_not_exists, so
// the no-reset rule holds even under concurrent re-sends.
//
// Items stay flexible documents; only the two key attrs + the byContact GSI key
// attrs (contactId, sentAt) are contractual (lib/tables.ts).
//
// PII (doc §9): NEVER log names/phones — IDs/type/response only.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

/**
 * The tenant's response to a sent listing (C4 `ListingResponse`, VERBATIM — the
 * frontend imports the identical union). Defaults to 'no_reply' on send; a
 * manual PATCH sets 'interested' / 'not_a_fit' (inference later). Do NOT rename.
 */
export type ListingResponse = 'interested' | 'not_a_fit' | 'no_reply';

/** How the listing reached the tenant (C4 `ListingSendRow.via`). */
export type ListingSendVia = 'broadcast' | 'individual';

/** One stored listing-send row. Flexible document — these are the read fields. */
export interface ListingSendItem {
  /** PK — the unit (listing) that was sent. */
  unitId: string;
  /** SK — the tenant the unit was sent to. */
  contactId: string;
  response: ListingResponse;
  /** byContact GSI range (ISO 8601) — when the listing was (most recently) sent. */
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
  response: ListingResponse;
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
   * UPSERT a listing-send keyed by (unitId, contactId). CREATE seeds
   * response='no_reply' + sentAt; RE-SEND refreshes sentAt/via/broadcastId but
   * NEVER resets `response`. Returns the stored row (ALL_NEW).
   */
  recordSend(input: RecordSendInput): Promise<ListingSendItem>;
  /**
   * Set the tenant's response on an EXISTING row (+ updated_at). Throws
   * ConditionalCheckFailedException when the row is absent (route → 404).
   */
  setResponse(
    unitId: string,
    contactId: string,
    response: ListingResponse,
  ): Promise<ListingSendItem>;
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
    response: item.response,
    sentAt: item.sentAt,
    via: item.via,
    ...(item.broadcastId !== undefined && { broadcastId: item.broadcastId }),
  };
}

export function createListingSendsRepo(deps: RepoDeps = {}): ListingSendsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('listing_sends', deps.env);
  const log = deps.logger ?? defaultLogger;

  return {
    async recordSend(input) {
      const now = new Date().toISOString();
      const sentAt = input.sentAt ?? now;
      // Idempotent UPSERT. `response` is seeded only via if_not_exists, so a
      // re-send (the row already exists) refreshes sentAt/via/broadcastId +
      // updated_at WITHOUT ever resetting a recorded interest. created_at is
      // likewise stamped only on the first write. broadcastId is set when
      // supplied, else REMOVEd (an individual re-send clears a prior broadcast
      // attribution rather than leaving a stale id).
      const sets = [
        'sentAt = :sentAt',
        'via = :via',
        'updated_at = :now',
        'created_at = if_not_exists(created_at, :now)',
        '#response = if_not_exists(#response, :noReply)',
      ];
      const removes: string[] = [];
      const values: Record<string, unknown> = {
        ':sentAt': sentAt,
        ':via': input.via,
        ':now': now,
        ':noReply': 'no_reply',
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
          // `response` is a DynamoDB reserved word → aliased.
          ExpressionAttributeNames: { '#response': 'response' },
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

    async setResponse(unitId, contactId, response) {
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { unitId, contactId },
          UpdateExpression: 'SET #response = :response, updated_at = :now',
          // Only an EXISTING row may be transitioned — a missing pairing throws
          // ConditionalCheckFailedException (route → 404).
          ConditionExpression: 'attribute_exists(unitId)',
          ExpressionAttributeNames: { '#response': 'response' },
          ExpressionAttributeValues: {
            ':response': response,
            ':now': new Date().toISOString(),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ unitId, contactId, response }, 'listing send response set');
      return Attributes as ListingSendItem;
    },

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
