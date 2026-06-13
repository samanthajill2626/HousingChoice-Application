// M1.1 unit tests: POST /api/conversations/:id/messages — payload validation
// and typed-refusal → HTTP status mapping, with a fake send service injected
// through buildApp (no DynamoDB, no provider). The route sits BEHIND the
// origin-secret middleware AND (M1.3) the session requireAuth gate.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import {
  CircuitBreakerOpenError,
  ContactOptedOutError,
  ConversationNotFoundError,
  type SendMessageInput,
} from '../src/services/sendMessage.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';

const SECRET = 'test-origin-secret';

function makeApp(behavior?: (input: SendMessageInput) => never) {
  const calls: SendMessageInput[] = [];
  const app = buildApp({
    config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }),
    logger: createLogger({ destination: createLogCapture().stream }),
    api: {
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
