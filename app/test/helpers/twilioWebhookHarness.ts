// Test harness for the M1.1 Twilio webhook golden suite: an app built via
// buildApp() with injected in-memory fakes (no DynamoDB, no network), plus a
// signed-form-POST builder that computes REAL HMAC-SHA1 X-Twilio-Signature
// values with the twilio package — signature verification is exercised for
// real, never mocked out.
import { Readable } from 'node:stream';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
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
import { DEV_SESSION_SECRET_DEFAULT, loadConfig, type AppConfig } from '../../src/lib/config.js';
import { createEventBus, type AppEventName, type EventBus } from '../../src/lib/events.js';
import { createLogger } from '../../src/lib/logger.js';
import type { AuditRepo } from '../../src/repos/auditRepo.js';
import type { ContactFlag, ContactItem, ContactsRepo } from '../../src/repos/contactsRepo.js';
import {
  toPreview,
  type ConversationItem,
  type ConversationsRepo,
  type ConversationType,
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
  /** jobIds recorded by putJobExecutionMarker (the M1.2 execution guard). */
  jobExecutionMarkers: Map<string, string>;
  contacts: ContactItem[];
  flagWrites: { contactId: string; flag: ContactFlag; value: boolean }[];
  /** Conversation-level sms_opt_out writes (setSmsOptOut calls), in order. */
  optOutSets: { conversationId: string; value: boolean }[];
  auditEvents: { entityKey: string; eventType: string; payload?: Record<string, unknown> }[];
  touches: { conversationId: string; previewText: string | undefined; ts: string }[];
  /** contactIds actually CREATED by createIfAbsent (M1.2 auto-capture). */
  contactCreates: string[];
  /** conversationIds whose unread counter was bumped, in order (M1.2). */
  unreadIncrements: string[];
  sent: SendMessageParams[];
  mediaPuts: { key: string; contentType?: string; bytes: number }[];
  /** Media URLs that getMediaStream should fail for. */
  failMediaUrls: Set<string>;
  /** The bus injected into the app — emit/subscribe like production code. */
  events: EventBus;
  /** Every bus emission, in order (the harness subscribes to both events). */
  emitted: { event: AppEventName; payload: unknown }[];
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
  const jobExecutionMarkers = new Map<string, string>();
  const contacts: ContactItem[] = [];
  const flagWrites: FakeWorld['flagWrites'] = [];
  const optOutSets: FakeWorld['optOutSets'] = [];
  const auditEvents: FakeWorld['auditEvents'] = [];
  const touches: FakeWorld['touches'] = [];
  const contactCreates: string[] = [];
  const unreadIncrements: string[] = [];
  const sent: SendMessageParams[] = [];
  const mediaPuts: FakeWorld['mediaPuts'] = [];
  const failMediaUrls = new Set<string>();
  let convCounter = 0;
  let sidCounter = 0;

  const events = createEventBus();
  const emitted: FakeWorld['emitted'] = [];
  events.on('conversation.updated', (payload) => emitted.push({ event: 'conversation.updated', payload }));
  events.on('message.persisted', (payload) => emitted.push({ event: 'message.persisted', payload }));

  /** The real repos throw the SDK's conditional-check error — mirror it. */
  const conditionalCheckFailed = (message: string): ConditionalCheckFailedException =>
    new ConditionalCheckFailedException({ message, $metadata: {} });

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
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`touchLastActivity: no conversation ${conversationId}`);
      conv.status = 'open';
      conv.last_activity_at = ts;
      const preview = toPreview(previewText);
      if (preview !== undefined) conv.last_message_preview = preview;
      return conv;
    },
    async setParticipantsIfAbsent(conversationId, participants) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error(`setParticipantsIfAbsent: conversation not found: ${conversationId}`);
      if (conv.participants !== undefined) return false;
      conv.participants = participants;
      return true;
    },
    async incrementUnread(conversationId) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`incrementUnread: no conversation ${conversationId}`);
      conv.unread_count = (conv.unread_count ?? 0) + 1;
      unreadIncrements.push(conversationId);
      return conv.unread_count;
    },
    async resetUnread(conversationId) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`resetUnread: no conversation ${conversationId}`);
      conv.unread_count = 0;
      return conv;
    },
    async setAssignment(conversationId, assigneeUserId) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`setAssignment: no conversation ${conversationId}`);
      const previousAssigneeUserId = typeof conv.assignment === 'string' ? conv.assignment : null;
      if (assigneeUserId === null) delete conv.assignment;
      else conv.assignment = assigneeUserId;
      return { conversation: conv, previousAssigneeUserId };
    },
    async listByLastActivity({ status, limit }) {
      const items = [...conversations.values()]
        .filter((c) => c.status === status)
        .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1))
        .slice(0, limit ?? 50);
      return { items };
    },
    async setMode(conversationId, mode) {
      const conv = conversations.get(conversationId);
      if (conv) conv.ai_mode = mode;
    },
    async setSmsOptOut(conversationId, value) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error(`setSmsOptOut: no conversation ${conversationId}`);
      conv.sms_opt_out = value;
      optOutSets.push({ conversationId, value });
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
      // twice, even when providerTs differs across redeliveries — and the
      // dedupe result carries the PERSISTED (first write's) tsMsgId.
      const existing = findBySid(message.providerSid);
      if (existing) return { deduped: true, tsMsgId: existing.tsMsgId };
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
    async listByConversation(conversationId, opts = {}) {
      return messages
        .filter((m) => m.conversationId === conversationId)
        .filter((m) => (opts.before === undefined ? true : m.tsMsgId < opts.before))
        .sort((a, b) => (a.tsMsgId < b.tsMsgId ? 1 : -1))
        .slice(0, opts.limit ?? 50);
    },
    async annotateMessage(conversationId, tsMsgId, annotations) {
      const item = messages.find((m) => m.conversationId === conversationId && m.tsMsgId === tsMsgId);
      if (!item) throw new Error(`annotateMessage: no message ${conversationId}/${tsMsgId}`);
      if (annotations.mediaS3Keys !== undefined) item.media_s3_keys = annotations.mediaS3Keys;
      if (annotations.retryOf !== undefined) item.retry_of = annotations.retryOf;
      if (annotations.retryAttempt !== undefined) item.retry_attempt = annotations.retryAttempt;
    },
    async putJobExecutionMarker(jobId, conversationId) {
      // Mirrors the conditional put: true only on the FIRST write per jobId.
      if (jobExecutionMarkers.has(jobId)) return false;
      jobExecutionMarkers.set(jobId, conversationId);
      return true;
    },
  };

  const contactsRepo: ContactsRepo = {
    async findByPhone(phone) {
      return contacts.find((c) => c.phone === phone);
    },
    async getById(contactId) {
      return contacts.find((c) => c.contactId === contactId);
    },
    async createIfAbsent(item) {
      if (contacts.some((c) => c.contactId === item.contactId)) return false;
      contacts.push({ ...item });
      contactCreates.push(item.contactId);
      return true;
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
    jobExecutionMarkers,
    contacts,
    flagWrites,
    optOutSets,
    auditEvents,
    touches,
    contactCreates,
    unreadIncrements,
    sent,
    mediaPuts,
    failMediaUrls,
    events,
    emitted,
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
  /** Unknown-SID retry window for /status (tests shrink the default 2500ms). */
  statusUnknownSidRetryDelayMs?: number;
  /** SSE heartbeat override for /api/events tests (default 25s). */
  sseHeartbeatMs?: number;
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
    // M1.3 auth wiring — production fail-fast keys, so tests overriding
    // NODE_ENV to 'production' still boot. SESSION_SECRET deliberately
    // matches the dev placeholder: the sealed cookies minted by
    // helpers/authSession.ts stay valid against harness-built apps.
    SESSION_SECRET: DEV_SESSION_SECRET_DEFAULT,
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    OAUTH_ALLOWED_DOMAINS: 'housingchoice.org,abt-industries.com',
    ...opts.env,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

  const config = loadConfig(env as NodeJS.ProcessEnv);
  const world = opts.world ?? createFakeWorld();
  const capture = createLogCapture();
  const app = buildApp({
    config,
    logger: createLogger({ level: 'info', destination: capture.stream }),
    // The /api router shares the same fakes + bus, so hub-API and SSE tests
    // can drive the FULL loop (webhook in → bus → SSE out) on one app.
    api: {
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      auditRepo: world.auditRepo,
      events: world.events,
      ...(opts.sseHeartbeatMs !== undefined && { sseHeartbeatMs: opts.sseHeartbeatMs }),
    },
    webhooks: {
      adapter: world.adapter,
      ...(opts.withoutMediaStore ? {} : { mediaStore: world.mediaStore }),
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
      events: world.events,
      ...(opts.statusUnknownSidRetryDelayMs !== undefined && {
        statusUnknownSidRetryDelayMs: opts.statusUnknownSidRetryDelayMs,
      }),
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
