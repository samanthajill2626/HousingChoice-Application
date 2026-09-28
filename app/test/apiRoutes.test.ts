// M1.1 unit tests: POST /api/conversations/:id/messages — payload validation
// and typed-refusal → HTTP status mapping, with a fake send service injected
// through buildApp (no DynamoDB, no provider). The route sits BEHIND the
// origin-secret middleware AND (M1.3) the session requireAuth gate.
import { Readable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { OUTBOUND_MMS_MAX_MEDIA_PER_MESSAGE } from '../src/lib/outboundMediaLimits.js';
import {
  RETRY_PROMISE_GRACE_MS,
  RETRY_PROMISE_WITHDRAWN_AT,
  RETRY_SEND_WINDOW_MS,
} from '../src/lib/retrySendWindow.js';
import {
  CircuitBreakerOpenError,
  ContactDeletedError,
  ContactNoConsentError,
  ContactOptedOutError,
  ConversationNotFoundError,
  createSendMessageService,
  type SendMessageInput,
} from '../src/services/sendMessage.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import type { ContactsRepo } from '../src/repos/contactsRepo.js';
import type { MessageItem, MessagesRepo, RetryChildPointer } from '../src/repos/messagesRepo.js';
import type { SendAttemptFacts, SendAttemptOutcome, SendAttemptOwner } from '../src/repos/sendAttemptsRepo.js';
import { makeFakeUsersRepo, testUserItem, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const SECRET = 'test-origin-secret';

function makeApp(behavior?: (input: SendMessageInput) => never) {
  const calls: SendMessageInput[] = [];
  const app = buildApp({
    config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }),
    logger: createLogger({ destination: createLogCapture().stream }),
    // The session-epoch check reads the users table — seed the session user.
    auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
    api: {
      // FIX 2: the send route now reads the conversation to branch on type
      // (relay vs 1:1). Stub getById → undefined so these 1:1 cases fall
      // straight through to the faked sendMessage path (no DynamoDB touch).
      conversationsRepo: {
        async getById() {
          return undefined;
        },
      } as unknown as ConversationsRepo,
      sendMessageService: async (input) => {
        calls.push(input);
        behavior?.(input);
        return {
          conversationId: input.conversationId,
          providerSid: 'SMfake-1',
          tsMsgId: '2026-06-12T10:00:00.000Z#SMfake-1',
          status: 'queued',
        };
      },
    },
  });
  return { app, calls };
}

