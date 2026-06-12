// conversations repo — thread headers + inbox index (doc §5).
//
// One ACTIVE 1:1 conversation per external phone: createOrGetByParticipantPhone
// queries the byParticipantPhone GSI before creating. Item shape is a flexible
// document; only keys/GSI attributes (conversationId, participant_phone,
// status, last_activity_at) are contractual (lib/tables.ts).
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
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

/** Conversation thread types (doc §5; relay groups land with a later milestone). */
export type ConversationType = 'tenant_1to1' | 'landlord_1to1';

/** Phase 2 hands `auto` to the AI; `manual` means humans only (breaker trips here). */
export type ConversationMode = 'auto' | 'manual';

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
  created_at: string;
  /** Circuit-breaker minute bucket (`YYYY-MM-DDTHH:mm`, UTC). */
  outbound_minute_bucket?: string;
  /** Automated sends observed within outbound_minute_bucket. */
  outbound_minute_count?: number;
  [key: string]: unknown;
}

/** Previews are denormalized inbox furniture, not transcripts — keep them short. */
const PREVIEW_MAX_CHARS = 120;

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
   * byParticipantPhone GSI, created (status `open`, ai_mode `auto`) when none
   * exists. NOTE: the GSI is eventually consistent, so two concurrent firsts
   * can race a duplicate; M1.1 traffic (single webhook + single operator)
   * makes that acceptable — revisit if fan-out ever creates conversations.
   */
  createOrGetByParticipantPhone(phone: string, type: ConversationType): Promise<ConversationItem>;
  getById(conversationId: string): Promise<ConversationItem | undefined>;
  /** Stamp the byLastActivity GSI attrs (status + last_activity_at) + preview. */
  touchLastActivity(conversationId: string, previewText: string | undefined, ts: string): Promise<void>;
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

  return {
    getById,

    async createOrGetByParticipantPhone(phone, type) {
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
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(conversationId)',
        }),
      );
      log.info({ conversationId: item.conversationId, type }, 'conversation created');
      return item;
    },

    async touchLastActivity(conversationId, previewText, ts) {
      const preview = toPreview(previewText);
      await doc.send(
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
        }),
      );
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
