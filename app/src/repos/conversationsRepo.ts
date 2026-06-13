// conversations repo — thread headers + inbox index (doc §5).
//
// One ACTIVE 1:1 conversation per external phone: createOrGetByParticipantPhone
// queries the byParticipantPhone GSI as the fast path, with a phone-keyed
// CLAIM item (PK `phone#<E164>`, the same pointer pattern as the messages
// repo's SID items) as the correctness backstop — the GSI is eventually
// consistent, so two near-concurrent first messages can both miss it. Item
// shape is a flexible document; only keys/GSI attributes (conversationId,
// participant_phone, status, last_activity_at) are contractual
// (lib/tables.ts).
//
// Circuit-breaker state (doc §7.1) lives ON the conversation item as a
// minute-bucketed counter pair (outbound_minute_bucket + outbound_minute_count)
// maintained by conditional updates — see incrementAutomatedSendCount().
//
// PII: message bodies/previews must NEVER be logged (doc §9) — log lines here
// carry IDs and lengths only; correlation context is attached by the pino mixin.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

/**
 * Conversation thread types (doc §5; relay groups land with a later
 * milestone). `unknown_1to1` (2026-06-12 deviation) mirrors the contact-side
 * honesty rule: a thread with no resolved tenant/landlord identity is typed
 * `unknown_1to1`, never guessed.
 */
export type ConversationType = 'tenant_1to1' | 'landlord_1to1' | 'unknown_1to1';

/** Phase 2 hands `auto` to the AI; `manual` means humans only (breaker trips here). */
export type ConversationMode = 'auto' | 'manual';

/** A linked external participant (M1.2 auto-capture): contact + phone pair. */
export interface ConversationParticipant {
  contactId: string;
  phone: string;
}

/** The contractual + commonly read attributes; items stay flexible documents. */
export interface ConversationItem {
  conversationId: string;
  /** External participant's phone, E.164 (byParticipantPhone GSI). */
  participant_phone: string;
  /** byLastActivity GSI HASH. `open` is the only status M1.1 writes. */
  status: string;
  /** byLastActivity GSI RANGE (ISO 8601). */
  last_activity_at: string;
  type: ConversationType;
  ai_mode: ConversationMode;
  /**
   * Conversation-level STOP suppression (doc §7.1): set even when the phone
   * has no contact record yet (auto-capture is M1.2), so a STOP from an
   * unknown phone still refuses every later send. The send wrapper gates on
   * EITHER this OR the contact's sms_opt_out flag.
   */
  sms_opt_out?: boolean;
  /** Denormalized preview of the latest message (truncated; never logged). */
  last_message_preview?: string;
  /**
   * Participants → contactIds (doc §5; M1.2 auto-capture). 1:1 threads carry
   * exactly one entry; the array shape is the relay-group seam. Written once
   * via setParticipantsIfAbsent — the auto-capture race anchor.
   */
  participants?: ConversationParticipant[];
  /** Inbound messages since the last POST /:id/read (M1.2 unread tracking). */
  unread_count?: number;
  /** Assigned team member's userId (M1.2; users-table validation is M1.3). */
  assignment?: string;
  created_at: string;
  /** Circuit-breaker minute bucket (`YYYY-MM-DDTHH:mm`, UTC). */
  outbound_minute_bucket?: string;
  /** Automated sends observed within outbound_minute_bucket. */
  outbound_minute_count?: number;
  [key: string]: unknown;
}

/** Previews are denormalized inbox furniture, not transcripts — keep them short. */
const PREVIEW_MAX_CHARS = 120;

/** Default inbox page size (GET /api/conversations passes its own limit). */
const DEFAULT_INBOX_PAGE_LIMIT = 50;

export function toPreview(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  // Truncate by CODE POINTS (Array.from), not UTF-16 units — a string slice
  // could split a surrogate pair (emoji) at the boundary into a lone
  // surrogate that breaks downstream JSON/display.
  const points = Array.from(text);
  return points.length > PREVIEW_MAX_CHARS
    ? `${points.slice(0, PREVIEW_MAX_CHARS - 1).join('')}…`
    : text;
}

/** UTC minute bucket (`2026-06-12T15:04`) for the breaker counter. */
export function minuteBucket(at: Date = new Date()): string {
  return at.toISOString().slice(0, 16);
}

/**
 * Claim-item partition key for a phone (the per-phone create lock). Claim
 * partitions (`phone#…`) never collide with real `conv-…` partitions.
 */
