// Email channel v1 (A4) - contact-timeline + contacts.ts reader fixes
// (invariant rule + ADJ-1c/1d/1e). Through the REAL Express routes on the shared
// in-memory world (makeWebhookHarness), asserting an email-only thread is folded
// in everywhere a phone thread would be:
//   - contact timeline: the email message appears with type 'email' + subject
//     (and NO fromPhone/toPhone);
//   - GET /:id/media: an email attachment surfaces in the Media panel (ADJ-1c);
//   - PATCH /:id triage: an email thread's type flips on re-type (ADJ-1d);
//   - DELETE /:id: conversation.updated fans out for the email thread (ADJ-1e).
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import type { ConversationItem, ConversationType } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';

let app: ReturnType<typeof makeWebhookHarness>['app'];
let world: FakeWorld;

const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

function seedContact(contact: ContactItem): void {
  world.contacts.push(contact);
}

function seedEmailConv(
  conversationId: string,
  email: string,
  opts: { type?: ConversationType; unread?: number } = {},
): void {
  const now = new Date().toISOString();
  const conv: ConversationItem = {
    conversationId,
    participant_email: email,
    status: 'open',
    last_activity_at: now,
    type: opts.type ?? 'tenant_1to1',
    ai_mode: 'auto',
    created_at: now,
    ...(opts.unread !== undefined && { unread_count: opts.unread }),
  };
  world.conversations.set(conversationId, conv);
}

beforeEach(() => {
  const h = makeWebhookHarness();
  app = h.app;
  world = h.world;
});

describe('contact timeline - email-only thread (invariant rule)', () => {
  it('shows the email message with type "email" + subject and no phones', async () => {
    seedContact({
      contactId: 'c-t',
      type: 'tenant',
      firstName: 'Tasha',
      lastName: 'Nguyen',
      email: 'tasha@example.com',
      emails: [{ email: 'tasha@example.com', primary: true }],
    });
    seedEmailConv('conv-t', 'tasha@example.com');
    await world.messagesRepo.append({
      conversationId: 'conv-t',
      providerSid: '<in-1@sender.example.com>',
      providerTs: '2026-07-12T10:00:00.000Z',
      type: 'email',
      direction: 'inbound',
      author: 'tenant',
      subject: 'Is the unit still available?',
      body: 'Hi, is it still open?',
      email_from: 'tasha@example.com',
      email_to: ['team@mail.local.test'],
      deliveryStatus: 'delivered',
    });

    const res = await auth(request(app).get('/api/contacts/c-t/timeline'));
    expect(res.status).toBe(200);
    const emailItems = (res.body.items as Array<Record<string, unknown>>).filter(
      (i) => i.kind === 'message' && i.type === 'email',
    );
    expect(emailItems).toHaveLength(1);
    expect(emailItems[0]).toMatchObject({
      type: 'email',
      subject: 'Is the unit still available?',
      body: 'Hi, is it still open?',
      email_from: 'tasha@example.com',
    });
    // Email items carry no phones.
    expect(emailItems[0]!.fromPhone).toBeUndefined();
    expect(emailItems[0]!.toPhone).toBeUndefined();
  });
});

describe('GET /:contactId/media - email attachments (ADJ-1c)', () => {
  it('surfaces an inbound email attachment in the Media panel', async () => {
    seedContact({
      contactId: 'c-m',
      type: 'landlord',
      email: 'marcus@example.com',
      emails: [{ email: 'marcus@example.com', primary: true }],
    });
    seedEmailConv('conv-m', 'marcus@example.com', { type: 'landlord_1to1' });
    await world.messagesRepo.append({
      conversationId: 'conv-m',
      providerSid: '<in-doc@sender.example.com>',
      providerTs: '2026-07-12T10:00:00.000Z',
      type: 'email',
      direction: 'inbound',
      author: 'landlord',
      subject: 'Lease attached',
      deliveryStatus: 'delivered',
      mediaAttachments: [{ s3Key: 'media/conv-m/doc0', contentType: 'application/pdf' }],
    });

    const res = await auth(request(app).get('/api/contacts/c-m/media'));
    expect(res.status).toBe(200);
    expect(res.body.media).toHaveLength(1);
    expect(res.body.media[0]).toMatchObject({
      s3Key: 'media/conv-m/doc0',
      contentType: 'application/pdf',
      conversationId: 'conv-m',
    });
  });
});

describe('PATCH /:contactId triage propagation - email thread (ADJ-1d)', () => {
  it('flips an email thread from unknown_1to1 to the resolved type on re-type', async () => {
    seedContact({
      contactId: 'c-x',
      type: 'unknown',
      email: 'mystery@example.com',
      emails: [{ email: 'mystery@example.com', primary: true }],
    });
    seedEmailConv('conv-x', 'mystery@example.com', { type: 'unknown_1to1' });

    const res = await auth(request(app).patch('/api/contacts/c-x').send({ type: 'tenant' }));
    expect(res.status).toBe(200);
    // The email thread's type was propagated (unknown_1to1 -> tenant_1to1).
    expect(world.conversations.get('conv-x')?.type).toBe('tenant_1to1');
  });
});

describe('DELETE /:contactId presence fan-out - email thread (ADJ-1e)', () => {
  it('emits conversation.updated for the contact\'s email thread', async () => {
    seedContact({
      contactId: 'c-d',
      type: 'tenant',
      email: 'depart@example.com',
      emails: [{ email: 'depart@example.com', primary: true }],
    });
    seedEmailConv('conv-d', 'depart@example.com');

    const before = world.emitted.length;
    const res = await auth(request(app).delete('/api/contacts/c-d'));
    expect(res.status).toBe(200);
    const emittedIds = world.emitted
      .slice(before)
      .filter((e) => e.event === 'conversation.updated')
      .map((e) => (e.payload as { conversationId: string }).conversationId);
    expect(emittedIds).toContain('conv-d');
  });
});
