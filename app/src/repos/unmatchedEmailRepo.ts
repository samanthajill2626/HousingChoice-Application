// Unmatched-email repo (email-channel B3) - the unmatched_email table: the
// unknown-sender inbound side-door + the sender blocklist.
//
// Two kinds of item share the single-key table, disjoint by key prefix:
//
//   um-<hash>        one non-threaded inbound mail (B2's NewUnmatchedEmail +
//                    the stamps added here: unmatchedId, read, TTL). The id is
//                    DETERMINISTIC - `um-<sha256(raw_ref)>` - so a redelivery of
//                    the same S3 object dedupes via a conditional put (created
//                    flag), the side-door analog of append's sid# idempotency.
//                    Lifecycle
//                    status: unmatched -> linked | dismissed, or quarantined ->
//                    unmatched (release) | dismissed; blocked senders' mail
//                    arrives as 'dismissed' (invisible to the feeds).
//   block#<address>  a sender-blocklist pointer (normalized-lowercase address;
//                    B2 tier 3 isBlocked). Carries NO status/received_at, so it
//                    never indexes in the sparse byStatus GSI and never
//                    surfaces in any feed.
//
// Retention (plan review F19) - the DynamoDB TTL attribute `expires_at`
// (epoch SECONDS), applied at insert AND on every status transition:
//   unmatched            -> no expires_at (awaiting a human; never expires)
//   quarantined          -> now + 90d
//   linked / dismissed   -> now + 90d
//   quarantined -> unmatched (release) -> expires_at REMOVED
// Blocklist pointers are permanent ("never again" is not a 90-day opinion).
//
// unreadCount is a CAPPED first-page count (the inbox 100-cap pattern): ONE
// byStatus Query over the 'unmatched' partition, Limit 100, counting
// read:false in code - NEVER a table Scan. The badge saturates at 100.
//
// PII (plan F18): addresses/subjects/bodies never appear in logs - ids,
// statuses, and counts only.
import { createHash } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { NewUnmatchedEmail, UnmatchedEmailStore } from '../services/inboundEmail.js';
import type { RepoDeps } from './conversationsRepo.js';

/** Row lifecycle. B2 never writes 'linked' - that is a B3 route transition. */
export type UnmatchedStatus = 'unmatched' | 'quarantined' | 'linked' | 'dismissed';

/** F19 retention: linked/dismissed/quarantined rows expire 90 days out. */
export const UNMATCHED_EMAIL_TTL_SECONDS = 90 * 24 * 60 * 60;

/** The capped first-page unread count (the inbox MAX_INBOX_LIMIT pattern). */
export const UNMATCHED_UNREAD_COUNT_CAP = 100;

/** The stored row: B2's NewUnmatchedEmail + the stamps this repo adds. */
export interface UnmatchedEmailItem extends Omit<NewUnmatchedEmail, 'status'> {
  /** PK - `um-<uuid>` (blocklist pointers use `block#<address>`, never returned here). */
  unmatchedId: string;
  /** byStatus GSI hash. */
  status: UnmatchedStatus;
  read: boolean;
  /** Set when a human linked this mail to a contact (status 'linked'). */
  linked_contact_id?: string;
  /** DynamoDB TTL, epoch seconds (F19 matrix above). */
  expires_at?: number;
}

/** The two triage feeds (B6 tabs). 'quarantine' = the 'quarantined' partition. */
export type UnmatchedListFilter = 'unmatched' | 'quarantine';

export interface ListUnmatchedOpts {
  limit?: number;
  /** The prior page's lastEvaluatedKey (routes opaque-cursor it, base64url). */
  exclusiveStartKey?: Record<string, unknown>;
}

export interface UnmatchedEmailPage {
  items: UnmatchedEmailItem[];
  /** Present when another page exists (the contactsRepo.listByType convention). */
  lastEvaluatedKey?: Record<string, unknown>;
}

/**
 * The full B3 store: B2's ingestion dep interface (putUnmatched/isBlocked -
 * implemented VERBATIM) plus what the /api/unmatched-email routes need.
 */