describe('POST /api/conversations/:conversationId/messages', () => {
  it('sends a manual (automated: false) message and returns 201 with the outcome', async () => {
    const { app, calls } = makeApp();
    const res = await request(app)
      .post('/api/conversations/conv-1/messages')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
      .send({ body: 'hello' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      conversationId: 'conv-1',
      providerSid: 'SMfake-1',
      tsMsgId: '2026-06-12T10:00:00.000Z#SMfake-1',
      status: 'queued',
    });
    expect(calls).toEqual([{ conversationId: 'conv-1', body: 'hello', automated: false }]);
  });

  it('400s when neither body nor mediaUrls is usable', async () => {
    const { app, calls } = makeApp();
    for (const payload of [{}, { body: '' }, { mediaUrls: [] }, { mediaUrls: [42] }]) {
      const res = await request(app)
        .post('/api/conversations/conv-1/messages')
        .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
        .send(payload);
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('maps typed refusals onto HTTP statuses (404 / 409 / 429)', async () => {
    const cases = [
      { err: new ConversationNotFoundError('conv-1'), status: 404, code: 'conversation_not_found' },
      { err: new ContactOptedOutError('conv-1'), status: 409, code: 'contact_opted_out' },
      { err: new ContactDeletedError('conv-1'), status: 409, code: 'contact_deleted' },
      // A2P/CTIA JIT gate: a proactive human send to a no-consent contact → 409.
      { err: new ContactNoConsentError('conv-1'), status: 409, code: 'contact_no_consent' },
      { err: new CircuitBreakerOpenError('conv-1'), status: 429, code: 'breaker_open' },
    ];
    for (const { err, status, code } of cases) {
      const { app } = makeApp(() => {
        throw err;
      });
      const res = await request(app)
        .post('/api/conversations/conv-1/messages')
        .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
        .send({ body: 'x' });
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: code });
    }
  });

  it('stays behind the origin-secret middleware', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/conversations/conv-1/messages').send({ body: 'x' });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

// SOR D3 (code review D-5): the staff send route answers 201 - not 500 - when a
// step AFTER the append fails. The REAL send wrapper runs here, not makeApp's
// stand-in: the text went out and its row is written, so the failed inbox
// touch is logged and the send returns its normal result.
describe('POST /api/conversations/:conversationId/messages - a post-append failure (SOR D3, code review D-5)', () => {
  it('answers 201 with the outcome when the inbox touch fails after a successful send', async () => {
    const world = createFakeWorld();
    const conversation = await world.conversationsRepo.createOrGetByParticipantPhone('+15550100001', 'tenant_1to1');
    world.contacts.push({ contactId: 'c-1', type: 'tenant', phone: '+15550100001', consent_method: 'inbound_text' });
    world.conversationsRepo.touchLastActivity = async () => {
      throw new Error('dynamo down');
    };
    const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET });
    const capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    const app = buildApp({
      config,
      logger,
      auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
      api: {
        conversationsRepo: world.conversationsRepo,
        sendMessageService: createSendMessageService({
          config,
          logger,
          adapter: world.adapter,
          conversationsRepo: world.conversationsRepo,
          messagesRepo: world.messagesRepo,
          contactsRepo: world.contactsRepo,
          auditRepo: world.auditRepo,
          events: world.events,
        }),
      },
    });

    const res = await request(app)
      .post(`/api/conversations/${conversation.conversationId}/messages`)
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
      .send({ body: 'hello' });

    expect(res.status).toBe(201);
    expect(world.sent).toHaveLength(1);
    const sid = world.sentDetails[0]!.sid;
    expect(res.body).toMatchObject({ conversationId: conversation.conversationId, providerSid: sid });
    expect(world.messages.filter((m) => m.provider_sid === sid)).toHaveLength(1);
    const errors = capture.atLevel(50).filter((l) => String(l['msg']).includes('post-append step failed'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ step: 'touchLastActivity', providerSid: sid });
  });
});

// POST /api/conversations/:id/messages with outbound MMS attachmentKeys: the
// route regex-validates keys, HeadObjects each (type + total-size), presigns
// per attempt, and threads the durable attachments + presigned mediaUrls into
// the send service.
describe('POST /api/conversations/:conversationId/messages (attachmentKeys)', () => {
  function makeMmsApp(heads: Record<string, { contentType?: string; size?: number } | undefined>) {
    const calls: SendMessageInput[] = [];
    const presignCalls: string[] = [];
    const mediaStore = {
      async head(key: string) {
        return heads[key];
      },
      async presign(key: string, ttl: number) {
        presignCalls.push(key);
        return `https://s3.local/${key}?X-Amz-Signature=sig-${key}&X-Amz-Expires=${ttl}`;
      },
      async getStream() {
        return undefined;
      },
      async put() {
        /* unused */
      },
    } as unknown as import('../src/adapters/mediaStore.js').MediaStore;
    const app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }),
      logger: createLogger({ destination: createLogCapture().stream }),
      auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
      api: {
        conversationsRepo: {
          async getById() {
            return undefined; // 1:1 path
          },
        } as unknown as ConversationsRepo,
        mediaStore,
        sendMessageService: async (input) => {
          calls.push(input);
          return {
            conversationId: input.conversationId,
            providerSid: 'SMfake-1',
            tsMsgId: '2026-06-12T10:00:00.000Z#SMfake-1',
            status: 'queued',
          };
        },
      },
    });
    return { app, calls, presignCalls };
  }

  const send = (app: ReturnType<typeof makeMmsApp>['app'], payload: Record<string, unknown>) =>
    request(app)
      .post('/api/conversations/conv-1/messages')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(payload);

  it('presigns validated keys and passes durable attachments + presigned mediaUrls to the send', async () => {
    const { app, calls, presignCalls } = makeMmsApp({
      'uploads/abc-123': { contentType: 'image/png', size: 1000 },
    });
    const res = await send(app, { body: 'flyer', attachmentKeys: ['uploads/abc-123'] });
    expect(res.status).toBe(201);
    expect(presignCalls).toEqual(['uploads/abc-123']);
    expect(calls).toHaveLength(1);
    // Durable attachments (s3Key + normalized type) reach the service.
    expect(calls[0]?.attachments).toEqual([{ s3Key: 'uploads/abc-123', contentType: 'image/png' }]);
    // The adapter mediaUrls are the PRESIGNED (bearer-token) URLs.
    expect(calls[0]?.mediaUrls?.[0]).toContain('X-Amz-Signature=');
    expect(calls[0]?.mediaUrls?.[0]).toContain('uploads/abc-123');
  });

  it('rejects a key that is not uploads/<uuid> (400 invalid_attachment_key)', async () => {
    const { app, calls } = makeMmsApp({});
    const res = await send(app, { attachmentKeys: ['media/other/evil'] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_attachment_key' });
    expect(calls).toHaveLength(0);
  });

  it('rejects more than OUTBOUND_MMS_MAX_MEDIA keys (400 too_many_attachments)', async () => {
    const { app, calls } = makeMmsApp({});
    const keys = Array.from({ length: 11 }, (_, i) => `uploads/${'0'.repeat(8)}-${i}`);
    const res = await send(app, { attachmentKeys: keys });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'too_many_attachments' });
    expect(calls).toHaveLength(0);
  });

  it('400s unknown_attachment when a key does not exist (HeadObject 404)', async () => {
    const { app, calls } = makeMmsApp({ 'uploads/deadbeef': { contentType: 'image/png', size: 10 } });
    const res = await send(app, { attachmentKeys: ['uploads/deadf00d'] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unknown_attachment' });
    expect(calls).toHaveLength(0);
  });

  // 2026-08-20: a summed overage is no longer a refusal - it SPLITS. What still
  // refuses is ONE file too big for any single message, which batching cannot
  // rescue (in practice a GIF; jpeg/png are transcoded to the target first).
  it('400s attachments_too_large when a SINGLE attachment exceeds the per-message cap', async () => {
    const { app, calls } = makeMmsApp({
      'uploads/a': { contentType: 'image/gif', size: 4 * 1024 * 1024 },
    });
    const res = await send(app, { attachmentKeys: ['uploads/a'] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'attachments_too_large' });
    expect(calls).toHaveLength(0);
  });

  it('SPLITS an over-budget send across messages instead of refusing it', async () => {
    // The prod shape that got silently dropped: 7 attachments, 2.93MB total.
    const sizes = [58_101, 929_757, 76_934, 918_527, 923_368, 73_092, 89_528];
    // UPLOAD_KEY_PATTERN only admits hex + dashes.
    const key = (i: number): string => `uploads/deadbee${i}`;
    const objects = Object.fromEntries(
      sizes.map((size, i) => [key(i), { contentType: 'image/jpeg', size }]),
    );
    const { app, calls } = makeMmsApp(objects);
    const res = await send(app, {
      body: 'here are the photos',
      attachmentKeys: sizes.map((_, i) => key(i)),
    });

    expect(res.status).toBe(201);
    expect(calls.length).toBeGreaterThan(1);
    // Every message is inside the carrier budget on its own...
    for (const call of calls) {
      expect(call.attachments?.length ?? 0).toBeLessThanOrEqual(
        OUTBOUND_MMS_MAX_MEDIA_PER_MESSAGE,
      );
    }
    // ...every attachment went out exactly once, in order...
    expect(calls.flatMap((c) => (c.attachments ?? []).map((a) => a.s3Key))).toEqual(
      sizes.map((_, i) => key(i)),
    );
    // ...and the typed body rode only the FIRST one.
    expect(calls[0]?.body).toBe('here are the photos');
    expect(calls.slice(1).every((c) => c.body === undefined)).toBe(true);
  });

  it('400s unsupported_attachment_type when the stored type is not allowlisted', async () => {
    const { app, calls } = makeMmsApp({
      'uploads/cafe': { contentType: 'application/zip', size: 10 },
    });
    const res = await send(app, { attachmentKeys: ['uploads/cafe'] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unsupported_attachment_type' });
    expect(calls).toHaveLength(0);
  });
});

// A RELAY-group send splits the same way the 1:1 path does. It matters more
// here: the fan-out re-presigns and sends the WHOLE attachment set to each
// member separately, so an over-budget payload is not dropped once - it is
// dropped once per member, each with no receipt and no error code.
describe('POST /api/conversations/:conversationId/messages (relay group, attachment batching)', () => {
  function makeRelayMmsApp(heads: Record<string, { contentType?: string; size?: number }>) {
    /** Every hub message the route persisted - one per batch. */
    const appended: { attachmentCount: number; body?: string }[] = [];
    const mediaStore = {
      async head(key: string) {
        return heads[key];
      },
      async presign(key: string) {
        return `https://s3.local/${key}?X-Amz-Signature=sig`;
      },
      async getStream() {
        return undefined;
      },
      async put() {
        /* unused */
      },
    } as unknown as import('../src/adapters/mediaStore.js').MediaStore;
    const app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }),
      logger: createLogger({ destination: createLogCapture().stream }),
      auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
      api: {
        conversationsRepo: {
          async getById() {
            return {
              conversationId: 'conv-relay',
              type: 'relay_group',
              status: 'open',
              pool_number: '+15550199999',
              participants: [
                { contactId: 'c-alice', phone: '+15550100001', name: 'Alice' },
                { contactId: 'c-bob', phone: '+15550100002', name: 'Bob' },
              ],
            };
          },
          async touchLastActivity() {
            return undefined;
          },
        } as unknown as ConversationsRepo,
        messagesRepo: {
          async append(input: { mediaAttachments?: unknown[]; body?: string }) {
            appended.push({
              attachmentCount: input.mediaAttachments?.length ?? 0,
              ...(input.body !== undefined && { body: input.body }),
            });
            return { tsMsgId: `2026-08-20T10:00:0${appended.length}.000Z#team-${appended.length}` };
          },
        } as unknown as import('../src/repos/messagesRepo.js').MessagesRepo,
        auditRepo: {
          async append() {
            /* noop */
          },
        } as unknown as import('../src/repos/auditRepo.js').AuditRepo,
        mediaStore,
      },
    });
    return { app, appended };
  }

  const relaySend = (
    app: ReturnType<typeof makeRelayMmsApp>['app'],
    payload: Record<string, unknown>,
  ) =>
    request(app)
      .post('/api/conversations/conv-relay/messages')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(payload);

  it('SPLITS an over-budget relay send into several hub messages instead of refusing', async () => {
    // The prod shape: 7 attachments, 2.93MB total.
    const sizes = [58_101, 929_757, 76_934, 918_527, 923_368, 73_092, 89_528];
    const key = (i: number): string => `uploads/deadbee${i}`;
    const heads = Object.fromEntries(
      sizes.map((size, i) => [key(i), { contentType: 'image/jpeg', size }]),
    );
    const { app, appended } = makeRelayMmsApp(heads);

    const res = await relaySend(app, {
      body: 'photos from the walkthrough',
      attachmentKeys: sizes.map((_, i) => key(i)),
    });

    expect(res.status).toBe(201);
    // One hub message per batch - each fans out on its own.
    expect(appended.length).toBeGreaterThan(1);
    expect(appended.reduce((n, a) => n + a.attachmentCount, 0)).toBe(sizes.length);
    // The typed body rides the FIRST hub message only.
    expect(appended[0]?.body).toBe('photos from the walkthrough');
    expect(appended.slice(1).every((a) => a.body === undefined)).toBe(true);
  });

  it('leaves a send that already fits as ONE hub message', async () => {
    const heads = { 'uploads/deadbeef': { contentType: 'image/jpeg', size: 120_000 } };
    const { app, appended } = makeRelayMmsApp(heads);
    const res = await relaySend(app, { body: 'one photo', attachmentKeys: ['uploads/deadbeef'] });
    expect(res.status).toBe(201);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.attachmentCount).toBe(1);
  });
});

