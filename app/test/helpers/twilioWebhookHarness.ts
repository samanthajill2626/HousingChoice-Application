// Test harness for the M1.1 Twilio webhook golden suite: an app built via
// buildApp() with injected in-memory fakes (no DynamoDB, no network), plus a
// signed-form-POST builder that computes REAL HMAC-SHA1 X-Twilio-Signature
// values with the twilio package — signature verification is exercised for
// real, never mocked out.
import { Readable } from 'node:stream';
import type { Express } from 'express';
import request, { type Test } from 'supertest';
import twilio from 'twilio';
import { buildApp } from '../../src/app.js';
import type { MediaStore } from '../../src/adapters/mediaStore.js';
import type {
  MessagingAdapter,
  SendMessageParams,
  SendMessageResult,
} from '../../src/adapters/messaging.js';
import { loadConfig, type AppConfig } from '../../src/lib/config.js';
import { createLogger } from '../../src/lib/logger.js';
import type { AuditRepo } from '../../src/repos/auditRepo.js';
import type { ContactFlag, ContactItem, ContactsRepo } from '../../src/repos/contactsRepo.js';
import type {
  ConversationItem,
  ConversationsRepo,
  ConversationType,
} from '../../src/repos/conversationsRepo.js';
import {
  allowedPriorStatuses,
  buildTsMsgId,
  type MessageItem,
  type MessagesRepo,
} from '../../src/repos/messagesRepo.js';
import { createLogCapture, type LogCapture } from './logCapture.js';

export const ORIGIN_SECRET = 'test-origin-secret';
export const AUTH_TOKEN = 'test-twilio-auth-token';
export const PUBLIC_BASE_URL = 'https://dxxxx.cloudfront.example';
export const OUR_NUMBER = '+15550009999';
export const TENANT_PHONE = '+15550100001';

// ---------------------------------------------------------------------------
// In-memory fakes — mirror the contractual semantics the routes rely on:
// SID-conditional append dedupe, forward-only status machine, byPhone lookup.
// ---------------------------------------------------------------------------

export interface FakeWorld {
  conversations: Map<string, ConversationItem>;
  messages: MessageItem[];
  contacts: ContactItem[];
  flagWrites: { contactId: string; flag: ContactFlag; value: boolean }[];
  auditEvents: { entityKey: string; eventType: string; payload?: Record<string, unknown> }[];
  touches: { conversationId: string; previewText: string | undefined; ts: string }[];
  sent: SendMessageParams[];
  mediaPuts: { key: string; contentType?: string; bytes: number }[];
  /** Media URLs that getMediaStream should fail for. */
  failMediaUrls: Set<string>;
  conversationsRepo: ConversationsRepo;
  messagesRepo: MessagesRepo;
  contactsRepo: ContactsRepo;
  auditRepo: AuditRepo;
  adapter: MessagingAdapter;
  mediaStore: MediaStore;
}

