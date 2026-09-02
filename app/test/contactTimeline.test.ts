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
import { MANUAL_ONLY_REMINDER_KINDS } from '../src/jobs/tourReminders.js';
import { MANUAL_ONLY_NUDGE_KINDS } from '../src/jobs/placementNudges.js';
import type { ReminderKind } from '../src/repos/tourRemindersRepo.js';
import type { NudgeKind } from '../src/repos/placementNudgesRepo.js';
import { resolveMessage } from '../src/messages/index.js';
import { composeTourReminderBody } from '../src/messages/tourCopy.js';
import { DEFAULT_ORG_SETTINGS } from '../src/repos/settingsRepo.js';
import type { AppConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import type { ConversationItem, ConversationType } from '../src/repos/conversationsRepo.js';
import {
  isoHoursFromNow,
  quietLaterSettingsRepo,
  quietNowSettingsRepo,
  quietOffSettingsRepo,
  type SettingsReadRepo,
} from './helpers/settingsStub.js';
// Cross-package import: the D12 seam test drives the REAL client presenter with
// the REAL projected payload, because nothing else in this mission spans the
// projection/presenter boundary. Established practice - see consentDrift.test.ts.
import { presentCallState } from '../../dashboard/src/routes/contact/presentCallState.js';

const TENANT = 'c-tenant';
const PHONE_A = '+15550100001';
const PHONE_B = '+15550100002';

describe('GET /api/contacts/:id/timeline (BE2/C2)', () => {
  let app: Express;
  let world: FakeWorld;
  let capture: ReturnType<typeof createLogCapture>;

  beforeEach(() => {
    const h = makeWebhookHarness();
    app = h.app;
    world = h.world;
    capture = h.capture;
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

  it('projects versioned transport facts without deriving them for legacy rows', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'SM-transport',
      providerTs: '2026-06-16T10:00:00.000Z',
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'sent',
      transportSchemaVersion: 1,
      requestedTransport: 'rcs',
      actualTransport: 'sms',
      deliveryRecipients: {
        'contact-recipient': {
          status: 'sent',
          requestedTransport: 'rcs',
          actualTransport: 'mms',
          transportAggregationState: 'attempted',
        },
      },
    });
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'SM-unresolved',
      providerTs: '2026-06-16T11:00:00.000Z',
      type: 'mms',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      transportSchemaVersion: 1,
    });
    await seedMessage('conv-a', '2026-06-16T12:00:00.000Z', 'SM-legacy');

    const res = await authedGet('/api/contacts/c-tenant/timeline?kinds=message');
    expect(res.status).toBe(200);
    const versioned = res.body.items.find((item: { id: string }) => item.id.includes('SM-transport'));
    expect(versioned).toMatchObject({
      transport_schema_version: 1,
      requested_transport: 'rcs',
      actual_transport: 'sms',
      delivery_recipients: {
        'contact-recipient': {
          requestedTransport: 'rcs',
          actualTransport: 'mms',
          transportAggregationState: 'attempted',
        },
      },
    });
    const unresolved = res.body.items.find((item: { id: string }) => item.id.includes('SM-unresolved'));
    expect(unresolved).toMatchObject({ transport_schema_version: 1, type: 'mms' });
    expect(unresolved).not.toHaveProperty('requested_transport');
    expect(unresolved).not.toHaveProperty('actual_transport');
    const legacy = res.body.items.find((item: { id: string }) => item.id.includes('SM-legacy'));
    expect(legacy).not.toHaveProperty('transport_schema_version');
    expect(legacy).not.toHaveProperty('requested_transport');
    expect(legacy).not.toHaveProperty('actual_transport');
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

  it('emits imported:true only on a row the importer stamped', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await seedMessage('conv-a', '2026-03-01T10:00:00.000Z', 'SM-old', {
      direction: 'outbound',
      body: 'history',
    });
    await seedMessage('conv-a', '2026-06-16T10:00:00.000Z', 'SM-ours', {
      direction: 'outbound',
      body: 'ours',
    });
    // `imported_from` is an undeclared rider the importer PUTs on the item
    // (lib/import/apply.ts), so the fake world is stamped the same way.
    const historical = world.messages.find((m) => m.provider_sid === 'SM-old')!;
    (historical as Record<string, unknown>)['imported_from'] = 'quo-airtable-import';

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const items = res.body.items as Array<{ tsMsgId: string; imported?: boolean }>;
    expect(items.find((i) => i.tsMsgId.endsWith('#SM-old'))!.imported).toBe(true);
    expect(items.find((i) => i.tsMsgId.endsWith('#SM-ours'))!.imported).toBeUndefined();
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

  it('projects direction on calls: an inbound call carries inbound, an outbound call carries outbound', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-in',
      providerTs: '2026-06-16T10:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      callOutcome: 'answered',
    });
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-out',
      providerTs: '2026-06-16T11:00:00.000Z',
      type: 'call',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'delivered',
      callOutcome: 'answered',
    });

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const calls = res.body.items.filter((i: { kind: string }) => i.kind === 'call');
    const inbound = calls.find((c: { id: string }) => c.id.includes('CA-in'));
    const outbound = calls.find((c: { id: string }) => c.id.includes('CA-out'));

    expect(inbound.direction).toBe('inbound');
    expect(outbound.direction).toBe('outbound');
  });

  it('projects call_status ONLY when the stored value is a member of the CallStatus union', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    // A live outbound call still ringing - a real member of the union.
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-ringing',
      providerTs: '2026-06-16T10:00:00.000Z',
      type: 'call',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'sent',
      callStatus: 'ringing',
    });
    // An imported/anomalous row carrying an out-of-union status. `append` cannot
    // produce one (its param is typed CallStatus), so stamp the stored row.
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-bogus',
      providerTs: '2026-06-16T11:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      callOutcome: 'answered',
    });
    const bogus = world.messages.find((m) => m.provider_sid === 'CA-bogus')!;
    (bogus as Record<string, unknown>)['call_status'] = 'queued';

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const calls = res.body.items.filter((i: { kind: string }) => i.kind === 'call');
    const ringing = calls.find((c: { id: string }) => c.id.includes('CA-ringing'));
    const outOfUnion = calls.find((c: { id: string }) => c.id.includes('CA-bogus'));

    expect(ringing.call_status).toBe('ringing');
    // Never cast an unrecognized string onto the wire - drop it.
    expect(outOfUnion.call_status).toBeUndefined();
  });

  // N-4: the out-of-union `direction` warn is OBSERVABILITY on a PERMANENT data
  // condition, and this surface refetches on every message.persisted /
  // conversation.updated / scheduled.updated (debounced 300ms). Per-row, one
  // corrupt row on a busy thread becomes a sustained WARN stream for as long as
  // anyone leaves the contact open. Aggregate per REQUEST with a count + one
  // example, the same shape the orphan-logs work established for its per-poll-
  // tick rollup. What goes on the WIRE is unchanged - this is log shape only.
  it('aggregates the out-of-union direction warn to ONE line per request, carrying a count', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    // Three call rows whose stored `direction` the repo API cannot express
    // (`append`'s param is typed MessageDirection), so stamp the stored rows.
    const sids = ['CA-dir-1', 'CA-dir-2', 'CA-dir-3'];
    for (const [i, sid] of sids.entries()) {
      await world.messagesRepo.append({
        conversationId: 'conv-a',
        providerSid: sid,
        providerTs: `2026-06-16T1${i}:00:00.000Z`,
        type: 'call',
        direction: 'inbound',
        author: 'tenant',
        deliveryStatus: 'delivered',
        callStatus: 'ringing',
      });
      const row = world.messages.find((m) => m.provider_sid === sid)!;
      (row as Record<string, unknown>)['direction'] = 'sideways';
    }
    capture.lines.length = 0;

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    expect(res.status).toBe(200);

    // The wire contract is untouched: the stored value is still emitted as-is.
    const calls = res.body.items.filter((i: { kind: string }) => i.kind === 'call');
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.direction).toBe('sideways');

    // ONE warn for the whole request, carrying the count + one example id.
    const warns = capture
      .atLevel(40)
      .filter((l) => String(l['msg']).includes('out-of-union direction'));
    expect(warns).toHaveLength(1);
    const warn = warns[0]!;
    expect(warn['count']).toBe(3);
    expect(sids.some((sid) => String(warn['exampleTsMsgId']).includes(sid))).toBe(true);
    expect(warn['exampleConversationId']).toBe('conv-a');
  });

  it('a timeline with no anomalous direction warns NOT AT ALL', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-ok',
      providerTs: '2026-06-16T10:00:00.000Z',
      type: 'call',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'sent',
      callStatus: 'ringing',
    });
    capture.lines.length = 0;

    await authedGet('/api/contacts/c-tenant/timeline');

    expect(
      capture.atLevel(40).filter((l) => String(l['msg']).includes('out-of-union direction')),
    ).toHaveLength(0);
  });

  it('normalizes the importer call outcomes, drops unrecognized ones, and never defaults to missed', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    // Four call rows whose stored outcome the repo API cannot express: the
    // importer's two out-of-union strings (apply.ts writes `no_answer` /
    // `completed`), one unrecognized string, and one row with NO outcome at all
    // (the shape the /status gate refusal stamp produces). `append`'s
    // `callOutcome` param is typed CallOutcome, so all three are stamped onto
    // the stored row directly.
    const sids = ['CA-imp-noanswer', 'CA-imp-completed', 'CA-imp-bogus', 'CA-none'];
    for (const [i, sid] of sids.entries()) {
      await world.messagesRepo.append({
        conversationId: 'conv-a',
        providerSid: sid,
        providerTs: `2026-06-16T1${i}:00:00.000Z`,
        type: 'call',
        direction: 'inbound',
        author: 'tenant',
        deliveryStatus: 'delivered',
      });
    }
    const stamp = (sid: string, outcome: string): void => {
      const row = world.messages.find((m) => m.provider_sid === sid)!;
      (row as Record<string, unknown>)['call_outcome'] = outcome;
    };
    stamp('CA-imp-noanswer', 'no_answer');
    stamp('CA-imp-completed', 'completed');
    stamp('CA-imp-bogus', 'not-a-real-outcome');

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const calls = res.body.items.filter((i: { kind: string }) => i.kind === 'call');
    const pick = (sid: string) => calls.find((c: { id: string }) => c.id.includes(sid));

    // D10: the two importer strings normalize BEFORE the membership test.
    expect(pick('CA-imp-noanswer').call_outcome).toBe('missed');
    expect(pick('CA-imp-completed').call_outcome).toBe('answered');
    // Anything else unrecognized is DROPPED, never cast through `as CallOutcome`.
    expect(pick('CA-imp-bogus').call_outcome).toBeUndefined();
    // And a row with no stored outcome projects NO outcome. The `?? 'missed'`
    // default is gone; inventing one is the false attribution D6 exists to remove.
    expect(pick('CA-none').call_outcome).toBeUndefined();
  });

  it("falls back to the importer's call_duration_seconds when call_duration is absent", async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-imported-dur',
      providerTs: '2026-06-16T10:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      callOutcome: 'answered',
    });
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-native-dur',
      providerTs: '2026-06-16T11:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      callOutcome: 'answered',
      callDuration: 61,
    });
    // call_duration_seconds is the importer's own field. It is NOT declared on
    // MessageItem (only call_duration is), so it is neither an append param nor
    // a plain property read - stamp it directly, as the projection reads it
    // through the index signature with a typeof narrow.
    const imported = world.messages.find((m) => m.provider_sid === 'CA-imported-dur')!;
    (imported as Record<string, unknown>)['call_duration_seconds'] = 252;

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const calls = res.body.items.filter((i: { kind: string }) => i.kind === 'call');
    const pick = (sid: string) => calls.find((c: { id: string }) => c.id.includes(sid));

    expect(pick('CA-imported-dur').call_duration).toBe(252);
    // A declared call_duration still wins - the fallback only fills a gap.
    expect(pick('CA-native-dur').call_duration).toBe(61);
  });

  // A ZERO duration is ABSENT, not a duration. The importer derives its outcome
  // FROM the duration, so every imported MISS carries a literal 0 next to
  // 'no_answer'; projecting it made the card read "Incoming call - Missed - 0s",
  // because the client's formatDuration(0) returns the truthy string "0s". The
  // native path can reach it too (a DialCallDuration of '0'). The live WRITE side
  // already refuses to store a duration for a call that never connected.
  it('treats a NON-POSITIVE call duration as absent, on both the imported and the native field', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-imported-zero',
      providerTs: '2026-06-16T10:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
    });
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-native-zero',
      providerTs: '2026-06-16T11:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'tenant',
      deliveryStatus: 'delivered',
      callDuration: 0,
    });
    // The importer's own pairing: duration 0 and the out-of-union 'no_answer'
    // outcome are written together on the SAME row (lib/import/apply.ts).
    const imported = world.messages.find((m) => m.provider_sid === 'CA-imported-zero')!;
    (imported as Record<string, unknown>)['call_duration_seconds'] = 0;
    (imported as Record<string, unknown>)['call_outcome'] = 'no_answer';

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const calls = res.body.items.filter((i: { kind: string }) => i.kind === 'call');
    const pick = (sid: string) => calls.find((c: { id: string }) => c.id.includes(sid));

    // The outcome still projects - only the meaningless duration is dropped.
    expect(pick('CA-imported-zero').call_outcome).toBe('missed');
    expect(pick('CA-imported-zero').call_duration).toBeUndefined();
    expect(pick('CA-native-zero').call_duration).toBeUndefined();
  });

  it('projects every field the dashboard TimelineCall declares REQUIRED (manual cross-package mirror)', async () => {
    // There is NO cross-package type check: a projection that omits `direction`
    // type-checks clean on BOTH sides and fails only in the browser. This list is
    // a MANUAL mirror of the REQUIRED keys on `TimelineCall` in
    // dashboard/src/api/types.ts (plus its TimelineBase). It does not update
    // itself - if that interface gains a required field, add it here by hand.
    const DASHBOARD_REQUIRED_KEYS = ['kind', 'id', 'at', 'direction'];

    seedContact();
    seedConversation('conv-a', PHONE_A);
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-shape',
      providerTs: '2026-06-16T10:00:00.000Z',
      type: 'call',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'sent',
      callStatus: 'ringing',
    });

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const call = res.body.items.find((i: { kind: string }) => i.kind === 'call');
    for (const key of DASHBOARD_REQUIRED_KEYS) {
      expect(Object.keys(call)).toContain(key);
      expect(call[key]).toBeDefined();
    }
  });

  it('D12 seam: a refusal-stamped row (canceled, no outcome) presents as "Not completed" end to end', async () => {
    // The ONE test that spans the projection/presenter boundary. With the
    // `?? 'missed'` default restored on the server, this row arrives as
    // call_outcome: 'missed', the presenter's canceled clause never fires, and
    // the card reads "No answer" - the false attribution D12 exists to remove -
    // with every other gate still green.
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await world.messagesRepo.append({
      conversationId: 'conv-a',
      providerSid: 'CA-refused',
      providerTs: '2026-06-16T10:00:00.000Z',
      type: 'call',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'sent',
      callStatus: 'ringing',
    });
    // The gate refusal stamp: a terminal `canceled` with NO outcome.
    await world.messagesRepo.updateCallStatus('CA-refused', { callStatus: 'canceled' });

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    const call = res.body.items.find((i: { kind: string }) => i.kind === 'call');
    expect(call.call_status).toBe('canceled');
    expect(call.call_outcome).toBeUndefined();

    // Straight into the real client presenter, with the wire payload's own values.
    const presented = presentCallState({
      direction: call.direction,
      callStatus: call.call_status,
      callOutcome: call.call_outcome,
      at: call.at,
      now: Date.parse(call.at) + 5_000,
    });
    expect(presented.label).toBe('Not completed');
    expect(presented.tone).toBe('neutral');
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

  it('excludes relay_group threads (relay-group content is never inlined)', async () => {
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
    await world.auditRepo.append('units#u1', 'tour_scheduled', { tourId: 't1' }); // EXCLUDED (person feed owns tours)
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
    // ONLY the two remaining lifecycle rows interleave - the unit_updated
    // field-edit is filtered out (never surfaced on any timeline; it stays in the
    // audit trail), the historical listing_response_set row maps to null (stops
    // rendering), and tour_* rows no longer interleave AT ALL: the landlord's own
    // person feed carries those pins directly (contact-comms-pane).
    expect(ms).toHaveLength(2);
    const types = ms.map((m: { type: string }) => m.type);
    expect(types).not.toContain('tour_scheduled');
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

  // WS3's paging claim, which was previously verified only by code reading.
  //
  // The property-audit candidate keys on the RAW audit SK (`<ISO>#<rand>`), so a
  // page-2 cursor anchored on a property row is handed straight back to
  // `auditRepo.listByEntity` as a `before` bound. The real repo compares that
  // LEXICALLY; the in-memory fake used to parse it with `Number(...)`, which is
  // `NaN` for an ISO SK and silently turned the bound into a no-op - so the fake
  // could not exercise this path at all, and a regression in it would not have
  // been caught. That `Number(...)` bug was ALREADY fixed before this test
  // existed - the fake compares lexically today (twilioWebhookHarness.ts,
  // `listByEntity`). What was missing was any test that exercised the bound:
  // the file's other paging test walks MESSAGES only, so no page boundary ever
  // landed on an audit row. This is that test.
  // See docs/issues/audit-fake-before-cursor-fidelity.md.
  it('pages across a PROPERTY-AUDIT boundary with no dups and no skips', async () => {
    const h = makeWebhookHarness();
    const app = h.app;
    const world = h.world;
    world.contacts.push({
      contactId: 'll3',
      type: 'landlord',
      status: 'active',
      phone: '+15550100013',
      phones: [{ phone: '+15550100013', primary: true }],
    });
    world.units.set('u5', { unitId: 'u5', landlordId: 'll3', status: 'available' });

    // FIVE interleaving lifecycle rows, so a limit of 2 forces every page
    // boundary to land ON a property-audit row - which is the only shape that
    // exercises the audit `before` bound.
    for (let i = 0; i < 5; i += 1) {
      await world.auditRepo.append('units#u5', 'broadcast_sent', {
        broadcastId: `bp-${i}`,
        tenantCount: i + 1,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string =
        cursor === null
          ? '/api/contacts/ll3/timeline?limit=2'
          : `/api/contacts/ll3/timeline?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await authedGet(app, url);
      expect(res.status).toBe(200);
      for (const item of res.body.items as Array<{ id: string }>) seen.push(item.id);
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(seen).toHaveLength(5); // no skips
    expect(new Set(seen).size).toBe(5); // no dups
    expect(pages).toBeGreaterThanOrEqual(3); // really paginated (2+2+1)
  });

  it('shows a landlord tour pin ONCE, sourced from the person feed (not the property audit)', async () => {
    const h = makeWebhookHarness();
    const app = h.app;
    const world = h.world;
    world.contacts.push({
      contactId: 'll2',
      type: 'landlord',
      status: 'active',
      phone: '+15550100011',
      phones: [{ phone: '+15550100011', primary: true }],
    });
    world.units.set('u3', { unitId: 'u3', landlordId: 'll2', status: 'available' });
    // BOTH sources exist for the same tour, exactly as the live writers leave
    // them: the units# audit row (the property Activity card's source) AND the
    // landlord's own dual-party activity event.
    await world.auditRepo.append('units#u3', 'tour_scheduled', { tourId: 't9' });
    await world.activityEventsRepo.record({
      contactId: 'll2',
      type: 'tour_scheduled',
      label: 'Tour scheduled',
      refType: 'tour',
      refId: 't9',
    });
    // A broadcast row has no direct-event equivalent, so it STILL interleaves.
    await world.auditRepo.append('units#u3', 'broadcast_sent', { broadcastId: 'b9', tenantCount: 2 });

    const res = await authedGet(app, '/api/contacts/ll2/timeline');
    expect(res.status).toBe(200);

    const ms = res.body.items.filter((i: { kind: string }) => i.kind === 'milestone');
    const tours = ms.filter((m: { refType?: string }) => m.refType === 'tour');
    expect(tours).toHaveLength(1);
    expect(tours[0]).toMatchObject({
      type: 'tour_scheduled',
      label: 'Tour scheduled',
      refType: 'tour',
      refId: 't9',
    });
    expect(ms.some((m: { refType?: string }) => m.refType === 'broadcast')).toBe(true);
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

// Tour bodies are COMPOSED, not resolved: every tour.* default carries at least
// one required token, so the expectation has to be built from the same context
// the route composes from - this bucket's tour instant, the org-default zone the
// quiet-hours window resolves to (the stubs all inherit
// DEFAULT_ORG_SETTINGS.timezone), no address (these fixtures seed no unit) and
// no names.
// `names: {}` is the fixtures' REAL value: no contact in this file carries a
// firstName, so the route composes the "Hey there," fallbacks. `tourType` is
// VALUE-IRRELEVANT for these two kinds - only the en_route rung forks on it
// (tourCopy.ts idFor) - so 'self_guided' cannot disagree with the landlord_led
// fixtures further down.
/** The instant every tour fixture in this bucket books. */
const TOUR_AT = '2099-01-10T10:00:00.000Z';
const CONFIRMATION_BODY = composeTourReminderBody({
  kind: 'confirmation',
  scheduledAt: TOUR_AT,
  timezone: DEFAULT_ORG_SETTINGS.timezone,
  tourType: 'self_guided',
  names: {},
});
const MORNING_OF_BODY = composeTourReminderBody({
  kind: 'morning_of',
  scheduledAt: TOUR_AT,
  timezone: DEFAULT_ORG_SETTINGS.timezone,
  tourType: 'self_guided',
  names: {},
});
const DAY_BEFORE_BODY = composeTourReminderBody({
  kind: 'day_before',
  scheduledAt: TOUR_AT,
  timezone: DEFAULT_ORG_SETTINGS.timezone,
  tourType: 'self_guided',
  names: {},
});
const APPROVAL_BODY = resolveMessage('nudge.approval_check');

/** What a re-pause of ONE live tour kind looks like. Production pauses nothing
 *  since 2026-08-31 (Phase B), so every `paused` case here injects this. */
const PAUSE_DAY_BEFORE: ReadonlySet<ReminderKind> = new Set<ReminderKind>(['day_before']);

describe('GET /api/contacts/:id/timeline — scheduled upcoming[] gather (Part B server)', () => {
  it('the production tour hold-back is empty - nothing is paused by default', () => {
    // The unpause, on the surface that mirrors it. Without this pin every
    // `paused` case below could be green while production held everything back.
    expect(MANUAL_ONLY_REMINDER_KINDS.size).toBe(0);
  });

  function makeGatherHarness(
    // Quiet hours OFF by default so these cases keep asserting the pre-quiet
    // reasons regardless of the time of day the suite runs; the quiet cases
    // pass a window-around-now stub explicitly.
    settingsRepo: SettingsReadRepo = quietOffSettingsRepo(),
    // The manual-only hold-back defaults to EMPTY here, which since 2026-08-31
    // is also the PRODUCTION default (Phase B emptied
    // MANUAL_ONLY_REMINDER_KINDS). The parameter is kept because it is now the
    // only way to reach pause-mode behaviour at all: the cases below that assert
    // `paused` pass a non-empty set explicitly.
    manualOnlyReminderKinds: ReadonlySet<ReminderKind> = new Set(),
    // The nudge ladder's hold-back, off by default for the same reason.
    manualOnlyNudgeKinds: ReadonlySet<NudgeKind> = new Set(),
  ): { world: FakeWorld; app: Express } {
    const world = createFakeWorld();
    const logger = createLogger({ destination: createLogCapture().stream });
    const config = {
      smsSendingEnabled: true,
      businessPhoneNumber: OUR_NUMBER,
      relayPreferredAreaCodes: [],
    } as unknown as AppConfig;
    const router = createContactTimelineRouter({
      logger,
      config,
      settingsRepo,
      contactsRepo: world.contactsRepo,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      activityEventsRepo: world.activityEventsRepo,
      toursRepo: world.toursRepo,
      tourRemindersRepo: world.tourRemindersRepo,
      placementNudgesRepo: world.placementNudgesRepo,
      placementsRepo: world.placementsRepo,
      unitsRepo: world.unitsRepo,
      manualOnlyReminderKinds,
      manualOnlyNudgeKinds,
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
    // Insert out of dueAt order to prove the ascending sort. BOTH rungs are
    // LIVE kinds: this case asserts NO suppression, and a discontinued rung
    // carries one unconditionally (spec 3.1a).
    await world.tourRemindersRepo.create({ tourId: tour.tourId, kind: 'day_before', dueAt: '2099-01-09T10:00:00.000Z' });
    await world.tourRemindersRepo.create({ tourId: tour.tourId, kind: 'morning_of', dueAt: '2099-01-05T10:00:00.000Z' });

    const res = await request(app).get('/api/contacts/ct-1/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(2);
    expect(up.every((i) => i.kind === 'scheduled' && i.source === 'tour_reminder')).toBe(true);
    expect(up.map((i) => i.at)).toEqual(['2099-01-05T10:00:00.000Z', '2099-01-09T10:00:00.000Z']);
    expect(up[0]!.reminderKind).toBe('morning_of');
    expect(up[0]!.body).toBe(MORNING_OF_BODY);
    expect(up[1]!.body).toBe(DAY_BEFORE_BODY);
    expect(up.every((i) => i.conversationId === 'conv-ct-1')).toBe(true);
    expect(up.every((i) => i.suppression === undefined)).toBe(true);
    expect(up[0]!.refType).toBe('tour');
    expect(up[0]!.refId).toBe(tour.tourId);
    // The response carries the zone those bodies were composed in (spec D8), so
    // each card's fire-time label renders in the zone its body quotes rather
    // than in whatever zone the navigator's browser happens to sit in.
    expect(res.body.timezone).toBe(DEFAULT_ORG_SETTINGS.timezone);
  });

  // Manual-only hold-back: the contact page's Upcoming cards must agree with the
  // tour panel. A rung the poll will never claim cannot advertise "sends in 3h"
  // here while the panel calls it paused. Production pauses nothing today
  // (2026-08-31), so the set is INJECTED - this is the mechanism a future
  // re-pause would use, and it has to keep working on BOTH surfaces.
  it('marks a paused tour rung `paused` when a kind is held back', async () => {
    const { world, app } = makeGatherHarness(undefined, PAUSE_DAY_BEFORE);
    const phone = '+15550600031';
    world.contacts.push({ contactId: 'ct-paused', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-paused', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-paused',
      unitId: 'u-paused',
      scheduledAt: TOUR_AT,
      tourType: 'self_guided',
    });
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: '2099-01-09T10:00:00.000Z',
    });

    const res = await request(app).get('/api/contacts/ct-paused/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(1);
    expect(up[0]!.suppression).toEqual({ reason: 'paused' });
  });

  // Discontinued kinds (Phase B spec 3.1, row 4). This surface has its OWN
  // read of the kind sets - it does not inherit the tour panel's - and it is
  // the one the design called out as the row most likely to be missed: without
  // it, the contact page would keep promising "sends in 3h" on a rung that can
  // never send, one surface over from the panel that says otherwise.
  it('marks a discontinued tour rung `discontinued`, on the PRODUCTION default (nothing injected)', async () => {
    const { world, app } = makeGatherHarness();
    const phone = '+15550600034';
    world.contacts.push({ contactId: 'ct-disc', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-disc', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-disc',
      unitId: 'u-disc',
      scheduledAt: TOUR_AT,
      tourType: 'self_guided',
    });
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'confirmation',
      dueAt: '2099-01-05T10:00:00.000Z',
    });
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: '2099-01-09T10:00:00.000Z',
    });

    const res = await request(app).get('/api/contacts/ct-disc/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(2);
    expect(up[0]!.reminderKind).toBe('confirmation');
    expect(up[0]!.suppression).toEqual({ reason: 'discontinued' });
    // Never `paused`: the two mean opposite things to an operator, and only one
    // of them leaves Send now working.
    // ANTI-VACUITY: the live rung beside it still promises its send.
    expect(up[1]!.reminderKind).toBe('day_before');
    expect(up[1]!.suppression).toBeUndefined();
  });

  it('discontinued OUTRANKS an opted-out contact on the timeline too', async () => {
    // The same terminal-beats-everything rule the tour panel pins (spec 3.1a).
    const { world, app } = makeGatherHarness();
    const phone = '+15550600035';
    world.contacts.push({
      contactId: 'ct-disc-opt',
      type: 'tenant',
      status: 'active',
      phone,
      sms_opt_out: true,
    });
    seedConv(world, 'conv-ct-disc-opt', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-disc-opt',
      unitId: 'u-disc-opt',
      scheduledAt: TOUR_AT,
      tourType: 'self_guided',
    });
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'confirmation',
      dueAt: '2099-01-05T10:00:00.000Z',
    });
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: '2099-01-09T10:00:00.000Z',
    });

    const res = await request(app).get('/api/contacts/ct-disc-opt/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up[0]!.suppression).toEqual({ reason: 'discontinued' });
    // The opt-out is genuinely live - so the line above is a precedence proof.
    expect(up[1]!.suppression).toEqual({ reason: 'contact_opted_out' });
  });

  it('marks a paused NUDGE rung `paused` under the PRODUCTION hold-back', async () => {
    // The other ladder, held back since 2026-08-18. Its cards had the same
    // "sending shortly" lie until the tour pause brought the machinery in.
    const { world, app } = makeGatherHarness(undefined, new Set(), MANUAL_ONLY_NUDGE_KINDS);
    const phone = '+15550600033';
    world.contacts.push({ contactId: 'ct-nudge-paused', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-nudge-paused', phone, 'tenant_1to1');
    // receipt_check, NOT approval_check: this walk surfaces only the rungs whose
    // recipient is the TENANT, and approval_check goes to the landlord - seeding
    // one here would leave the bucket empty and pass every assertion vacuously.
    const placement = await world.placementsRepo.create({
      tenantId: 'ct-nudge-paused',
      unitId: 'u-nudge-paused',
      stage: 'awaiting_receipt',
    });
    await world.placementNudgesRepo.create({
      placementId: placement.placementId,
      kind: 'receipt_check',
      dueAt: '2099-01-09T10:00:00.000Z',
    });

    const res = await request(app).get('/api/contacts/ct-nudge-paused/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(1);
    expect(up[0]!.suppression).toEqual({ reason: 'paused' });
  });

  it('the two ladders hold back independently: a paused TOUR rung leaves nudges alone', async () => {
    // The tour pause must not leak onto the other ladder (and vice versa) - two
    // independent sets, two independent decisions. Live proof of the asymmetry
    // today: MANUAL_ONLY_NUDGE_KINDS is still full while
    // MANUAL_ONLY_REMINDER_KINDS is empty, so the tour side is injected.
    const { world, app } = makeGatherHarness(undefined, PAUSE_DAY_BEFORE);
    const phone = '+15550600032';
    world.contacts.push({ contactId: 'ct-nudge', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-nudge', phone, 'tenant_1to1');
    const placement = await world.placementsRepo.create({
      tenantId: 'ct-nudge',
      unitId: 'u-nudge',
      stage: 'awaiting_receipt',
    });
    await world.placementNudgesRepo.create({
      placementId: placement.placementId,
      kind: 'receipt_check',
      dueAt: '2099-01-09T10:00:00.000Z',
    });

    const res = await request(app).get('/api/contacts/ct-nudge/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    // A real nudge card, NOT an empty bucket - otherwise "nothing is paused"
    // would be true for the wrong reason.
    expect(up).toHaveLength(1);
    expect(up[0]!.source).toBe('placement_nudge');
    expect(up[0]!.suppression).toBeUndefined();
  });

  it('reads the org window ONLY when the gather runs: no settings read and NO timezone on a kinds=message request', async () => {
    // The other half of the rule above. /timeline is one of the hottest read
    // paths in the dashboard (contact page + both 1:1 comms tabs, refetched on
    // every debounced SSE burst); a request that can carry no scheduled item -
    // a kinds filter without `scheduled`, a cursor page, or a deployment with no
    // scheduled repos - must pay no settings GetItem and must not advertise a
    // zone for a bucket that is empty by construction.
    let reads = 0;
    const counting: SettingsReadRepo = {
      async getOrgSettings() {
        reads += 1;
        return quietOffSettingsRepo().getOrgSettings();
      },
    };
    const { world, app } = makeGatherHarness(counting);
    const phone = '+15550600011';
    world.contacts.push({ contactId: 'ct-tz', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-tz', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-tz',
      unitId: 'u-tz',
      scheduledAt: TOUR_AT,
      tourType: 'self_guided',
    });
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'confirmation',
      dueAt: '2099-01-05T10:00:00.000Z',
    });

    const filtered = await request(app).get('/api/contacts/ct-tz/timeline?kinds=message');
    expect(filtered.status).toBe(200);
    expect(filtered.body.upcoming).toEqual([]);
    expect(filtered.body.timezone).toBeUndefined();
    expect(reads).toBe(0);

    // ...and the gathering shape still reads it exactly once and reports it.
    const gathered = await request(app).get('/api/contacts/ct-tz/timeline');
    expect(gathered.status).toBe(200);
    expect(gathered.body.upcoming).toHaveLength(1);
    expect(gathered.body.timezone).toBe(DEFAULT_ORG_SETTINGS.timezone);
    expect(reads).toBe(1);
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
    // A LIVE kind: discontinued outranks the opt-out (spec 3.1a), so riding
    // `confirmation` here would silently stop testing the opt-out. The
    // discontinued/opt-out precedence has its own case below.
    await world.tourRemindersRepo.create({ tourId: tour.tourId, kind: 'day_before', dueAt: '2099-01-05T10:00:00.000Z' });

    const res = await request(app).get('/api/contacts/ct-5/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(1);
    expect(up[0]!.suppression).toEqual({ reason: 'contact_opted_out' });
  });

  // Quiet hours (spec 2026-08-03): the timeline is the THIRD evaluator caller,
  // so a rung deferred by the window must read the same here as on the tour /
  // placement panels - including the per-RUNG scoping: the chip is a claim
  // about the future, so it follows each rung's own dueAt against the
  // daily-recurring window, not the server wall clock. The window stub is built
  // from the current time (never a fixed HH:MM - time-of-day dependent).
  it('inside the quiet window BOTH ladders carry suppression quiet_hours', async () => {
    const { world, app } = makeGatherHarness(quietNowSettingsRepo());
    const phone = '+15550600007';
    world.contacts.push({ contactId: 'ct-7', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-7', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-7',
      unitId: 'u-7',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'self_guided',
    });
    // Both rungs are due at the same wall time tomorrow: inside TOMORROW's
    // occurrence of the window (the rung due later sorts second). A LIVE kind -
    // discontinued outranks quiet hours and would mask it (spec 3.1a).
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'morning_of',
      dueAt: isoHoursFromNow(24),
    });
    const placement = await world.placementsRepo.create({
      tenantId: 'ct-7',
      unitId: 'u-7',
      stage: 'awaiting_receipt',
    });
    await world.placementNudgesRepo.create({
      placementId: placement.placementId,
      kind: 'receipt_check',
      dueAt: isoHoursFromNow(24.5),
    });

    const res = await request(app).get('/api/contacts/ct-7/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(2);
    expect(up.map((i) => i.source)).toEqual(['tour_reminder', 'placement_nudge']);
    expect(up.every((i) => JSON.stringify(i.suppression) === JSON.stringify({ reason: 'quiet_hours' }))).toBe(true);
  });

  // THE THIRD SITE of the en_route quiet-hours exemption (Phase B spec 6
  // addendum), on the surface that aggregates BOTH ladders. The exemption is
  // applied at the REMINDER call site of suppressionFor - never inside
  // suppressionFor or quietFor themselves, which the placement-nudge walk above
  // shares: a placement nudge has no en_route and must keep its quiet
  // suppression untouched, which the nudge in this fixture proves.
  it('never chips quiet_hours on an en_route rung, while its day_before sibling and a placement nudge still do', async () => {
    const { world, app } = makeGatherHarness(quietNowSettingsRepo());
    const phone = '+15550600021';
    world.contacts.push({ contactId: 'ct-21', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-21', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-21',
      unitId: 'u-21',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'self_guided',
    });
    // Same wall time tomorrow for both rungs - inside TOMORROW's occurrence of
    // the window. Only the KIND differs, which is what makes this a control.
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'en_route',
      dueAt: isoHoursFromNow(24),
    });
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: isoHoursFromNow(24.5),
    });
    const placement = await world.placementsRepo.create({
      tenantId: 'ct-21',
      unitId: 'u-21',
      stage: 'awaiting_receipt',
    });
    await world.placementNudgesRepo.create({
      placementId: placement.placementId,
      kind: 'receipt_check',
      // Still inside tomorrow's occurrence (the stub window is now-1h..now+1h),
      // just after the two rungs so the ordering below is deterministic.
      dueAt: isoHoursFromNow(24.75),
    });

    const res = await request(app).get('/api/contacts/ct-21/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(3);
    expect(up[0]!.reminderKind).toBe('en_route');
    expect(up[0]!.suppression).toBeUndefined();
    expect(up[1]!.reminderKind).toBe('day_before');
    expect(up[1]!.suppression).toEqual({ reason: 'quiet_hours' });
    // The SHARED helper is untouched: the placement ladder still chips.
    expect(up[2]!.source).toBe('placement_nudge');
    expect(up[2]!.suppression).toEqual({ reason: 'quiet_hours' });
  });

  // The SF1 false positive: inside the window the wall clock says "quiet", but a
  // rung due days from now will not wait for tonight's window - while a rung
  // already due IS being held by the fire-time backstop right now.
  it('inside the window, chips only what quiet hours will hold - not every upcoming rung', async () => {
    const { world, app } = makeGatherHarness(quietNowSettingsRepo());
    const phone = '+15550600017';
    world.contacts.push({ contactId: 'ct-17', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-17', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-17',
      unitId: 'u-17',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'self_guided',
    });
    // Already due, with a dueAt outside every occurrence: the poll is deferring
    // it RIGHT NOW (worker-downtime catch-up that crossed the window start).
    // A LIVE kind - discontinued would outrank the quiet estimate (spec 3.1a).
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'morning_of',
      dueAt: isoHoursFromNow(-30),
    });
    // Three days out at a time of day outside EVERY occurrence of the window.
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: isoHoursFromNow(3 * 24 + 6),
    });

    const res = await request(app).get('/api/contacts/ct-17/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(2);
    expect(up[0]!.reminderKind).toBe('morning_of');
    expect(up[0]!.suppression).toEqual({ reason: 'quiet_hours' });
    expect(up[1]!.reminderKind).toBe('day_before');
    expect(up[1]!.suppression).toBeUndefined();
  });

  // The other half of SF1: during business hours a rung genuinely due at 23:00
  // tonight WILL be deferred, so it must chip even though the clock is outside
  // the window - exactly when staff are looking at the timeline.
  it('outside the window, still chips a rung due inside tonight occurrence', async () => {
    const { world, app } = makeGatherHarness(quietLaterSettingsRepo());
    const phone = '+15550600018';
    world.contacts.push({ contactId: 'ct-18', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-18', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-18',
      unitId: 'u-18',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'self_guided',
    });
    // Future, but before the window opens. A LIVE kind (spec 3.1a).
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'morning_of',
      dueAt: isoHoursFromNow(1),
    });
    // Inside tonight's occurrence.
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: isoHoursFromNow(4),
    });

    const res = await request(app).get('/api/contacts/ct-18/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(2);
    expect(up[0]!.reminderKind).toBe('morning_of');
    expect(up[0]!.suppression).toBeUndefined();
    expect(up[1]!.reminderKind).toBe('day_before');
    expect(up[1]!.suppression).toEqual({ reason: 'quiet_hours' });
  });

  // N1 (stalled-poller edge): once the window has ENDED, an overdue rung is one
  // poll tick from sending - "Will wait" would be a lie about the past. Its
  // in-window dueAt must not chip it via the rung-time disjunct; only a rung
  // still in the FUTURE reads its own dueAt against the window.
  it('outside the window, an OVERDUE rung with an in-window dueAt is not chipped', async () => {
    const { world, app } = makeGatherHarness(quietLaterSettingsRepo());
    const phone = '+15550600019';
    world.contacts.push({ contactId: 'ct-19', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-19', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-19',
      unitId: 'u-19',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'self_guided',
    });
    // Overdue, and its wall time sits inside a PAST occurrence of the window
    // (-20h = the same wall time as +4h): the poller already released it when
    // that occurrence ended, so nothing is holding it now. A LIVE kind
    // (spec 3.1a) - a discontinued rung is chipped unconditionally.
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: isoHoursFromNow(-20),
    });

    const res = await request(app).get('/api/contacts/ct-19/timeline');
    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(1);
    expect(up[0]!.suppression).toBeUndefined();
  });

  it('an opted-out tenant inside the quiet window still reports contact_opted_out (quiet is LAST)', async () => {
    const { world, app } = makeGatherHarness(quietNowSettingsRepo());
    const phone = '+15550600008';
    world.contacts.push({ contactId: 'ct-8', type: 'tenant', status: 'active', phone, sms_opt_out: true });
    seedConv(world, 'conv-ct-8', phone, 'tenant_1to1');
    const tour = await world.toursRepo.create({
      tenantId: 'ct-8',
      unitId: 'u-8',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'self_guided',
    });
    // Inside tomorrow's occurrence, so quiet hours WOULD chip this rung on its
    // own - the opt-out has to outrank it, not merely fill a gap. A LIVE kind:
    // discontinued outranks BOTH and would make this pass for the wrong reason.
    await world.tourRemindersRepo.create({
      tourId: tour.tourId,
      kind: 'day_before',
      dueAt: isoHoursFromNow(24),
    });

    const res = await request(app).get('/api/contacts/ct-8/timeline');
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

  it('an uncomposable tour empties ONLY its own rung - the rest of the bucket survives', async () => {
    // READ-PATH CONTAINMENT (spec F1), and the failure mode here is NOT a 500:
    // an uncontained throw lands in the gather's own catch, which returns `[]`
    // and silently deletes the OTHER tours AND both nudge walks from the page.
    // So the assertion is that the bucket SURVIVES, not merely that we got 200.
    const { world, app } = makeGatherHarness();
    const phone = '+15550600009';
    world.contacts.push({ contactId: 'ct-9', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-9', phone, 'tenant_1to1');

    const goodTour = await world.toursRepo.create({
      tenantId: 'ct-9',
      unitId: 'u-9-good',
      scheduledAt: '2099-01-10T10:00:00.000Z',
      tourType: 'self_guided',
    });
    await world.tourRemindersRepo.create({
      tourId: goodTour.tourId,
      kind: 'confirmation',
      dueAt: '2099-01-05T10:00:00.000Z',
    });
    const badTour = await world.toursRepo.create({
      tenantId: 'ct-9',
      unitId: 'u-9-bad',
      scheduledAt: '2099-01-12T10:00:00.000Z',
      tourType: 'self_guided',
    });
    await world.tourRemindersRepo.create({
      tourId: badTour.tourId,
      kind: 'day_before',
      dueAt: '2099-01-11T10:00:00.000Z',
    });
    // Corrupt AFTER arming - the only way to reach this state.
    await world.toursRepo.patch(badTour.tourId, { scheduledAt: 'not-an-instant' });

    // A tenant-recipient nudge from walk 2: it shares the bucket, so it proves
    // the OTHER walks are untouched by the tour walk's bad row.
    const placement = await world.placementsRepo.create({
      tenantId: 'ct-9',
      unitId: 'u-9-good',
      stage: 'awaiting_receipt',
    });
    await world.placementNudgesRepo.create({
      placementId: placement.placementId,
      kind: 'receipt_check',
      dueAt: '2099-02-01T10:00:00.000Z',
    });

    const res = await request(app).get('/api/contacts/ct-9/timeline');

    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(3);
    const bad = up.find((i) => i.refId === badTour.tourId)!;
    expect(bad.body).toBe('');
    expect(bad.reminderKind).toBe('day_before');
    const good = up.find((i) => i.refId === goodTour.tourId)!;
    expect(good.body).toBe(CONFIRMATION_BODY);
    expect(up.some((i) => i.source === 'placement_nudge')).toBe(true);
  });

  // Expected GREEN on first run (Task 4 built the memo) - this is a DRIFT PIN
  // on spec 6.3a's batching rule, on the ONE surface that memoizes property
  // names by unitId. It is where a wrong cache key would stamp one person's
  // name onto every row, which is the exact bug 6.3a names.
  it('pin 7: property names are memoized PER UNIT and rendered per unit (one unit read for two tours at one property)', async () => {
    const { world, app } = makeGatherHarness();
    const phone = '+15550600051';
    world.contacts.push({ contactId: 'ct-pin7', type: 'tenant', status: 'active', phone });
    seedConv(world, 'conv-ct-pin7', phone, 'tenant_1to1');
    for (const [unitId, contactId, firstName] of [
      ['u-pin7-a', 'c-pin7-dana', 'Dana'],
      ['u-pin7-b', 'c-pin7-lee', 'Lee'],
    ]) {
      world.units.set(unitId!, {
        unitId: unitId!,
        landlordId: contactId!,
        status: 'available',
        created_at: '2026-07-13T00:00:00.000Z',
        updated_at: '2026-07-13T00:00:00.000Z',
      });
      world.contacts.push({
        contactId: contactId!,
        type: 'landlord',
        status: 'active',
        phone: firstName === 'Dana' ? '+15550600052' : '+15550600053',
        firstName: firstName!,
      });
    }
    // COUNT the unit reads. The stub is wrapped AFTER seeding so only the
    // gather's own reads are counted.
    const unitReadIds: string[] = [];
    const realUnitGet = world.unitsRepo.getById.bind(world.unitsRepo);
    world.unitsRepo.getById = async (unitId: string) => {
      unitReadIds.push(unitId);
      return realUnitGet(unitId);
    };
    // landlord_led with NO groupThreadId: the group is unusable, so the walk
    // INCLUDES these tours on the tenant 1:1. Two units, THREE tours - the
    // third shares unit A, which is what makes the memo observable.
    const tourIds: string[] = [];
    for (const unitId of ['u-pin7-a', 'u-pin7-b', 'u-pin7-a']) {
      const tour = await world.toursRepo.create({
        tenantId: 'ct-pin7',
        unitId,
        scheduledAt: TOUR_AT,
        tourType: 'landlord_led',
      });
      await world.tourRemindersRepo.create({
        tourId: tour.tourId,
        kind: 'en_route',
        dueAt: '2099-01-10T09:00:00.000Z',
      });
      tourIds.push(tour.tourId);
    }

    const res = await request(app).get('/api/contacts/ct-pin7/timeline');

    expect(res.status).toBe(200);
    const up = res.body.upcoming as Array<Record<string, unknown>>;
    expect(up).toHaveLength(3);
    const bodyFor = (tourId: string): string =>
      up.find((i) => i.refId === tourId)!.body as string;
    expect(bodyFor(tourIds[0]!)).toContain('Dana will be headed');
    expect(bodyFor(tourIds[1]!)).toContain('Lee will be headed');
    expect(bodyFor(tourIds[2]!)).toContain('Dana will be headed');
    // ONE read for the shared unit, not two.
    expect(unitReadIds.filter((id) => id === 'u-pin7-a')).toHaveLength(1);
  });
});
