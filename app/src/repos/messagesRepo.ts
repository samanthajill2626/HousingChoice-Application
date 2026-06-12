// messages repo — the append-only conversation log (doc §5).
//
// SK shape: `<ISO ts>#<msgId>` where ts is the PROVIDER's message timestamp
// (stable across Twilio redeliveries) and msgId is the provider SID — so the
// same provider message always computes the same key, and the conditional
// append makes redeliveries/echoes a no-op. This is the §7.1 MessageSid
// idempotency primitive: outbound messages persist at send time, so the
// webhook echo of our own send dedupes here instead of re-entering pipelines.
//
// SID→location pointer: every append also writes `{ PK: sid#<providerSid>,
// SK: ptr }` carrying conversationId + tsMsgId, in the SAME transaction —
// Twilio status callbacks identify messages by SID alone and recover context
// by lookup (doc §9). Pointer partitions (`sid#…`) never collide with real
// conversation partitions, so listByConversation never sees them.
//
// PII: message bodies must NEVER be logged (doc §9) — IDs and lengths only.
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

export type MessageType = 'sms' | 'mms';
export type MessageDirection = 'inbound' | 'outbound';
/** Who authored the message (doc §5; `ai` is Phase 2). */
export type MessageAuthor = 'tenant' | 'landlord' | 'teammate' | 'ai';

/**
 * Outbound delivery status machine (doc §7.1):
 * queued → sent → delivered | undelivered | failed. Terminal states never
 * regress (a delivered message stays delivered).
 */
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';

/** Statuses a given new status may overwrite — forward-only transitions. */
const ALLOWED_PRIOR: Record<DeliveryStatus, DeliveryStatus[]> = {
  queued: [],
  sent: ['queued'],
  delivered: ['queued', 'sent'],
  undelivered: ['queued', 'sent'],
  failed: ['queued', 'sent'],
};

export function allowedPriorStatuses(next: DeliveryStatus): DeliveryStatus[] {
  return ALLOWED_PRIOR[next];
}

/** Deterministic SK: same provider message → same key, every delivery. */
export function buildTsMsgId(providerTs: string, providerSid: string): string {
  return `${providerTs}#${providerSid}`;
}

export interface NewMessage {
  conversationId: string;
  /** Provider message SID (Twilio SMxxx/MMxxx) — the idempotency key. */
  providerSid: string;
  /** PROVIDER timestamp (ISO 8601) — stable across redeliveries. */
  providerTs: string;
  type: MessageType;
  direction: MessageDirection;
  author: MessageAuthor;
  body?: string;
  /** Provider media URLs (MMS); S3 mirroring is Builder B's webhook path. */
  mediaUrls?: string[];
  deliveryStatus: DeliveryStatus;
  errorCode?: string;
}

export interface MessageItem {
  conversationId: string;
  tsMsgId: string;
  type: MessageType;
  direction: MessageDirection;
  author: MessageAuthor;
  body?: string;
  mediaUrls?: string[];
  provider_sid: string;
  provider_ts: string;
  delivery_status: DeliveryStatus;
  error_code?: string;
  created_at: string;
  /** S3 keys of mirrored MMS media (M1.1 webhook path), index-aligned-by-key. */
  media_s3_keys?: string[];
  /** Set on a 30003 retry send: the tsMsgId of the message being retried. */
  retry_of?: string;
  /** 1-based retry attempt number (caps the 30003 retry chain, doc §7.1). */
  retry_attempt?: number;
  [key: string]: unknown;
}

/**
 * Post-append annotations (M1.1 Builder B). The timeline stays append-only in
 * the doc-§5 sense — content (body/author/direction) is never rewritten;
 * these add operational metadata the same way delivery_status updates do.
 */
export interface MessageAnnotations {
  mediaS3Keys?: string[];
  retryOf?: string;
  retryAttempt?: number;
}

export interface AppendResult {
  /** False = fresh write; true = this provider SID was already persisted. */
  deduped: boolean;
  /** The PERSISTED message's SK — on dedupe, the FIRST write's key (which can differ from this call's providerTs). */
  tsMsgId: string;
}

export interface ListByConversationOptions {
  limit?: number;
  /** Exclusive upper bound on tsMsgId — pass the oldest seen key to page back. */
  before?: string;
}

export interface MessagesRepo {
  /** Conditional append + SID pointer in one transaction; dedupe is a no-op. */
  append(message: NewMessage): Promise<AppendResult>;
  /** Resolve a provider SID to its message via the pointer item (doc §9). */
  getByProviderSid(sid: string): Promise<MessageItem | undefined>;
  /**
   * Apply a status-callback transition. Returns false (no-op) when the
   * message is unknown or the transition would move backwards — delivery
   * callbacks arrive out of order and redelivered (doc §7.1).
   */
  updateDeliveryStatus(sid: string, status: DeliveryStatus, errorCode?: string): Promise<boolean>;
  /** Newest-first page of a conversation's log. */
  listByConversation(conversationId: string, opts?: ListByConversationOptions): Promise<MessageItem[]>;
  /** Stamp operational metadata (media S3 keys / retry lineage) onto a message. */
  annotateMessage(conversationId: string, tsMsgId: string, annotations: MessageAnnotations): Promise<void>;
}

const DEFAULT_PAGE_LIMIT = 50;

/** Pointer partition key for a provider SID. */
function sidPk(providerSid: string): string {
  return `sid#${providerSid}`;
}

