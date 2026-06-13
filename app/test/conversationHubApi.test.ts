// M1.2 unit tests: the conversation-hub REST endpoints —
//   GET   /api/conversations                  (inbox: ONE Query, cursor paging)
//   GET   /api/conversations/:id              (single item)
//   GET   /api/conversations/:id/messages     (timeline page)
//   POST  /api/conversations/:id/read         (unread reset)
//   PATCH /api/conversations/:id/assignment   (assign/unassign + audit)
// The inbox's Query-not-Scan mandate is asserted against a FAKE DocumentClient
// (every command the repo sends is captured and inspected); everything else
// runs on the shared in-memory world fakes.
import type { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { makeFakeUsersRepo, testUserItem, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

// Every /api request sits behind requireAuth since M1.3 — the suites ride a
// real sealed session cookie next to the origin secret.
const SECRET = ORIGIN_SECRET;

function seedConversation(
  world: ReturnType<typeof createFakeWorld>,
  id: string,
  overrides: Record<string, unknown> = {},
) {
  const item = {
    conversationId: id,
    participant_phone: '+15550100001',
    status: 'open',
    last_activity_at: '2026-06-12T10:00:00.000Z',
    type: 'tenant_1to1' as const,
    ai_mode: 'auto' as const,
    created_at: '2026-06-12T09:00:00.000Z',
    ...overrides,
  };
  world.conversations.set(id, item);
  return item;
}

describe('GET /api/conversations — the inbox', () => {
  it('returns summaries sorted by last_activity_at DESC with denormalized fields', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-old', { last_activity_at: '2026-06-12T08:00:00.000Z' });
    seedConversation(world, 'conv-new', {
      last_activity_at: '2026-06-12T11:00:00.000Z',
      last_message_preview: 'newest preview',
      unread_count: 4,
      assignment: 'user-va-1',
      sms_opt_out: true,
      participants: [{ contactId: 'contact-1', phone: '+15550100001' }],
    });
    seedConversation(world, 'conv-closed', { status: 'closed' });

    const res = await request(app).get('/api/conversations').set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.conversations.map((c: { conversationId: string }) => c.conversationId)).toEqual([
      'conv-new',
      'conv-old',
    ]);
    expect(res.body.conversations[0]).toEqual({
      conversationId: 'conv-new',
      type: 'tenant_1to1',
      participant_phone: '+15550100001',
      participants: [{ contactId: 'contact-1', phone: '+15550100001' }],
      preview: 'newest preview',
      last_activity_at: '2026-06-12T11:00:00.000Z',
      unread_count: 4,
      assignment: 'user-va-1',
      sms_opt_out: true,
    });
    // Defaults for sparse attributes:
    expect(res.body.conversations[1]).toMatchObject({
      participants: [],
      preview: null,
      unread_count: 0,
      assignment: null,
      sms_opt_out: false,
    });
    expect(res.body.nextCursor).toBeNull();
  });

  it('rejects bad limits and garbage cursors with 400', async () => {
    const { app } = makeWebhookHarness();
    for (const qs of ['limit=0', 'limit=101', 'limit=abc', 'limit=1.5']) {
      const res = await request(app).get(`/api/conversations?${qs}`).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
      expect(res.status, qs).toBe(400);
    }
    const wrongShape = (key: Record<string, unknown>): string =>
      Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
    const garbageCursors = [
      Buffer.from('not json', 'utf8').toString('base64url'), // decodes, fails to parse
      Buffer.from('[1,2]', 'utf8').toString('base64url'), // parses, but not a key object
      // Structurally valid JSON objects that are NOT the exact byLastActivity
      // ExclusiveStartKey shape — must 400, never reach DynamoDB:
      wrongShape({ conversationId: 'c', status: 'open' }), // missing last_activity_at
      wrongShape({ conversationId: 'c', status: 'open', last_activity_at: 't', extra: 'x' }), // extra key
      wrongShape({ conversationId: 5, status: 'open', last_activity_at: 't' }), // wrong type
      wrongShape({}), // empty object
    ];
    for (const cursor of garbageCursors) {
      const res = await request(app)
        .get(`/api/conversations?cursor=${cursor}`)
        .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
      expect(res.status, cursor).toBe(400);
      expect(res.body).toEqual({ error: 'invalid cursor' });
    }
  });

  it('rejects a ?status= outside the allowlist with 400 (the value is a raw GSI partition key)', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-1');

    for (const status of ['closed', 'bogus', 'OPEN', 'open%20OR%201']) {
      const res = await request(app)
        .get(`/api/conversations?status=${status}`)
        .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
      expect(res.status, status).toBe(400);
    }
    const ok = await request(app)
      .get('/api/conversations?status=open')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(ok.status).toBe(200);
  });

  it('stays behind the origin-secret middleware', async () => {
    const { app } = makeWebhookHarness();
    expect((await request(app).get('/api/conversations')).status).toBe(403);
  });
});

