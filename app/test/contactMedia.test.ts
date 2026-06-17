// BE5/C5 route tests — GET /api/contacts/:contactId/media → { media: ContactMediaItem[] }.
// Runs on the shared in-memory world (the harness fakes), authed via the real
// sealed session cookie next to the origin secret. Covers:
//   - media aggregated across TWO of the contact's numbers, newest-first;
//   - a relay_group thread's media is NOT included (PII / pool number);
//   - a message with MULTIPLE attachments yields multiple items;
//   - legacy `media_s3_keys`-only messages are included (via mediaAttachmentsOf);
//   - 404 unknown contact + 404 a phone-pointer id;
//   - { media: [] } for a contact with no media.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { phoneRefId } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationType } from '../src/repos/conversationsRepo.js';
import type { MediaAttachment } from '../src/repos/messagesRepo.js';

const TENANT = 'c-tenant';
const PHONE_A = '+15550100001';
const PHONE_B = '+15550100002';

describe('GET /api/contacts/:id/media (BE5/C5)', () => {
  let app: Express;
  let world: FakeWorld;

  beforeEach(() => {
    const h = makeWebhookHarness();
    app = h.app;
    world = h.world;
  });

  const authedGet = (path: string) =>
    request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

  function seedContact(): void {
    world.contacts.push({
      contactId: TENANT,
      type: 'tenant',
      status: 'active',
      phone: PHONE_A,
      phones: [
        { phone: PHONE_A, primary: true },
        { phone: PHONE_B, primary: false, label: 'work' },
      ],
    });
  }

  function seedConversation(
    conversationId: string,
    participantPhone: string,
    type: ConversationType = 'tenant_1to1',
  ): void {
    const now = new Date().toISOString();
    const conv: ConversationItem = {
      conversationId,
      participant_phone: participantPhone,
      status: 'open',
      last_activity_at: now,
      type,
      ai_mode: 'auto',
      created_at: now,
    };
    world.conversations.set(conversationId, conv);
  }

  /** Append an mms message carrying media_attachments (the modern shape). */
  async function seedMediaMessage(
    conversationId: string,
    providerTs: string,
    providerSid: string,
    attachments: MediaAttachment[],
  ): Promise<void> {
    await world.messagesRepo.append({
      conversationId,
      providerSid,
      providerTs,
      type: 'mms',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
    });
    // media_attachments is a post-append annotation (mirrors the webhook path).
    await world.messagesRepo.annotateMessage(
      conversationId,
      `${providerTs}#${providerSid}`,
      { mediaAttachments: attachments },
    );
  }

  it('404s an unknown contact', async () => {
    const res = await authedGet('/api/contacts/nope/media');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('contact_not_found');
  });

  it('404s a phone-pointer id (internal routing record, never a contact)', async () => {
    seedContact();
    // The fake stores a pointer entry in `contacts` for a non-primary number.
    const pointerId = phoneRefId(PHONE_B);
    world.contacts.push({
      contactId: pointerId,
      type: 'unknown',
      phone: PHONE_B,
      phone_ref: true,
      phone_ref_owner: TENANT,
    } as never);
    const res = await authedGet(`/api/contacts/${encodeURIComponent(pointerId)}/media`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('contact_not_found');
  });

  it('returns { media: [] } for a contact with no media', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    // A text-only message (no media) must not produce a media item.
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'SM-text',
      providerTs: '2026-06-16T10:00:00.000Z',
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      body: 'no media here',
    });
    const res = await authedGet('/api/contacts/c-tenant/media');
    expect(res.status).toBe(200);
    expect(res.body.media).toEqual([]);
  });

  it('aggregates media across TWO of the contact numbers, newest-first', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    seedConversation('conv-b', PHONE_B);
    await seedMediaMessage('conv-a', '2026-06-16T10:00:00.000Z', 'MM-a1', [
      { s3Key: 'media/a1.jpg', contentType: 'image/jpeg' },
    ]);
    await seedMediaMessage('conv-b', '2026-06-16T11:00:00.000Z', 'MM-b1', [
      { s3Key: 'media/b1.png', contentType: 'image/png' },
    ]);
    await seedMediaMessage('conv-a', '2026-06-16T13:00:00.000Z', 'MM-a2', [
      { s3Key: 'media/a2.gif', contentType: 'image/gif' },
    ]);

    const res = await authedGet('/api/contacts/c-tenant/media');
    expect(res.status).toBe(200);
    expect(res.body.media).toEqual([
      { s3Key: 'media/a2.gif', contentType: 'image/gif', at: '2026-06-16T13:00:00.000Z', conversationId: 'conv-a' },
      { s3Key: 'media/b1.png', contentType: 'image/png', at: '2026-06-16T11:00:00.000Z', conversationId: 'conv-b' },
      { s3Key: 'media/a1.jpg', contentType: 'image/jpeg', at: '2026-06-16T10:00:00.000Z', conversationId: 'conv-a' },
    ]);
  });

  it('a message with MULTIPLE attachments yields multiple items', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await seedMediaMessage('conv-a', '2026-06-16T10:00:00.000Z', 'MM-multi', [
      { s3Key: 'media/one.jpg', contentType: 'image/jpeg' },
      { s3Key: 'media/two.jpg', contentType: 'image/jpeg' },
      { s3Key: 'media/three.png', contentType: 'image/png' },
    ]);
    const res = await authedGet('/api/contacts/c-tenant/media');
    expect(res.status).toBe(200);
    expect(res.body.media).toHaveLength(3);
    expect(res.body.media.map((m: { s3Key: string }) => m.s3Key).sort()).toEqual([
      'media/one.jpg',
      'media/three.png',
      'media/two.jpg',
    ]);
    // All carry the same at + conversationId from the source message.
    for (const item of res.body.media) {
      expect(item.at).toBe('2026-06-16T10:00:00.000Z');
      expect(item.conversationId).toBe('conv-a');
    }
  });

  it('includes legacy media_s3_keys-only messages (via mediaAttachmentsOf)', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    // Append a message, then poke a legacy media_s3_keys array onto the stored
    // item (pre-media_attachments data). mediaAttachmentsOf folds it to
    // application/octet-stream.
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'MM-legacy',
      providerTs: '2026-06-16T10:00:00.000Z',
      type: 'mms',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
    });
    const stored = world.messages.find((m) => m.provider_sid === 'MM-legacy')!;
    stored.media_s3_keys = ['legacy/old.bin'];

    const res = await authedGet('/api/contacts/c-tenant/media');
    expect(res.status).toBe(200);
    expect(res.body.media).toEqual([
      {
        s3Key: 'legacy/old.bin',
        contentType: 'application/octet-stream',
        at: '2026-06-16T10:00:00.000Z',
        conversationId: 'conv-a',
      },
    ]);
  });

  it('excludes media on a relay_group thread (pool number, never the contact 1:1)', async () => {
    seedContact();
    // A relay_group thread fronted by a pool number that happens to also be one
    // of the contact's numbers — it must STILL be excluded purely on type.
    seedConversation('conv-relay', PHONE_A, 'relay_group');
    await seedMediaMessage('conv-relay', '2026-06-16T10:00:00.000Z', 'MM-relay', [
      { s3Key: 'media/group.jpg', contentType: 'image/jpeg' },
    ]);
    const res = await authedGet('/api/contacts/c-tenant/media');
    expect(res.status).toBe(200);
    expect(res.body.media).toEqual([]);
  });
});
