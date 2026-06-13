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
// by lookup (doc §9). Pointer partitions (`sid#…`, and the `job#…` execution
// markers below) never collide with real conversation partitions, so
// listByConversation never sees them.
//
// PII: message bodies must NEVER be logged (doc §9) — IDs and lengths only.
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
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
/**
 * Who authored the message (doc §5; `ai` is Phase 2). `unknown` is the
 * operator-mandated honesty value (deviations table 2026-06-12): inbound from
 * an unreviewed contact must not be recorded as a guessed `tenant` — it
 * resolves when the contact is typed in the M1.4/M1.5 review flows.
 */
export type MessageAuthor = 'tenant' | 'landlord' | 'teammate' | 'ai' | 'unknown';

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

/**
 * Per-recipient delivery state for a relay-group fan-out (M1.7). The relayed
 * message is stored ONCE (the inbound source message); this map records the
 * outbound delivery to each OTHER member, keyed by member key
 * (relayMemberKey() below). Each entry runs the SAME forward-only status
 * machine as 1:1 delivery_status, independently per recipient.
 */
export interface RelayRecipientDelivery {
  status: DeliveryStatus;
  /** Provider SID of the per-recipient outbound send (Twilio SMxxx). */
  sid?: string;
  errorCode?: string;
  sentAt?: string;
  deliveredAt?: string;
}

/**
 * Stable member key for relay delivery maps + relaysid pointers: the
 * contactId when the member has one, else `phone#<E164>`. Used as the
 * delivery_recipients map key and stored on the relaysid pointer so a
 * delivery callback can find the right recipient slot to update.
 */
export function relayMemberKey(member: { contactId?: string; phone: string }): string {
  return member.contactId && member.contactId.length > 0
    ? member.contactId
    : `phone#${member.phone}`;
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
  /** Relay group (M1.7): sender member key on an inbound relay message. */
  relaySenderKey?: string;
  /** Relay group (M1.7): inbound landed on a closed relay thread (no fan-out). */
  receivedOnClosedThread?: boolean;
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
  /**
   * Relay group (M1.7): on an INBOUND relay message, the member key
   * (relayMemberKey) of the sender — which member texted the pool number.
   * Absent on 1:1 messages.
   */
  relay_sender_key?: string;
  /**
   * Relay group (M1.7): true when this inbound arrived on a CLOSED relay
   * thread — persisted for the audit trail but NOT fanned out. Absent
   * otherwise.
   */
  received_on_closed_thread?: boolean;
  /**
   * Relay group (M1.7): per-recipient delivery state for the fan-out of THIS
   * (inbound source) message to the other members, keyed by member key. The
   * relayed message is stored once; fan-out only updates this map. Absent on
   * 1:1 messages (the single `delivery_status` is unchanged for those).
   */
  delivery_recipients?: Record<string, RelayRecipientDelivery>;
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
  /**
   * Execution guard for duplicate-sensitive jobs (M1.2): conditionally
   * record that the job with this envelope jobId ran — `{ PK: job#<jobId>,
   * SK: ran }`, the same pointer-partition trick as the SID items. True =
   * first execution (proceed); false = this jobId already ran (an SQS
   * redelivery — suppress the side effect).
   */
  putJobExecutionMarker(jobId: string, conversationId: string): Promise<boolean>;

  // --- Relay groups (M1.7) -------------------------------------------------

  /**
   * Record the per-recipient send result on the SOURCE message's
   * delivery_recipients map (relay fan-out): sets `status` (+ optional sid /
   * sentAt / errorCode) for `memberKey`. A blind SET on the nested map slot —
   * the fan-out owns the initial queued→sent write per recipient; the
   * forward-only state machine is enforced by updateRecipientDeliveryStatus
   * (the callback path). No-op semantics are the caller's (idempotency check).
   */
  setRecipientDelivery(
    conversationId: string,
    tsMsgId: string,
    memberKey: string,
    delivery: RelayRecipientDelivery,
  ): Promise<void>;
  /**
   * Apply a delivery-callback transition to ONE recipient slot of a relay
   * source message: forward-only (same machine as updateDeliveryStatus),
   * keyed by memberKey, found via the relaysid pointer. Returns false (no-op)
   * when the slot is unknown or the transition would regress.
   */
  updateRecipientDeliveryStatus(
    conversationId: string,
    tsMsgId: string,
    memberKey: string,
    status: DeliveryStatus,
    errorCode?: string,
  ): Promise<boolean>;
  /**
   * Write the relaysid pointer for a per-recipient fan-out send: `{ PK:
   * relaysid#<providerSid>, SK: ptr }` → conversationId + tsMsgId + memberKey.
   * Delivery callbacks carry only the SID, so this is how a relay-recipient
   * callback recovers WHICH source message + recipient slot to update. Same
   * marker-partition convention as the sid# pointers (never collides with
   * real conversation partitions). Conditional create — a redelivered
   * fan-out never clobbers an existing pointer.
   */
  putRelaySidPointer(
    providerSid: string,
    ref: { conversationId: string; tsMsgId: string; memberKey: string },
  ): Promise<void>;
  /** Resolve a relay-recipient provider SID to its source message + member slot. */
  getRelaySidPointer(
    providerSid: string,
  ): Promise<{ conversationId: string; tsMsgId: string; memberKey: string } | undefined>;
}