function phoneClaimPk(phone: string): string {
  return `phone#${phone}`;
}

export interface RepoDeps {
  /** Injectable for tests (throwaway prefixes against DynamoDB Local). */
  doc?: DynamoDBDocumentClient;
  /** Env for tableName() resolution — tests pass a throwaway TABLE_PREFIX. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export interface ConversationsRepo {
  /**
   * The one active 1:1 conversation for an external phone — found via the
   * byParticipantPhone GSI (fast path), created (status `open`, ai_mode
   * `auto`) when none exists. The GSI is eventually consistent, so creation
   * is arbitrated by a conditional put on a phone-keyed claim item
   * (`phone#<E164>` → ref_conversationId): the winner creates the real row,
   * losers adopt the claimed id — two concurrent firsts can never create two
   * conversations. A crash between claim and row create self-heals on the
   * next call (the claimed id is recreated).
   */
  createOrGetByParticipantPhone(phone: string, type: ConversationType): Promise<ConversationItem>;
  getById(conversationId: string): Promise<ConversationItem | undefined>;
  /**
   * All conversations for an external phone via the byParticipantPhone GSI
   * (M1.4 contact triage: when a contact's type is resolved, the linked
   * conversation's type is propagated). Filters out the phone-claim items
   * (they don't project participant_phone, so they never appear in the GSI —
   * but the filter is defensive). Returns [] when none.
   */
  findByParticipantPhone(phone: string): Promise<ConversationItem[]>;
  /**
   * Set a conversation's type (M1.4 contact triage: unknown_1to1 →
   * tenant_1to1/landlord_1to1 once a human resolves the contact's identity).
   * Throws ConditionalCheckFailedException for unknown conversations.
   */
  setType(conversationId: string, type: ConversationType): Promise<void>;
  /**
   * Stamp the byLastActivity GSI attrs (status + last_activity_at) + preview.
   * Returns the post-update item (ALL_NEW) — the fresh inbox row the M1.2
   * SSE conversation.updated event is built from.
   */
  touchLastActivity(
    conversationId: string,
    previewText: string | undefined,
    ts: string,
  ): Promise<ConversationItem>;
  /**
   * Atomically claim the participants link IFF none exists yet — the M1.2
   * auto-capture race anchor (the conversation row is unique per phone; the
   * contacts byPhone GSI is NOT trustworthy mid-race). True when THIS call
   * set the link; false when a link already existed (read it via getById).
   * Throws when the conversation does not exist.
   */
  setParticipantsIfAbsent(
    conversationId: string,
    participants: ConversationParticipant[],
  ): Promise<boolean>;
  /** Atomic unread bump on a FRESH inbound persist; returns the new count. */
  incrementUnread(conversationId: string): Promise<number>;
  /**
   * Zero the unread counter (POST /:id/read); returns the updated item.
   * Throws ConditionalCheckFailedException for unknown conversations.
   */
  resetUnread(conversationId: string): Promise<ConversationItem>;
  /**
   * Set (string) or clear (null) the assignee. Returns the updated item plus
   * the previous assignee — captured atomically (ALL_OLD) for the
   * assignment_changed audit event. Throws ConditionalCheckFailedException
   * for unknown conversations.
   */
  setAssignment(
    conversationId: string,
    assigneeUserId: string | null,
  ): Promise<{ conversation: ConversationItem; previousAssigneeUserId: string | null }>;
  /**
   * THE inbox read (M1.2): ONE DynamoDB Query on the byLastActivity GSI
   * (status partition, last_activity_at descending) — never a Scan.
   * Pagination via the raw LastEvaluatedKey; routes base64 it into an
   * opaque cursor.
   */
  listByLastActivity(opts: {
    status: string;
    limit?: number;
    exclusiveStartKey?: Record<string, unknown>;
  }): Promise<{ items: ConversationItem[]; lastEvaluatedKey?: Record<string, unknown> }>;
  setMode(conversationId: string, mode: ConversationMode): Promise<void>;
  /** Set/clear the conversation-level STOP suppression flag (doc §7.1). */
  setSmsOptOut(conversationId: string, value: boolean): Promise<void>;
  /**
   * Circuit-breaker support (doc §7.1): atomically count an automated send
   * against the conversation's CURRENT minute bucket and return the new
   * count. Bucket rollover resets the counter via a conditional-update
   * retry pair (ADD within the bucket; SET on bucket change).
   */
  incrementAutomatedSendCount(conversationId: string, bucket: string): Promise<number>;
}