// POST /api/conversations/:id/messages/:providerSid/retry — re-send a FAILED
// outbound message, stamping retry_of so the timeline collapses the stale bubble.
describe('POST /api/conversations/:conversationId/messages/:providerSid/retry', () => {
  const FAILED_ORIGINAL = {
    conversationId: 'conv-1',
    tsMsgId: '2026-06-12T09:00:00.000Z#SMorig',
    provider_sid: 'SMorig',
    direction: 'outbound' as const,
    author: 'teammate' as const,
    type: 'sms' as const,
    body: 'this failed',
    delivery_status: 'failed' as const,
  };

  /** What a press may read beyond the pressed row. Every field is optional. */
  interface RetryAppOptions {
    mediaStore?: import('../src/adapters/mediaStore.js').MediaStore;
    /** retry-send-window D14: the recorded-recipient read (by id). */
    contactsRepo?: Pick<ContactsRepo, 'getById'>;
    /** retry-send-adoption R6: the pressed row's retrychild# pointers. */
    children?: RetryChildPointer[];
    /** R7: the one row the consistent point-get serves (the pre-deploy retry_of walk). */
    parent?: MessageItem;
    /** Overrides on the one-to-one thread the route reads for R1's phone key; null = no thread. */
    conversation?: Partial<ConversationItem> | null;
    /** R6: the world whose send-attempt fake holds the seeded records. */
    world?: FakeWorld;
  }

  function makeRetryApp(original: unknown, opts: RetryAppOptions = {}) {
    const calls: SendMessageInput[] = [];
    const world = opts.world ?? createFakeWorld();
    // A HAND stub: any method the route calls that it lacks (a thread scan such
    // as listByConversation included) is a TypeError and a 500 - never DynamoDB.
    const messagesRepo = {
      async getByProviderSid() {
        return original;
      },
      listRetryChildrenConsistent: vi.fn(
        async (_conversationId: string, _parentTsMsgId: string): Promise<RetryChildPointer[]> =>
          opts.children ?? [],
      ),
      getByTsMsgIdConsistent: vi.fn(
        async (_conversationId: string, tsMsgId: string): Promise<MessageItem | undefined> =>
          opts.parent?.tsMsgId === tsMsgId ? opts.parent : undefined,
      ),
    };
    const conversationsRepo = {
      getById: vi.fn(async (_conversationId: string) =>
        opts.conversation === null
          ? undefined
          : {
              conversationId: 'conv-1',
              type: 'tenant_1to1',
              participant_phone: '+15550100001',
              ...opts.conversation,
            },
      ),
    };
    const app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }),
      logger: createLogger({ destination: createLogCapture().stream }),
      auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
      api: {
        messagesRepo: messagesRepo as unknown as MessagesRepo,
        conversationsRepo: conversationsRepo as unknown as ConversationsRepo,
        sendAttemptsRepo: world.sendAttemptsRepo,
        ...(opts.mediaStore !== undefined && { mediaStore: opts.mediaStore }),
        ...(opts.contactsRepo !== undefined && {
          contactsRepo: opts.contactsRepo as unknown as ContactsRepo,
        }),
        sendMessageService: async (input) => {
          calls.push(input);
          return {
            conversationId: input.conversationId,
            providerSid: 'SMretry',
            tsMsgId: '2026-06-12T10:00:00.000Z#SMretry',
            status: 'queued',
          };
        },
      },
    });
    return { app, calls, messagesRepo, conversationsRepo, world };
  }

  const press = (app: ReturnType<typeof buildApp>, providerSid = 'SMorig') =>
    request(app)
      .post(`/api/conversations/conv-1/messages/${providerSid}/retry`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();

  // --- retry-send-adoption: the attempt records a press reads (R6) -----------

  /** R1's key for FAILED_ORIGINAL's attempts: no recorded recipient, so the thread's number. */
  const PHONE_KEY = 'phone#+15550100001';
  const FACTS: SendAttemptFacts = {
    recipientDigest: 'digest-test',
    bodyHash: 'hash-test',
    bodyShort: false,
    mediaCount: 0,
  };
  type RetryOwner = Extract<SendAttemptOwner, { kind: 'retry_send' }>;
  /** The owner the retry job keys FAILED_ORIGINAL's attempt-1 record on (retrySend.ts). */
  function retryOwner(overrides: Partial<RetryOwner> = {}): RetryOwner {
    return {
      kind: 'retry_send',
      conversationId: 'conv-1',
      retriedTsMsgId: FAILED_ORIGINAL.tsMsgId,
      attempt: 1,
      recipientKey: PHONE_KEY,
      retryRoot: FAILED_ORIGINAL.tsMsgId,
      ...overrides,
    };
  }
  type SeededState = 'attempting' | 'reconciling' | 'redriven' | Exclude<SendAttemptOutcome, 'never_sent'>;
  /**
   * One attempt record on `world`, walked there through the fake's OWN
   * transitions - so every seeded shape is one the repo can reach - claimed
   * `ageMs` before now. Each `done` outcome closes from the state its real
   * writer closes it from: the job's finishAttempt (sent, refused, rejected,
   * retryable), the reconcile's close (unresolved, adopted, redrive_refused)
   * and a failed re-drive enqueue (enqueue_failed, from redriven).
   */
  async function seedRecord(world: FakeWorld, owner: RetryOwner, state: SeededState, ageMs: number): Promise<void> {
    const repo = world.sendAttemptsRepo;
    const at = new Date(Date.now() - ageMs).toISOString();
    const claimed = await repo.claim(owner, FACTS, at);
    expect(claimed.outcome).toBe('claimed');
    const ref = { attemptNo: claimed.record.attemptNo, attemptedAt: at };
    switch (state) {
      case 'attempting':
        return;
      case 'sent':
      case 'refused':
      case 'rejected':
      case 'retryable':
        expect(
          await repo.finishAttempt(owner, ref, { outcome: state, ...(state === 'sent' && { sid: 'SMsent' }) }),
        ).toBe(true);
        return;
      default:
        break;
    }
    expect(await repo.handToReconcile(owner, ref)).toBe(true);
    switch (state) {
      case 'reconciling':
        return;
      case 'redriven':
      case 'enqueue_failed':
        expect(await repo.markRedriven(owner, at)).toBe(true);
        if (state === 'enqueue_failed') {
          expect(await repo.closeRedriven(owner, { outcome: 'enqueue_failed', cause: 'enqueue_failed' })).toBe(true);
        }
        return;
      case 'unresolved':
      case 'adopted':
      case 'redrive_refused':
        expect(
          await repo.closeFromReconcile(owner, at, {
            outcome: state,
            ...(state === 'adopted' && { sid: 'SMadopted' }),
            ...(state === 'unresolved' && { cause: 'provider_unreachable' }),
            ...(state === 'redrive_refused' && { cause: 'retry_window_closed' }),
          }),
        ).toBe(true);
        return;
    }
  }

  it('re-sends the original body + carries retry_of, returning 201', async () => {
    const { app, calls } = makeRetryApp(FAILED_ORIGINAL);
    const res = await request(app)
      .post('/api/conversations/conv-1/messages/SMorig/retry')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();

    expect(res.status).toBe(201);
    expect(res.body.providerSid).toBe('SMretry');
    expect(calls).toEqual([
      {
        conversationId: 'conv-1',
        body: 'this failed',
        automated: false,
        author: 'teammate',
        retryOf: '2026-06-12T09:00:00.000Z#SMorig',
        // retry-send-adoption R7: a root row is its own chain's root.
        retryRoot: '2026-06-12T09:00:00.000Z#SMorig',
      },
    ]);
  });

  it('404s when the message is unknown or belongs to another conversation', async () => {
    for (const original of [undefined, { ...FAILED_ORIGINAL, conversationId: 'other' }]) {
      const { app, calls } = makeRetryApp(original);
      const res = await request(app)
        .post('/api/conversations/conv-1/messages/SMorig/retry')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send();
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    }
  });

  it('400s when the original is not outbound', async () => {
    const { app, calls } = makeRetryApp({ ...FAILED_ORIGINAL, direction: 'inbound' });
    const res = await request(app)
      .post('/api/conversations/conv-1/messages/SMorig/retry')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('409s when the original is not in a failure state (no accidental double-send)', async () => {
    for (const status of ['queued', 'sent', 'delivered'] as const) {
      const { app, calls } = makeRetryApp({ ...FAILED_ORIGINAL, delivery_status: status });
      const res = await request(app)
        .post('/api/conversations/conv-1/messages/SMorig/retry')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send();
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'not_failed' });
      expect(calls).toHaveLength(0);
    }
  });

  it('retry-send-window D10: 409 retry_pending while an automatic retry is scheduled - before retry_due_at and inside the grace after it', async () => {
    for (const offsetMs of [30_000, -60_000]) {
      const { app, calls } = makeRetryApp({
        ...FAILED_ORIGINAL,
        retry_due_at: new Date(Date.now() + offsetMs).toISOString(),
      });
      const res = await request(app)
        .post('/api/conversations/conv-1/messages/SMorig/retry')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send();
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'retry_pending' });
      expect(calls).toHaveLength(0);
    }
  });

  it('retry-send-window D10: the Retry goes through once the promise has expired, or after it was withdrawn', async () => {
    for (const due of [
      new Date(Date.now() - RETRY_PROMISE_GRACE_MS - 60_000).toISOString(),
      RETRY_PROMISE_WITHDRAWN_AT,
    ]) {
      const { app, calls } = makeRetryApp({ ...FAILED_ORIGINAL, retry_due_at: due });
      const res = await request(app)
        .post('/api/conversations/conv-1/messages/SMorig/retry')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send();
      expect(res.status).toBe(201);
      expect(calls).toHaveLength(1);
    }
  });

  it('retry-send-window D10: the not-failed check still answers first', async () => {
    const { app, calls } = makeRetryApp({
      ...FAILED_ORIGINAL,
      delivery_status: 'delivered',
      retry_due_at: new Date(Date.now() + 30_000).toISOString(),
    });
    const res = await request(app)
      .post('/api/conversations/conv-1/messages/SMorig/retry')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'not_failed' });
    expect(calls).toHaveLength(0);
  });

  it('retry-send-window D14: passes the RECORDED recipient (read by id), stays automated:false, and never copies retry_window_start or retry_attempt', async () => {
    const real = {
      contactId: 'c-real',
      type: 'tenant' as const,
      phone: '+15550100001',
      consent_method: 'verbal_in_person' as const,
    };
    const reads: string[] = [];
    const { app, calls } = makeRetryApp(
      {
        ...FAILED_ORIGINAL,
        recipient_contact_id: 'c-real',
        retry_window_start: '2026-06-12T08:58:00.000Z',
        retry_attempt: 2,
      },
      {
        contactsRepo: {
          async getById(contactId: string) {
            reads.push(contactId);
            return contactId === 'c-real' ? real : undefined;
          },
        },
      },
    );
    const res = await request(app)
      .post('/api/conversations/conv-1/messages/SMorig/retry')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();

    expect(res.status).toBe(201);
    expect(reads).toEqual(['c-real']);
    expect(calls).toEqual([
      {
        conversationId: 'conv-1',
        body: 'this failed',
        automated: false,
        author: 'teammate',
        retryOf: '2026-06-12T09:00:00.000Z#SMorig',
        retryRoot: '2026-06-12T09:00:00.000Z#SMorig',
        recipient: real,
      },
    ]);
  });

  it('retry-send-window D14: a recorded recipient that no longer exists sends with NO recipient (the phone-matched contact is judged)', async () => {
    const { app, calls } = makeRetryApp(
      { ...FAILED_ORIGINAL, recipient_contact_id: 'c-gone' },
      {
        contactsRepo: {
          async getById() {
            return undefined;
          },
        },
      },
    );
    const res = await request(app)
      .post('/api/conversations/conv-1/messages/SMorig/retry')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('recipient');
  });

  it('409 not_retryable when the original is an email (never re-send an email down the SMS path)', async () => {
    // A failed outbound email otherwise passes every check below (outbound + failed),
    // so it would text the email body to participant_phone. The type guard refuses it.
    const { app, calls } = makeRetryApp({
      ...FAILED_ORIGINAL,
      type: 'email',
      provider_sid: 'hc-abc@mail.test',
      tsMsgId: '2026-06-12T09:00:00.000Z#hc-abc@mail.test',
    });
    const res = await request(app)
      .post('/api/conversations/conv-1/messages/hc-abc@mail.test/retry')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'not_retryable' });
    expect(calls).toHaveLength(0);
  });

  // THE Cameron rule (design Sec 5 / spec S5+S12): a retry of a message with
  // media_attachments RE-PRESIGNS each s3Key FRESH - it must never replay the
  // stored (expired) mediaUrls. Pinned: the retried URLs DIFFER from the
  // originals AND derive from the durable s3Keys.
  it('re-presigns media_attachments fresh on retry (URLs differ from the stored originals)', async () => {
    let presignCount = 0;
    const mediaStore = {
      async presign(key: string, ttl: number) {
        // Unique per call AND derived from the key: proves the retry re-presigns.
        presignCount += 1;
        return `https://s3.local/${key}?X-Amz-Signature=fresh${presignCount}&X-Amz-Expires=${ttl}`;
      },
      async head() {
        return undefined;
      },
      async getStream() {
        return undefined;
      },
      async put() {
        /* unused */
      },
    } as unknown as import('../src/adapters/mediaStore.js').MediaStore;

    const STALE_URL = 'https://s3.local/uploads/aaaa?X-Amz-Signature=STALEEXPIRED&X-Amz-Expires=3600';
    const original = {
      ...FAILED_ORIGINAL,
      type: 'mms' as const,
      // The durable truth (what a resend must re-derive from).
      media_attachments: [{ s3Key: 'uploads/aaaa', contentType: 'image/png' }],
      // The stale presigned URL from the FIRST send - must NOT be replayed.
      mediaUrls: [STALE_URL],
    };
    const { app, calls } = makeRetryApp(original, { mediaStore });

    const res = await request(app)
      .post('/api/conversations/conv-1/messages/SMorig/retry')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    const sentUrls = calls[0]?.mediaUrls ?? [];
    // Differs from the stored original (not a verbatim replay).
    expect(sentUrls).not.toContain(STALE_URL);
    expect(sentUrls[0]).not.toBe(STALE_URL);
    // Freshly presigned (bearer-token query present) AND derived from the s3Key.
    expect(sentUrls[0]).toContain('X-Amz-Signature=fresh');
    expect(sentUrls[0]).toContain('uploads/aaaa');
    // The durable attachments ride along so the retried message persists them.
    expect(calls[0]?.attachments).toEqual([{ s3Key: 'uploads/aaaa', contentType: 'image/png' }]);
  });

  // F2: attachments exist but no MediaStore is available (degenerate no-
  // MEDIA_BUCKET config). We must NEVER replay the stored (expired) presigned
  // URLs - retry the body only rather than ship an expired token.
  it('with media_attachments but NO mediaStore, drops media (never replays the stale presigned URLs)', async () => {
    const STALE_URL = 'https://s3.local/uploads/bbbb?X-Amz-Signature=STALEEXPIRED&X-Amz-Expires=3600';
    const original = {
      ...FAILED_ORIGINAL,
      type: 'mms' as const,
      media_attachments: [{ s3Key: 'uploads/bbbb', contentType: 'image/png' }],
      mediaUrls: [STALE_URL],
    };
    // No mediaStore passed - route's mediaStore is undefined (no MEDIA_BUCKET).
    const { app, calls } = makeRetryApp(original);
    const res = await request(app)
      .post('/api/conversations/conv-1/messages/SMorig/retry')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    // The stale token is NOT shipped, and no media rides along.
    expect(calls[0]?.mediaUrls).toBeUndefined();
    expect(calls[0]?.attachments).toBeUndefined();
    // The body still retries.
    expect(calls[0]?.body).toBe('this failed');
  });

  it('falls back to replaying raw mediaUrls when the original has NO media_attachments (e2e seam)', async () => {
    const original = {
      ...FAILED_ORIGINAL,
      type: 'mms' as const,
      mediaUrls: ['https://fake/canned/room.png'],
    };
    const { app, calls } = makeRetryApp(original);
    const res = await request(app)
      .post('/api/conversations/conv-1/messages/SMorig/retry')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();
    expect(res.status).toBe(201);
    expect(calls[0]?.mediaUrls).toEqual(['https://fake/canned/room.png']);
    expect(calls[0]?.attachments).toBeUndefined();
  });

  // --- retry-send-adoption R6: the route reads the pointer family and the
  // attempt RECORD after RSW's time guard; R7: its append carries the chain
  // root and the share stamp. ------------------------------------------------

  it('retry-send-adoption R6: 409 superseded when the pressed row has ANY child - an automatic retry row, or a manual one', async () => {
    const automaticChild: RetryChildPointer = { tsMsgId: '2026-06-12T09:01:00.000Z#SMx', providerSid: 'SMx', retryAttempt: 1 };
    const manualChild: RetryChildPointer = { tsMsgId: '2026-06-12T09:02:00.000Z#SMy', providerSid: 'SMy' };
    for (const children of [[automaticChild], [manualChild], [automaticChild, manualChild]]) {
      const { app, calls } = makeRetryApp(FAILED_ORIGINAL, { children });
      const res = await press(app);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'superseded' });
      expect(calls).toHaveLength(0);
    }
  });

  it("retry-send-adoption R6: the superseded check is ONE consistent Query on the pressed row's pointer family, never a thread scan", async () => {
    const { app, calls, messagesRepo } = makeRetryApp(FAILED_ORIGINAL, {
      children: [{ tsMsgId: '2026-06-12T09:01:00.000Z#SMx', providerSid: 'SMx', retryAttempt: 1 }],
    });
    const res = await press(app);
    expect(res.status).toBe(409);
    expect(messagesRepo.listRetryChildrenConsistent).toHaveBeenCalledTimes(1);
    expect(messagesRepo.listRetryChildrenConsistent).toHaveBeenCalledWith('conv-1', FAILED_ORIGINAL.tsMsgId);
    // The stub has no thread read at all: a scan would be a TypeError and a 500.
    expect(messagesRepo).not.toHaveProperty('listByConversation');
    expect(messagesRepo).not.toHaveProperty('listByConversationConsistent');
    expect(calls).toHaveLength(0);
  });

  it('retry-send-adoption R6: 409 retry_unresolved on a done/unresolved record read by KEY - with or without retry_outcome on the row - and the route adds no time bound of its own (a 45-day-old record still refuses)', async () => {
    // In production the record's 30-day expires_at reaps it; the row's
    // retry_outcome belt is then the only guard (a residue Task 9 records).
    const FORTY_FIVE_DAYS_MS = 45 * 24 * 60 * 60 * 1000;
    for (const original of [
      FAILED_ORIGINAL,
      { ...FAILED_ORIGINAL, retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' as const },
    ]) {
      for (const ageMs of [60_000, FORTY_FIVE_DAYS_MS]) {
        const world = createFakeWorld();
        await seedRecord(world, retryOwner(), 'unresolved', ageMs);
        const { app, calls } = makeRetryApp(original, { world });
        const res = await press(app);
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'retry_unresolved' });
        expect(calls).toHaveLength(0);
      }
    }
  });

  it('retry-send-adoption R6: 409 retry_unresolved on the row belt alone (retry_outcome unconfirmed, no record)', async () => {
    const world = createFakeWorld();
    const get = vi.spyOn(world.sendAttemptsRepo, 'get');
    const { app, calls } = makeRetryApp(
      { ...FAILED_ORIGINAL, retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' },
      { world },
    );
    const res = await press(app);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'retry_unresolved' });
    expect(calls).toHaveLength(0);
    // The record WAS looked for, and there is none: the belt answered.
    expect(get).toHaveBeenCalledTimes(1);
    await expect(get.mock.results[0]!.value).resolves.toBeUndefined();
  });

  it('retry-send-adoption R6: 409 retry_pending on an OPEN record younger than RETRY_SEND_WINDOW_MS - a 31 s attempting (plan deviation 8), a reconciling, an in-window redriven, an attempting 1 s inside the bound', async () => {
    for (const [state, ageMs] of [
      ['attempting', 31_000],
      ['reconciling', 30_000],
      ['redriven', 30_000],
      ['attempting', RETRY_SEND_WINDOW_MS - 1_000],
    ] as Array<[SeededState, number]>) {
      const world = createFakeWorld();
      await seedRecord(world, retryOwner(), state, ageMs);
      const { app, calls } = makeRetryApp(FAILED_ORIGINAL, { world });
      const res = await press(app);
      expect(res.status, `${state} at ${ageMs} ms`).toBe(409);
      expect(res.body).toEqual({ error: 'retry_pending' });
      expect(calls).toHaveLength(0);
    }
  });

  it('retry-send-adoption R6: 201 on a STALE open record (RETRY_SEND_WINDOW_MS + 1 s old) and on every done outcome but unresolved - the press reads the record and lets it through', async () => {
    const STALE_MS = RETRY_SEND_WINDOW_MS + 1_000;
    for (const [state, ageMs] of [
      ['attempting', STALE_MS],
      ['reconciling', STALE_MS],
      ['redriven', STALE_MS],
      ['sent', 60_000],
      ['retryable', 60_000],
      ['refused', 60_000],
      ['rejected', 60_000],
      ['adopted', 60_000],
      ['enqueue_failed', 60_000],
      ['redrive_refused', 60_000],
    ] as Array<[SeededState, number]>) {
      const world = createFakeWorld();
      await seedRecord(world, retryOwner(), state, ageMs);
      const get = vi.spyOn(world.sendAttemptsRepo, 'get');
      const { app, calls } = makeRetryApp(FAILED_ORIGINAL, { world });
      const res = await press(app);
      expect(res.status, `${state} at ${ageMs} ms`).toBe(201);
      expect(calls).toHaveLength(1);
      // Not a miss: the route read THIS record and judged it.
      expect(get).toHaveBeenCalledTimes(1);
      const seen = (await get.mock.results[0]!.value) as Awaited<ReturnType<FakeWorld['sendAttemptsRepo']['get']>>;
      expect(seen?.state === 'done' ? seen.outcome : seen?.state).toBe(state);
    }
  });

  it('retry-send-adoption R6: the record is read at attempt (retry_attempt ?? 0) + 1 only - a pressed attempt-1 retry row reads attempt 2 (plan deviation 1)', async () => {
    const pressedRetryRow = {
      ...FAILED_ORIGINAL,
      retry_of: '2026-06-12T08:59:00.000Z#SMroot',
      retry_attempt: 1,
      retry_root: '2026-06-12T08:59:00.000Z#SMroot',
    };
    const atAttempt2 = createFakeWorld();
    await seedRecord(atAttempt2, retryOwner({ attempt: 2 }), 'unresolved', 60_000);
    const refused = makeRetryApp(pressedRetryRow, { world: atAttempt2 });
    const refusedRes = await press(refused.app);
    expect(refusedRes.status).toBe(409);
    expect(refusedRes.body).toEqual({ error: 'retry_unresolved' });

    // The row's OWN attempt-1 record belongs to the chain above it, never to a press on this row.
    const atAttempt1 = createFakeWorld();
    await seedRecord(atAttempt1, retryOwner({ attempt: 1 }), 'unresolved', 60_000);
    const get = vi.spyOn(atAttempt1.sendAttemptsRepo, 'get');
    const passed = makeRetryApp(pressedRetryRow, { world: atAttempt1 });
    const passedRes = await press(passed.app);
    expect(passedRes.status).toBe(201);
    expect(passed.calls).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ kind: 'retry_send', attempt: 2 }));
  });

  it('retry-send-adoption R6: the record key is R1\'s - the recorded recipient\'s id when the row has one, else phone#<the thread\'s number>', async () => {
    const recorded = { ...FAILED_ORIGINAL, recipient_contact_id: 'c-real' };
    const contactsRepo = {
      async getById(contactId: string) {
        return contactId === 'c-real'
          ? { contactId: 'c-real', type: 'tenant' as const, phone: '+15550100001', consent_method: 'verbal_in_person' as const }
          : undefined;
      },
    };
    const byContact = createFakeWorld();
    await seedRecord(byContact, retryOwner({ recipientKey: 'c-real' }), 'unresolved', 60_000);
    const refused = await press(makeRetryApp(recorded, { world: byContact, contactsRepo }).app);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'retry_unresolved' });

    // The same row's attempt under the PHONE key is another record - never this row's.
    const byPhone = createFakeWorld();
    await seedRecord(byPhone, retryOwner({ recipientKey: PHONE_KEY }), 'unresolved', 60_000);
    expect((await press(makeRetryApp(recorded, { world: byPhone, contactsRepo }).app)).status).toBe(201);

    // No recorded recipient: the thread's number is the key.
    const phoneOnly = createFakeWorld();
    await seedRecord(phoneOnly, retryOwner({ recipientKey: 'phone#+15550100077' }), 'unresolved', 60_000);
    const onThread = await press(
      makeRetryApp(FAILED_ORIGINAL, { world: phoneOnly, conversation: { participant_phone: '+15550100077' } }).app,
    );
    expect(onThread.status).toBe(409);
    expect(onThread.body).toEqual({ error: 'retry_unresolved' });
  });

  it('retry-send-adoption R6: no record is read where none can exist - a row at the attempt cap, or no key (no thread and no recorded recipient)', async () => {
    for (const [original, opts] of [
      [{ ...FAILED_ORIGINAL, retry_of: '2026-06-12T08:59:00.000Z#SMr2', retry_attempt: 3, retry_root: 'T#SMroot' }, {}],
      [FAILED_ORIGINAL, { conversation: null }],
      [FAILED_ORIGINAL, { conversation: { participant_phone: undefined } }],
    ] as Array<[unknown, RetryAppOptions]>) {
      const world = createFakeWorld();
      const get = vi.spyOn(world.sendAttemptsRepo, 'get');
      const { app, calls } = makeRetryApp(original, { ...opts, world });
      const res = await press(app);
      // The send wrapper judges the thread itself (a missing one is its 404).
      expect(res.status).toBe(201);
      expect(calls).toHaveLength(1);
      expect(get).not.toHaveBeenCalled();
    }
  });

  it('retry-send-adoption R6: guard order - RSW\'s time guard, then superseded, then retry_unresolved, then the record\'s retry_pending', async () => {
    const child: RetryChildPointer = { tsMsgId: '2026-06-12T09:01:00.000Z#SMx', providerSid: 'SMx' };
    const unconfirmed = { ...FAILED_ORIGINAL, retry_outcome: 'unconfirmed' as const };
    const cases: Array<[string, unknown, RetryAppOptions, SeededState, string]> = [
      // A live promise answers first, whatever else is true (a stale tab after a success reads this - worklist item 26).
      ['live promise', { ...unconfirmed, retry_due_at: new Date(Date.now() + 30_000).toISOString() }, { children: [child] }, 'unresolved', 'retry_pending'],
      ['child', unconfirmed, { children: [child] }, 'unresolved', 'superseded'],
      ['belt over an open record', unconfirmed, {}, 'attempting', 'retry_unresolved'],
    ];
    for (const [label, original, opts, state, error] of cases) {
      const world = createFakeWorld();
      await seedRecord(world, retryOwner(), state, 30_000);
      const { app, calls } = makeRetryApp(original, { ...opts, world });
      const res = await press(app);
      expect(res.status, label).toBe(409);
      expect(res.body, label).toEqual({ error });
      expect(calls).toHaveLength(0);
    }
  });

  it('retry-send-adoption R6: every new read runs AFTER the existing 404 / 400 / 409 guards (rateLimit.test.ts drives the route with no original)', async () => {
    const cases: Array<[unknown, number, string]> = [
      [undefined, 404, 'message_not_found'],
      [{ ...FAILED_ORIGINAL, conversationId: 'other' }, 404, 'message_not_found'],
      [{ ...FAILED_ORIGINAL, direction: 'inbound' }, 400, 'not_outbound'],
      [{ ...FAILED_ORIGINAL, type: 'email' }, 409, 'not_retryable'],
      [{ ...FAILED_ORIGINAL, delivery_status: 'delivered' }, 409, 'not_failed'],
      [{ ...FAILED_ORIGINAL, retry_due_at: new Date(Date.now() + 30_000).toISOString() }, 409, 'retry_pending'],
    ];
    for (const [original, status, error] of cases) {
      const world = createFakeWorld();
      const get = vi.spyOn(world.sendAttemptsRepo, 'get');
      const { app, calls, messagesRepo, conversationsRepo } = makeRetryApp(original, { world });
      const res = await press(app);
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error });
      expect(messagesRepo.listRetryChildrenConsistent).not.toHaveBeenCalled();
      expect(messagesRepo.getByTsMsgIdConsistent).not.toHaveBeenCalled();
      expect(conversationsRepo.getById).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    }
  });

  it("retry-send-adoption R7: the route's append carries retryRoot and broadcastId from the pressed row", async () => {
    const shareRetryRow = {
      ...FAILED_ORIGINAL,
      retry_of: '2026-06-12T08:59:00.000Z#SMroot',
      retry_attempt: 1,
      retry_root: '2026-06-12T08:59:00.000Z#SMroot',
      broadcast_id: 'b-1',
    };
    const share = makeRetryApp(shareRetryRow);
    expect((await press(share.app)).status).toBe(201);
    expect(share.calls[0]).toMatchObject({
      retryOf: FAILED_ORIGINAL.tsMsgId,
      retryRoot: '2026-06-12T08:59:00.000Z#SMroot',
      broadcastId: 'b-1',
    });
    // A manual row starts its own window and is no automatic attempt.
    expect(share.calls[0]).not.toHaveProperty('retryAttempt');
    expect(share.calls[0]).not.toHaveProperty('retryWindowStart');

    const plain = makeRetryApp(FAILED_ORIGINAL);
    expect((await press(plain.app)).status).toBe(201);
    expect(plain.calls[0]).toMatchObject({ retryOf: FAILED_ORIGINAL.tsMsgId, retryRoot: FAILED_ORIGINAL.tsMsgId });
    expect(plain.calls[0]).not.toHaveProperty('broadcastId');
  });

  it('retry-send-adoption R7: a pre-deploy pressed row (retry_of, no retry_root) walks retry_of for the root', async () => {
    const root: MessageItem = {
      ...FAILED_ORIGINAL,
      tsMsgId: '2026-06-12T08:59:00.000Z#SMroot',
      provider_sid: 'SMroot',
      provider_ts: '2026-06-12T08:59:00.000Z',
      created_at: '2026-06-12T08:59:00.000Z',
    };
    const { app, calls, messagesRepo } = makeRetryApp(
      { ...FAILED_ORIGINAL, retry_of: root.tsMsgId, retry_attempt: 1 },
      { parent: root },
    );
    expect((await press(app)).status).toBe(201);
    expect(calls[0]?.retryRoot).toBe(root.tsMsgId);
    expect(messagesRepo.getByTsMsgIdConsistent).toHaveBeenCalledWith('conv-1', root.tsMsgId);
  });

  it('retry-send-adoption R6 + R7 through the REAL send wrapper over the world fakes: the press appends a retry row with retry_of, retry_root and broadcast_id AND its retrychild# pointer; a second press on the same row - 60 newer rows in the thread - is 409 superseded by ONE pointer Query', async () => {
    const world = createFakeWorld();
    const conversation = await world.conversationsRepo.createOrGetByParticipantPhone('+15550100001', 'tenant_1to1');
    const conversationId = conversation.conversationId;
    world.contacts.push({ contactId: 'c-1', type: 'tenant', phone: '+15550100001', consent_method: 'inbound_text' });
    const rootAt = Date.now() - 20 * 60_000;
    const root = await world.messagesRepo.append({
      conversationId,
      providerSid: 'SMshare',
      providerTs: new Date(rootAt).toISOString(),
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'a share text',
      deliveryStatus: 'undelivered',
      errorCode: '30003',
      broadcastId: 'b-1',
    });
    const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET });
    const logger = createLogger({ destination: createLogCapture().stream });
    const app = buildApp({
      config,
      logger,
      auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
      api: {
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        contactsRepo: world.contactsRepo,
        sendAttemptsRepo: world.sendAttemptsRepo,
        sendMessageService: createSendMessageService({
          config,
          logger,
          adapter: world.adapter,
          conversationsRepo: world.conversationsRepo,
          messagesRepo: world.messagesRepo,
          contactsRepo: world.contactsRepo,
          auditRepo: world.auditRepo,
          events: world.events,
        }),
      },
    });
    const pressRoot = () =>
      request(app)
        .post(`/api/conversations/${conversationId}/messages/SMshare/retry`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send();

    const first = await pressRoot();
    expect(first.status).toBe(201);
    expect(world.sent).toHaveLength(1);
    const retryRow = world.messages.find((m) => m.retry_of === root.tsMsgId)!;
    expect(retryRow).toMatchObject({
      retry_of: root.tsMsgId,
      retry_root: root.tsMsgId,
      broadcast_id: 'b-1',
      automated: false,
    });
    expect(retryRow).not.toHaveProperty('retry_attempt');
    expect(await world.messagesRepo.listRetryChildrenConsistent(conversationId, root.tsMsgId)).toEqual([
      { tsMsgId: retryRow.tsMsgId, providerSid: retryRow.provider_sid },
    ]);

    // Sixty newer, unrelated rows: the second press must not read them.
    for (let i = 0; i < 60; i += 1) {
      await world.messagesRepo.append({
        conversationId,
        providerSid: `SMnewer${i}`,
        providerTs: new Date(rootAt + 60_000 + i * 1_000).toISOString(),
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: `newer ${i}`,
        deliveryStatus: 'delivered',
      });
    }
    const pointerQuery = vi.spyOn(world.messagesRepo, 'listRetryChildrenConsistent');
    const scan = vi.spyOn(world.messagesRepo, 'listByConversation');
    const consistentScan = vi.spyOn(world.messagesRepo, 'listByConversationConsistent');
    const second = await pressRoot();
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'superseded' });
    expect(pointerQuery).toHaveBeenCalledTimes(1);
    expect(scan).not.toHaveBeenCalled();
    expect(consistentScan).not.toHaveBeenCalled();
    expect(world.sent).toHaveLength(1);
  });

  it("retry-send-adoption R6: makeWebhookHarness threads the world's send-attempt fake to the route - a seeded unresolved record refuses the press", async () => {
    const { app, world } = makeWebhookHarness();
    const conversation = await world.conversationsRepo.createOrGetByParticipantPhone('+15550100001', 'tenant_1to1');
    const { tsMsgId } = await world.messagesRepo.append({
      conversationId: conversation.conversationId,
      providerSid: 'SMharness',
      providerTs: new Date(Date.now() - 60_000).toISOString(),
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'harness row',
      deliveryStatus: 'undelivered',
      errorCode: '30003',
    });
    await seedRecord(
      world,
      retryOwner({ conversationId: conversation.conversationId, retriedTsMsgId: tsMsgId, retryRoot: tsMsgId }),
      'unresolved',
      60_000,
    );
    const res = await request(app)
      .post(`/api/conversations/${conversation.conversationId}/messages/SMharness/retry`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'retry_unresolved' });
    expect(world.sent).toHaveLength(0);
  });
});