export function createFakeWorld(): FakeWorld {
  const conversations = new Map<string, ConversationItem>();
  const messages: MessageItem[] = [];
  const contacts: ContactItem[] = [];
  const flagWrites: FakeWorld['flagWrites'] = [];
  const auditEvents: FakeWorld['auditEvents'] = [];
  const touches: FakeWorld['touches'] = [];
  const sent: SendMessageParams[] = [];
  const mediaPuts: FakeWorld['mediaPuts'] = [];
  const failMediaUrls = new Set<string>();
  let convCounter = 0;
  let sidCounter = 0;

  const conversationsRepo: ConversationsRepo = {
    async createOrGetByParticipantPhone(phone: string, type: ConversationType) {
      for (const conv of conversations.values()) {
        if (conv.participant_phone === phone && conv.status === 'open') return conv;
      }
      const now = new Date().toISOString();
      const item: ConversationItem = {
        conversationId: `conv-${++convCounter}`,
        participant_phone: phone,
        status: 'open',
        last_activity_at: now,
        type,
        ai_mode: 'auto',
        created_at: now,
      };
      conversations.set(item.conversationId, item);
      return item;
    },
    async getById(conversationId) {
      return conversations.get(conversationId);
    },
    async touchLastActivity(conversationId, previewText, ts) {
      touches.push({ conversationId, previewText, ts });
    },
    async setMode(conversationId, mode) {
      const conv = conversations.get(conversationId);
      if (conv) conv.ai_mode = mode;
    },
    async incrementAutomatedSendCount() {
      return 1; // breaker untested here (covered by sendMessage.test.ts)
    },
  };

  const findBySid = (sid: string): MessageItem | undefined =>
    messages.find((m) => m.provider_sid === sid);

  const messagesRepo: MessagesRepo = {
    async append(message) {
      const tsMsgId = buildTsMsgId(message.providerTs, message.providerSid);
      // The SID-pointer conditional write: same provider SID never persists
      // twice, even when providerTs differs across redeliveries.
      if (findBySid(message.providerSid)) return { deduped: true, tsMsgId };
      messages.push({
        conversationId: message.conversationId,
        tsMsgId,
        type: message.type,
        direction: message.direction,
        author: message.author,
        ...(message.body !== undefined && { body: message.body }),
        ...(message.mediaUrls !== undefined && { mediaUrls: message.mediaUrls }),
        provider_sid: message.providerSid,
        provider_ts: message.providerTs,
        delivery_status: message.deliveryStatus,
        ...(message.errorCode !== undefined && { error_code: message.errorCode }),
        created_at: new Date().toISOString(),
      });
      return { deduped: false, tsMsgId };
    },
    async getByProviderSid(sid) {
      return findBySid(sid);
    },
    async updateDeliveryStatus(sid, status, errorCode) {
      const existing = findBySid(sid);
      if (!existing) return false;
      if (!allowedPriorStatuses(status).includes(existing.delivery_status)) return false;
      existing.delivery_status = status;
      if (errorCode !== undefined) existing.error_code = errorCode;
      return true;
    },
    async listByConversation(conversationId) {
      return messages
        .filter((m) => m.conversationId === conversationId)
        .sort((a, b) => (a.tsMsgId < b.tsMsgId ? 1 : -1));
    },
    async annotateMessage(conversationId, tsMsgId, annotations) {
      const item = messages.find((m) => m.conversationId === conversationId && m.tsMsgId === tsMsgId);
      if (!item) throw new Error(`annotateMessage: no message ${conversationId}/${tsMsgId}`);
      if (annotations.mediaS3Keys !== undefined) item.media_s3_keys = annotations.mediaS3Keys;
      if (annotations.retryOf !== undefined) item.retry_of = annotations.retryOf;
      if (annotations.retryAttempt !== undefined) item.retry_attempt = annotations.retryAttempt;
    },
  };

  const contactsRepo: ContactsRepo = {
    async findByPhone(phone) {
      return contacts.find((c) => c.phone === phone);
    },
    async setFlag(contactId, flag) {
      const contact = contacts.find((c) => c.contactId === contactId);
      if (!contact) throw new Error(`setFlag: no contact ${contactId}`);
      contact[flag] = true;
      flagWrites.push({ contactId, flag, value: true });
    },
    async clearFlag(contactId, flag) {
      const contact = contacts.find((c) => c.contactId === contactId);
      if (!contact) throw new Error(`clearFlag: no contact ${contactId}`);
      contact[flag] = false;
      flagWrites.push({ contactId, flag, value: false });
    },
  };

  const auditRepo: AuditRepo = {
    async append(entityKey, eventType, payload) {
      auditEvents.push({ entityKey, eventType, ...(payload !== undefined && { payload }) });
    },
  };

  const adapter: MessagingAdapter = {
    async sendMessage(params): Promise<SendMessageResult> {
      sent.push(params);
      return {
        providerSid: `SMfake-out-${++sidCounter}`,
        status: 'queued',
        providerTs: new Date().toISOString(),
      };
    },
    async getMediaStream(mediaUrl) {
      if (failMediaUrls.has(mediaUrl)) throw new Error(`fake media fetch failed: 404`);
      return Readable.from([Buffer.from(`media-bytes-for:${mediaUrl}`)]);
    },
  };

  const mediaStore: MediaStore = {
    async put(key, body, contentType) {
      let bytes = 0;
      for await (const chunk of body) bytes += (chunk as Buffer).length;
      mediaPuts.push({ key, ...(contentType !== undefined && { contentType }), bytes });
    },
  };

  return {
    conversations,
    messages,
    contacts,
    flagWrites,
    auditEvents,
    touches,
    sent,
    mediaPuts,
    failMediaUrls,
    conversationsRepo,
    messagesRepo,
    contactsRepo,
    auditRepo,
    adapter,
    mediaStore,
  };
}

