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
import express, { type Express } from 'express';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET, OUR_NUMBER, createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createContactTimelineRouter } from '../src/routes/contactTimeline.js';
import { resolveMessage } from '../src/messages/index.js';
import type { AppConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
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
    overrides: {
      direction?: 'inbound' | 'outbound';
      body?: string;
      deliveryStatus?: 'delivered' | 'failed';
      retryOf?: string;
    } = {},
  ): Promise<void> {
    await world.messagesRepo.append({
      conversationId,
      providerSid,
      providerTs,
      type: 'sms',
      direction: overrides.direction ?? 'inbound',
      author: 'tenant',
      deliveryStatus: overrides.deliveryStatus ?? 'delivered',
      ...(overrides.body !== undefined && { body: overrides.body }),
      ...(overrides.retryOf !== undefined && { retryOf: overrides.retryOf }),
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

  it('merges messages from TWO of the contact numbers + an interleaved milestone, oldest→newest (C2 ascending)', async () => {
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
      refType: 'placement',
      refId: 'placement-1',
      at: '2026-06-16T12:00:00.000Z',
    });
    await seedMessage('conv-a', '2026-06-16T13:00:00.000Z', 'SM-a2', { body: 'latest on A' });

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    expect(res.status).toBe(200);
    const kindsAt = res.body.items.map((i: { kind: string; at: string }) => [i.kind, i.at]);
    // C2: the server returns ascending (oldest→newest); the client renders as-is.
    expect(kindsAt).toEqual([
      ['message', '2026-06-16T10:00:00.000Z'],
      ['message', '2026-06-16T11:00:00.000Z'],
      ['milestone', '2026-06-16T12:00:00.000Z'],
      ['message', '2026-06-16T13:00:00.000Z'],
    ]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('every item carries a non-empty `at`: a provider_ts-less message + a milestone (sourced from the sort-key prefix)', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    // Append a message via the repo, then STRIP its provider_ts to simulate a
    // seed / provider_ts-less row — `at` must still come back as the tsMsgId prefix.
    await seedMessage('conv-a', '2026-06-16T10:00:00.000Z', 'SM-nots', { body: 'no provider_ts' });
    const stored = world.messages.find((m) => m.provider_sid === 'SM-nots')!;
    // The sort key (tsMsgId) keeps the ISO prefix even when provider_ts is gone.
    delete (stored as { provider_ts?: string }).provider_ts;
    // A milestone (id = evt-<uuid>, no embeddable timestamp in the id itself —
    // `at` must be sourced from its tsEventId prefix).
    await world.activityEventsRepo.record({
      contactId: TENANT,
      type: 'placement_opened',
      label: 'Placement opened',
      at: '2026-06-16T11:00:00.000Z',
    });

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    expect(res.status).toBe(200);
    const msg = res.body.items.find((i: { kind: string }) => i.kind === 'message');
    const milestone = res.body.items.find((i: { kind: string }) => i.kind === 'milestone');
    // The message's `at` is non-empty and equals its tsMsgId prefix (the sort key).
    expect(typeof msg.at).toBe('string');
    expect(msg.at.length).toBeGreaterThan(0);
    expect(msg.at).toBe('2026-06-16T10:00:00.000Z');
    expect(msg.tsMsgId.startsWith(`${msg.at}#`)).toBe(true);
    // The milestone's `at` is non-empty.
    expect(typeof milestone.at).toBe('string');
    expect(milestone.at).toBe('2026-06-16T11:00:00.000Z');
    // No item in the page is missing `at`.
    for (const item of res.body.items as Array<{ at?: string }>) {
      expect(typeof item.at).toBe('string');
      expect((item.at ?? '').length).toBeGreaterThan(0);
    }
  });

  it('a single page is in ascending `at` order', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    for (let i = 0; i < 4; i++) {
      await seedMessage('conv-a', `2026-06-16T1${i}:00:00.000Z`, `SM-${i}`, { body: `m${i}` });
    }
    const res = await authedGet('/api/contacts/c-tenant/timeline');
    expect(res.status).toBe(200);
    const ats = (res.body.items as Array<{ at: string }>).map((i) => i.at);
    const sortedAsc = [...ats].sort();
    expect(ats).toEqual(sortedAsc);
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
      type: 'placement_opened',
      label: 'Placement opened',
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

  it('emits retry_of on a retry message so the client can collapse the superseded bubble', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    // A failed outbound, then its retry whose retry_of points at the original's tsMsgId.
    const failedTs = '2026-06-16T10:00:00.000Z';
    const failedTsMsgId = `${failedTs}#SM-fail`;
    await seedMessage('conv-a', failedTs, 'SM-fail', {
      direction: 'outbound',
      body: 'retry me',
      deliveryStatus: 'failed',
    });
    await seedMessage('conv-a', '2026-06-16T10:05:00.000Z', 'SM-retry', {
      direction: 'outbound',
      body: 'retry me',
      retryOf: failedTsMsgId,
    });

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const items = res.body.items as Array<{ tsMsgId: string; retry_of?: string }>;
    const original = items.find((i) => i.tsMsgId === failedTsMsgId)!;
    const retry = items.find((i) => i.tsMsgId === '2026-06-16T10:05:00.000Z#SM-retry')!;
    expect(original.retry_of).toBeUndefined(); // the original carries no lineage
    expect(retry.retry_of).toBe(failedTsMsgId); // the retry points back at it
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

  it('serializes transcript_status + call_sid (the bare CallSid) on non-masked calls, NEVER on masked', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    // Founder-bridge voicemail (non-masked): the audio player needs the BARE
    // CallSid (== provider_sid) for GET /api/calls/:callId/recording (the wire
    // `id` is the composite tsMsgId, which would 404), plus transcript_status.
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-founder2',
      providerTs: '2026-06-16T12:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      callOutcome: 'voicemail',
      recordingS3Key: 'recordings/founder2.mp3',
      transcript: 'the voicemail text',
    });
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-masked2',
      providerTs: '2026-06-16T13:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      callOutcome: 'missed',
      masked: true,
    });
    // transcript_status is a new field with no append param - stamp it directly.
    world.messages.find((m) => m.provider_sid === 'CA-founder2')!.transcript_status = 'completed';
    world.messages.find((m) => m.provider_sid === 'CA-masked2')!.transcript_status = 'pending';

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const calls = res.body.items.filter((i: { kind: string }) => i.kind === 'call');
    const founder = calls.find((c: { id: string }) => c.id.includes('CA-founder2'));
    const masked = calls.find((c: { id: string }) => c.id.includes('CA-masked2'));

    // Non-masked: transcript_status + the bare CallSid are exposed.
    expect(founder.transcript_status).toBe('completed');
    expect(founder.call_sid).toBe('CA-founder2');
    // Masked: NEITHER transcript_status NOR call_sid (privacy invariant holds).
    expect(masked.transcript_status).toBeUndefined();
    expect(masked.call_sid).toBeUndefined();
  });

  it("a call's at equals its provider_ts (sort-key parity) and sorts among messages", async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    // A message before and after the call so the call must sort by its provider_ts.
    await seedMessage('conv-a', '2026-06-16T10:00:00.000Z', 'SM-before', { body: 'before' });
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-mid',
      providerTs: '2026-06-16T11:00:00.000Z',
      // started_at intentionally DIVERGES from provider_ts to prove `at` tracks
      // provider_ts (the sort/cursor key), not started_at.
      startedAt: '2026-06-16T09:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      callOutcome: 'answered',
    });
    await seedMessage('conv-a', '2026-06-16T12:00:00.000Z', 'SM-after', { body: 'after' });

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    expect(res.status).toBe(200);
    const call = res.body.items.find((i: { kind: string }) => i.kind === 'call');
    // at == provider_ts (not the divergent started_at).
    expect(call.at).toBe('2026-06-16T11:00:00.000Z');
    // And it sorts strictly between the two messages by that key (C2 ascending).
    const kindsAt = res.body.items.map((i: { kind: string; at: string }) => [i.kind, i.at]);
    expect(kindsAt).toEqual([
      ['message', '2026-06-16T10:00:00.000Z'],
      ['call', '2026-06-16T11:00:00.000Z'],
      ['message', '2026-06-16T12:00:00.000Z'],
    ]);
  });

  it('multi-source cursor walk: paginates messages from TWO conversations + milestones with no dups/skips, ascending within each page while the cursor pages older', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    seedConversation('conv-b', PHONE_B);
    // 8 items across THREE sources, interleaved in time (all distinct `at`):
    //   conv-a: A1 @10:00, A2 @13:00, A3 @16:00
    //   conv-b: B1 @11:00, B2 @14:00, B3 @17:00
    //   milestones: M1 @12:00, M2 @15:00
    await seedMessage('conv-a', '2026-06-16T10:00:00.000Z', 'SM-a1', { body: 'a1' });
    await seedMessage('conv-b', '2026-06-16T11:00:00.000Z', 'SM-b1', { body: 'b1' });
    await world.activityEventsRepo.record({
      contactId: TENANT,
      type: 'stage_changed',
      label: 'M1',
      at: '2026-06-16T12:00:00.000Z',
    });
    await seedMessage('conv-a', '2026-06-16T13:00:00.000Z', 'SM-a2', { body: 'a2' });
    await seedMessage('conv-b', '2026-06-16T14:00:00.000Z', 'SM-b2', { body: 'b2' });
    await world.activityEventsRepo.record({
      contactId: TENANT,
      type: 'placement_opened',
      label: 'M2',
      at: '2026-06-16T15:00:00.000Z',
    });
    await seedMessage('conv-a', '2026-06-16T16:00:00.000Z', 'SM-a3', { body: 'a3' });
    await seedMessage('conv-b', '2026-06-16T17:00:00.000Z', 'SM-b3', { body: 'b3' });

    // Walk every page with a small limit until nextCursor is null. Collect each
    // page separately so we can assert per-page ascending + page-level ordering.
    const pagesItems: Array<Array<{ id: string; at: string }>> = [];
    let cursor: string | null = null;
    do {
      const url: string =
        cursor === null
          ? '/api/contacts/c-tenant/timeline?limit=3'
          : `/api/contacts/c-tenant/timeline?limit=3&cursor=${encodeURIComponent(cursor)}`;
      const res = await authedGet(url);
      expect(res.status).toBe(200);
      pagesItems.push(res.body.items as Array<{ id: string; at: string }>);
      cursor = res.body.nextCursor;
    } while (cursor !== null && pagesItems.length < 20);

    const pages = pagesItems.length;
    const seenIds = pagesItems.flatMap((p) => p.map((i) => i.id));
    const seenAts = pagesItems.flatMap((p) => p.map((i) => i.at));

    // (a) the collected set equals all 8 items.
    expect(seenIds).toHaveLength(8);
    // (b) no item id appears twice.
    expect(new Set(seenIds).size).toBe(8);
    // (c) each page's items are ASCENDING within the page (C2 server order).
    for (const page of pagesItems) {
      const ats = page.map((i) => i.at);
      expect(ats).toEqual([...ats].sort());
    }
    // (d) the cursor pages OLDER: each page is strictly older than the previous
    //     (the oldest `at` of page N exceeds the newest `at` of page N+1).
    for (let p = 1; p < pagesItems.length; p++) {
      const prevOldest = pagesItems[p - 1]!.map((i) => i.at).sort()[0]!;
      const thisNewest = pagesItems[p]!.map((i) => i.at).sort().at(-1)!;
      expect(thisNewest < prevOldest).toBe(true);
    }
    // (e) concatenating pages newest-page-first reconstructs the WHOLE history:
    //     reversing each page (asc→desc) then flattening yields strict descending.
    const newestFirst = pagesItems.flatMap((p) => [...p].reverse().map((i) => i.at));
    for (let i = 1; i < newestFirst.length; i++) {
      expect(newestFirst[i]! < newestFirst[i - 1]!).toBe(true);
    }
    expect(new Set([...seenAts]).size).toBe(8);
    // Really walked multiple pages (8 items / limit 3 = ceil 3 pages).
    expect(pages).toBeGreaterThanOrEqual(3);
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

// WS3 Task 3.2 — a LANDLORD contact's owned-property lifecycle audit is
// interleaved into their person-centric timeline as milestone pins. Lifecycle
// only (broadcasts / tours / listing-status / roster); routine
// field edits (unit_updated/created/deleted/restored) are NEVER surfaced. The
// property-audit candidate keys on the RAW audit SK (`<ISO>#<rand>`) so its
// merged cursor lives in the audit's own `before` lexical space (page-safe).
describe('GET /api/contacts/:id/timeline — landlord property interleave', () => {
  const authedGet = (app: Express, path: string) =>
    request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

  it('merges owned-unit lifecycle audit into the landlord timeline, excluding field-edits', async () => {
    const h = makeWebhookHarness();
    const app = h.app;
    const world = h.world;
    world.contacts.push({
      contactId: 'll1',
      type: 'landlord',
      status: 'active',
      phone: '+15550100009',
      phones: [{ phone: '+15550100009', primary: true }],
    });
    world.units.set('u1', { unitId: 'u1', landlordId: 'll1', status: 'available' });
    await world.auditRepo.append('units#u1', 'broadcast_sent', { broadcastId: 'b1', tenantCount: 4 });
    await world.auditRepo.append('units#u1', 'tour_scheduled', { tourId: 't1' });
    await world.auditRepo.append('units#u1', 'listing_status_changed', { to: 'under_application' });
    await world.auditRepo.append('units#u1', 'unit_updated', { fields: ['rent_min'] }); // EXCLUDED
    // A historical listing_response_set row (the response label was removed):
    // it falls to the default:null mapping and must NOT render (graceful decay).
    await world.auditRepo.append('units#u1', 'listing_response_set', {
      contactId: 'c-old',
      response: 'interested',
    });

    const res = await authedGet(app, '/api/contacts/ll1/timeline');
    expect(res.status).toBe(200);

    const ms = res.body.items.filter((i: { kind: string }) => i.kind === 'milestone');
    // ONLY the three lifecycle rows interleave — the unit_updated field-edit is
    // filtered out (never surfaced on any timeline; it stays in the audit trail),
    // and the historical listing_response_set row maps to null (stops rendering).
    expect(ms).toHaveLength(3);
    const types = ms.map((m: { type: string }) => m.type);
    expect(types).toContain('tour_scheduled'); // tour_* maps 1:1 to the same-named type
    expect(types).not.toContain('unit_updated');
    expect(types).not.toContain('listing_reviewed');

    // The broadcast row deep-links to the broadcast, with the recipient count in
    // its label. type reuses an existing member ('listing_sent'); refType carries
    // the real deep-link target.
    const bc = ms.find((m: { refType?: string }) => m.refType === 'broadcast');
    expect(bc).toMatchObject({
      kind: 'milestone',
      type: 'listing_sent',
      refType: 'broadcast',
      refId: 'b1',
      label: expect.stringContaining('4'),
    });

    const tr = ms.find((m: { refType?: string }) => m.refType === 'tour');
    expect(tr).toMatchObject({ type: 'tour_scheduled', refType: 'tour', refId: 't1' });

    // The status-change row humanizes the raw enum via LISTING_STATUS_LABELS,
    // matching the property Activity card ('under_application' → 'Under application').
    const st = ms.find((m: { type: string }) => m.type === 'stage_changed');
    expect(st).toMatchObject({
      type: 'stage_changed',
      refType: 'unit',
      refId: 'u1',
      label: 'Property status → Under application',
    });
  });

  it('does NOT interleave property activity for a tenant contact', async () => {
    const h = makeWebhookHarness();
    const app = h.app;
    const world = h.world;
    world.contacts.push({
      contactId: 't1',
      type: 'tenant',
      status: 'active',
      phone: '+15550100010',
      phones: [{ phone: '+15550100010', primary: true }],
    });
    // Even a (mis-owned) unit pointing at the tenant contact must NOT interleave.
    world.units.set('u2', { unitId: 'u2', landlordId: 't1', status: 'available' });
    await world.auditRepo.append('units#u2', 'broadcast_sent', { broadcastId: 'b2', tenantCount: 1 });

    const res = await authedGet(app, '/api/contacts/t1/timeline');
    expect(res.status).toBe(200);
    expect(
      res.body.items.filter(
        (i: { kind: string; type?: string }) => i.kind === 'milestone' && i.type === 'listing_sent',
      ),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Part B server (scheduled-message-visibility, Task 4): the not-yet-sent
// scheduled-send gather returned in a FIRST-PAGE-ONLY `upcoming[]` envelope.
// Built directly against createContactTimelineRouter with the in-memory fakes
// (no DynamoDB) so the gather's three walks + suppression are exercised.
// ---------------------------------------------------------------------------

const CONFIRMATION_BODY = resolveMessage('tour.confirmation');
const DAY_BEFORE_BODY = resolveMessage('tour.day_before');
const APPROVAL_BODY = resolveMessage('nudge.approval_check');

describe('GET /api/contacts/:id/timeline — scheduled upcoming[] gather (Part B server)', () => {
  function makeGatherHarness(): { world: FakeWorld; app: Express } {
    const world = createFakeWorld();
    const logger = createLogger({ destination: createLogCapture().stream });
    const config = {
      smsSendingEnabled: true,
      ourPhoneNumbers: [OUR_NUMBER],
    } as unknown as AppConfig;
    const router = createContactTimelineRouter({
      logger,
      config,
      contactsRepo: world.contactsRepo,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      activityEventsRepo: world.activityEventsRepo,
      toursRepo: world.toursRepo,
      tourRemindersRepo: world.tourRemindersRepo,
      placementNudgesRepo: world.placementNudgesRepo,
      placementsRepo: world.placementsRepo,
      unitsRepo: world.unitsRepo,
    });
    const app = express();
    app.use('/api/contacts', router);
    return { world, app };
  }

  function seedConv(
    world: FakeWorld,
    conversationId: string,
    participantPhone: string,
    type: ConversationType,
  ): void {
    const now = new Date().toISOString();
    world.conversations.set(conversationId, {
      conversationId,
      participant_phone: participantPhone,
      status: 'open',
      last_activity_at: now,
      type,
      ai_mode: 'auto',
      created_at: now,
    });
  }

  /** Seed a relay_group conversation; `usable` toggles open+pool+roster vs closed. */
  function seedGroup(world: FakeWorld, conversationId: string, poolNumber: string, usable: boolean): void {
    const now = new Date().toISOString();
    world.conversations.set(conversationId, {
      conversationId,
      participant_phone: poolNumber,
      pool_number: poolNumber,
      status: usable ? 'open' : 'closed',
      last_activity_at: now,
      type: 'relay_group',
      ai_mode: 'manual',
      created_at: now,
      participants: [{ contactId: 'someone', phone: '+15550190999' }],
    });
  }

  it('self_guided tour with 2 upcoming rungs → 2 scheduled items (asc by dueAt) on the tenant 1:1', async () => {
    const { world, app } = makeGatherHarness();
    const phone = '+15550600001';
    world.contacts.push({ contactId: 'ct-1', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-1', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-1',
      unitId: 'u-1',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'self_guided',
    });
    // Insert out of dueAt order to prove the ascending sort.
    await world.tourRemindersRepo.create({ tourId: tour.tourId, kind: 'day_before', dueAt: '2099-01-09T10:00:00.000Z' });
    await world.tourRemindersRepo.create({ tourId: tour.tourId, kind: 'confirmation', dueAt: '2099-01-05T10:00:00.000Z' });

    const res = await request(app).get('/api/contacts/ct-1/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(2);
    expect(up.every((i) => i.kind === 'scheduled' && i.source === 'tour_reminder')).toBe(true);
    expect(up.map((i) => i.at)).toEqual(['2099-01-05T10:00:00.000Z', '2099-01-09T10:00:00.000Z']);
    expect(up[0]!.reminderKind).toBe('confirmation');
    expect(up[0]!.body).toBe(CONFIRMATION_BODY);
    expect(up[1]!.body).toBe(DAY_BEFORE_BODY);
    expect(up.every((i) => i.conversationId === 'conv-ct-1')).toBe(true);
    expect(up.every((i) => i.suppression === undefined)).toBe(true);
    expect(up[0]!.refType).toBe('tour');
    expect(up[0]!.refId).toBe(tour.tourId);
  });

  it('non-self_guided tour with an UNUSABLE (closed) group still surfaces its rungs as 1:1 items (M3)', async () => {
    const { world, app } = makeGatherHarness();
    const phone = '+15550600002';
    world.contacts.push({ contactId: 'ct-2', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-2', phone, 'tenant_1to1');
    seedGroup(world, 'grp-closed', '+15550190002', /* usable */ false);
    const tour = await world.toursRepo.create({
      tenantId: 'ct-2',
      unitId: 'u-2',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'landlord_led',
      groupThreadId: 'grp-closed',
    });
    await world.tourRemindersRepo.create({ tourId: tour.tourId, kind: 'confirmation', dueAt: '2099-01-05T10:00:00.000Z' });

    const res = await request(app).get('/api/contacts/ct-2/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(1);
    expect(up[0]!.source).toBe('tour_reminder');
    expect(up[0]!.conversationId).toBe('conv-ct-2');
  });

  it('non-self_guided tour with a USABLE group does NOT surface its rungs (group-routed, no 1:1)', async () => {
    const { world, app } = makeGatherHarness();
    const phone = '+15550600003';
    world.contacts.push({ contactId: 'ct-3', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-3', phone, 'tenant_1to1');
    seedGroup(world, 'grp-open', '+15550190003', /* usable */ true);
    const tour = await world.toursRepo.create({
      tenantId: 'ct-3',
      unitId: 'u-3',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'landlord_led',
      groupThreadId: 'grp-open',
    });
    await world.tourRemindersRepo.create({ tourId: tour.tourId, kind: 'confirmation', dueAt: '2099-01-05T10:00:00.000Z' });

    const res = await request(app).get('/api/contacts/ct-3/timeline');
    expect(res.status).toBe(200);
    expect(res.body.upcoming).toEqual([]);
  });

  it('landlord contact with an awaiting_approval nudge and NO landlord 1:1 → item with conversationId undefined (M4)', async () => {
    const { world, app } = makeGatherHarness();
    const landlordPhone = '+15550600004';
    world.contacts.push({ contactId: 'll-1', type: 'landlord', status: 'active', phone: landlordPhone });
    // Deliberately NO conversation for the landlord (created on demand at fire time).
    const unit = await world.unitsRepo.create({ landlordId: 'll-1', status: 'available' });
    const placement = await world.placementsRepo.create({
      tenantId: 'tt-1',
      unitId: unit.unitId,
      stage: 'awaiting_approval',
    });
    await world.placementNudgesRepo.create({
      placementId: placement.placementId,
      kind: 'approval_check',
      dueAt: '2099-02-01T10:00:00.000Z',
    });

    const res = await request(app).get('/api/contacts/ll-1/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(1);
    expect(up[0]!.source).toBe('placement_nudge');
    expect(up[0]!.nudgeKind).toBe('approval_check');
    expect(up[0]!.body).toBe(APPROVAL_BODY);
    expect('conversationId' in up[0]!).toBe(false);
    expect(up[0]!.suppression).toBeUndefined();
    expect(up[0]!.refType).toBe('placement');
    expect(up[0]!.refId).toBe(placement.placementId);
  });

  it('opted-out tenant → the tour-reminder upcoming item carries suppression contact_opted_out', async () => {
    const { world, app } = makeGatherHarness();
    const phone = '+15550600005';
    world.contacts.push({ contactId: 'ct-5', type: 'tenant', status: 'active', phone, sms_opt_out: true });
    seedConv(world, 'conv-ct-5', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-5',
      unitId: 'u-5',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'self_guided',
    });
    await world.tourRemindersRepo.create({ tourId: tour.tourId, kind: 'confirmation', dueAt: '2099-01-05T10:00:00.000Z' });

    const res = await request(app).get('/api/contacts/ct-5/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(1);
    expect(up[0]!.suppression).toEqual({ reason: 'contact_opted_out' });
  });

  it('a request WITH a cursor returns an empty upcoming[] (gather is first-page only)', async () => {
    const { world, app } = makeGatherHarness();
    const phone = '+15550600006';
    world.contacts.push({ contactId: 'ct-6', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-6', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-6',
      unitId: 'u-6',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'self_guided',
    });
    await world.tourRemindersRepo.create({ tourId: tour.tourId, kind: 'confirmation', dueAt: '2099-01-05T10:00:00.000Z' });

    const cursor = Buffer.from('2099-01-01T00:00:00.000Z#z', 'utf8').toString('base64url');
    const res = await request(app).get(`/api/contacts/ct-6/timeline?cursor=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(200);
    expect(res.body.upcoming).toEqual([]);
  });

  it('kinds=message (excludes scheduled) → empty upcoming[] and the gather is skipped', async () => {
    const { world, app } = makeGatherHarness();
    const phone = '+15550600007';
    world.contacts.push({ contactId: 'ct-7', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-7', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-7',
      unitId: 'u-7',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'self_guided',
    });
    await world.tourRemindersRepo.create({ tourId: tour.tourId, kind: 'confirmation', dueAt: '2099-01-05T10:00:00.000Z' });

    const res = await request(app).get('/api/contacts/ct-7/timeline?kinds=message');
    expect(res.status).toBe(200);
    expect(res.body.upcoming).toEqual([]);
  });
});
