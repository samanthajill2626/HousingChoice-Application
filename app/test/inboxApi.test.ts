// Task 1 (Contract C8) API tests: GET /api/inbox — the contact-aggregated inbox
// feed behind the /api auth gate (origin-verify + session cookie). Runs on the
// shared in-memory world fakes (makeWebhookHarness) — seed conversations /
// contacts / messages directly, then assert the C8 wire shape end-to-end through
// the real Express router (no mocked handlers).
//
// SCOPE: the GET side only (the read/assign mutations are Task 2). Cursor
// MULTI-PAGE paging is covered by the aggregator unit tests (inboxFeed.test.ts)
// against a fake that surfaces a LastEvaluatedKey; the world fake here returns a
// single unpaged batch, so nextCursor is null — that's the shape asserted below.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE, TEST_SESSION_USER } from './helpers/authSession.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
} from './helpers/twilioWebhookHarness.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { buildTsMsgId } from '../src/repos/messagesRepo.js';

const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

type World = ReturnType<typeof createFakeWorld>;

function seedConversation(
  world: World,
  id: string,
  overrides: Partial<ConversationItem> & { participant_phone: string; last_activity_at: string },
): ConversationItem {
  const item: ConversationItem = {
    conversationId: id,
    status: 'open',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: overrides.last_activity_at,
    ...overrides,
  };
  world.conversations.set(id, item);
  return item;
}

function seedContact(world: World, contact: ContactItem): ContactItem {
  world.contacts.push(contact);
  return contact;
}

/** Push a latest message onto a conversation so channel/direction derive. */
function seedMessage(
  world: World,
  conversationId: string,
  msg: Partial<MessageItem> & { type: MessageItem['type']; direction: MessageItem['direction'] },
): void {
  const providerTs = msg.provider_ts ?? new Date().toISOString();
  const providerSid = msg.provider_sid ?? `SMseed-${world.messages.length + 1}`;
  world.messages.push({
    conversationId,
    tsMsgId: buildTsMsgId(providerTs, providerSid),
    author: 'tenant',
    provider_sid: providerSid,
    provider_ts: providerTs,
    delivery_status: 'delivered',
    created_at: providerTs,
    ...msg,
  } as MessageItem);
}