describe('GET /api/conversations — ONE Query on byLastActivity, never a Scan (fake doc client)', () => {
  /** A DocumentClient stand-in that records every command and serves pages. */
  function makeFakeDoc(pages: { Items: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }[]) {
    const commands: object[] = [];
    let call = 0;
    const fakeDoc = {
      send: async (cmd: object) => {
        commands.push(cmd);
        const page = pages[Math.min(call, pages.length - 1)];
        call += 1;
        return page ?? { Items: [] };
      },
    } as unknown as DynamoDBDocumentClient;
    return { fakeDoc, commands };
  }

  function makeAppWithDoc(fakeDoc: DynamoDBDocumentClient) {
    const repo = createConversationsRepo({
      doc: fakeDoc,
      env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    return buildApp({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET } as NodeJS.ProcessEnv),
      logger: createLogger({ destination: createLogCapture().stream }),
      // The session-epoch check reads the users table — keep it OFF the fake
      // doc client (whose commands this suite counts) with its own fake repo.
      auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
      api: { conversationsRepo: repo },
    });
  }

  const itemA = { conversationId: 'conv-a', participant_phone: '+1', status: 'open', last_activity_at: '2026-06-12T11:00:00.000Z', type: 'tenant_1to1', ai_mode: 'auto', created_at: 'x' };
  const lek = { conversationId: 'conv-a', status: 'open', last_activity_at: '2026-06-12T11:00:00.000Z' };

  it('issues exactly ONE QueryCommand on byLastActivity (descending), and never a Scan', async () => {
    const { fakeDoc, commands } = makeFakeDoc([{ Items: [itemA] }]);
    const app = makeAppWithDoc(fakeDoc);

    const res = await request(app)
      .get('/api/conversations?status=open&limit=25')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(commands).toHaveLength(1); // ONE DynamoDB round trip for the whole inbox page
    const cmd = commands[0] as QueryCommand;
    expect(cmd.constructor.name).toBe('QueryCommand'); // a Query — NEVER ScanCommand
    expect(cmd.input).toMatchObject({
      TableName: 'hc-fake-conversations',
      IndexName: 'byLastActivity',
      KeyConditionExpression: '#s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': 'open' },
      ScanIndexForward: false,
      Limit: 25,
    });
    expect(cmd.input).not.toHaveProperty('FilterExpression');
  });

  it('round-trips the cursor: LastEvaluatedKey → nextCursor → ExclusiveStartKey, byte-identical', async () => {
    const { fakeDoc, commands } = makeFakeDoc([
      { Items: [itemA], LastEvaluatedKey: lek },
      { Items: [] },
    ]);
    const app = makeAppWithDoc(fakeDoc);

    const first = await request(app).get('/api/conversations').set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(first.status).toBe(200);
    const cursor: string = first.body.nextCursor;
    expect(typeof cursor).toBe('string');
    // Opaque to clients, but decodes to exactly the LastEvaluatedKey:
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual(lek);

    const second = await request(app)
      .get(`/api/conversations?cursor=${encodeURIComponent(cursor)}`)
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(second.status).toBe(200);
    expect(second.body.nextCursor).toBeNull();

    expect(commands).toHaveLength(2);
    const cmd2 = commands[1] as QueryCommand;
    expect(cmd2.constructor.name).toBe('QueryCommand');
    expect(cmd2.input.ExclusiveStartKey).toEqual(lek); // the round-tripped key
  });
});

describe('GET /api/conversations/:conversationId', () => {
  it('returns the single item, 404 when unknown', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-1', { unread_count: 2 });

    const ok = await request(app).get('/api/conversations/conv-1').set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(ok.status).toBe(200);
    expect(ok.body.conversation).toMatchObject({ conversationId: 'conv-1', unread_count: 2 });

    const missing = await request(app).get('/api/conversations/conv-nope').set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'conversation_not_found' });
  });
});