// ---------------------------------------------------------------------------
// App builder + signed POST helper
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /** Env overrides merged into the default test env (set a key to '' to unset… use delete semantics below). */
  env?: Record<string, string | undefined>;
  world?: FakeWorld;
  /** Omit the media store (simulates MEDIA_BUCKET unset). */
  withoutMediaStore?: boolean;
}

export interface Harness {
  app: Express;
  world: FakeWorld;
  capture: LogCapture;
  config: AppConfig;
}

export function makeWebhookHarness(opts: HarnessOptions = {}): Harness {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    CF_ORIGIN_SECRET: ORIGIN_SECRET,
    MESSAGING_DRIVER: 'console',
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    PUBLIC_BASE_URL: PUBLIC_BASE_URL,
    OUR_PHONE_NUMBERS: OUR_NUMBER,
    ...opts.env,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

  const config = loadConfig(env as NodeJS.ProcessEnv);
  const world = opts.world ?? createFakeWorld();
  const capture = createLogCapture();
  const app = buildApp({
    config,
    logger: createLogger({ level: 'info', destination: capture.stream }),
    webhooks: {
      adapter: world.adapter,
      ...(opts.withoutMediaStore ? {} : { mediaStore: world.mediaStore }),
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
    },
  });
  return { app, world, capture, config };
}

export interface SignedPostOptions {
  /** Tamper with the computed signature (rejection tests). */
  tamper?: boolean;
  /** Omit the X-Twilio-Signature header entirely. */
  omitSignature?: boolean;
  /** Base URL used for SIGNING (mismatch tests); requests still hit the app. */
  signatureBaseUrl?: string;
}

/** POST a Twilio-style urlencoded webhook with a REAL computed signature. */
export function signedTwilioPost(
  app: Express,
  path: string,
  params: Record<string, string>,
  opts: SignedPostOptions = {},
): Test {
  const url = `${opts.signatureBaseUrl ?? PUBLIC_BASE_URL}${path}`;
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  let req = request(app).post(path).set('x-origin-verify', ORIGIN_SECRET).type('form');
  if (!opts.omitSignature) {
    req = req.set('x-twilio-signature', opts.tamper ? `${signature}TAMPERED` : signature);
  }
  return req.send(params);
}

/** Standard inbound SMS webhook params (Programmable Messaging shape). */
export function inboundSmsParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: 'SMinbound0001',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    MessagingServiceSid: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    From: TENANT_PHONE,
    To: OUR_NUMBER,
    Body: 'hello, looking for a 2 bed',
    NumMedia: '0',
    SmsStatus: 'received',
    ApiVersion: '2010-04-01',
    ...overrides,
  };
}

/** Standard delivery status callback params. */
export function statusParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: 'SMout0001',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    MessagingServiceSid: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    MessageStatus: 'delivered',
    To: TENANT_PHONE,
    From: OUR_NUMBER,
    ApiVersion: '2010-04-01',
    ...overrides,
  };
}
