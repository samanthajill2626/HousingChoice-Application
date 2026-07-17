import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName, type AppConfig } from '../lib/config.js';
import { createDocumentClient, createDynamoClient } from '../lib/dynamo.js';
import { ensureTable } from '../lib/dynamoAdmin.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type {
  InitiateCallParams,
  InitiateCallResult,
  MessagingAdapter,
  ProvisionPhoneNumberResult,
  SendMessageParams,
  SendMessageResult,
} from './messaging.js';

/** Base name; physical table is `${TABLE_PREFIX}dev-outbox` (e.g. hc-local-dev-outbox). */
export const OUTBOX_TABLE_BASE = 'dev-outbox';

export interface OutboxRecord {
  id: string;
  to: string;
  from?: string;
  body?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  providerSid: string;
  status: string;
  createdAt: string;
}

export interface RecordingMessagingDriverDeps {
  inner: MessagingAdapter;
  config: AppConfig;
  logger?: Logger;
  client?: DynamoDBClient;
  doc?: DynamoDBDocumentClient;
}

/**
 * @deprecated Outbound-only proof-of-send log. New tests should assert against the
 * fake-twilio thread store (`GET /control/threads`), which captures BOTH directions
 * plus delivery-status progression. Retained only so the three pre-existing green
 * specs (outbox / intake-to-reply / boards) don't churn. Do not add new reliance.
 *
 * Decorates a MessagingAdapter: delegates every method to `inner`, and after a
 * successful send also persists the outbound message to the dev-only outbox
 * table so e2e tests (and humans) can see what would have been sent. Dev-only;
 * the table is created lazily and never lives in prod/terraform.
 */
export class RecordingMessagingDriver implements MessagingAdapter {
  private readonly inner: MessagingAdapter;
  private readonly log: Logger;
  private readonly client: DynamoDBClient;
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;
  private ensured?: Promise<unknown>;

  constructor(deps: RecordingMessagingDriverDeps) {
    this.inner = deps.inner;
    this.log = deps.logger ?? defaultLogger;
    this.client = deps.client ?? createDynamoClient({ config: deps.config });
    this.doc = deps.doc ?? createDocumentClient({ config: deps.config });
    this.table = tableName(OUTBOX_TABLE_BASE);
  }

  private ensureTable(): Promise<unknown> {
    if (!this.ensured) {
      this.ensured = ensureTable(this.client, { baseName: OUTBOX_TABLE_BASE, hashKey: { name: 'id', type: 'S' }, gsis: [] }, this.table).catch((err) => {
        this.ensured = undefined; // allow retry on the next send
        throw err;
      });
    }
    return this.ensured;
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const result = await this.inner.sendMessage(params);
    try {
      await this.ensureTable();
      const record: OutboxRecord = {
        id: randomUUID(),
        to: params.to,
        ...(params.from !== undefined && { from: params.from }),
        ...(params.body !== undefined && { body: params.body }),
        ...(params.mediaUrls !== undefined && { mediaUrls: params.mediaUrls }),
        ...(params.idempotencyKey !== undefined && { idempotencyKey: params.idempotencyKey }),
        providerSid: result.providerSid,
        status: result.status,
        createdAt: result.providerTs,
      };
      await this.doc.send(new PutCommand({ TableName: this.table, Item: record }));
    } catch (err) {
      // Recording is best-effort: never let outbox failures break a real send.
      this.log.error({ err }, 'recording driver: failed to persist outbox record');
    }
    return result;
  }

  getMediaStream(url: string): Promise<Readable> {
    return this.inner.getMediaStream(url);
  }
  getRecordingStream(url: string): Promise<Readable> {
    return this.inner.getRecordingStream(url);
  }
  provisionPhoneNumber(opts: { voiceCapable: true; areaCode?: string }): Promise<ProvisionPhoneNumberResult> {
    return this.inner.provisionPhoneNumber(opts);
  }
  setVoiceWebhook(phoneNumber: string, voiceUrl: string): Promise<void> {
    return this.inner.setVoiceWebhook(phoneNumber, voiceUrl);
  }
  releasePhoneNumber(phoneNumber: string): Promise<void> {
    return this.inner.releasePhoneNumber(phoneNumber);
  }
  initiateCall(params: InitiateCallParams): Promise<InitiateCallResult> {
    return this.inner.initiateCall(params);
  }
}
