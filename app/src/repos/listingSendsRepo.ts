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
// NO-RESET INVARIANT: the one share writer, putShareMemory, stamps created_at
// (and via) only when absent, so a later share never rewrites the first-write
// furniture. (share-sent-outcome T7 retired the old blind upsert writer.) It
// extends to `declined` (last-heard-from spec 5.4): putShareMemory never SETs
// or REMOVEs it, and NO writer resets it except clearDeclined. The outcome
// route's two writers, setDeclined / clearDeclined, touch ONLY `declined`,
// `updated_at` and the change token `shares_op`, conditioned on a COUNTED
// row. flyer-leads O1: each stamps a FRESH token, so a ledger write that read
// the row before a decline landed loses its condition, re-reads and sees the
// decline (the flyer entry's current-decline refusal is decided on that
// re-read - services/shareLedger.ts applyFlyerShareEntry). A cleared decline's history
// lives in the activity / audit events, never on the row. The ONE accepted
// exception is dev-only: the seed runner's full PutCommand (lib/seed/index.ts,
// seedAll's Put loop) rewrites the seeded listing_sends rows (seed/cast.ts and
// seed/matrix.ts) whole, so a NON-wiping re-seed drops `declined` on those
// seeded pairs (/__dev/reseed clears the tables first, so it loses nothing).
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
// each putShareMemory and, since flyer-leads O1, by each decline writer);
// services/shareLedger.ts is its one caller. A legacy row
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
import type { DeclineRecord, InterestedMode, ListingSendOutcome } from '../lib/listingSendOutcome.js';
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
  /** share-sent-outcome D7: the per-share memory, keyed by broadcastId (or `individual`, or `flyer` for a flyer sign-up - flyer-leads D7). Absent on a legacy row. */
  shares?: Record<string, ShareLedgerEntry>;
  /** share-sent-outcome D7: the change token every putShareMemory stamps - and, since flyer-leads O1, every setDeclined / clearDeclined (a random id, never a clock). */
  shares_op?: string;
  /** last-heard-from spec 5.4: a recorded "not interested". Absent = not
   *  declined. Written ONLY by setDeclined / clearDeclined. Supersession is
   *  NOT stored: every read recomputes it (lib/listingSendOutcome.ts
   *  effectiveDecline) from the row's sentAt and the pair's tour activity
   *  (lib/listingSendTour.ts deriveTourActivityAt). Tour supersession is
   *  DURABLE (spec 14.7, code review round 2 A R2-1): the createdAt of EVERY
   *  tour for the pair counts, qualifying or not, so a record superseded by
   *  a tour created after it stays superseded - simply ineffective, left on
   *  the row - even once that tour is canceled, no_show or closed not a fit,
   *  whichever path created it. A cancel / no-show / not-a-fit MARK (a
   *  non-qualifying tour's lastMarkedAt) never supersedes on its own; only a
   *  QUALIFYING tour's lastMarkedAt does. Pinned in
   *  test/listingSendOutcome.test.ts (the spec 14.7 PIN). */
  declined?: DeclineRecord;
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
  /** Denormalized recipient label, attached ONLY by the units recipients read
   *  and the outcome route's re-projection (routes/units.ts recipientLabelOf;
   *  the contact listings-sent read never carries it - its contact is the page
   *  owner): the contact's name, else - flyer-leads AR13 - its OWN formatted
   *  phone, because an `unknown` contact a flyer sign-up puts on the card is
   *  never renamed (spec D4, D7). Absent when the contact did not resolve (a
   *  missing recipient) or has neither a name nor a phone; the dashboard then
   *  falls back to the id. Staff chrome only - never a message body. */
  tenantName?: string;
  unitId: string;
  sentAt: string;
  via: ListingSendVia;
  broadcastId?: string;
  /** TENANT rows only - never on a partner or missing recipient's row (spec 14.3 B11). */
  tour?: TourSignal;
  /** caseworkers D20 (plan 3.7): the recipient's contact type - on the units
   *  recipients read ONLY, and only when the contact resolves (absent, never
   *  null, otherwise). The dashboard labels a non-tenant row by it. */
  type?: ContactType;
  /** caseworkers D20: the recipient's role, when it holds text (same rules as `type`). */
  role?: string;
  /** last-heard-from spec 5.4 - the recipient's own last_heard_from_at. */
  lastHeardFromAt?: string;
  /** The derived send outcome (lib/listingSendOutcome.ts). */
  outcome: ListingSendOutcome;
  /** Present ONLY while the stored decline is effective; never staffId. */
  declined?: { at: string; by: 'staff' | 'engine' };
  /** false on a non-tenant or missing recipient (partners never read a tour). */
  interestedSupported: boolean;
  /** Units route only (the unit is known): 'route' with a structured tour_type. */
  interestedMode?: InterestedMode;
  /** Units route only: isEligibleRecipient on the recipient. */
  eligible?: boolean;
  /** true when the contact row is gone (a hard-deleted contact behind a listed row). */
  recipientMissing?: boolean;
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
   * row OR a seeded/legacy row nobody has written memory or a decline on). `false` = the
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
  /**
   * last-heard-from spec 5.4: SET `declined` (and `updated_at` and a fresh
   * `shares_op` - flyer-leads O1) on a COUNTED
   * row - condition `attribute_exists(unitId) AND (attribute_not_exists(counted)
   * OR counted <> :false)`. 'not_found' when the condition fails (no row, or no
   * share counts); anything else throws. Never creates a row.
   */
  setDeclined(unitId: string, contactId: string, record: DeclineRecord): Promise<'ok' | 'not_found'>;
  /**
   * REMOVE `declined` (SET `updated_at` and a fresh `shares_op`) under the same condition. Idempotent
   * without `opts`. With `opts.expectedAt` it is a COMPARE-AND-CLEAR (spec
   * 14.7, code review round 2 B R2-1): the condition also requires
   * `declined.at = :readAt`, so it removes only the record the caller READ - a
   * decline another staff member recorded meanwhile (or none at all) makes it
   * answer 'not_found' and write nothing.
   */
  clearDeclined(unitId: string, contactId: string, opts?: { expectedAt?: string }): Promise<'ok' | 'not_found'>;
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