// GET /api/messages/:providerSid/media/:idx — reads the cohesive media_attachments
// record (with legacy media_s3_keys compat) and serves inline only for allowlisted
// types, else as a download. The inline/attachment decision uses the LIVE stored
// Content-Type from the media store (authoritative), not the recorded hint.
describe('GET /api/messages/:providerSid/media/:idx', () => {
  function makeMediaApp(opts: {
    message: Record<string, unknown> | undefined;
    /** What the store returns for getStream (its contentType drives the decision). */
    object?: { contentType?: string };
  }) {
    const getCalls: string[] = [];
    const app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET, MEDIA_BUCKET: 'b' }),
      logger: createLogger({ destination: createLogCapture().stream }),
      auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
      api: {
        messagesRepo: {
          async getByProviderSid() {
            return opts.message;
          },
        } as unknown as import('../src/repos/messagesRepo.js').MessagesRepo,
        mediaStore: {
          async getStream(key: string) {
            getCalls.push(key);
            if (!opts.object) return undefined;
            return {
              body: Readable.from([Buffer.from('bytes')]),
              ...(opts.object.contentType !== undefined && { contentType: opts.object.contentType }),
            };
          },
          async put() {
            /* unused */
          },
        } as unknown as import('../src/adapters/mediaStore.js').MediaStore,
      },
    });
    return { app, getCalls };
  }

  const get = (app: import('express').Express, sid: string, idx: number) =>
    request(app)
      .get(`/api/messages/${sid}/media/${idx}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

  it('serves an image attachment INLINE (no attachment disposition)', async () => {
    const { app, getCalls } = makeMediaApp({
      message: { provider_sid: 'MM1', conversationId: 'c1', media_attachments: [{ s3Key: 'media/c1/MM1/0', contentType: 'image/png' }] },
      object: { contentType: 'image/png' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(getCalls).toEqual(['media/c1/MM1/0']);
  });

  it('serves a PDF attachment INLINE (application/pdf, no attachment disposition)', async () => {
    const { app } = makeMediaApp({
      message: { provider_sid: 'MM2', conversationId: 'c1', media_attachments: [{ s3Key: 'media/c1/MM2/0', contentType: 'application/pdf' }] },
      object: { contentType: 'application/pdf' },
    });
    const res = await get(app, 'MM2', 0);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="/);
  });

  it('forces a download for a non-allowlisted stored type', async () => {
    const { app } = makeMediaApp({
      message: { provider_sid: 'MM3', conversationId: 'c1', media_attachments: [{ s3Key: 'media/c1/MM3/0', contentType: 'application/octet-stream' }] },
      object: { contentType: 'application/octet-stream' },
    });
    const res = await get(app, 'MM3', 0);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/octet-stream/);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('serves legacy media_s3_keys (no media_attachments) as a download', async () => {
    const { app, getCalls } = makeMediaApp({
      message: { provider_sid: 'MM4', conversationId: 'c1', media_s3_keys: ['media/c1/MM4/0'] },
      object: { contentType: 'application/octet-stream' },
    });
    const res = await get(app, 'MM4', 0);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(getCalls).toEqual(['media/c1/MM4/0']);
  });

  it('404s for an out-of-range index', async () => {
    const { app } = makeMediaApp({
      message: { provider_sid: 'MM5', conversationId: 'c1', media_attachments: [{ s3Key: 'k0', contentType: 'image/png' }] },
      object: { contentType: 'image/png' },
    });
    const res = await get(app, 'MM5', 9);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'media_not_found' });
  });

  it('404s when the message is unknown', async () => {
    const { app } = makeMediaApp({ message: undefined });
    const res = await get(app, 'NOPE', 0);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'message_not_found' });
  });

  function mediaMessage(attachment: Record<string, unknown>) {
    return {
      conversationId: 'c1',
      tsMsgId: '2026-08-01T00:00:00.000Z#MM1',
      provider_sid: 'MM1',
      media_attachments: [{ s3Key: 'media/c1/MM1/0', ...attachment }],
    };
  }

  it('HANDS OFF a video: true type, real extension, inline so the phone opens it', async () => {
    // The reported bug was that this downloaded as an untyped, extensionless
    // blob. It now carries its true type AND `inline`, which is not a
    // rendering decision on our part - it is "browser, this is yours", the
    // same mechanism that already opens a PDF without us shipping a viewer.
    // A tenant's video should open in the phone's player, not land in Files.
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'video/mp4' }),
      object: { contentType: 'video/mp4' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-disposition']).toBe('inline; filename="attachment-1.mp4"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // A real browser proved BOTH of these necessary: media-src falls back to
    // default-src 'none' and blocks the video, and sandbox blocks the built-in
    // player's script. default-src 'none' still stands.
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; media-src 'self'");
  });

  it('hands off audio the same way', async () => {
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'audio/mpeg' }),
      object: { contentType: 'audio/mpeg' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['content-disposition']).toBe('inline; filename="attachment-1.mp3"');
  });

  it('keeps a HEIC as a DOWNLOAD, not a hand-off', async () => {
    // HEIC is on the declarable tier precisely BECAUSE browsers cannot decode
    // it. Handing it off would produce a broken viewer where a saved file the
    // OS can route to Photos is the useful outcome.
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'image/heic' }),
      object: { contentType: 'image/heic' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-type']).toBe('image/heic');
    expect(res.headers['content-disposition']).toBe('attachment; filename="attachment-1.heic"');
  });

  it('keeps a spreadsheet as a DOWNLOAD, not a hand-off', async () => {
    const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: xlsx, filename: 'Q3.xlsx' }),
      object: { contentType: xlsx },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-disposition']).toBe('attachment; filename="Q3.xlsx"');
  });

  it('still forces an unknown stored type to an opaque download', async () => {
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'application/x-made-up' }),
      object: { contentType: 'application/x-made-up' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment; filename="attachment-1.bin"');
  });

  it('refuses to render a script-capable type stored on the OBJECT', async () => {
    // The stored-XSS guard, exercised where it actually lives. An object
    // mirrored before the write-side normalizer existed can still carry
    // text/html at rest, which is the population this gate is for - so the
    // OBJECT's type is text/html here even though no write path would produce
    // it today.
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'application/octet-stream' }),
      object: { contentType: 'text/html' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('names an inline attachment without forcing a download', async () => {
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'image/png' }),
      object: { contentType: 'image/png' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe('inline; filename="attachment-1.png"');
  });

  it('takes a stored filename stem but never its extension', async () => {
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'video/mp4', filename: 'invoice.exe' }),
      object: { contentType: 'video/mp4' },
    });
    const res = await get(app, 'MM1', 0);
    // `inline` because video is a hand-off type; the point of this test is the
    // FILENAME - the sender's `.exe` is discarded for our own `.mp4`.
    expect(res.headers['content-disposition']).toBe('inline; filename="invoice.mp4"');
  });

  it('keeps a recognised stored extension when the type is unrecoverable', async () => {
    // Historical inbound email: octet-stream at rest, real name still present.
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'application/octet-stream', filename: 'budget.xlsx' }),
      object: { contentType: 'application/octet-stream' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-disposition']).toBe('attachment; filename="budget.xlsx"');
  });

  it('serves an OUTBOUND email attachment on the declarable tier', async () => {
    // Not the reported bug, but the same route: outbound email attachments are
    // already stored as their real type, so they change tier the moment this
    // lands with no backfill at all. Spec section 8.6.
    const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: xlsx, filename: 'Q3.xlsx' }),
      object: { contentType: xlsx },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-type']).toBe(xlsx);
    expect(res.headers['content-disposition']).toBe('attachment; filename="Q3.xlsx"');
  });

  it('emits filename* for a non-ASCII stored name', async () => {
    // Built, not written as a literal - the ASCII-only source rule.
    const stored = `bud${String.fromCharCode(0xe9)}get.mov`;
    const { app } = makeMediaApp({
      message: mediaMessage({ contentType: 'video/mp4', filename: stored }),
      object: { contentType: 'video/mp4' },
    });
    const res = await get(app, 'MM1', 0);
    expect(res.headers['content-disposition']).toBe(
      "inline; filename=\"bud_get.mp4\"; filename*=UTF-8''bud%C3%A9get.mp4",
    );
  });
});
