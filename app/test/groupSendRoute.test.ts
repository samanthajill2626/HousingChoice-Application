// T5.4: POST /api/conversations/:id/messages gains a group_text branch.
//
// Before S5 this route fell through to the 1:1 wrapper and 409'd
// `group_text_not_supported` (S4's own typed refusal), which is what the
// composer had no way to explain. Now it routes to the group send service - and
// the two OTHER branches must be provably untouched, because relay and 1:1 are
// the shipped product.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import type { GroupSendInput } from '../src/services/groupSend.js';
import {
  GroupMemberDeletedError,
  GroupMemberNoConsentError,
  GroupRailUnavailableError,
  GroupTooManyMembersError,
} from '../src/services/groupSend.js';
import { SmsSendingDisabledError } from '../src/services/sendMessage.js';
import type { SendMessageInput } from '../src/services/sendMessage.js';
import { makeFakeUsersRepo, testUserItem, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';

const SECRET = 'test-origin-secret';

const GROUP: ConversationItem = {
  conversationId: 'group-1',
  type: 'group_text',
  status: 'group_open',
  ai_mode: 'auto',
  created_at: '2026-08-01T00:00:00.000Z',
  last_activity_at: '2026-08-10T00:00:00.000Z',
  participants: [
    { contactId: 'contact-ann', phone: '+16175550111', name: 'Ann' },
    { contactId: 'contact-marcus', phone: '+16175550222', name: 'Marcus' },
  ],
};

const ONE_TO_ONE: ConversationItem = {
  conversationId: 'conv-1',
  type: 'tenant_1to1',
  participant_phone: '+15550100001',
  status: 'open',
  ai_mode: 'auto',
  created_at: '2026-08-01T00:00:00.000Z',
  last_activity_at: '2026-08-10T00:00:00.000Z',
};

function makeApp(opts: { conversation?: ConversationItem; behavior?: () => never } = {}) {
  const groupCalls: GroupSendInput[] = [];
  const oneToOneCalls: SendMessageInput[] = [];
  const conversation = opts.conversation ?? GROUP;
  const app = buildApp({
    config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }),
    logger: createLogger({ destination: createLogCapture().stream }),
    auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
    api: {
      conversationsRepo: {
        async getById(id: string) {
          return id === conversation.conversationId ? conversation : undefined;
        },
      } as unknown as ConversationsRepo,
      sendMessageService: async (input) => {
        oneToOneCalls.push(input);
        return {
          conversationId: input.conversationId,
          providerSid: 'SMfake-1',
          tsMsgId: '2026-06-12T10:00:00.000Z#SMfake-1',
          status: 'queued',
        };
      },
      groupSendService: async (input) => {
        groupCalls.push(input);
        opts.behavior?.();
        return {
          conversationId: input.conversationId,
          providerSid: 'IMfake-1',
          tsMsgId: '2026-08-11T13:00:00.500Z#IMfake-1',
          status: 'queued',
        };
      },
    },
  });
  return { app, groupCalls, oneToOneCalls };
}

function post(app: ReturnType<typeof makeApp>['app'], id: string, payload: object) {
  return request(app)
    .post(`/api/conversations/${id}/messages`)
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(payload);
}

describe('POST /api/conversations/:id/messages - the group_text branch', () => {
  it('routes a group thread to the group send service and 201s with the outcome', async () => {
    const { app, groupCalls, oneToOneCalls } = makeApp();
    const res = await post(app, 'group-1', { body: 'on my way' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      conversationId: 'group-1',
      providerSid: 'IMfake-1',
      tsMsgId: '2026-08-11T13:00:00.500Z#IMfake-1',
      status: 'queued',
    });
    expect(groupCalls).toEqual([
      { conversationId: 'group-1', body: 'on my way', actorUserId: testUserItem().userId },
    ]);
    // The 1:1 wrapper is never reached - which is the whole point: it would
    // have texted a participant_phone the thread does not have.
    expect(oneToOneCalls).toEqual([]);
  });

  it('no longer answers group_text_not_supported (S4 shipped that 409; S5 replaces it)', async () => {
    const { app } = makeApp();
    const res = await post(app, 'group-1', { body: 'hi' });
    expect(res.body.error).toBeUndefined();
    expect(res.status).not.toBe(409);
  });

  it('maps every group refusal onto its status code', async () => {
    const cases = [
      { err: new GroupTooManyMembersError('group-1', 10), code: 'group_too_many_members', status: 409 },
      { err: new GroupMemberDeletedError('group-1', 'Marcus'), code: 'group_member_deleted', status: 409 },
      { err: new GroupMemberNoConsentError('group-1', 'Marcus'), code: 'group_member_no_consent', status: 409 },
      { err: new GroupRailUnavailableError('group-1', 'no rail'), code: 'group_rail_unavailable', status: 409 },
      // The adapter kill switch, translated by the service into the family the
      // route maps - otherwise this would have been an untyped 500.
      { err: new SmsSendingDisabledError(), code: 'sms_sending_disabled', status: 503 },
    ];
    for (const { err, code, status } of cases) {
      const { app } = makeApp({
        behavior: () => {
          throw err;
        },
      });
      const res = await post(app, 'group-1', { body: 'hi' });
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: code });
    }
  });

  it('refuses outbound group MEDIA rather than dropping the attachments silently (text only in v1)', async () => {
    const { app, groupCalls } = makeApp();
    const res = await post(app, 'group-1', {
      body: 'here you go',
      mediaUrls: ['https://example.test/a.jpg'],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'group_text_media_not_supported' });
    expect(groupCalls).toEqual([]);
  });

  it('refuses a media-ONLY group send (no body) with the same explicit error', async () => {
    const { app, groupCalls } = makeApp();
    const res = await post(app, 'group-1', { mediaUrls: ['https://example.test/a.jpg'] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'group_text_media_not_supported' });
    expect(groupCalls).toEqual([]);
  });

  it('still 400s an empty payload before it reaches any branch', async () => {
    const { app, groupCalls } = makeApp();
    const res = await post(app, 'group-1', {});
    expect(res.status).toBe(400);
    expect(groupCalls).toEqual([]);
  });

  it('stays behind the origin-secret gate', async () => {
    const { app, groupCalls } = makeApp();
    const res = await request(app).post('/api/conversations/group-1/messages').send({ body: 'x' });
    expect(res.status).toBe(403);
    expect(groupCalls).toEqual([]);
  });
});

describe('the OTHER branches are untouched', () => {
  it('a 1:1 thread still goes through the 1:1 send wrapper', async () => {
    const { app, groupCalls, oneToOneCalls } = makeApp({ conversation: ONE_TO_ONE });
    const res = await post(app, 'conv-1', { body: 'hello' });
    expect(res.status).toBe(201);
    expect(oneToOneCalls).toEqual([{ conversationId: 'conv-1', body: 'hello', automated: false }]);
    expect(groupCalls).toEqual([]);
  });

  it('an UNKNOWN conversation still falls through to the 1:1 wrapper, whose service owns the 404', async () => {
    const { app, groupCalls, oneToOneCalls } = makeApp();
    const res = await post(app, 'nope', { body: 'hello' });
    expect(res.status).toBe(201);
    expect(oneToOneCalls).toHaveLength(1);
    expect(groupCalls).toEqual([]);
  });
});
