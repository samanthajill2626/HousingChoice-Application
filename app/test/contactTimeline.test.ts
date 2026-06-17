// BE2/C2 route tests — GET /api/contacts/:contactId/timeline. Runs on the
// shared in-memory world (the harness fakes), authed via the real sealed
// session cookie next to the origin secret. Covers:
//   - merge ordering across TWO of the contact's numbers + an interleaved
//     milestone (newest-first, by the global <at>#<id> key);
//   - kinds= filters (message,call excludes milestones; message excludes calls);
//   - cursor pagination returns every item exactly once (no dups/skips);
//   - PII: a MASKED call has NO transcript/recording_s3_key; a founder-bridge
//     call DOES; full message body is returned untruncated;
//   - 404 unknown contact; 400 invalid cursor.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import type { ConversationItem, ConversationType } from '../src/repos/conversationsRepo.js';

const TENANT = 'c-tenant';
const PHONE_A = '+15550100001';
const PHONE_B = '+15550100002';

describe('GET /api/contacts/:id/timeline (BE2/C2)', () => {
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

  /** Seed a conversation row keyed by participant_phone (the 1:1 thread). */
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

  /** Append an sms message with an explicit provider timestamp + sid. */
  async function seedMessage(
    conversationId: string,
    providerTs: string,
    providerSid: string,
    overrides: { direction?: 'inbound' | 'outbound'; body?: string } = {},
  ): Promise<void> {
    await world.messagesRepo.append({
      conversationId,
      providerSid,
      providerTs,
      type: 'sms',
      direction: overrides.direction ?? 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      ...(overrides.body !== undefined && { body: overrides.body }),
    });
  }

  it('404s an unknown contact', async () => {
    const res = await authedGet('/api/contacts/nope/timeline');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('contact_not_found');
  });

  it('400s an invalid cursor', async () => {
    seedContact();
    const res = await authedGet('/api/contacts/c-tenant/timeline?cursor=not-a-real-cursor');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid cursor');
  });

  it('merges messages from TWO of the contact numbers + an interleaved milestone, newest-first', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    seedConversation('conv-b', PHONE_B);
    // Interleaved by time (oldest → newest): A1, B1, milestone, A2.
    await seedMessage('conv-a', '2026-06-16T10:00:00.000Z', 'SM-a1', { body: 'first on A' });
    await seedMessage('conv-b', '2026-06-16T11:00:00.000Z', 'SM-b1', { body: 'on B' });
    await world.activityEventsRepo.record({
      contactId: TENANT,
      type: 'stage_changed',
      label: 'Stage → Touring',
      refType: 'case',
      refId: 'case-1',
      at: '2026-06-16T12:00:00.000Z',
    });
    await seedMessage('conv-a', '2026-06-16T13:00:00.000Z', 'SM-a2', { body: 'latest on A' });

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    expect(res.status).toBe(200);
    const kindsAt = res.body.items.map((i: { kind: string; at: string }) => [i.kind, i.at]);
    // Newest-first.
    expect(kindsAt).toEqual([
      ['message', '2026-06-16T13:00:00.000Z'],
      ['milestone', '2026-06-16T12:00:00.000Z'],
      ['message', '2026-06-16T11:00:00.000Z'],
      ['message', '2026-06-16T10:00:00.000Z'],
    ]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('kinds=message,call excludes milestones; kinds=message excludes calls', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await seedMessage('conv-a', '2026-06-16T10:00:00.000Z', 'SM-1', { body: 'hi' });
    // A founder-bridge (non-masked) call.
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-1',
      providerTs: '2026-06-16T11:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      callOutcome: 'answered',
    });
    await world.activityEventsRepo.record({
      contactId: TENANT,
      type: 'case_opened',
      label: 'Case opened',
      at: '2026-06-16T12:00:00.000Z',
    });

    const both = await authedGet('/api/contacts/c-tenant/timeline?kinds=message,call');
    expect(both.body.items.map((i: { kind: string }) => i.kind).sort()).toEqual(['call', 'message']);

    const msgOnly = await authedGet('/api/contacts/c-tenant/timeline?kinds=message');
    expect(msgOnly.body.items.map((i: { kind: string }) => i.kind)).toEqual(['message']);

    const bad = await authedGet('/api/contacts/c-tenant/timeline?kinds=message,bogus');
    expect(bad.status).toBe(400);
  });

  it('cursor pagination returns every item exactly once with no dups/skips', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    // 5 messages at distinct increasing times.
    for (let i = 0; i < 5; i++) {
      await seedMessage('conv-a', `2026-06-16T1${i}:00:00.000Z`, `SM-${i}`, { body: `m${i}` });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string =
        cursor === null
          ? '/api/contacts/c-tenant/timeline?limit=2'
          : `/api/contacts/c-tenant/timeline?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await authedGet(url);
      expect(res.status).toBe(200);
      for (const item of res.body.items) seen.push(item.id);
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(new Set(seen).size).toBe(5); // no dups
    expect(seen).toHaveLength(5); // no skips
    expect(pages).toBeGreaterThanOrEqual(3); // really paginated (2+2+1)
  });

  it('returns the FULL message body untruncated', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    const longBody = 'x'.repeat(500);
    await seedMessage('conv-a', '2026-06-16T10:00:00.000Z', 'SM-long', { body: longBody });

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const msg = res.body.items.find((i: { kind: string }) => i.kind === 'message');
    expect(msg.body).toBe(longBody);
    expect(msg.body).toHaveLength(500);
  });

  it('derives fromPhone/toPhone from the contact own number + our number only', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await seedMessage('conv-a', '2026-06-16T10:00:00.000Z', 'SM-in', { direction: 'inbound', body: 'in' });
    await seedMessage('conv-a', '2026-06-16T11:00:00.000Z', 'SM-out', { direction: 'outbound', body: 'out' });

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const items = res.body.items as Array<{ direction: string; fromPhone?: string; toPhone?: string }>;
    const inbound = items.find((i) => i.direction === 'inbound')!;
    const outbound = items.find((i) => i.direction === 'outbound')!;
    // Inbound: from the contact's number → to our org number.
    expect(inbound.fromPhone).toBe(PHONE_A);
    expect(inbound.toPhone).toBe('+15550009999'); // OUR_NUMBER from the harness
    // Outbound: from our number → to the contact's number.
    expect(outbound.fromPhone).toBe('+15550009999');
    expect(outbound.toPhone).toBe(PHONE_A);
  });

  it('a MASKED call exposes NO transcript/recording_s3_key; a founder-bridge call DOES', async () => {
    seedContact();
    // A masked relay-pool call sits on a relay_group thread — but masked calls
    // are excluded from a contact's 1:1 timeline (the thread fronts a pool
    // number). To assert the PII guard at the MAPPER, seed BOTH a masked and a
    // founder-bridge call on the contact's OWN 1:1 thread.
    seedConversation('conv-a', PHONE_A);
    // Founder-bridge (non-masked): recording + transcript are exposed.
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-founder',
      providerTs: '2026-06-16T10:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      callOutcome: 'answered',
      recordingS3Key: 'recordings/founder.mp3',
      transcript: 'hello this is the call',
    });
    // Masked: recording + transcript must NEVER surface.
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-masked',
      providerTs: '2026-06-16T11:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      callOutcome: 'answered',
      masked: true,
      // These would be a data anomaly on a masked call — assert the mapper drops
      // them regardless of what's stored.
      recordingS3Key: 'recordings/should-not-leak.mp3',
      transcript: 'this must never be exposed',
    });

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const calls = res.body.items.filter((i: { kind: string }) => i.kind === 'call');
    const founder = calls.find((c: { id: string }) => c.id.includes('CA-founder'));
    const masked = calls.find((c: { id: string }) => c.id.includes('CA-masked'));

    expect(founder.recording_s3_key).toBe('recordings/founder.mp3');
    expect(founder.transcript).toBe('hello this is the call');

    expect(masked.recording_s3_key).toBeUndefined();
    expect(masked.transcript).toBeUndefined();
    // And no PII leaked anywhere in the masked call payload.
    expect(JSON.stringify(masked)).not.toContain('never be exposed');
    expect(JSON.stringify(masked)).not.toContain('should-not-leak');
  });

  it('excludes relay_group threads (group-text content is never inlined)', async () => {
    seedContact();
    // A relay_group thread fronted by a pool number that happens to also be one
    // of the contact's numbers in this contrived seed — it must STILL be
    // excluded purely on type, never inlining group content.
    seedConversation('conv-relay', PHONE_A, 'relay_group');
    await seedMessage('conv-relay', '2026-06-16T10:00:00.000Z', 'SM-relay', { body: 'group msg' });

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    expect(res.body.items).toHaveLength(0);
  });
});
