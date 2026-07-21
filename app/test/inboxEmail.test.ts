// Email channel v1 (A4) - inbox reader fixes (plan F2/F3 BLOCKERS + ADJ-1a/1b).
// Runs on the shared in-memory world (makeWebhookHarness) through the REAL
// Express inbox router, exactly like inboxApi.test.ts. Asserts:
//   - an email-only contact (no phones, one email + one email thread) folds into
//     ONE contact row, channel 'email', NOT a phantom unknown/needsTriage row;
//   - a phoneless conversation that resolves to NO contact renders NO row
//     (spec Decision 4 - email unknowns never enter the general inbox);
//   - a mixed phone+email contact gets ONE row whose unread SUMS both threads;
//   - POST /:contactId/read zeroes unread on the contact's EMAIL thread too.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { buildTsMsgId } from '../src/repos/messagesRepo.js';

const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

type World = ReturnType<typeof createFakeWorld>;

function seedConv(
  world: World,
  id: string,
  overrides: Partial<ConversationItem> & { last_activity_at: string },
): ConversationItem {
  const item: ConversationItem = {
    conversationId: id,
    status: 'open',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: overrides.last_activity_at,
    ...overrides,
  } as ConversationItem;
  world.conversations.set(id, item);
  return item;
}

function seedContact(world: World, contact: ContactItem): ContactItem {
  world.contacts.push(contact);
  return contact;
}

function seedMessage(
  world: World,
  conversationId: string,
  msg: Partial<MessageItem> & { type: MessageItem['type']; direction: MessageItem['direction'] },
): void {
  const providerTs = msg.provider_ts ?? new Date().toISOString();
  const providerSid = msg.provider_sid ?? `seed-${world.messages.length + 1}`;
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

describe('GET /api/inbox - email reader fixes (F2/F3)', () => {
  it('an email-only contact folds into ONE contact row, channel email, NOT unknown/needsTriage', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-email',
      type: 'tenant',
      firstName: 'Tasha',
      lastName: 'Nguyen',
      email: 'tasha@example.com',
      emails: [{ email: 'tasha@example.com', primary: true }],
    });
    seedConv(world, 'conv-email', {
      participant_email: 'tasha@example.com',
      last_activity_at: '2026-07-10T10:00:00.000Z',
      unread_count: 2,
    });
    seedMessage(world, 'conv-email', {
      type: 'email',
      direction: 'inbound',
      subject: 'Re: Your unit',
      body: 'Is it still available?',
      provider_ts: '2026-07-10T10:00:00.000Z',
    });

    const res = await auth(request(app).get('/api/inbox'));
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      kind: 'contact',
      contactId: 'c-email',
      name: 'Tasha Nguyen',
      role: 'tenant',
      channel: 'email',
      needsTriage: false,
      unreadCount: 2,
    });
  });

  it('a phoneless conversation that resolves to NO contact renders NO row (Decision 4)', async () => {
    const { app, world } = makeWebhookHarness();
    // An email thread with no matching contact (unknown sender). It must NOT
    // surface as a phantom unknown-triage row - email unknowns live only in the
    // unmatched surface.
    seedConv(world, 'conv-orphan', {
      participant_email: 'stranger@example.com',
      type: 'unknown_1to1',
      last_activity_at: '2026-07-10T10:00:00.000Z',
      unread_count: 1,
    });

    const res = await auth(request(app).get('/api/inbox'));
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(0);
  });

  it('a mixed phone+email contact gets ONE row; unread SUMS across both threads (ADJ-1a)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-mixed',
      type: 'landlord',
      firstName: 'Marcus',
      lastName: 'Bell',
      phone: '+15550000301',
      phones: [{ phone: '+15550000301', primary: true }],
      email: 'marcus@example.com',
      emails: [{ email: 'marcus@example.com', primary: true }],
    });
    seedConv(world, 'conv-phone', {
      participant_phone: '+15550000301',
      type: 'landlord_1to1',
      last_activity_at: '2026-07-09T10:00:00.000Z',
      unread_count: 1,
    });
    seedConv(world, 'conv-mail', {
      participant_email: 'marcus@example.com',
      type: 'landlord_1to1',
      last_activity_at: '2026-07-11T10:00:00.000Z',
      unread_count: 4,
    });

    const res = await auth(request(app).get('/api/inbox'));
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      kind: 'contact',
      contactId: 'c-mixed',
      unreadCount: 5, // 1 (phone) + 4 (email)
      lastActivityAt: '2026-07-11T10:00:00.000Z', // the email thread is newest
    });
  });
});

describe('POST /api/inbox/:contactId/read - email threads (ADJ-1b)', () => {
  it('zeroes unread on the contact\'s EMAIL thread too', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-mr',
      type: 'tenant',
      email: 'reader@example.com',
      emails: [{ email: 'reader@example.com', primary: true }],
    });
    seedConv(world, 'conv-mr-email', {
      participant_email: 'reader@example.com',
      last_activity_at: '2026-07-10T10:00:00.000Z',
      unread_count: 3,
    });

    const res = await auth(request(app).post('/api/inbox/c-mr/read'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.conversations.get('conv-mr-email')?.unread_count).toBe(0);
  });
});
