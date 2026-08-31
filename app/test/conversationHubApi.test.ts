// M1.2 unit tests: the conversation-hub REST endpoints —
//   GET   /api/conversations                  (inbox: ONE Query, cursor paging)
//   GET   /api/conversations/:id              (single item)
//   GET   /api/conversations/:id/messages     (timeline page)
//   POST  /api/conversations/:id/read         (unread reset)
// The inbox's Query-not-Scan mandate is asserted against a FAKE DocumentClient
// (every command the repo sends is captured and inspected); everything else
// runs on the shared in-memory world fakes.
import type { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { unreadFlagFor } from './helpers/unreadIndexFake.js';
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
    // FLAG IFF COUNT>0, derived centrally (helpers/unreadIndexFake.ts). This
    // suite drives the conversation HUB, not the inbox - but its rows land in
    // the SHARED world.conversations map the inbox/today routers read, so an
    // unflagged unread row here is a trap armed for whoever adds the first
    // unread assertion to this file. Overridable below.
    ...unreadFlagFor(overrides),
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
      participant_display_name: null,
      last_activity_at: '2026-06-12T11:00:00.000Z',
      unread_count: 4,
      sms_opt_out: true,
    });
    // Defaults for sparse attributes:
    expect(res.body.conversations[1]).toMatchObject({
      participants: [],
      preview: null,
      participant_display_name: null,
      unread_count: 0,
      sms_opt_out: false,
    });
    expect(res.body.nextCursor).toBeNull();
  });

  it('surfaces the denormalized participant_display_name when set (else null)', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-named', { participant_display_name: 'Keisha Jones' });

    const res = await request(app).get('/api/conversations').set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const named = res.body.conversations.find(
      (c: { conversationId: string }) => c.conversationId === 'conv-named',
    );
    // The inbox row shows the resolved person, not the raw phone (Cluster D).
    expect(named.participant_display_name).toBe('Keisha Jones');
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
  async function appendExternalCall(
    world: ReturnType<typeof createFakeWorld>,
    providerSid: string,
    contactId?: string,
  ) {
    return world.messagesRepo.append({
      conversationId: 'conv-1',
      providerSid,
      providerTs: '2026-08-28T16:21:16.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'unknown',
      deliveryStatus: 'delivered',
      callStatus: 'no-answer',
      callOutcome: 'missed',
      masked: true,
      relayRefusalReason: 'non_member',
      relayExternalCallerPhone: '+16175550198',
      ...(contactId !== undefined && { relayExternalCallerContactId: contactId }),
    });
  }

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

  it('hydrates a trimmed current display name with one deduplicated batch read', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-1');
    world.contacts.push({ contactId: 'contact-external', type: 'tenant', firstName: ' Morgan ', lastName: ' Lee ' });
    await appendExternalCall(world, 'CAexternal-1', 'contact-external');
    await appendExternalCall(world, 'CAexternal-2', 'contact-external');
    const getDisplaysByIds = vi.spyOn(world.contactsRepo, 'getDisplaysByIds');

    const res = await request(app)
      .get('/api/conversations/conv-1/messages')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(getDisplaysByIds).toHaveBeenCalledTimes(1);
    expect(getDisplaysByIds).toHaveBeenCalledWith(['contact-external']);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages.every((message: { relay_external_caller_display_name?: string }) =>
      message.relay_external_caller_display_name === 'Morgan Lee')).toBe(true);
    expect(world.messages.every((message) => !('relay_external_caller_display_name' in message))).toBe(true);
  });

  it('does not read displays when the current page has no external contact ids', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-1');
    await appendExternalCall(world, 'CAphone-only');
    const getDisplaysByIds = vi.spyOn(world.contactsRepo, 'getDisplaysByIds');

    const res = await request(app)
      .get('/api/conversations/conv-1/messages')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(getDisplaysByIds).not.toHaveBeenCalled();
    expect(res.body.messages[0]).not.toHaveProperty('relay_external_caller_display_name');
  });

  it('omits a display name for a missing display row', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-1');
    await appendExternalCall(world, 'CAmissing', 'contact-missing');

    const res = await request(app)
      .get('/api/conversations/conv-1/messages')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.messages[0]).not.toHaveProperty('relay_external_caller_display_name');
  });

  it('omits a deleted display name and hydrates it again after restore', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-1');
    world.contacts.push({
      contactId: 'contact-external',
      type: 'tenant',
      firstName: 'Morgan',
      lastName: 'Lee',
      deleted_at: '2026-08-28T16:21:16.000Z',
    });
    await appendExternalCall(world, 'CAdeleted', 'contact-external');

    const deleted = await request(app)
      .get('/api/conversations/conv-1/messages')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(deleted.status).toBe(200);
    expect(deleted.body.messages[0]).not.toHaveProperty('relay_external_caller_display_name');

    await world.contactsRepo.restore('contact-external');
    const restored = await request(app)
      .get('/api/conversations/conv-1/messages')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(restored.status).toBe(200);
    expect(restored.body.messages[0]).toMatchObject({ relay_external_caller_display_name: 'Morgan Lee' });
  });

  it('returns the unhydrated page when the optional display batch read fails', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-1');
    world.contacts.push({ contactId: 'contact-external', type: 'tenant', firstName: 'Morgan' });
    await appendExternalCall(world, 'CAbatch-failure', 'contact-external');
    vi.spyOn(world.contactsRepo, 'getDisplaysByIds').mockRejectedValueOnce(new Error('contacts unavailable'));

    const res = await request(app)
      .get('/api/conversations/conv-1/messages')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0]).not.toHaveProperty('relay_external_caller_display_name');
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
    // payload shape as every other conversation.updated (incl. the M1.4
    // type wire field).
    expect(world.emitted).toEqual([
      {
        event: 'conversation.updated',
        payload: {
          conversationId: 'conv-1',
          last_activity_at: '2026-06-12T10:00:00.000Z',
          unread_count: 0,
          preview: 'seen now',
          type: 'tenant_1to1',
          participant_display_name: null,
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

describe('GET /api/conversations/:conversationId/group-members', () => {
  async function seedGroup(world: ReturnType<typeof createFakeWorld>) {
    await world.conversationsRepo.createGroupTextThread({
      conversationId: 'gt-1',
      members: [
        { contactId: 'c-ann', phone: '+14045550111', name: 'Ann Tenant' },
        { contactId: 'c-marcus', phone: '+14045550112', name: 'Marcus Landlord' },
      ],
      lastActivityAt: '2026-06-12T10:00:00.000Z',
    });
  }
  const get = (app: Parameters<typeof request>[0], id: string) =>
    request(app)
      .get(`/api/conversations/${id}/group-members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

  it('returns the roster with per-member suppression, preferring the CONTACT name', async () => {
    const { app, world } = makeWebhookHarness();
    await seedGroup(world);
    world.contacts.push({
      contactId: 'c-ann',
      type: 'tenant',
      firstName: 'Annabel',
      lastName: 'Tenant',
      phone: '+14045550111',
      created_at: '2026-06-01T00:00:00.000Z',
    });

    const res = await get(app, 'gt-1');

    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([
      {
        contactId: 'c-ann',
        phone: '+14045550111',
        // The contact record is fresher than the roster snapshot taken at
        // creation, so a renamed contact renders under its current name.
        name: 'Annabel Tenant',
        suppressed: false,
        suppressionScope: 'primary',
      },
      {
        contactId: 'c-marcus',
        phone: '+14045550112',
        name: 'Marcus Landlord',
        suppressed: false,
        suppressionScope: 'no_contact',
      },
    ]);
  });

  it('reports a PRIMARY-number opt-out from the contact flag', async () => {
    const { app, world } = makeWebhookHarness();
    await seedGroup(world);
    world.contacts.push({
      contactId: 'c-ann',
      type: 'tenant',
      firstName: 'Ann',
      lastName: 'Tenant',
      phone: '+14045550111',
      sms_opt_out: true,
      created_at: '2026-06-01T00:00:00.000Z',
    });

    const res = await get(app, 'gt-1');

    expect(res.body.members[0]).toMatchObject({
      suppressed: true,
      suppressionScope: 'primary',
    });
  });

  it('reports a SECONDARY number from that number OWN 1:1 thread, never the contact flag', async () => {
    // The number-scoped rule: the contact is NOT opted out, but this second
    // number of theirs is. Reading the contact flag alone would miss it; reading
    // it as the contact opting out would libel them.
    const { app, world } = makeWebhookHarness();
    await seedGroup(world);
    world.contacts.push({
      contactId: 'c-ann',
      type: 'tenant',
      firstName: 'Ann',
      lastName: 'Tenant',
      phone: '+14045550100',
      created_at: '2026-06-01T00:00:00.000Z',
    });
    // The second number resolves through its phone-pointer item, exactly as a
    // real multi-number contact does.
    await world.contactsRepo.addPhone('c-ann', { phone: '+14045550111' });
    const { conversationId } = await world.conversationsRepo.createOrGetByParticipantPhone(
      '+14045550111',
      'tenant_1to1',
    );
    await world.conversationsRepo.setSmsOptOut(conversationId, true);

    const res = await get(app, 'gt-1');

    expect(res.body.members[0]).toMatchObject({
      suppressed: true,
      suppressionScope: 'secondary',
    });
  });

  it('flags a soft-deleted member', async () => {
    const { app, world } = makeWebhookHarness();
    await seedGroup(world);
    world.contacts.push({
      contactId: 'c-ann',
      type: 'tenant',
      firstName: 'Ann',
      lastName: 'Tenant',
      phone: '+14045550111',
      deleted_at: '2026-06-11T00:00:00.000Z',
      created_at: '2026-06-01T00:00:00.000Z',
    });

    const res = await get(app, 'gt-1');

    expect(res.body.members[0]).toMatchObject({ deleted: true });
  });

  it('reports suppression UNKNOWN when the contact read fails, never "not suppressed"', async () => {
    // Group reads are LOUD by contract. A contact whose opt-out came from the
    // manual DNC toggle or from the import carries ONLY the contact flag - no
    // conversation flag to fall back on - so swallowing a findByPhone failure
    // turns an opted-out member into a green light on the exact screen staff
    // use to decide whether to text a group.
    const { app, world } = makeWebhookHarness();
    await seedGroup(world);
    const realFindByPhone = world.contactsRepo.findByPhone.bind(world.contactsRepo);
    world.contactsRepo.findByPhone = (async (phone: string) => {
      if (phone === '+14045550111') throw new Error('DynamoDB unavailable');
      return realFindByPhone(phone);
    }) as typeof world.contactsRepo.findByPhone;

    const res = await get(app, 'gt-1');

    expect(res.status).toBe(200);
    // The roster is NOT blanked - the member is present, and honest.
    expect(res.body.members).toHaveLength(2);
    expect(res.body.members[0]).toMatchObject({
      phone: '+14045550111',
      suppressionUnknown: true,
    });
    // The healthy member says nothing of the sort.
    expect(res.body.members[1].suppressionUnknown).toBeUndefined();
  });

  it('404s for a relay group and for a 1:1 (this surface speaks for group texts only)', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-1');
    const relay = await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550160001',
      members: [{ contactId: 'c-ann', phone: '+14045550111' }],
    });

    const oneToOne = await get(app, 'conv-1');
    expect(oneToOne.status).toBe(404);
    expect(oneToOne.body).toEqual({ error: 'group_text_not_found' });

    const relayRes = await get(app, relay.conversationId);
    expect(relayRes.status).toBe(404);

    const missing = await get(app, 'nope');
    expect(missing.status).toBe(404);
  });
});
