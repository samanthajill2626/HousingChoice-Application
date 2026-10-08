// listing-sends repo (BE4/C4) -- the "Sent to" / "Properties sent" record.
//
// ONE row per unit<->contact pairing captures that a property (a `unit`, the
// tenant-facing "home") was sent to a contact (a tenant, or a partner - spec 2026-10-06 D20). Two read directions share these
// rows:
//   - listByUnit(unitId)       -> the unit's "Sent to" roster (base table).
//   - listByContact(contactId) -> the contact's "Properties sent" (byContact GSI,
//     newest-first by sentAt).
//
// KEY shape (lib/tables.ts): PK unitId, SK contactId -- one row per pairing, so a
// re-send can never duplicate. The byContact GSI inverts it (PK contactId, SK
// sentAt) for the reverse direction.
//
// NO-RESET INVARIANT: the one writer, putShareMemory, stamps created_at (and
// via) only when absent, so a later share never rewrites the first-write
// furniture. (share-sent-outcome T7 retired the old blind upsert writer.)
//
// Items stay flexible documents; only the two key attrs + the byContact GSI key
// attrs (contactId, sentAt) are contractual (lib/tables.ts).
//
// share-sent-outcome D7 - THE LEDGER FOLLOWS THE RULE: a row carries per-share
// memory (`shares`, one entry per share of the pair: the attempt it records and
// that attempt's ledger state) and a `counted` flag. Only a `counted` entry
// counts; while none does, `counted` is false and `sentAt` + `broadcastId` are
// REMOVED, so the byContact index drops the pair by attribute ABSENCE and the
// base-table reader filters it. Every memory write is a conditional
// read-modify-write on the row's change token (`shares_op`, stamped fresh by
// each putShareMemory); services/shareLedger.ts is its one caller. A legacy row
// (no memory yet) has no `counted` and reads as counted.
//
// PII (doc section 9): NEVER log names/phones -- IDs/type only.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { queryAll } from '../lib/dynamoPaging.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { TourSignal } from '../lib/listingSendTour.js';
import type { ContactType } from './contactsRepo.js';
import type { RepoDeps } from './conversationsRepo.js';

/** How the property reached the tenant (C4 `ListingSendRow.via`). */
export type ListingSendVia = 'broadcast' | 'individual';

/** share-sent-outcome D7: one share entry's ledger state. Only `counted` counts. */
export type ShareLedgerState = 'counted' | 'pending' | 'unconfirmed' | 'failed';

/** share-sent-outcome D7: what the ledger remembers for one share of a pair. */
export interface ShareLedgerEntry {
  /** The attempt this entry records (shareAttemptOrder key; `!legacy` / `!individual` for a seeded entry). */
  attempt: string;
  /** The attempt row's conversation (D6 reads the row for a pending entry). Absent on a seeded entry. */
  conversationId?: string;
  state: ShareLedgerState;
  /** For `counted`: what counted it. A DELIVERY-counted entry is terminal (I2). */
  by?: 'acceptance' | 'delivery';
  /** ISO - the ATTEMPT's own provider instant (never a write instant): the row's sentAt follows the latest counted one. */
  countedAt?: string;
}

/** share-sent-outcome D7: the memory a putShareMemory write sets (sentAt / broadcastId undefined = REMOVED). */
export interface ShareMemoryWrite {
  shares: Record<string, ShareLedgerEntry>;
  counted: boolean;
  sentAt: string | undefined;
  broadcastId: string | undefined;
}

/** One stored listing-send row. Flexible document - these are the read fields. */
export interface ListingSendItem {
  /** PK - the unit (property) that was sent. */
  unitId: string;
  /** SK - the tenant the unit was sent to. */
  contactId: string;
  /**
   * byContact GSI range (ISO 8601) - when the property was (most recently)
   * sent: the latest COUNTED share's attempt instant. REMOVED while no share
   * counts (share-sent-outcome D7), so the index drops the pair; a listed row
   * always has one.
   */
  sentAt?: string;
  via: ListingSendVia;
  /** The broadcast that sent it, when via='broadcast'. */
  broadcastId?: string;
  /** ISO 8601 — when the row was first written (audit furniture). */
  created_at: string;
  /** ISO 8601 — last touched (audit furniture). */
  updated_at: string;
  /** share-sent-outcome D7: true while any share entry counts; ABSENT on a legacy row = counted. */
  counted?: boolean;
  /** share-sent-outcome D7: the per-share memory, keyed by broadcastId (or `individual`). Absent on a legacy row. */
  shares?: Record<string, ShareLedgerEntry>;
  /** share-sent-outcome D7: the change token every putShareMemory stamps (a random id, never a clock). */
  shares_op?: string;
  [key: string]: unknown;
}