/** The options a GET projection (or the outcome route) passes to toListingSendRow. */
export interface ListingSendRowOptions {
  tour?: TourSignal;
  tenantName?: string;
  facts?: ListingSendRecipientFacts;
  outcome: ListingSendOutcome;
  lastHeardFromAt?: string;
  declined?: { at: string; by: 'staff' | 'engine' };
  interestedSupported: boolean;
  interestedMode?: InterestedMode;
  eligible?: boolean;
  recipientMissing?: boolean;
}

/**
 * Pure serializer to the C4 wire shape. Drops the audit furniture and the
 * STORED decline (a caller passes `declined` only while it is effective -
 * wireDecline); includes broadcastId only when present; every optional field
 * only when supplied (absent, never null). `recipientMissing` only when true.
 */
export function toListingSendRow(item: ListingSendItem, opts: ListingSendRowOptions): ListingSendRow {
  // share-sent-outcome D7: only a counted row is projected (the readers filter
  // the rest), and a counted row always carries sentAt - the guard documents it.
  if (item.sentAt === undefined) {
    throw new Error(`toListingSendRow: listing-send ${item.unitId}|${item.contactId} has no sentAt (an un-counted row is never projected)`);
  }
  return {
    contactId: item.contactId,
    ...(opts.tenantName !== undefined && { tenantName: opts.tenantName }),
    unitId: item.unitId,
    sentAt: item.sentAt,
    via: item.via,
    ...(item.broadcastId !== undefined && { broadcastId: item.broadcastId }),
    ...(opts.tour !== undefined && { tour: opts.tour }),
    ...(opts.facts?.type !== undefined && { type: opts.facts.type }),
    ...(opts.facts?.role !== undefined && { role: opts.facts.role }),
    ...(opts.lastHeardFromAt !== undefined && { lastHeardFromAt: opts.lastHeardFromAt }),
    outcome: opts.outcome,
    ...(opts.declined !== undefined && { declined: { at: opts.declined.at, by: opts.declined.by } }),
    interestedSupported: opts.interestedSupported,
    ...(opts.interestedMode !== undefined && { interestedMode: opts.interestedMode }),
    ...(opts.eligible !== undefined && { eligible: opts.eligible }),
    ...(opts.recipientMissing === true && { recipientMissing: true }),
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

    async setDeclined(unitId, contactId, record) {
      const now = new Date().toISOString();
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { unitId, contactId },
            // flyer-leads O1: a fresh change token - a ledger write that read
            // the row before this decline loses its condition and re-reads.
            UpdateExpression: 'SET #declined = :declined, #updatedAt = :now, #op = :op',
            ConditionExpression: 'attribute_exists(#unitId) AND (attribute_not_exists(#counted) OR #counted <> :false)',
            ExpressionAttributeNames: {
              '#declined': 'declined',
              '#updatedAt': 'updated_at',
              '#unitId': 'unitId',
              '#counted': 'counted',
              '#op': 'shares_op',
            },
            ExpressionAttributeValues: {
              ':declined': { at: record.at, by: record.by, ...(record.staffId !== undefined && { staffId: record.staffId }) },
              ':now': now,
              ':false': false,
              ':op': randomUUID(),
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return 'not_found';
        throw err;
      }
      log.info({ unitId, contactId, by: record.by }, 'listing send decline recorded');
      return 'ok';
    },

    async clearDeclined(unitId, contactId, opts) {
      const now = new Date().toISOString();
      const expectedAt = opts?.expectedAt;
      const counted = 'attribute_exists(#unitId) AND (attribute_not_exists(#counted) OR #counted <> :false)';
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { unitId, contactId },
            // flyer-leads O1: a fresh change token, as setDeclined.
            UpdateExpression: 'SET #updatedAt = :now, #op = :op REMOVE #declined',
            // Compare-and-clear (B R2-1): an absent `declined` fails the
            // comparison too, so only the record the caller read is removed.
            ConditionExpression: expectedAt !== undefined ? `${counted} AND #declined.#at = :readAt` : counted,
            ExpressionAttributeNames: {
              '#declined': 'declined',
              '#updatedAt': 'updated_at',
              '#unitId': 'unitId',
              '#counted': 'counted',
              '#op': 'shares_op',
              ...(expectedAt !== undefined && { '#at': 'at' }),
            },
            ExpressionAttributeValues: { ':now': now, ':false': false, ':op': randomUUID(), ...(expectedAt !== undefined && { ':readAt': expectedAt }) },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return 'not_found';
        throw err;
      }
      log.info({ unitId, contactId }, 'listing send decline cleared');
      return 'ok';
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