export function createConversationsRepo(deps: RepoDeps = {}): ConversationsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('conversations', deps.env);
  const log = deps.logger ?? defaultLogger;

  async function getById(conversationId: string): Promise<ConversationItem | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { conversationId } }));
    return Item as ConversationItem | undefined;
  }

  /**
   * Create the real conversation row under an agreed (claimed) id. Losing
   * the conditional put just means another caller created it first — read
   * it back and return it (both callers end up with the same row).
   */
  async function createConversationRow(item: ConversationItem): Promise<ConversationItem> {
    try {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(conversationId)',
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      const existing = await getById(item.conversationId);
      if (!existing) {
        throw new Error(
          `createOrGetByParticipantPhone: conversation ${item.conversationId} exists per the conditional put but is unreadable`,
        );
      }
      return existing;
    }
    log.info({ conversationId: item.conversationId, type: item.type }, 'conversation created');
    return item;
  }

  return {
    getById,

    async createOrGetByParticipantPhone(phone, type) {
      // Fast path: the byParticipantPhone GSI. Eventually consistent — a
      // miss here is NOT proof the conversation doesn't exist.
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byParticipantPhone',
          KeyConditionExpression: 'participant_phone = :p',
          ExpressionAttributeValues: { ':p': phone },
        }),
      );
      const active = (Items as ConversationItem[] | undefined)?.find((c) => c.status === 'open');
      if (active) return active;

      const now = new Date().toISOString();
      const item: ConversationItem = {
        conversationId: `conv-${randomUUID()}`,
        participant_phone: phone,
        status: 'open',
        last_activity_at: now,
        type,
        ai_mode: 'auto',
        created_at: now,
      };
      // Correctness backstop (the SID-pointer pattern from messagesRepo):
      // conditionally claim the phone before creating. The claim item
      // carries ONLY the key + ref_conversationId — no participant_phone,
      // status, or last_activity_at on purpose, so the sparse GSIs
      // (byParticipantPhone, byLastActivity) never index it.
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: { conversationId: phoneClaimPk(phone), ref_conversationId: item.conversationId },
            ConditionExpression: 'attribute_not_exists(conversationId)',
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Claim taken: another caller won (now or in the past). Adopt the
        // claimed id; if the winner crashed before creating the row, the
        // conditional create below self-heals it under the SAME id.
        const claim = await doc.send(
          new GetCommand({ TableName: table, Key: { conversationId: phoneClaimPk(phone) } }),
        );
        const ref = (claim.Item as { ref_conversationId?: unknown } | undefined)
          ?.ref_conversationId;
        if (typeof ref !== 'string' || ref.length === 0) {
          throw new Error(
            'createOrGetByParticipantPhone: phone claim exists but carries no ref_conversationId',
          );
        }
        const existing = await getById(ref);
        if (existing) return existing;
        return createConversationRow({ ...item, conversationId: ref });
      }
      return createConversationRow(item);
    },

    async findByParticipantPhone(phone) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byParticipantPhone',
          KeyConditionExpression: 'participant_phone = :p',
          ExpressionAttributeValues: { ':p': phone },
        }),
      );
      return (Items as ConversationItem[] | undefined) ?? [];
    },

    async setType(conversationId, type) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET #t = :type',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeNames: { '#t': 'type' },
          ExpressionAttributeValues: { ':type': type },
        }),
      );
      log.info({ conversationId, type }, 'conversation type set');
    },

    async touchLastActivity(conversationId, previewText, ts) {
      const preview = toPreview(previewText);
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          // Activity (re)opens the thread; preview only set when one exists.
          UpdateExpression:
            preview !== undefined
              ? 'SET #s = :open, last_activity_at = :ts, last_message_preview = :preview'
              : 'SET #s = :open, last_activity_at = :ts',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':open': 'open',
            ':ts': ts,
            ...(preview !== undefined && { ':preview': preview }),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return Attributes as ConversationItem;
    },

    async setParticipantsIfAbsent(conversationId, participants) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET participants = :p',
            ConditionExpression:
              'attribute_exists(conversationId) AND attribute_not_exists(participants)',
            ExpressionAttributeValues: { ':p': participants },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Either a link already exists (the normal race-loser case) or the
          // conversation is missing — disambiguate with a read.
          const existing = await getById(conversationId);
          if (!existing) {
            throw new Error(`setParticipantsIfAbsent: conversation not found: ${conversationId}`);
          }
          return false;
        }
        throw err;
      }
      log.info(
        { conversationId, contactId: participants[0]?.contactId },
        'conversation participants linked',
      );
      return true;
    },

    async incrementUnread(conversationId) {
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'ADD unread_count :one',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':one': 1 },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return (Attributes as ConversationItem).unread_count ?? 1;
    },

    async resetUnread(conversationId) {
      // Accepted risk (M1.2): SET-to-zero is last-write-wins vs in-flight
      // inbound increments — a read racing an inbound can drop that bump
      // (a watermark design fixes it if this ever bites).
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET unread_count = :zero',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':zero': 0 },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ conversationId }, 'conversation unread reset');
      return Attributes as ConversationItem;
    },

    async setAssignment(conversationId, assigneeUserId) {
      // ALL_OLD captures the previous assignee atomically with the write —
      // the assignment_changed audit event needs an honest old → new pair
      // even under concurrent PATCHes.
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: assigneeUserId === null ? 'REMOVE assignment' : 'SET assignment = :a',
          ConditionExpression: 'attribute_exists(conversationId)',
          ...(assigneeUserId !== null && {
            ExpressionAttributeValues: { ':a': assigneeUserId },
          }),
          ReturnValues: 'ALL_OLD',
        }),
      );
      const previous = Attributes as ConversationItem;
      const previousAssigneeUserId =
        typeof previous.assignment === 'string' ? previous.assignment : null;
      const conversation: ConversationItem = { ...previous };
      if (assigneeUserId === null) delete conversation.assignment;
      else conversation.assignment = assigneeUserId;
      log.info(
        { conversationId, assigneeUserId, previousAssigneeUserId },
        'conversation assignment set',
      );
      return { conversation, previousAssigneeUserId };
    },

    async listByLastActivity({ status, limit, exclusiveStartKey }) {
      // M1.2 mandate: the inbox is ONE Query on byLastActivity (status
      // partition, last_activity_at DESC) — NEVER a Scan, at any size.
      const { Items, LastEvaluatedKey } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byLastActivity',
          KeyConditionExpression: '#s = :status',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':status': status },
          ScanIndexForward: false, // newest activity first
          Limit: limit ?? DEFAULT_INBOX_PAGE_LIMIT,
          ...(exclusiveStartKey !== undefined && {
            ExclusiveStartKey: exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
          }),
        }),
      );
      return {
        items: (Items ?? []) as ConversationItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },

    async setMode(conversationId, mode) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET ai_mode = :mode',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':mode': mode },
        }),
      );
      log.info({ conversationId, mode }, 'conversation mode set');
    },

    async setSmsOptOut(conversationId, value) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET sms_opt_out = :v',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':v': value },
        }),
      );
      log.info({ conversationId, smsOptOut: value }, 'conversation sms_opt_out set');
    },

    async incrementAutomatedSendCount(conversationId, bucket) {
      // Accepted risk (M1.1): this is a FIXED minute window — a burst
      // straddling a bucket boundary can reach ~2x the cap before tripping.
      // Two conditional shapes, retried: (a) ADD when the item is already on
      // this bucket; (b) SET/reset when the bucket changed (or never existed).
      // A loser of either race re-enters the loop; two passes settle it in
      // practice, the bound is just a stuck-loop guard.
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const { Attributes } = await doc.send(
            new UpdateCommand({
              TableName: table,
              Key: { conversationId },
              UpdateExpression: 'ADD outbound_minute_count :one',
              ConditionExpression: 'outbound_minute_bucket = :bucket',
              ExpressionAttributeValues: { ':one': 1, ':bucket': bucket },
              ReturnValues: 'ALL_NEW',
            }),
          );
          return (Attributes as ConversationItem).outbound_minute_count ?? 1;
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
        }
        try {
          await doc.send(
            new UpdateCommand({
              TableName: table,
              Key: { conversationId },
              UpdateExpression: 'SET outbound_minute_bucket = :bucket, outbound_minute_count = :one',
              ConditionExpression:
                'attribute_exists(conversationId) AND (attribute_not_exists(outbound_minute_bucket) OR outbound_minute_bucket <> :bucket)',
              ExpressionAttributeValues: { ':bucket': bucket, ':one': 1 },
            }),
          );
          return 1;
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
        }
      }
      throw new Error(
        `incrementAutomatedSendCount: conditional updates kept failing for ${conversationId} — does the conversation exist?`,
      );
    },
  };
}
