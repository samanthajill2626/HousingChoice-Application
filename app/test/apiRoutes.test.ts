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
import {
  CircuitBreakerOpenError,
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

  it('400s attachments_too_large when the summed size exceeds the total cap', async () => {
    const { app, calls } = makeMmsApp({
      'uploads/a': { contentType: 'image/png', size: 4 * 1024 * 1024 },
      'uploads/b': { contentType: 'image/png', size: 2 * 1024 * 1024 },
    });
    const res = await send(app, { attachmentKeys: ['uploads/a', 'uploads/b'] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'attachments_too_large' });
    expect(calls).toHaveLength(0);
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
    expect(res.headers['content-disposition']).toBeUndefined();
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
    expect(res.headers['content-disposition']).toBeUndefined();
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
});