describe('GET /api/conversations/:conversationId/messages', () => {
  it('serves a newest-first page and forwards limit/before to the repo', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-1');
    for (const [i, ts] of ['10:00', '11:00', '12:00'].entries()) {
      await world.messagesRepo.append({
        conversationId: 'conv-1',
        providerSid: `SMpage${i}`,
        providerTs: `2026-06-12T${ts}:00.000Z`,
        type: 'sms',
        direction: 'inbound',
        author: 'tenant',
        body: `msg ${i}`,
        deliveryStatus: 'delivered',
      });
    }

    const res = await request(app)
      .get('/api/conversations/conv-1/messages')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { provider_sid: string }) => m.provider_sid)).toEqual([
      'SMpage2',
      'SMpage1',
      'SMpage0',
    ]);

    const before: string = res.body.messages[2].tsMsgId; // oldest seen
    const older = await request(app)
      .get(`/api/conversations/conv-1/messages?before=${encodeURIComponent(res.body.messages[1].tsMsgId)}`)
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(older.status).toBe(200);
    expect(older.body.messages.map((m: { tsMsgId: string }) => m.tsMsgId)).toEqual([before]);

    const bad = await request(app)
      .get('/api/conversations/conv-1/messages?limit=0')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/conversations/:conversationId/read — unread reset', () => {
  it('zeroes unread_count, returns the conversation, and emits conversation.updated on the bus', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-1', { unread_count: 7, last_message_preview: 'seen now' });

    const res = await request(app)
      .post('/api/conversations/conv-1/read')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.conversation).toMatchObject({ conversationId: 'conv-1', unread_count: 0 });
    expect(world.conversations.get('conv-1')!.unread_count).toBe(0);
    // SSE (M1.2): other dashboards drop their unread badge live — same
    // payload shape as every other conversation.updated.
    expect(world.emitted).toEqual([
      {
        event: 'conversation.updated',
        payload: {
          conversationId: 'conv-1',
          last_activity_at: '2026-06-12T10:00:00.000Z',
          unread_count: 0,
          preview: 'seen now',
        },
      },
    ]);
  });

  it('404s for unknown conversations (conditional write failed) and emits nothing', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/conversations/conv-nope/read')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'conversation_not_found' });
    expect(world.emitted).toHaveLength(0);
  });
});

describe('PATCH /api/conversations/:conversationId/assignment', () => {
  it('assigns, reassigns, and unassigns — auditing each change as old → new', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-1');

    const assign = await request(app)
      .patch('/api/conversations/conv-1/assignment')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
      .send({ assigneeUserId: 'user-va-1' });
    expect(assign.status).toBe(200);
    expect(assign.body.conversation.assignment).toBe('user-va-1');

    const reassign = await request(app)
      .patch('/api/conversations/conv-1/assignment')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
      .send({ assigneeUserId: 'user-va-2' });
    expect(reassign.status).toBe(200);
    expect(reassign.body.conversation.assignment).toBe('user-va-2');

    const unassign = await request(app)
      .patch('/api/conversations/conv-1/assignment')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
      .send({ assigneeUserId: null });
    expect(unassign.status).toBe(200);
    expect(unassign.body.conversation.assignment).toBeUndefined();
    expect(world.conversations.get('conv-1')!.assignment).toBeUndefined();

    expect(world.auditEvents).toEqual([
      { entityKey: 'conversations#conv-1', event_type: 'assignment_changed', payload: { from: null, to: 'user-va-1' } },
      { entityKey: 'conversations#conv-1', event_type: 'assignment_changed', payload: { from: 'user-va-1', to: 'user-va-2' } },
      { entityKey: 'conversations#conv-1', event_type: 'assignment_changed', payload: { from: 'user-va-2', to: null } },
    ]);

    // SSE (M1.2): each assignment change pushes one conversation.updated
    // (shared event shape; clients re-read the summary for the assignee).
    expect(world.emitted).toEqual([
      expect.objectContaining({ event: 'conversation.updated' }),
      expect.objectContaining({ event: 'conversation.updated' }),
      expect.objectContaining({ event: 'conversation.updated' }),
    ]);
    expect(world.emitted[0]!.payload).toEqual({
      conversationId: 'conv-1',
      last_activity_at: '2026-06-12T10:00:00.000Z',
      unread_count: 0,
    });
  });

  it('400s on malformed payloads without touching the conversation or audit trail', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-1', { assignment: 'user-va-1' });

    for (const payload of [{}, { assigneeUserId: '' }, { assigneeUserId: 42 }, { assigneeUserId: ['x'] }]) {
      const res = await request(app)
        .patch('/api/conversations/conv-1/assignment')
        .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
        .send(payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
    expect(world.conversations.get('conv-1')!.assignment).toBe('user-va-1');
    expect(world.auditEvents).toHaveLength(0);
  });

  it('404s for unknown conversations and writes no audit event', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .patch('/api/conversations/conv-nope/assignment')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
      .send({ assigneeUserId: 'user-va-1' });
    expect(res.status).toBe(404);
    expect(world.auditEvents).toHaveLength(0);
  });
});
