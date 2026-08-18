// GET /api/contacts/:contactId/media -> { media: ContactMediaItem[], nextCursor? }
// (2026-08-18: index-backed and cursor-paged). Runs on the shared in-memory
// world (the harness fakes, whose media index is DERIVED from the stored
// messages exactly as the real pointer partition is written from them), authed
// via the real sealed session cookie next to the origin secret. Covers:
//   - media aggregated across TWO of the contact's numbers, newest-first, each
//     item ADDRESSED as {providerSid, index} (the serve endpoint's shape);
//   - a relay_group thread's media is NOT included (PII / pool number);
//   - a message with MULTIPLE attachments yields multiple items;
//   - legacy `media_s3_keys`-only messages are included (via mediaAttachmentsOf);
//   - 404 unknown contact + 404 a phone-pointer id;
//   - { media: [] } for a contact with no media;
//   - NO SCAN CAP: an attachment buried under hundreds of later messages is
//     still served (the old shape scanned the newest 200 rows and dropped it),
//     and the page is walked by cursor across conversations.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import type { LogCapture } from './helpers/logCapture.js';
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
  let capture: LogCapture;

  beforeEach(() => {
    const h = makeWebhookHarness();
    app = h.app;
    world = h.world;
    capture = h.capture;
  });

  /** Append N plain text (no-media) messages to a conversation, oldest-first. */
  async function seedTextMessages(conversationId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      // Distinct, monotonically-increasing provider_ts → stable newest-first sort.
      const ts = `2026-06-16T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`;
      await world.messagesRepo.append({
        conversationId,
        providerSid: `SM-bulk-${i}`,
        providerTs: ts,
        type: 'sms',
        direction: 'inbound',
        author: 'tenant',
        deliveryStatus: 'delivered',
        body: `m${i}`,
      });
    }
  }

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
      { providerSid: 'MM-a2', index: 0, contentType: 'image/gif', at: '2026-06-16T13:00:00.000Z', conversationId: 'conv-a' },
      { providerSid: 'MM-b1', index: 0, contentType: 'image/png', at: '2026-06-16T11:00:00.000Z', conversationId: 'conv-b' },
      { providerSid: 'MM-a1', index: 0, contentType: 'image/jpeg', at: '2026-06-16T10:00:00.000Z', conversationId: 'conv-a' },
    ]);
    // Never an S3 key or a provider URL on the wire.
    for (const item of res.body.media) {
      expect(item).not.toHaveProperty('s3Key');
      expect(item).not.toHaveProperty('url');
    }
    expect(res.body.nextCursor).toBeUndefined();
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
    // One item per stored position, addressed by (sid, index) - newest position
    // first within a message is fine; what matters is every position is there.
    expect(res.body.media.map((m: { providerSid: string; index: number }) => `${m.providerSid}:${m.index}`).sort()).toEqual([
      'MM-multi:0',
      'MM-multi:1',
      'MM-multi:2',
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
        providerSid: 'MM-legacy',
        index: 0,
        contentType: 'application/octet-stream',
        at: '2026-06-16T10:00:00.000Z',
        conversationId: 'conv-a',
      },
    ]);
  });

  it('excludes media on a relay_group thread (pool number, never the contact 1:1)', async () => {
    seedContact();
    // A relay_group thread fronted by a pool number that happens to also be the
    // contact's PRIMARY number (PHONE_A) — excluded purely on type.
    seedConversation('conv-relay', PHONE_A, 'relay_group');
    await seedMediaMessage('conv-relay', '2026-06-16T10:00:00.000Z', 'MM-relay', [
      { s3Key: 'media/group.jpg', contentType: 'image/jpeg' },
    ]);
    // And another relay_group fronted by the contact's SECONDARY number
    // (PHONE_B) — relay exclusion must hold across ALL the contact's numbers,
    // not just the primary.
    seedConversation('conv-relay-b', PHONE_B, 'relay_group');
    await seedMediaMessage('conv-relay-b', '2026-06-16T12:00:00.000Z', 'MM-relay-b', [
      { s3Key: 'media/group-b.jpg', contentType: 'image/jpeg' },
    ]);
    const res = await authedGet('/api/contacts/c-tenant/media');
    expect(res.status).toBe(200);
    expect(res.body.media).toEqual([]);
  });

  // THE DEFECT THESE PIN (prod, 2026-08-18: 25 WARNs in 24h, and a gallery
  // that could not show a document once 200 newer messages had arrived). The
  // old route scanned the newest 200 messages of each thread and dropped the
  // rest, WARNing on every long imported thread. The gallery now reads its own
  // index, so a thread's length is irrelevant.
  it('NO SCAN CAP: an attachment buried under 250 later messages is still served, and nothing WARNs', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await seedMediaMessage('conv-a', '2026-06-15T09:00:00.000Z', 'MM-old', [
      { s3Key: 'media/buried.pdf', contentType: 'application/pdf' },
    ]);
    await seedTextMessages('conv-a', 250); // all newer than the attachment

    const res = await authedGet('/api/contacts/c-tenant/media');
    expect(res.status).toBe(200);
    expect(res.body.media).toEqual([
      { providerSid: 'MM-old', index: 0, contentType: 'application/pdf', at: '2026-06-15T09:00:00.000Z', conversationId: 'conv-a' },
    ]);
    expect(capture.atLevel(40).filter((l) => String(l['msg'] ?? '').includes('scan cap'))).toEqual([]);
  });

  it('PAGES by cursor, newest-first, ACROSS the contact conversations, until nextCursor is absent', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    seedConversation('conv-b', PHONE_B);
    // 5 attachments interleaved across the two threads by time.
    await seedMediaMessage('conv-a', '2026-06-16T10:00:00.000Z', 'MM-1', [{ s3Key: 'k1', contentType: 'image/jpeg' }]);
    await seedMediaMessage('conv-b', '2026-06-16T11:00:00.000Z', 'MM-2', [{ s3Key: 'k2', contentType: 'image/jpeg' }]);
    await seedMediaMessage('conv-a', '2026-06-16T12:00:00.000Z', 'MM-3', [{ s3Key: 'k3', contentType: 'image/jpeg' }]);
    await seedMediaMessage('conv-b', '2026-06-16T13:00:00.000Z', 'MM-4', [{ s3Key: 'k4', contentType: 'image/jpeg' }]);
    await seedMediaMessage('conv-a', '2026-06-16T14:00:00.000Z', 'MM-5', [{ s3Key: 'k5', contentType: 'image/jpeg' }]);

    const p1 = await authedGet('/api/contacts/c-tenant/media?limit=2');
    expect(p1.status).toBe(200);
    expect(p1.body.media.map((m: { providerSid: string }) => m.providerSid)).toEqual(['MM-5', 'MM-4']);
    expect(typeof p1.body.nextCursor).toBe('string');

    const p2 = await authedGet(`/api/contacts/c-tenant/media?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.media.map((m: { providerSid: string }) => m.providerSid)).toEqual(['MM-3', 'MM-2']);
    expect(typeof p2.body.nextCursor).toBe('string');

    const p3 = await authedGet(`/api/contacts/c-tenant/media?limit=2&cursor=${encodeURIComponent(p2.body.nextCursor)}`);
    expect(p3.body.media.map((m: { providerSid: string }) => m.providerSid)).toEqual(['MM-1']);
    expect(p3.body.nextCursor).toBeUndefined();
  });

  it('a page that is EXACTLY full carries no nextCursor when nothing older exists', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await seedMediaMessage('conv-a', '2026-06-16T10:00:00.000Z', 'MM-1', [{ s3Key: 'k1', contentType: 'image/jpeg' }]);
    await seedMediaMessage('conv-a', '2026-06-16T11:00:00.000Z', 'MM-2', [{ s3Key: 'k2', contentType: 'image/jpeg' }]);
    const res = await authedGet('/api/contacts/c-tenant/media?limit=2');
    expect(res.body.media).toHaveLength(2);
    expect(res.body.nextCursor).toBeUndefined();
  });

  it('400s a malformed cursor or limit rather than passing them to the store', async () => {
    seedContact();
    expect((await authedGet('/api/contacts/c-tenant/media?cursor=nope')).status).toBe(400);
    expect((await authedGet('/api/contacts/c-tenant/media?limit=0')).status).toBe(400);
    expect((await authedGet('/api/contacts/c-tenant/media?limit=9999')).status).toBe(400);
  });
});