export function createMessagesRepo(deps: RepoDeps = {}): MessagesRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('messages', deps.env);
  const log = deps.logger ?? defaultLogger;

  /** Read the SID pointer item: where the persisted message actually lives. */
  async function getSidPointer(
    sid: string,
  ): Promise<{ ref_conversationId: string; ref_tsMsgId: string } | undefined> {
    const pointer = await doc.send(
      new GetCommand({ TableName: table, Key: { conversationId: sidPk(sid), tsMsgId: 'ptr' } }),
    );
    return pointer.Item as { ref_conversationId: string; ref_tsMsgId: string } | undefined;
  }

  async function getByProviderSid(sid: string): Promise<MessageItem | undefined> {
    const ptr = await getSidPointer(sid);
    if (!ptr) return undefined;
    const { Item } = await doc.send(
      new GetCommand({
        TableName: table,
        Key: { conversationId: ptr.ref_conversationId, tsMsgId: ptr.ref_tsMsgId },
      }),
    );
    return Item as MessageItem | undefined;
  }

  return {
    getByProviderSid,

    async append(message) {
      const tsMsgId = buildTsMsgId(message.providerTs, message.providerSid);
      const now = new Date().toISOString();
      const item: MessageItem = {
        conversationId: message.conversationId,
        tsMsgId,
        type: message.type,
        direction: message.direction,
        author: message.author,
        body: message.body,
        mediaUrls: message.mediaUrls,
        provider_sid: message.providerSid,
        provider_ts: message.providerTs,
        delivery_status: message.deliveryStatus,
        error_code: message.errorCode,
        created_at: now,
      };
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: table,
                  Item: item,
                  // §7.1 idempotency primitive: same provider message never
                  // persists twice (PK exists, so condition the SK).
                  ConditionExpression: 'attribute_not_exists(tsMsgId)',
                },
              },
              {
                Put: {
                  TableName: table,
                  Item: {
                    conversationId: sidPk(message.providerSid),
                    tsMsgId: 'ptr',
                    ref_conversationId: message.conversationId,
                    ref_tsMsgId: tsMsgId,
                  },
                  ConditionExpression: 'attribute_not_exists(tsMsgId)',
                },
              },
            ],
          }),
        );
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          const conditionFailed = err.CancellationReasons?.some(
            (r) => r.Code === 'ConditionalCheckFailed',
          );
          if (conditionFailed) {
            // The PERSISTED tsMsgId can differ from the one computed above:
            // inbound redeliveries carry no provider timestamp, so a
            // redelivered webhook computes a NEW first-seen providerTs.
            // Resolve the real key via the SID pointer (written in the same
            // transaction as the original message, so it must exist here).
            const ptr = await getSidPointer(message.providerSid);
            log.info(
              { conversationId: message.conversationId, providerSid: message.providerSid },
              'message append deduped (provider SID already persisted)',
            );
            return { deduped: true, tsMsgId: ptr?.ref_tsMsgId ?? tsMsgId };
          }
        }
        throw err;
      }
      log.info(
        {
          conversationId: message.conversationId,
          providerSid: message.providerSid,
          direction: message.direction,
          type: message.type,
          bodyLength: message.body?.length ?? 0,
          mediaCount: message.mediaUrls?.length ?? 0,
        },
        'message appended',
      );
      return { deduped: false, tsMsgId };
    },

    async updateDeliveryStatus(sid, status, errorCode) {
      const existing = await getByProviderSid(sid);
      if (!existing) {
        log.warn({ providerSid: sid, status }, 'delivery status for unknown provider SID ignored');
        return false;
      }
      const allowed = allowedPriorStatuses(status);
      if (allowed.length === 0) return false; // nothing may transition INTO queued
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression:
              errorCode !== undefined
                ? 'SET delivery_status = :s, error_code = :e'
                : 'SET delivery_status = :s',
            // Forward-only: the write commits only from an allowed prior
            // status, so out-of-order callbacks can never regress `delivered`.
            ConditionExpression: `delivery_status IN (${allowed.map((_, i) => `:p${i}`).join(', ')})`,
            ExpressionAttributeValues: {
              ':s': status,
              ...(errorCode !== undefined && { ':e': errorCode }),
              ...Object.fromEntries(allowed.map((p, i) => [`:p${i}`, p])),
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { providerSid: sid, status, currentStatus: existing.delivery_status },
            'delivery status transition skipped (would regress)',
          );
          return false;
        }
        throw err;
      }
      log.info({ providerSid: sid, status, errorCode }, 'delivery status updated');
      return true;
    },

    async annotateMessage(conversationId, tsMsgId, annotations) {
      const sets: string[] = [];
      const values: Record<string, unknown> = {};
      if (annotations.mediaS3Keys !== undefined) {
        sets.push('media_s3_keys = :mediaKeys');
        values[':mediaKeys'] = annotations.mediaS3Keys;
      }
      if (annotations.retryOf !== undefined) {
        sets.push('retry_of = :retryOf');
        values[':retryOf'] = annotations.retryOf;
      }
      if (annotations.retryAttempt !== undefined) {
        sets.push('retry_attempt = :retryAttempt');
        values[':retryAttempt'] = annotations.retryAttempt;
      }
      if (sets.length === 0) return;
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId, tsMsgId },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(tsMsgId)',
          ExpressionAttributeValues: values,
        }),
      );
      log.info(
        {
          conversationId,
          tsMsgId,
          mediaKeyCount: annotations.mediaS3Keys?.length,
          retryOf: annotations.retryOf,
          retryAttempt: annotations.retryAttempt,
        },
        'message annotated',
      );
    },

    async listByConversation(conversationId, opts = {}) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: opts.before
            ? 'conversationId = :c AND tsMsgId < :before'
            : 'conversationId = :c',
          ExpressionAttributeValues: {
            ':c': conversationId,
            ...(opts.before && { ':before': opts.before }),
          },
          ScanIndexForward: false, // newest-first
          Limit: opts.limit ?? DEFAULT_PAGE_LIMIT,
        }),
      );
      return (Items ?? []) as MessageItem[];
    },
  };
}