/**
 * The C4 wire shape (`ListingSendRow`, VERBATIM — the frontend imports it).
 * created_at/updated_at are dropped; broadcastId is included only when present.
 * `tour` is the DERIVED chip signal for this (unit, tenant) pairing, attached by
 * the GET projections (units recipients / contact listings-sent); ABSENT when no
 * qualifying tour exists (never null). The dashboard mirrors this shape.
 */
export interface ListingSendRow {
  contactId: string;
  /** Denormalized tenant display name, attached by the GET projections (same
   *  contacts join as the roster's `name`). HONEST - absent when the contact is
   *  unknown or has no name; the dashboard then falls back to the id. */
  tenantName?: string;
  unitId: string;
  sentAt: string;
  via: ListingSendVia;
  broadcastId?: string;
  tour?: TourSignal;
  /** caseworkers D20 (plan 3.7): the recipient's contact type - on the units
   *  recipients read ONLY, and only when the contact resolves (absent, never
   *  null, otherwise). The dashboard labels a non-tenant row by it. */
  type?: ContactType;
  /** caseworkers D20: the recipient's role, when it holds text (same rules as `type`). */
  role?: string;
}

/** caseworkers D20: the recipient facts the units recipients read attaches to a row. */
export interface ListingSendRecipientFacts {
  type?: ContactType;
  role?: string;
}

export interface ListingSendsRepo {
  /** Point read of a single row by its full key (PK+SK). */
  getByKey(unitId: string, contactId: string): Promise<ListingSendItem | undefined>;
  /** share-sent-outcome D7: `getByKey` with ConsistentRead - the read a memory write decides from. */
  getByKeyConsistent(unitId: string, contactId: string): Promise<ListingSendItem | undefined>;
  /**
   * share-sent-outcome D7: write the row's per-share memory in ONE conditional
   * write. SETs `shares`, `counted`, a fresh `shares_op` token and
   * `updated_at`; stamps `created_at` and `via` ('broadcast') only if absent;
   * SETs or REMOVEs `sentAt` and `broadcastId` (undefined = REMOVE - never an
   * empty REMOVE clause). The condition is `shares_op = :tok`, or, when
   * `expect.token` is undefined, `attribute_not_exists(shares_op)` (an absent
   * row OR a seeded/legacy row nobody has written memory on). `false` = the
   * condition failed (the caller re-reads and re-applies); anything else throws.
   */
  putShareMemory(unitId: string, contactId: string, next: ShareMemoryWrite, expect: { token: string | undefined }): Promise<boolean>;
  /**
   * share-sent-outcome D6: BatchGet of rows by (unitId, contactId), keyed
   * `${unitId}|${contactId}` (chunks of 100; unprocessed keys are retried once,
   * then WARNed with their ids and left absent). Missing pairs are absent.
   */
  getByKeys(pairs: Array<{ unitId: string; contactId: string }>): Promise<Map<string, ListingSendItem>>;
  /** The unit's recipients (base-table Query, PK=unitId); a row no share counts is filtered out. */
  listByUnit(unitId: string): Promise<ListingSendItem[]>;
  /** The contact's listings-sent (byContact GSI, newest-first by sentAt); a row no share counts is filtered out. */
  listByContact(contactId: string): Promise<ListingSendItem[]>;
}

/** The key getByKeys answers under. */
export function listingSendKey(unitId: string, contactId: string): string {
  return `${unitId}|${contactId}`;
}

/**
 * share-sent-outcome D7: whether a stored row is LISTED - some share counts
 * (`counted` absent on a legacy row reads as counted) and it carries the
 * `sentAt` every listed row has. The one rule both readers apply.
 */
function isListed(row: ListingSendItem): boolean {
  return row.counted !== false && typeof row.sentAt === 'string';
}

/**
 * Pure serializer to the C4 wire shape. Drops the audit furniture
 * (created_at/updated_at); includes broadcastId only when present. The optional
 * `tour` chip signal (derived from the tours table by the caller) is attached
 * only when supplied - a row with no qualifying tour carries no `tour` field.
 */