describe('GET /api/inbox (C8)', () => {
  it('401 without a session cookie', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app).get('/api/inbox').set('x-origin-verify', ORIGIN_SECRET);
    expect(res.status).toBe(401);
  });

  it('403 without the origin-verify header', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app).get('/api/inbox').set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(403);
  });

  it('returns InboxPage with one row per contact, newest-first', async () => {
    const { app, world } = makeWebhookHarness();
    // A contact with TWO numbers → ONE row; unread sums across both numbers.
    // Add the second number via the repo so its phone-pointer item exists (the
    // byPhone resolution path a non-primary number actually relies on), exactly
    // as production multi-number contacts are built.
    seedContact(world, {
      contactId: 'c-tenant',
      type: 'tenant',
      firstName: 'Dana',
      lastName: 'Doe',
      phone: '+15550000001',
      created_at: '2026-06-01T00:00:00.000Z',
    });
    await world.contactsRepo.addPhone('c-tenant', { phone: '+15550000002' });
    seedContact(world, { contactId: 'c-landlord', type: 'landlord', firstName: 'Lee', lastName: 'Lord', phone: '+15550000003' });
    seedConversation(world, 'conv-tenant-a', { participant_phone: '+15550000001', last_activity_at: '2026-06-10T10:00:00.000Z', unread_count: 2 });
    seedConversation(world, 'conv-tenant-b', { participant_phone: '+15550000002', last_activity_at: '2026-06-13T10:00:00.000Z', unread_count: 3 });
    seedConversation(world, 'conv-landlord', { participant_phone: '+15550000003', last_activity_at: '2026-06-14T10:00:00.000Z', type: 'landlord_1to1' });
    seedMessage(world, 'conv-tenant-b', { type: 'sms', direction: 'inbound', body: 'newest tenant text' });
    seedMessage(world, 'conv-landlord', { type: 'mms', direction: 'outbound', body: 'flyer attached', mediaUrls: ['http://x/1.jpg'] });

    const res = await auth(request(app).get('/api/inbox'));

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows).toHaveLength(2);
    // Newest-activity-first: the landlord (T14) before the tenant (T13).
    expect(res.body.rows.map((r: { contactId: string }) => r.contactId)).toEqual([
      'c-landlord',
      'c-tenant',
    ]);

    const tenant = res.body.rows.find((r: { contactId: string }) => r.contactId === 'c-tenant');
    expect(tenant).toMatchObject({
      kind: 'contact',
      contactId: 'c-tenant',
      name: 'Dana Doe',
      role: 'tenant',
      unreadCount: 5, // 2 + 3 across the two numbers
      channel: 'sms',
      direction: 'inbound',
      preview: 'newest tenant text',
      lastActivityAt: '2026-06-13T10:00:00.000Z',
      needsTriage: false,
    });

    const landlord = res.body.rows.find((r: { contactId: string }) => r.contactId === 'c-landlord');
    expect(landlord).toMatchObject({
      kind: 'contact',
      role: 'landlord',
      channel: 'mms',
      direction: 'outbound',
    });
    // Exactly the C8 keys — no stray/renamed fields.
    expect(Object.keys(tenant).sort()).toEqual(
      ['channel', 'contactId', 'direction', 'kind', 'lastActivityAt', 'name', 'needsTriage', 'phone', 'preview', 'role', 'unreadCount'].sort(),
    );
  });

  it('an unknown number (no contact) → kind:unknown, needsTriage, formatted-number name', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-unk', {
      participant_phone: '+14049824978',
      last_activity_at: '2026-06-12T10:00:00.000Z',
      type: 'unknown_1to1',
      unread_count: 1,
    });

    const res = await auth(request(app).get('/api/inbox'));
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      kind: 'unknown',
      needsTriage: true,
      role: 'unknown',
      phone: '+14049824978',
      name: '(404) 982-4978',
    });
    expect(res.body.rows[0].contactId).toBeUndefined();
  });

  it('filter=unread only unread; filter=unknown only needsTriage; filter=mine only the session user', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-read', type: 'tenant', phone: '+15550000001' });
    seedContact(world, { contactId: 'c-unread', type: 'tenant', phone: '+15550000002' });
    seedContact(world, { contactId: 'c-mine', type: 'tenant', phone: '+15550000003' });
    seedConversation(world, 'conv-read', { participant_phone: '+15550000001', last_activity_at: '2026-06-10T10:00:00.000Z', unread_count: 0 });
    seedConversation(world, 'conv-unread', { participant_phone: '+15550000002', last_activity_at: '2026-06-11T10:00:00.000Z', unread_count: 4 });
    seedConversation(world, 'conv-mine', { participant_phone: '+15550000003', last_activity_at: '2026-06-12T10:00:00.000Z', assignment: TEST_SESSION_USER.userId });
    seedConversation(world, 'conv-unk', { participant_phone: '+14049824978', last_activity_at: '2026-06-09T10:00:00.000Z', type: 'unknown_1to1', unread_count: 1 });

    const unread = await auth(request(app).get('/api/inbox?filter=unread'));
    expect(unread.status).toBe(200);
    expect(unread.body.rows.every((r: { unreadCount: number }) => r.unreadCount > 0)).toBe(true);
    expect(
      unread.body.rows.map((r: { contactId?: string; phone?: string }) => r.contactId ?? r.phone).sort(),
    ).toEqual(['+14049824978', 'c-unread'].sort());

    const unknown = await auth(request(app).get('/api/inbox?filter=unknown'));
    expect(unknown.status).toBe(200);
    expect(unknown.body.rows.every((r: { needsTriage: boolean }) => r.needsTriage)).toBe(true);
    expect(unknown.body.rows.map((r: { phone: string }) => r.phone)).toEqual(['+14049824978']);

    const mine = await auth(request(app).get('/api/inbox?filter=mine'));
    expect(mine.status).toBe(200);
    expect(mine.body.rows.map((r: { contactId: string }) => r.contactId)).toEqual(['c-mine']);
    expect(mine.body.rows[0].assignment).toEqual({
      userId: TEST_SESSION_USER.userId,
      name: TEST_SESSION_USER.email, // the fake users repo has no name → email
    });
  });

  it('caseContext is surfaced when the representative conversation has a caseId', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', phone: '+15550000001' });
    seedConversation(world, 'conv-1', { participant_phone: '+15550000001', last_activity_at: '2026-06-12T10:00:00.000Z', caseId: 'case-1' });
    world.cases.set('case-1', {
      caseId: 'case-1',
      tenantId: 'c-1',
      unitId: 'unit-1',
      stage: 'touring',
    });

    const res = await auth(request(app).get('/api/inbox'));
    expect(res.status).toBe(200);
    expect(res.body.rows[0].caseContext).toEqual({ caseId: 'case-1', label: 'Touring' });
  });

  it('400 on an invalid filter value (NOT 500)', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(request(app).get('/api/inbox?filter=bogus'));
    expect(res.status).toBe(400);
  });

  it('400 on a malformed cursor (NOT 500)', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(request(app).get('/api/inbox?cursor=not-base64-json!!!'));
    expect(res.status).toBe(400);
  });
});
