// M1.1 unit tests: POST /api/conversations/:id/messages — payload validation
// and typed-refusal → HTTP status mapping, with a fake send service injected
// through buildApp (no DynamoDB, no provider). The route sits BEHIND the
// origin-secret middleware AND (M1.3) the session requireAuth gate.
import { Readable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { OUTBOUND_MMS_MAX_MEDIA_PER_MESSAGE } from '../src/lib/outboundMediaLimits.js';
import {
  CircuitBreakerOpenError,
  ContactDeletedError,
  ContactNoConsentError,
  ContactOptedOutError,
  ConversationNotFoundError,
  type SendMessageInput,
} from '../src/services/sendMessage.js';
import type { ConversationsRepo } from '../src/repos/conversationsRepo.js';
import { makeFakeUsersRepo, testUserItem, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';

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

  function makeRetryApp(
    original: unknown,
    mediaStore?: import('../src/adapters/mediaStore.js').MediaStore,
  ) {
    const calls: SendMessageInput[] = [];
    const app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }),
      logger: createLogger({ destination: createLogCapture().stream }),
      auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
      api: {
        messagesRepo: {
          async getByProviderSid() {
            return original;
          },
        } as unknown as import('../src/repos/messagesRepo.js').MessagesRepo,
        ...(mediaStore !== undefined && { mediaStore }),
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
    return { app, calls };
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
    const { app, calls } = makeRetryApp(original, mediaStore);

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
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
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
