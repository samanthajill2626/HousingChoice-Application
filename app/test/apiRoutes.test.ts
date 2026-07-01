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

  function makeRetryApp(original: unknown) {
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