export interface UnmatchedEmailRepo extends UnmatchedEmailStore {
  putUnmatched(row: NewUnmatchedEmail): Promise<{ unmatchedId: string; created: boolean }>;
  isBlocked(address: string): Promise<boolean>;
  /** The row by id; undefined for unknown ids AND for blocklist pointer items. */
  getById(unmatchedId: string): Promise<UnmatchedEmailItem | undefined>;
  /** One byStatus page, newest-first (received_at DESC). Never a Scan. */
  listByStatus(filter: UnmatchedListFilter, opts?: ListUnmatchedOpts): Promise<UnmatchedEmailPage>;
  /** Flip read -> true. Returns the updated row; undefined for unknown ids. */
  markRead(unmatchedId: string): Promise<UnmatchedEmailItem | undefined>;
  /**
   * Status transition + the F19 TTL matrix (linked/dismissed/quarantined SET
   * expires_at +90d; unmatched REMOVEs it). Stamps linked_contact_id when
   * given. Returns the updated row; undefined for unknown ids. State-machine
   * legality (e.g. release requires 'quarantined') is the ROUTE's concern.
   */
  setStatus(
    unmatchedId: string,
    status: UnmatchedStatus,
    opts?: { linkedContactId?: string },
  ): Promise<UnmatchedEmailItem | undefined>;
  /** Capped first-page count of read:false 'unmatched' rows (cap 100). */
  unreadCount(): Promise<number>;
  /** Blocklist the (normalized-lowercase) address - idempotent put. */
  putBlock(address: string): Promise<void>;
  /** Un-blocklist an address (no route uses it yet; admin/repair seam). */
  removeBlock(address: string): Promise<void>;
}

const blockId = (address: string): string => `block#${address}`;

/**
 * Deterministic side-door id from the raw S3 ref: `um-<sha256(bucket/key)[:32]>`.
 * Same object -> same id, so putUnmatched's conditional put dedupes a redelivery
 * (the fix-wave B idempotency that lets the object marker be a fast path only).
 */
function deterministicUnmatchedId(rawRef: { bucket: string; key: string }): string {
  const hash = createHash('sha256').update(`${rawRef.bucket}/${rawRef.key}`).digest('hex');
  return `um-${hash.slice(0, 32)}`;
}

/** The F19 matrix: epoch-seconds TTL for statuses that expire, else undefined. */
function expiresAtFor(status: UnmatchedStatus, nowMs: number): number | undefined {
  if (status === 'unmatched') return undefined;
  return Math.floor(nowMs / 1000) + UNMATCHED_EMAIL_TTL_SECONDS;
}