const DEFAULT_PAGE_LIMIT = 50;

/** Pointer partition key for a provider SID. */
function sidPk(providerSid: string): string {
  return `sid#${providerSid}`;
}

/** Marker partition key for a job execution (see putJobExecutionMarker). */
function jobPk(jobId: string): string {
  return `job#${jobId}`;
}

/** Pointer partition key for a relay-recipient provider SID (M1.7). */
function relaySidPk(providerSid: string): string {
  return `relaysid#${providerSid}`;
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
        ...(message.relaySenderKey !== undefined && { relay_sender_key: message.relaySenderKey }),
        ...(message.receivedOnClosedThread === true && { received_on_closed_thread: true }),
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

    async putJobExecutionMarker(jobId, conversationId) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: {
              conversationId: jobPk(jobId),
              tsMsgId: 'ran',
              ref_conversationId: conversationId,
              executed_at: new Date().toISOString(),
            },
            ConditionExpression: 'attribute_not_exists(tsMsgId)',
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
      return true;
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

    // --- Relay groups (M1.7) -----------------------------------------------

    async setRecipientDelivery(conversationId, tsMsgId, memberKey, delivery) {
      // SET the whole recipient slot (delivery_recipients.<memberKey>). Lazily
      // initialise the parent map with if_not_exists so the first recipient
      // write creates it. memberKey is attacker-free (derived from our own
      // roster) but may contain `#` (phone keys) — bind it as a value, address
      // the map slot via an aliased name to avoid dotted-path parsing issues.
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId, tsMsgId },
          UpdateExpression:
            'SET delivery_recipients = if_not_exists(delivery_recipients, :empty), delivery_recipients.#mk = :d',
          ConditionExpression: 'attribute_exists(tsMsgId)',
          ExpressionAttributeNames: { '#mk': memberKey },
          ExpressionAttributeValues: { ':empty': {}, ':d': delivery },
        }),
      );
    },

    async updateRecipientDeliveryStatus(conversationId, tsMsgId, memberKey, status, errorCode) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId, tsMsgId } }),
      );
      const message = Item as MessageItem | undefined;
      const slot = message?.delivery_recipients?.[memberKey];
      if (!slot) {
        log.warn(
          { conversationId, tsMsgId, status },
          'relay recipient delivery status for unknown recipient slot ignored',
        );
        return false;
      }
      const allowed = allowedPriorStatuses(status);
      if (!allowed.includes(slot.status)) {
        log.info(
          { conversationId, tsMsgId, status, currentStatus: slot.status },
          'relay recipient delivery status transition skipped (would regress)',
        );
        return false;
      }
      const now = new Date().toISOString();
      const next: RelayRecipientDelivery = {
        ...slot,
        status,
        ...(errorCode !== undefined && { errorCode }),
        ...(status === 'delivered' && { deliveredAt: now }),
      };
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId, tsMsgId },
            UpdateExpression: 'SET delivery_recipients.#mk = :d',
            // Guard the read-modify-write: only commit if the slot is still on
            // the status we just read (forward-only under concurrent callbacks).
            ConditionExpression: 'delivery_recipients.#mk.#st = :prev',
            ExpressionAttributeNames: { '#mk': memberKey, '#st': 'status' },
            ExpressionAttributeValues: { ':d': next, ':prev': slot.status },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { conversationId, tsMsgId, status },
            'relay recipient delivery status transition lost a race (regressed)',
          );
          return false;
        }
        throw err;
      }
      log.info({ conversationId, tsMsgId, status, errorCode }, 'relay recipient delivery updated');
      return true;
    },

    async putRelaySidPointer(providerSid, ref) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: {
              conversationId: relaySidPk(providerSid),
              tsMsgId: 'ptr',
              ref_conversationId: ref.conversationId,
              ref_tsMsgId: ref.tsMsgId,
              ref_member_key: ref.memberKey,
            },
            ConditionExpression: 'attribute_not_exists(tsMsgId)',
          }),
        );
      } catch (err) {
        // A redelivered fan-out re-sends to the same recipient under a NEW
        // provider SID, so a collision here is unexpected — but never fatal:
        // the existing pointer already routes the callback correctly.
        if (err instanceof ConditionalCheckFailedException) return;
        throw err;
      }
    },

    async getRelaySidPointer(providerSid) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId: relaySidPk(providerSid), tsMsgId: 'ptr' } }),
      );
      const ptr = Item as
        | { ref_conversationId: string; ref_tsMsgId: string; ref_member_key: string }
        | undefined;
      if (!ptr) return undefined;
      return {
        conversationId: ptr.ref_conversationId,
        tsMsgId: ptr.ref_tsMsgId,
        memberKey: ptr.ref_member_key,
      };
    },
  };
}