export function toListingSendRow(
  item: ListingSendItem,
  tour?: TourSignal,
  tenantName?: string,
  recipient?: ListingSendRecipientFacts,
): ListingSendRow {
  // share-sent-outcome D7: only a counted row is projected (the readers filter
  // the rest), and a counted row always carries sentAt - the guard documents it.
  if (item.sentAt === undefined) {
    throw new Error(`toListingSendRow: listing-send ${item.unitId}|${item.contactId} has no sentAt (an un-counted row is never projected)`);
  }
  return {
    contactId: item.contactId,
    ...(tenantName !== undefined && { tenantName }),
    unitId: item.unitId,
    sentAt: item.sentAt,
    via: item.via,
    ...(item.broadcastId !== undefined && { broadcastId: item.broadcastId }),
    ...(tour !== undefined && { tour }),
    ...(recipient?.type !== undefined && { type: recipient.type }),
    ...(recipient?.role !== undefined && { role: recipient.role }),
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
    async getByKeyConsistent(unitId, contactId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { unitId, contactId }, ConsistentRead: true }),
      );
      return Item as ListingSendItem | undefined;
    },

    async putShareMemory(unitId, contactId, next, expect) {
      // Every attribute is aliased, and names/values are built per statement:
      // `:sentAt` / `:bid` / `:tok` are bound only when used (an unused alias is
      // a ValidationException), and the REMOVE clause exists only when
      // something is removed (an empty REMOVE is a syntax error).
      const now = new Date().toISOString();
      const names: Record<string, string> = {
        '#shares': 'shares',
        '#counted': 'counted',
        '#op': 'shares_op',
        '#updatedAt': 'updated_at',
        '#createdAt': 'created_at',
        '#via': 'via',
        '#sentAt': 'sentAt',
        '#bid': 'broadcastId',
      };
      const values: Record<string, unknown> = {
        ':shares': next.shares,
        ':counted': next.counted,
        ':op': randomUUID(),
        ':now': now,
        ':via': 'broadcast',
      };
      const sets = [
        '#shares = :shares',
        '#counted = :counted',
        '#op = :op',
        '#updatedAt = :now',
        '#createdAt = if_not_exists(#createdAt, :now)',
        '#via = if_not_exists(#via, :via)',
      ];
      const removes: string[] = [];
      if (next.sentAt !== undefined) {
        sets.push('#sentAt = :sentAt');
        values[':sentAt'] = next.sentAt;
      } else {
        removes.push('#sentAt');
      }
      if (next.broadcastId !== undefined) {
        sets.push('#bid = :bid');
        values[':bid'] = next.broadcastId;
      } else {
        removes.push('#bid');
      }
      let condition = 'attribute_not_exists(#op)';
      if (expect.token !== undefined) {
        condition = '#op = :tok';
        values[':tok'] = expect.token;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { unitId, contactId },
            UpdateExpression: `SET ${sets.join(', ')}` + (removes.length > 0 ? ` REMOVE ${removes.join(', ')}` : ''),
            ConditionExpression: condition,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
      log.info(
        { unitId, contactId, counted: next.counted, broadcastId: next.broadcastId, shareCount: Object.keys(next.shares).length },
        'listing send memory written',
      );
      return true;
    },

    async getByKeys(pairs) {
      const out = new Map<string, ListingSendItem>();
      const unique = new Map<string, { unitId: string; contactId: string }>();
      for (const p of pairs) unique.set(listingSendKey(p.unitId, p.contactId), { unitId: p.unitId, contactId: p.contactId });
      const keysAll = [...unique.values()];
      for (let i = 0; i < keysAll.length; i += 100) {
        let keys: Array<{ unitId: string; contactId: string }> = keysAll.slice(i, i + 100);
        // The first read, then ONE retry of whatever DynamoDB left unprocessed.
        for (let round = 0; round < 2 && keys.length > 0; round += 1) {
          const res = await doc.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }));
          for (const item of (res.Responses?.[table] ?? []) as ListingSendItem[]) {
            out.set(listingSendKey(item.unitId, item.contactId), item);
          }
          keys = (res.UnprocessedKeys?.[table]?.Keys ?? []) as Array<{ unitId: string; contactId: string }>;
        }
        if (keys.length > 0) {
          log.warn(
            { count: keys.length, keys: keys.map((k) => listingSendKey(k.unitId, k.contactId)) },
            'listing sends getByKeys: keys still unprocessed after one retry - left absent',
          );
        }
      }
      return out;
    },

    getByKey,

    async listByUnit(unitId) {
      // Paged to exhaustion - one Query caps at 1 MB, and a busy property's
      // older sends would otherwise vanish from the "Sent to" card.
      // share-sent-outcome D7: the base table holds un-counted rows too - the
      // reader drops them (the GSI drops them by absence).
      const rows = await queryAll<ListingSendItem>(doc, {
        TableName: table,
        KeyConditionExpression: 'unitId = :u',
        ExpressionAttributeValues: { ':u': unitId },
      });
      return rows.filter(isListed);
    },

    async listByContact(contactId) {
      // Paged to exhaustion (see listByUnit). Ordering is preserved: each page
      // continues the same newest-first index walk. The index is sparse by
      // sentAt's absence; the filter is the same rule as listByUnit's.
      const rows = await queryAll<ListingSendItem>(doc, {
        TableName: table,
        IndexName: 'byContact',
        KeyConditionExpression: 'contactId = :c',
        ExpressionAttributeValues: { ':c': contactId },
        ScanIndexForward: false, // newest-first by sentAt
      });
      return rows.filter(isListed);
    },
  };
}