export function createUnmatchedEmailRepo(deps: RepoDeps = {}): UnmatchedEmailRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('unmatched_email', deps.env);
  const log = deps.logger ?? defaultLogger;

  return {
    async putUnmatched(row) {
      // DETERMINISTIC id from the raw S3 ref + a conditional put: a redelivery
      // of the SAME object is a no-op (created:false), the side-door analog of
      // append's sid# idempotency. This - not the object marker - is what makes
      // a marker-less crash redelivery converge instead of double-writing or
      // dropping the row (fix-wave B).
      const unmatchedId = deterministicUnmatchedId(row.raw_ref);
      const expiresAt = expiresAtFor(row.status, Date.now());
      const item: UnmatchedEmailItem = {
        ...row,
        unmatchedId,
        read: false,
        ...(expiresAt !== undefined && { expires_at: expiresAt }),
      };
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: item,
            ConditionExpression: 'attribute_not_exists(unmatchedId)',
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info({ unmatchedId, status: row.status }, 'unmatched email row already stored (idempotent)');
          return { unmatchedId, created: false };
        }
        throw err;
      }
      log.info({ unmatchedId, status: row.status }, 'unmatched email row stored');
      return { unmatchedId, created: true };
    },

    async isBlocked(address) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { unmatchedId: blockId(address) } }),
      );
      return Item !== undefined;
    },

    async getById(unmatchedId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { unmatchedId } }),
      );
      // Blocklist pointers share the table but are NOT rows: they carry no
      // status/received_at. Never surface them as an UnmatchedEmailItem.
      if (Item === undefined || typeof (Item as { status?: unknown }).status !== 'string') {
        return undefined;
      }
      return Item as UnmatchedEmailItem;
    },

    async listByStatus(filter, opts = {}) {
      // ONE byStatus Query: hash = the stored status value, newest-first by
      // received_at (ScanIndexForward false). `status` is a DynamoDB reserved
      // word -> expression-aliased (the contactsRepo.listByType precedent).
      const status: UnmatchedStatus = filter === 'quarantine' ? 'quarantined' : 'unmatched';
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byStatus',
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
        ScanIndexForward: false,
        ...(opts.limit !== undefined && { Limit: opts.limit }),
        ...(opts.exclusiveStartKey !== undefined && {
          ExclusiveStartKey: opts.exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
        }),
      };
      const { Items, LastEvaluatedKey } = await doc.send(new QueryCommand(input));
      return {
        items: (Items ?? []) as UnmatchedEmailItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },

    async markRead(unmatchedId) {
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { unmatchedId },
            UpdateExpression: 'SET #read = :true',
            // received_at exists on every real row and never on a blocklist
            // pointer - the condition 404s both unknown ids AND pointer items.
            ConditionExpression: 'attribute_exists(unmatchedId) AND attribute_exists(received_at)',
            ExpressionAttributeNames: { '#read': 'read' },
            ExpressionAttributeValues: { ':true': true },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return Attributes as UnmatchedEmailItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return undefined;
        throw err;
      }
    },

    async setStatus(unmatchedId, status, opts = {}) {
      const expiresAt = expiresAtFor(status, Date.now());
      const sets = ['#s = :s'];
      const names: Record<string, string> = { '#s': 'status' };
      const values: Record<string, unknown> = { ':s': status };
      if (expiresAt !== undefined) {
        sets.push('#exp = :exp');
        names['#exp'] = 'expires_at';
        values[':exp'] = expiresAt;
      }
      if (opts.linkedContactId !== undefined) {
        sets.push('#lc = :lc');
        names['#lc'] = 'linked_contact_id';
        values[':lc'] = opts.linkedContactId;
      }
      let update = `SET ${sets.join(', ')}`;
      if (expiresAt === undefined) {
        // Back to 'unmatched' (release): the row awaits action again - it must
        // NOT keep a countdown (F19).
        names['#exp'] = 'expires_at';
        update += ' REMOVE #exp';
      }
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { unmatchedId },
            UpdateExpression: update,
            ConditionExpression: 'attribute_exists(unmatchedId) AND attribute_exists(received_at)',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ unmatchedId, status }, 'unmatched email status set');
        return Attributes as UnmatchedEmailItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return undefined;
        throw err;
      }
    },

    async unreadCount() {
      // The inbox 100-cap pattern: ONE first-page Query over the 'unmatched'
      // byStatus partition, counting read:false in code. Deliberately NOT a
      // paginated full count (unbounded work on a hostile flood) and never a
      // Scan; the nav badge saturates at the cap.
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byStatus',
          KeyConditionExpression: '#s = :s',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': 'unmatched' },
          ScanIndexForward: false,
          Limit: UNMATCHED_UNREAD_COUNT_CAP,
        }),
      );
      const rows = (Items ?? []) as UnmatchedEmailItem[];
      return rows.filter((r) => r.read === false).length;
    },

    async putBlock(address) {
      // Idempotent put (re-blocking refreshes blocked_at; harmless). The item
      // deliberately carries NO status/received_at so it can never appear in
      // the byStatus feeds.
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: { unmatchedId: blockId(address), blocked_at: new Date().toISOString() },
        }),
      );
      log.info({}, 'sender blocklisted'); // PII: never the address
    },

    async removeBlock(address) {
      await doc.send(
        new DeleteCommand({ TableName: table, Key: { unmatchedId: blockId(address) } }),
      );
      log.info({}, 'sender un-blocklisted');
    },
  };
}
