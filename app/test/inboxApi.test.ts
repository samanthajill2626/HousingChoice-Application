// Task 1 + Task 2 (Contract C8) API tests: GET /api/inbox (Task 1), and the
// mutation routes POST /api/inbox/:contactId/read + POST /api/inbox/read
// (Task 2). Runs on the shared in-memory
// world fakes (makeWebhookHarness) — seed conversations / contacts / messages
// directly, then assert the C8 wire shape end-to-end through the real Express
// router (no mocked handlers).
//
// SCOPE: GET and mutations. Cursor MULTI-PAGE paging is covered by the
// integration test (inbox.integration.test.ts) over real DynamoDB Local.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
} from './helpers/twilioWebhookHarness.js';
import { conversationsForContact } from '../src/lib/contactThreads.js';
import {
  encodeGroupCursor,
  GROUP_TEXT_STATUS,
  type ConversationItem,
} from '../src/repos/conversationsRepo.js';
import { unreadFlagFor } from './helpers/unreadIndexFake.js';
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
    // FLAG IFF COUNT>0, derived centrally (helpers/unreadIndexFake.ts): the
    // sparse byUnread index keys on `unread_flag`, so a fixture with unread and
    // no flag is invisible to every index-fed read. Overridable below.
    ...unreadFlagFor(overrides),
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

  it('surfaces a CONNECTING relay group with a distinct connecting status (D9)', async () => {
    const { app, world } = makeWebhookHarness();
    // A connect-when-ready group: createRelayGroup with NO pool number -> connecting.
    // It must be VISIBLE in the inbox (so staff can open + queue on it) and carry a
    // distinct 'connecting' status (never mis-bucketed as open).
    const connecting = await world.conversationsRepo.createRelayGroup({
      members: [
        { phone: '+15551230001', contactId: 'c1', name: 'Alice' },
        { phone: '+15551230002', contactId: 'c2', name: 'Bob' },
      ],
    });
    expect(connecting.status).toBe('connecting');

    const res = await auth(request(app).get('/api/inbox'));
    expect(res.status).toBe(200);
    const row = res.body.rows.find(
      (r: { conversationId?: string }) => r.conversationId === connecting.conversationId,
    );
    expect(row).toBeDefined();
    expect(row.kind).toBe('relay_group');
    expect(row.status).toBe('connecting'); // distinct - NOT 'open'
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

  it('filter=unread only unread; filter=unknown only needsTriage', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-read', type: 'tenant', phone: '+15550000001' });
    seedContact(world, { contactId: 'c-unread', type: 'tenant', phone: '+15550000002' });
    seedConversation(world, 'conv-read', { participant_phone: '+15550000001', last_activity_at: '2026-06-10T10:00:00.000Z', unread_count: 0 });
    seedConversation(world, 'conv-unread', { participant_phone: '+15550000002', last_activity_at: '2026-06-11T10:00:00.000Z', unread_count: 4 });
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
  });

  it('placementContext is surfaced when the representative conversation has a placementId', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', phone: '+15550000001' });
    seedConversation(world, 'conv-1', { participant_phone: '+15550000001', last_activity_at: '2026-06-12T10:00:00.000Z', placementId: 'placement-1' });
    world.placements.set('placement-1', {
      placementId: 'placement-1',
      tenantId: 'c-1',
      unitId: 'unit-1',
      stage: 'awaiting_inspection',
    });

    const res = await auth(request(app).get('/api/inbox'));
    expect(res.status).toBe(200);
    expect(res.body.rows[0].placementContext).toEqual({ placementId: 'placement-1', label: 'Awaiting inspection' });
  });

  it('400 on an invalid filter value (NOT 500)', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(request(app).get('/api/inbox?filter=bogus'));
    expect(res.status).toBe(400);
  });

  // Regression pin: the removed "mine" (Assigned to me) filter is no longer in
  // the allowlist, so it 400s like any other unknown value (the surface is gone).
  it('400 on filter=mine now that conversation assignment is removed', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(request(app).get('/api/inbox?filter=mine'));
    expect(res.status).toBe(400);
  });

  it('400 on a malformed cursor (NOT 500)', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(request(app).get('/api/inbox?cursor=not-base64-json!!!'));
    expect(res.status).toBe(400);
  });

  // --- S4: the native group-text filter -------------------------------------
  it('serves filter=groups from the group partition, with no contact or relay rows', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-tenant',
      type: 'tenant',
      firstName: 'Dana',
      lastName: 'Doe',
      phone: '+15550000001',
      created_at: '2026-06-01T00:00:00.000Z',
    });
    seedConversation(world, 'conv-tenant', {
      participant_phone: '+15550000001',
      last_activity_at: '2026-06-14T10:00:00.000Z',
    });
    await world.conversationsRepo.createGroupTextThread({
      conversationId: 'gt-1',
      members: [
        { contactId: 'c-tenant', phone: '+15550000001', name: 'Dana Doe' },
        { contactId: 'c-other', phone: '+15550000009', name: 'Rex Roe' },
      ],
      lastActivityAt: '2026-06-12T10:00:00.000Z',
      preview: 'Saturday works',
    });

    const res = await auth(request(app).get('/api/inbox?filter=groups'));

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      kind: 'group_text',
      conversationId: 'gt-1',
      name: 'With Dana & Rex',
      preview: 'Saturday works',
      needsTriage: false,
    });
    expect(res.body.rows[0].status).toBeUndefined();
  });

  it('400s a cursor whose partition does not match the filter (NOT a 500)', async () => {
    const { app } = makeWebhookHarness();
    // A bare 'open'-partition LastEvaluatedKey replayed into the groups filter.
    const openCursor = Buffer.from(JSON.stringify({ conversationId: 'x' }), 'utf8').toString(
      'base64url',
    );
    const intoGroups = await auth(
      request(app).get(`/api/inbox?filter=groups&cursor=${openCursor}`),
    );
    expect(intoGroups.status).toBe(400);

    // ...and the reverse: a tagged group cursor replayed into the default feed.
    const groupCursor = encodeGroupCursor({ conversationId: 'gt-1' });
    const intoAll = await auth(request(app).get(`/api/inbox?cursor=${groupCursor}`));
    expect(intoAll.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — Mutation tests (POST read + assign fan-outs)
// ---------------------------------------------------------------------------

describe('POST /api/inbox/:contactId/read (C8)', () => {
  it('resets unread across ALL the contact\'s conversations and emits conversation.updated per conversation', async () => {
    const { app, world } = makeWebhookHarness();
    // Contact c-1 owns two numbers; seed a conversation with unread > 0 on each.
    seedContact(world, {
      contactId: 'c-1',
      type: 'tenant',
      phone: '+15550000010',
      created_at: '2026-06-01T00:00:00.000Z',
    });
    await world.contactsRepo.addPhone('c-1', { phone: '+15550000011' });
    seedConversation(world, 'conv-1a', {
      participant_phone: '+15550000010',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      unread_count: 3,
    });
    seedConversation(world, 'conv-1b', {
      participant_phone: '+15550000011',
      last_activity_at: '2026-06-11T10:00:00.000Z',
      unread_count: 2,
    });
    // A second contact's conversation that must NOT be touched.
    seedContact(world, { contactId: 'c-2', type: 'tenant', phone: '+15550000012' });
    seedConversation(world, 'conv-2', {
      participant_phone: '+15550000012',
      last_activity_at: '2026-06-12T10:00:00.000Z',
      unread_count: 5,
    });

    const emittedBefore = world.emitted.length;
    const res = await auth(request(app).post('/api/inbox/c-1/read'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Both conversations zeroed; the other contact's conversation untouched.
    expect(world.conversations.get('conv-1a')?.unread_count).toBe(0);
    expect(world.conversations.get('conv-1b')?.unread_count).toBe(0);
    expect(world.conversations.get('conv-2')?.unread_count).toBe(5);

    // conversation.updated emitted for each zeroed conversation.
    const newEmits = world.emitted.slice(emittedBefore);
    expect(newEmits.every((e) => e.event === 'conversation.updated')).toBe(true);
    const emittedIds = newEmits.map((e) => (e.payload as { conversationId: string }).conversationId).sort();
    expect(emittedIds).toEqual(['conv-1a', 'conv-1b'].sort());
  });

  it('skips conversations already at unread 0 (no redundant emit)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-3', type: 'tenant', phone: '+15550000013' });
    seedConversation(world, 'conv-3a', {
      participant_phone: '+15550000013',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      unread_count: 0,
    });

    const emittedBefore = world.emitted.length;
    const res = await auth(request(app).post('/api/inbox/c-3/read'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // No new emissions (conversation already at 0).
    expect(world.emitted.slice(emittedBefore)).toHaveLength(0);
  });

  it('404 when the contact does not exist', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(request(app).post('/api/inbox/no-such-contact/read'));
    expect(res.status).toBe(404);
  });

  it('401 without a session', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/inbox/c-1/read')
      .set('x-origin-verify', ORIGIN_SECRET);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT PIN (contact-comms-pane spec M3). The tour/placement 1:1 tabs now
// mark-read through THIS contact fan-out instead of one conversation, so the
// group tab's unread depends on the fan-out never touching a relay group. There
// is no type filter in the route: the guarantee is STRUCTURAL - a relay group
// fronts the POOL number as participant_phone and never carries a
// participant_email, so neither of conversationsForContact's queries can return
// one. These tests pin that structure (the harness fakes ARE the GSI predicates:
// participant_phone === phone / participant_email === email), so they would go
// red the day a relay group started carrying a member's number or email.
// ---------------------------------------------------------------------------
describe('relay-group exclusion from the contact fan-out (spec M3 pin)', () => {
  const TENANT_PHONE = '+15550000020';
  const TENANT_EMAIL = 'dana@example.com';
  const POOL_NUMBER = '+15559990001';

  /** A contact + their phone 1:1 + email 1:1 + a relay group they are IN. */
  function seedRelayWorld(world: World): ContactItem {
    const contact = seedContact(world, {
      contactId: 'c-relay-1',
      type: 'tenant',
      firstName: 'Dana',
      lastName: 'Doe',
      phone: TENANT_PHONE,
      email: TENANT_EMAIL,
      created_at: '2026-06-01T00:00:00.000Z',
    });
    seedConversation(world, 'conv-1to1', {
      participant_phone: TENANT_PHONE,
      last_activity_at: '2026-06-10T10:00:00.000Z',
      unread_count: 4,
    });
    seedConversation(world, 'conv-email', {
      participant_phone: '',
      participant_email: TENANT_EMAIL,
      last_activity_at: '2026-06-11T10:00:00.000Z',
      unread_count: 2,
    });
    // The relay group: the POOL number is its participant_phone (createRelayGroup
    // stamps it), the member's own number lives ONLY in the participants roster,
    // and there is no participant_email at all.
    seedConversation(world, 'conv-group', {
      participant_phone: POOL_NUMBER,
      pool_number: POOL_NUMBER,
      type: 'relay_group',
      last_activity_at: '2026-06-12T10:00:00.000Z',
      unread_count: 6,
      participants: [
        { contactId: 'c-relay-1', phone: TENANT_PHONE },
        { contactId: 'c-landlord-1', phone: '+15550000021' },
      ],
    });
    return contact;
  }

  it("returns the contact's 1:1s only - never the relay group they are a member of", async () => {
    const { world } = makeWebhookHarness();
    const contact = seedRelayWorld(world);

    const found = await conversationsForContact(contact, world.conversationsRepo);

    expect(found.map((c) => c.conversationId).sort()).toEqual(['conv-1to1', 'conv-email']);
    expect(found.some((c) => c.type === 'relay_group')).toBe(false);
  });

  it('POST /:contactId/read zeroes every 1:1 and leaves the relay group unread INTACT', async () => {
    const { app, world } = makeWebhookHarness();
    seedRelayWorld(world);

    const res = await auth(request(app).post('/api/inbox/c-relay-1/read'));

    expect(res.status).toBe(200);
    // Both of the person's threads (phone AND email) are read...
    expect(world.conversations.get('conv-1to1')?.unread_count).toBe(0);
    expect(world.conversations.get('conv-email')?.unread_count).toBe(0);
    // ...and the relay group they are in keeps its unread: viewing a 1:1 tab must
    // never clear the Group tab's dot.
    expect(world.conversations.get('conv-group')?.unread_count).toBe(6);
  });
});

// The deleted-contact resurfacing predicate (2026-08-03) is per-conversation
// unread state, so every mark-read path is load-bearing for it. The tour and
// placement 1:1 tabs now fire the CONTACT fan-out, which clears all of a
// person's threads at once - so opening one of those tabs dismisses a
// resurfaced inbox row in a single view. ACCEPTED (contact-page parity, which
// already did exactly this); pinned here so it stays deliberate.
describe('deleted-contact resurfacing x the contact fan-out', () => {
  const DELETED_AT = '2026-08-01T00:00:00.000Z';
  const AFTER = '2026-08-02T00:00:00.000Z';

  it('the fan-out read dismisses a resurfaced row', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-del',
      type: 'tenant',
      firstName: 'Dana',
      lastName: 'Doe',
      phone: '+15550000030',
      deleted_at: DELETED_AT,
      created_at: '2026-06-01T00:00:00.000Z',
    });
    seedConversation(world, 'conv-del', {
      participant_phone: '+15550000030',
      last_activity_at: AFTER,
      unread_count: 2,
    });
    seedMessage(world, 'conv-del', {
      type: 'sms',
      direction: 'inbound',
      body: 'im back',
      provider_ts: AFTER,
    });

    // An unread POST-deletion inbound resurfaces the row (deleted: true).
    const before = await auth(request(app).get('/api/inbox'));
    expect(before.status).toBe(200);
    expect(before.body.rows).toHaveLength(1);
    expect(before.body.rows[0]).toMatchObject({
      contactId: 'c-del',
      deleted: true,
      unreadCount: 2,
    });

    // Viewing their 1:1 tab on a tour/placement page fires exactly this.
    const read = await auth(request(app).post('/api/inbox/c-del/read'));
    expect(read.status).toBe(200);
    expect(world.conversations.get('conv-del')?.unread_count).toBe(0);

    // Nothing unread is left to resurface them: the row is gone.
    const after = await auth(request(app).get('/api/inbox'));
    expect(after.status).toBe(200);
    expect(after.body.rows).toHaveLength(0);
  });
});

describe('Mark UNREAD - the row toggle (POST /api/inbox/:contactId/unread, /api/inbox/unread, /api/conversations/:id/unread)', () => {
  it('flags the contact\'s NEWEST 1:1 thread (never a fan-out), sets the byUnread flag, emits once, and is idempotent', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-mu', type: 'tenant', phone: '+15550000701', firstName: 'Mia', lastName: 'U' } as ContactItem);
    seedConversation(world, 'conv-mu-old', { participant_phone: '+15550000701', last_activity_at: '2026-06-01T10:00:00.000Z' });
    seedConversation(world, 'conv-mu-new', {
      participant_phone: '+15550000701',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'tenant_1to1',
    });
    // Two threads on one phone would not happen for a 1:1 (findByParticipantPhone
    // is keyed by phone), so give the newer one an email identity instead: the
    // contact fan-out gathers phone AND email threads.
    world.conversations.get('conv-mu-new')!.participant_phone = undefined as never;
    (world.conversations.get('conv-mu-new') as ConversationItem & { participant_email?: string }).participant_email = 'mia@example.com';
    (world.contacts.find((c) => c.contactId === 'c-mu') as ContactItem & { email?: string }).email = 'mia@example.com';

    const before = world.emitted.length;
    const res = await auth(request(app).post('/api/inbox/c-mu/unread'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const newest = world.conversations.get('conv-mu-new')!;
    expect(newest.unread_count).toBe(1);
    expect(newest.unread_flag).toBe('unread');
    expect(world.conversations.get('conv-mu-old')!.unread_count ?? 0).toBe(0);
    expect(world.emitted.slice(before).map((e) => e.event)).toEqual(['conversation.updated']);

    // Idempotent: a second flag does not double-count or re-emit.
    const again = await auth(request(app).post('/api/inbox/c-mu/unread'));
    expect(again.status).toBe(200);
    expect(world.conversations.get('conv-mu-new')!.unread_count).toBe(1);
    expect(world.emitted.slice(before)).toHaveLength(1);

    // And it shows in the unread feed + badge like any inbound would.
    const unread = await auth(request(app).get('/api/inbox?filter=unread'));
    expect(unread.body.rows.map((r: { contactId?: string }) => r.contactId)).toContain('c-mu');
    const count = await auth(request(app).get('/api/inbox/unread-count'));
    expect(count.body.unreadCount).toBe(1);

    // Round-trip: Mark read clears it again.
    await auth(request(app).post('/api/inbox/c-mu/read'));
    expect(world.conversations.get('conv-mu-new')!.unread_count).toBe(0);
    expect(world.conversations.get('conv-mu-new')!.unread_flag).toBeUndefined();
  });

  it('404 unknown contact; 409 for a soft-deleted contact (never fakes a fresh inbound); 404 when the contact has no thread', async () => {
    const { app, world } = makeWebhookHarness();
    expect((await auth(request(app).post('/api/inbox/nope/unread'))).status).toBe(404);
    seedContact(world, { contactId: 'c-del', type: 'tenant', phone: '+15550000702', deleted_at: '2026-06-01T00:00:00.000Z' } as ContactItem);
    seedConversation(world, 'conv-del', { participant_phone: '+15550000702', last_activity_at: '2026-06-01T10:00:00.000Z' });
    const del = await auth(request(app).post('/api/inbox/c-del/unread'));
    expect(del.status).toBe(409);
    expect(del.body).toEqual({ error: 'contact_deleted' });
    expect(world.conversations.get('conv-del')!.unread_count ?? 0).toBe(0);
    seedContact(world, { contactId: 'c-bare', type: 'tenant', phone: '+15550000703' } as ContactItem);
    expect((await auth(request(app).post('/api/inbox/c-bare/unread'))).status).toBe(404);
  });

  it('POST /api/inbox/unread { phone } flags an unknown number\'s thread; 400 / 404 like its read twin', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-unk-mu', {
      participant_phone: '+14049820701',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'unknown_1to1',
    });
    const res = await auth(request(app).post('/api/inbox/unread').send({ phone: '+14049820701' }));
    expect(res.status).toBe(200);
    expect(world.conversations.get('conv-unk-mu')!.unread_count).toBe(1);
    expect(world.conversations.get('conv-unk-mu')!.unread_flag).toBe('unread');
    expect((await auth(request(app).post('/api/inbox/unread').send({ phone: 'nope' }))).status).toBe(400);
    expect((await auth(request(app).post('/api/inbox/unread').send({}))).status).toBe(400);
    expect((await auth(request(app).post('/api/inbox/unread').send({ phone: '+14049820799' }))).status).toBe(404);
  });

  it('POST /api/conversations/:id/unread flags an OPEN relay / group thread, refuses a CLOSED relay (409), 404 unknown', async () => {
    const { app, world } = makeWebhookHarness();
    seedConversation(world, 'conv-relay-open', {
      participant_phone: '+15550009001',
      pool_number: '+15550009001',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'relay_group',
      status: 'open',
      participants: [{ contactId: 'c-a', phone: '+15550000711', name: 'A' }],
    });
    seedConversation(world, 'conv-relay-closed', {
      participant_phone: '+15550009002',
      pool_number: '+15550009002',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'relay_group',
      status: 'closed',
      participants: [{ contactId: 'c-b', phone: '+15550000712', name: 'B' }],
    });
    seedConversation(world, 'conv-gt', {
      participant_phone: '',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'group_text',
      status: GROUP_TEXT_STATUS,
    });

    const open = await auth(request(app).post('/api/conversations/conv-relay-open/unread'));
    expect(open.status).toBe(200);
    expect(world.conversations.get('conv-relay-open')!.unread_count).toBe(1);
    expect(open.body.conversation.unread_count).toBe(1);

    const closed = await auth(request(app).post('/api/conversations/conv-relay-closed/unread'));
    expect(closed.status).toBe(409);
    expect(closed.body).toEqual({ error: 'thread_closed' });
    expect(world.conversations.get('conv-relay-closed')!.unread_count ?? 0).toBe(0);

    const gt = await auth(request(app).post('/api/conversations/conv-gt/unread'));
    expect(gt.status).toBe(200);
    expect(world.conversations.get('conv-gt')!.unread_count).toBe(1);
    // group_text keeps its partition status through the flag.
    expect(world.conversations.get('conv-gt')!.status).toBe(GROUP_TEXT_STATUS);

    expect((await auth(request(app).post('/api/conversations/nope/unread'))).status).toBe(404);

    // Each route owns its kind: a 1:1 is refused here (it would route around the
    // contact-level rules), and the inbox routes refuse a thread the unread feed
    // would never show (a closed relay reachable through its pool number).
    seedConversation(world, 'conv-1to1', { participant_phone: '+15550000713', last_activity_at: '2026-06-10T10:00:00.000Z' });
    const oneToOne = await auth(request(app).post('/api/conversations/conv-1to1/unread'));
    expect(oneToOne.status).toBe(409);
    expect(oneToOne.body).toEqual({ error: 'not_a_group_thread' });
    expect(world.conversations.get('conv-1to1')!.unread_count ?? 0).toBe(0);
    const viaPhone = await auth(request(app).post('/api/inbox/unread').send({ phone: '+15550009002' }));
    expect(viaPhone.status).toBe(409);
    expect(viaPhone.body).toEqual({ error: 'thread_closed' });
    expect(world.conversations.get('conv-relay-closed')!.unread_flag).toBeUndefined();
  });
});

// H1.5 - the CONDITIONAL write behind the three routes above. The matrix in the
// previous describe pins WHAT the routes do; these pin HOW they do it, which is
// the whole point of H1: the MU-1 precondition rides the write's own
// ConditionExpression, so a status/type transition committing between the
// route's read and its write LOSES instead of planting an invisible byUnread
// resident. Every arm here is unreachable through the fake's own state machine
// (a correct condition never fails on a row the route just read as eligible),
// so each is staged either with the harness's test-only failure counter or with
// raceOnFirstSetUnread below.
describe('Mark UNREAD - the conditional write, its one retry, and its classification (H1)', () => {
  /**
   * Commit `mutate` on the FIRST setUnread call, then let the real fake decide.
   * This is the concurrent write landing between the route's read and its
   * write - the TOCTOU H1 closes. The in-memory fake cannot produce it on its
   * own, and neither can a correct ConditionExpression.
   */
  function raceOnFirstSetUnread(world: World, mutate: () => void): void {
    const base = world.conversationsRepo.setUnread;
    let fired = false;
    world.conversationsRepo.setUnread = async (conversationId, eligibility) => {
      if (!fired) {
        fired = true;
        mutate();
      }
      return base(conversationId, eligibility);
    };
  }

  /**
   * Hand the ROUTE a stale image carrying a POSITIVE `unread_count` while the
   * stored row stays where it really is (read). This is the eventually
   * consistent read every one of these routes lives on: the fan-in routes Query
   * the `byParticipantPhone` GSI (a lagging projection) and the conversation
   * route does a base-table GetItem with no ConsistentRead. Scoped to the FIRST
   * call of each finder, so markUnread's own re-read still sees the truth.
   *
   * Fix wave 1: a route that pre-checks this count answers 200 with NO write at
   * all, and the client then commits an optimistic unread onto a row the server
   * left read - the silent no-op a to-do affordance must never produce.
   */
  function stalePositiveOnFirstRead(world: World, staleCount: number): void {
    const baseFind = world.conversationsRepo.findByParticipantPhone;
    let findFired = false;
    world.conversationsRepo.findByParticipantPhone = async (phone) => {
      const items = await baseFind(phone);
      if (findFired) return items;
      findFired = true;
      return items.map((c) => ({ ...c, unread_count: staleCount }));
    };
    const baseGet = world.conversationsRepo.getById;
    let getFired = false;
    world.conversationsRepo.getById = async (conversationId) => {
      const item = await baseGet(conversationId);
      if (getFired || item === undefined) return item;
      getFired = true;
      return { ...item, unread_count: staleCount };
    };
  }

  const seedRelayOpen = (world: World, id: string): void => {
    seedConversation(world, id, {
      participant_phone: '+15550009101',
      pool_number: '+15550009101',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'relay_group',
      status: 'open',
      participants: [{ contactId: 'c-h1', phone: '+15550000721', name: 'A' }],
    });
  };

  /** A contact plus the single open 1:1 thread their inbox row shows. */
  const seedContactThread = (world: World, contactId: string, id: string, phone: string): void => {
    seedContact(world, { contactId, type: 'tenant', phone, firstName: 'Rae', lastName: 'H' } as ContactItem);
    seedConversation(world, id, {
      participant_phone: phone,
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'tenant_1to1',
    });
  };

  it('conversation route: a raced condition failure is retried ONCE and succeeds, emitting exactly once', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedRelayOpen(world, 'conv-h1-relay');
    world.failNextSetUnread = 1;

    const before = world.emitted.length;
    const res = await auth(request(app).post('/api/conversations/conv-h1-relay/unread'));
    expect(res.status).toBe(200);
    expect(res.body.conversation.unread_count).toBe(1);
    expect(world.conversations.get('conv-h1-relay')!.unread_flag).toBe('unread');
    expect(world.unreadSetAttempts).toEqual([
      { conversationId: 'conv-h1-relay', bucket: 'relay_group' },
      { conversationId: 'conv-h1-relay', bucket: 'relay_group' },
    ]);
    // ONE write happened, so exactly ONE event describes it.
    expect(world.emitted.slice(before).map((e) => e.event)).toEqual(['conversation.updated']);
  });

  it('conversation route: the retry recomputes the bucket from the RE-READ, not from the stale image', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    // A connecting relay group - eligible in the relay_group bucket.
    seedConversation(world, 'conv-h1-convert', {
      participant_phone: '+15550009102',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'relay_group',
      status: 'connecting',
      participants: [{ contactId: 'c-h1b', phone: '+15550000722', name: 'B' }],
    });
    // convertRelayGroupToGroupText commits mid-flight: the SAME row is now a
    // group text in the group_open partition. This is the one case where a
    // stale bucket wastes the retry and a recomputed one succeeds.
    raceOnFirstSetUnread(world, () => {
      const conv = world.conversations.get('conv-h1-convert')!;
      conv.type = 'group_text';
      conv.status = GROUP_TEXT_STATUS;
    });

    const res = await auth(request(app).post('/api/conversations/conv-h1-convert/unread'));
    expect(res.status).toBe(200);
    expect(world.conversations.get('conv-h1-convert')!.unread_count).toBe(1);
    expect(world.unreadSetAttempts.map((a) => a.bucket)).toEqual(['relay_group', 'group_text']);
  });

  it('conversation route: a TWICE-raced write is terminal - 409 thread_closed, no third attempt, no emit', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedRelayOpen(world, 'conv-h1-twice');
    world.failNextSetUnread = 2;

    const before = world.emitted.length;
    const res = await auth(request(app).post('/api/conversations/conv-h1-twice/unread'));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'thread_closed' });
    expect(world.unreadSetAttempts).toHaveLength(2);
    expect(world.conversations.get('conv-h1-twice')!.unread_count ?? 0).toBe(0);
    expect(world.emitted.slice(before)).toHaveLength(0);
  });

  it('conversation route: a row that VANISHES between the read and the write -> 404 conversation_not_found', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedRelayOpen(world, 'conv-h1-gone');
    raceOnFirstSetUnread(world, () => world.conversations.delete('conv-h1-gone'));

    const res = await auth(request(app).post('/api/conversations/conv-h1-gone/unread'));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'conversation_not_found' });
  });

  it('conversation route: ELIGIBILITY BEFORE COUNT - an ineligible AND unread thread is refused, never reported as success', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    // Arm 1: the route's own pre-check. A closed relay carrying unread residue
    // (the inbound-reflags-closed-relay-group issue) must 409, not 200.
    seedConversation(world, 'conv-h1-residue', {
      participant_phone: '+15550009103',
      pool_number: '+15550009103',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'relay_group',
      status: 'closed',
      unread_count: 3,
      participants: [{ contactId: 'c-h1c', phone: '+15550000723', name: 'C' }],
    });
    const residue = await auth(request(app).post('/api/conversations/conv-h1-residue/unread'));
    expect(residue.status).toBe(409);
    expect(residue.body).toEqual({ error: 'thread_closed' });
    expect(world.conversations.get('conv-h1-residue')!.unread_count).toBe(3);

    // Arm 2: the CLASSIFY path, which is where the ordering can actually be got
    // wrong. The route read an eligible, read thread; a close plus an inbound
    // commit before the write. Count-first would classify this as
    // already-unread and answer 200 for a row the unread feed will never show.
    seedRelayOpen(world, 'conv-h1-raceclose');
    raceOnFirstSetUnread(world, () => {
      const conv = world.conversations.get('conv-h1-raceclose')!;
      conv.status = 'closed';
      conv.unread_count = 5;
      conv.unread_flag = 'unread';
    });
    const raced = await auth(request(app).post('/api/conversations/conv-h1-raceclose/unread'));
    expect(raced.status).toBe(409);
    expect(raced.body).toEqual({ error: 'thread_closed' });
    // One attempt only: the classification is terminal, there is no retry.
    expect(world.unreadSetAttempts.filter((a) => a.conversationId === 'conv-h1-raceclose')).toHaveLength(1);
  });

  it('by-phone route: raced once -> retried and 200; raced twice -> 409 thread_closed with no third attempt', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedConversation(world, 'conv-h1-phone', {
      participant_phone: '+14049820801',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'unknown_1to1',
    });
    world.failNextSetUnread = 1;
    const before = world.emitted.length;
    const once = await auth(request(app).post('/api/inbox/unread').send({ phone: '+14049820801' }));
    expect(once.status).toBe(200);
    expect(once.body).toEqual({ ok: true });
    expect(world.conversations.get('conv-h1-phone')!.unread_count).toBe(1);
    expect(world.unreadSetAttempts).toEqual([
      { conversationId: 'conv-h1-phone', bucket: 'one_to_one' },
      { conversationId: 'conv-h1-phone', bucket: 'one_to_one' },
    ]);
    expect(world.emitted.slice(before).map((e) => e.event)).toEqual(['conversation.updated']);

    // A second row, twice-raced: terminal, and the fan-in vocabulary is
    // thread_closed (these routes named a phone, never this conversation).
    seedConversation(world, 'conv-h1-phone2', {
      participant_phone: '+14049820802',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'unknown_1to1',
    });
    world.unreadSetAttempts.length = 0;
    world.failNextSetUnread = 2;
    const twice = await auth(request(app).post('/api/inbox/unread').send({ phone: '+14049820802' }));
    expect(twice.status).toBe(409);
    expect(twice.body).toEqual({ error: 'thread_closed' });
    expect(world.unreadSetAttempts).toHaveLength(2);
    expect(world.conversations.get('conv-h1-phone2')!.unread_count ?? 0).toBe(0);
  });

  it('by-phone route: a vanished row -> 409 thread_closed (the client named a phone, never a conversation)', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedConversation(world, 'conv-h1-phone-gone', {
      participant_phone: '+14049820803',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'unknown_1to1',
    });
    raceOnFirstSetUnread(world, () => world.conversations.delete('conv-h1-phone-gone'));

    const res = await auth(request(app).post('/api/inbox/unread').send({ phone: '+14049820803' }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'thread_closed' });
  });

  it('by-phone route: ELIGIBILITY BEFORE COUNT - a thread that closes AND gains unread mid-flight is refused', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedConversation(world, 'conv-h1-phone-order', {
      participant_phone: '+14049820804',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'unknown_1to1',
    });
    raceOnFirstSetUnread(world, () => {
      const conv = world.conversations.get('conv-h1-phone-order')!;
      conv.status = 'closed';
      conv.unread_count = 4;
      conv.unread_flag = 'unread';
    });

    const res = await auth(request(app).post('/api/inbox/unread').send({ phone: '+14049820804' }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'thread_closed' });
    expect(world.unreadSetAttempts).toHaveLength(1);
  });

  it('by-contact route: raced once -> retried and 200; raced twice -> 409 thread_closed with no third attempt', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedContactThread(world, 'c-h1-one', 'conv-h1-contact', '+15550000731');
    world.failNextSetUnread = 1;
    const before = world.emitted.length;
    const once = await auth(request(app).post('/api/inbox/c-h1-one/unread'));
    expect(once.status).toBe(200);
    expect(once.body).toEqual({ ok: true });
    expect(world.conversations.get('conv-h1-contact')!.unread_count).toBe(1);
    expect(world.unreadSetAttempts).toEqual([
      { conversationId: 'conv-h1-contact', bucket: 'one_to_one' },
      { conversationId: 'conv-h1-contact', bucket: 'one_to_one' },
    ]);
    expect(world.emitted.slice(before).map((e) => e.event)).toEqual(['conversation.updated']);

    seedContactThread(world, 'c-h1-two', 'conv-h1-contact2', '+15550000732');
    world.unreadSetAttempts.length = 0;
    world.failNextSetUnread = 2;
    const twice = await auth(request(app).post('/api/inbox/c-h1-two/unread'));
    expect(twice.status).toBe(409);
    expect(twice.body).toEqual({ error: 'thread_closed' });
    expect(world.unreadSetAttempts).toHaveLength(2);
    expect(world.conversations.get('conv-h1-contact2')!.unread_count ?? 0).toBe(0);
  });

  it('by-contact route: a vanished row -> 409 thread_closed (the client named a contact, never a conversation)', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedContactThread(world, 'c-h1-gone', 'conv-h1-contact-gone', '+15550000733');
    raceOnFirstSetUnread(world, () => world.conversations.delete('conv-h1-contact-gone'));

    const res = await auth(request(app).post('/api/inbox/c-h1-gone/unread'));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'thread_closed' });
  });

  it('by-contact route: a STALE POSITIVE count from the GSI does NOT short-circuit the write', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedContactThread(world, 'c-h1-stale', 'conv-h1-stale', '+15550000735');
    // The stored row is READ; the participant Query still projects the count it
    // held before the mark-read fan-out landed. The operator's request must be
    // decided by the conditional write, not by that lagging image.
    stalePositiveOnFirstRead(world, 3);

    const before = world.emitted.length;
    const res = await auth(request(app).post('/api/inbox/c-h1-stale/unread'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // The write was ATTEMPTED - a pre-check on the stale count skips it entirely.
    expect(world.unreadSetAttempts).toEqual([
      { conversationId: 'conv-h1-stale', bucket: 'one_to_one' },
    ]);
    // And it LANDED: the row the operator flagged is really unread and really
    // in the byUnread index, so the optimistic row the client keeps is true.
    expect(world.conversations.get('conv-h1-stale')!.unread_count).toBe(1);
    expect(world.conversations.get('conv-h1-stale')!.unread_flag).toBe('unread');
    expect(world.emitted.slice(before).map((e) => e.event)).toEqual(['conversation.updated']);
  });

  it('by-phone route: a STALE POSITIVE count from the GSI does NOT short-circuit the write', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedConversation(world, 'conv-h1-phone-stale', {
      participant_phone: '+14049820805',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'unknown_1to1',
    });
    stalePositiveOnFirstRead(world, 3);

    const before = world.emitted.length;
    const res = await auth(request(app).post('/api/inbox/unread').send({ phone: '+14049820805' }));
    expect(res.status).toBe(200);
    expect(world.unreadSetAttempts).toEqual([
      { conversationId: 'conv-h1-phone-stale', bucket: 'one_to_one' },
    ]);
    expect(world.conversations.get('conv-h1-phone-stale')!.unread_count).toBe(1);
    expect(world.conversations.get('conv-h1-phone-stale')!.unread_flag).toBe('unread');
    expect(world.emitted.slice(before).map((e) => e.event)).toEqual(['conversation.updated']);
  });

  it('conversation route: a STALE POSITIVE count from the base-table read does NOT short-circuit the write', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedRelayOpen(world, 'conv-h1-stale-conv');
    stalePositiveOnFirstRead(world, 3);

    const before = world.emitted.length;
    const res = await auth(request(app).post('/api/conversations/conv-h1-stale-conv/unread'));
    expect(res.status).toBe(200);
    expect(world.unreadSetAttempts).toEqual([
      { conversationId: 'conv-h1-stale-conv', bucket: 'relay_group' },
    ]);
    expect(world.conversations.get('conv-h1-stale-conv')!.unread_count).toBe(1);
    expect(world.conversations.get('conv-h1-stale-conv')!.unread_flag).toBe('unread');
    // The body carries the WRITE's own image, never the stale one it replaced.
    expect(res.body.conversation.unread_count).toBe(1);
    expect(world.emitted.slice(before).map((e) => e.event)).toEqual(['conversation.updated']);
  });

  // D3 (conformance). The fan-in already-unread no-op is pinned by the delivered
  // matrix; this is the conversation route's twin, and after fix wave 1 it runs
  // through markUnread's CLASSIFIED path rather than a pre-check.
  it('conversation route: an ALREADY-unread thread answers 200, writes nothing, and emits no second event', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedRelayOpen(world, 'conv-h1-already');

    const first = await auth(request(app).post('/api/conversations/conv-h1-already/unread'));
    expect(first.status).toBe(200);
    const before = world.emitted.length;
    world.unreadSetAttempts.length = 0;

    const again = await auth(request(app).post('/api/conversations/conv-h1-already/unread'));
    expect(again.status).toBe(200);
    expect(again.body.conversation.conversationId).toBe('conv-h1-already');
    expect(again.body.conversation.unread_count).toBe(1);
    // The write is attempted and REFUSED by its own condition - that refusal is
    // what makes this arm correct rather than a guess off a lagging read.
    expect(world.unreadSetAttempts).toEqual([
      { conversationId: 'conv-h1-already', bucket: 'relay_group' },
    ]);
    // Nothing changed, so nothing is announced: no double-count, no second event.
    expect(world.conversations.get('conv-h1-already')!.unread_count).toBe(1);
    expect(world.emitted.slice(before)).toHaveLength(0);
  });

  it('by-contact route: ELIGIBILITY BEFORE COUNT - a thread that closes AND gains unread mid-flight is refused', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    seedContactThread(world, 'c-h1-order', 'conv-h1-contact-order', '+15550000734');
    raceOnFirstSetUnread(world, () => {
      const conv = world.conversations.get('conv-h1-contact-order')!;
      conv.status = 'closed';
      conv.unread_count = 6;
      conv.unread_flag = 'unread';
    });

    const res = await auth(request(app).post('/api/inbox/c-h1-order/unread'));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'thread_closed' });
    expect(world.unreadSetAttempts).toHaveLength(1);
  });
});

// H2 - MU-2 on the by-phone route. The other two routes already refuse a
// soft-deleted contact (/:contactId/unread via isDeleted; a 1:1 cannot reach
// the conversation route at all), so this was the one way in.
describe('POST /api/inbox/unread { phone } - MU-2, a soft-deleted contact (H2)', () => {
  it('409 contact_deleted for a deleted contact\'s number, 200 for a live one, 200 for a number with no contact at all', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-h2-del',
      type: 'tenant',
      phone: '+14049820901',
      deleted_at: '2026-06-01T00:00:00.000Z',
    } as ContactItem);
    seedConversation(world, 'conv-h2-del', {
      participant_phone: '+14049820901',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'tenant_1to1',
    });
    const del = await auth(request(app).post('/api/inbox/unread').send({ phone: '+14049820901' }));
    expect(del.status).toBe(409);
    expect(del.body).toEqual({ error: 'contact_deleted' });
    // The refusal is a REFUSAL: their row is only ever visible while unread
    // (the resurfacing rule), and a manual flag must not fake a fresh inbound.
    expect(world.conversations.get('conv-h2-del')!.unread_count ?? 0).toBe(0);
    expect(world.conversations.get('conv-h2-del')!.unread_flag).toBeUndefined();

    // A live contact's number is untouched by the new check.
    seedContact(world, {
      contactId: 'c-h2-live',
      type: 'tenant',
      phone: '+14049820902',
      firstName: 'Liv',
    } as ContactItem);
    seedConversation(world, 'conv-h2-live', {
      participant_phone: '+14049820902',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'tenant_1to1',
    });
    const live = await auth(request(app).post('/api/inbox/unread').send({ phone: '+14049820902' }));
    expect(live.status).toBe(200);
    expect(world.conversations.get('conv-h2-live')!.unread_count).toBe(1);

    // A phone with NO contact record is NOT deleted - an untriaged unknown
    // number is exactly what this route exists for and stays markable.
    seedConversation(world, 'conv-h2-unknown', {
      participant_phone: '+14049820903',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'unknown_1to1',
    });
    const unknown = await auth(request(app).post('/api/inbox/unread').send({ phone: '+14049820903' }));
    expect(unknown.status).toBe(200);
    expect(world.conversations.get('conv-h2-unknown')!.unread_count).toBe(1);
  });

  it('the /read twin deliberately keeps NO such check - zeroing a deleted contact\'s unread is harmless', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-h2-read',
      type: 'tenant',
      phone: '+14049820904',
      deleted_at: '2026-06-01T00:00:00.000Z',
    } as ContactItem);
    seedConversation(world, 'conv-h2-read', {
      participant_phone: '+14049820904',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'tenant_1to1',
      unread_count: 2,
    });
    const res = await auth(request(app).post('/api/inbox/read').send({ phone: '+14049820904' }));
    expect(res.status).toBe(200);
    expect(world.conversations.get('conv-h2-read')!.unread_count).toBe(0);
  });
});

describe('POST /api/inbox/read { phone } — unknown number (C8)', () => {
  it('resets unread on the unknown number\'s conversation and emits conversation.updated', async () => {
    const { app, world } = makeWebhookHarness();
    // Unknown number — no contact record.
    seedConversation(world, 'conv-unk-1', {
      participant_phone: '+14049820001',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      type: 'unknown_1to1',
      unread_count: 4,
    });

    const emittedBefore = world.emitted.length;
    const res = await auth(
      request(app).post('/api/inbox/read').send({ phone: '+14049820001' }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.conversations.get('conv-unk-1')?.unread_count).toBe(0);

    const newEmits = world.emitted.slice(emittedBefore);
    expect(newEmits).toHaveLength(1);
    expect(newEmits[0]!.event).toBe('conversation.updated');
    expect((newEmits[0]!.payload as { conversationId: string }).conversationId).toBe('conv-unk-1');
  });

  it('404 when no conversation exists for the phone', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(
      request(app).post('/api/inbox/read').send({ phone: '+14049820099' }),
    );
    expect(res.status).toBe(404);
  });

  it('400 when phone is missing or invalid', async () => {
    const { app } = makeWebhookHarness();

    const noPhone = await auth(request(app).post('/api/inbox/read').send({}));
    expect(noPhone.status).toBe(400);

    const badPhone = await auth(
      request(app).post('/api/inbox/read').send({ phone: 'not-a-number' }),
    );
    expect(badPhone.status).toBe(400);
  });

  it('POST /read does not collide with /:contactId/read routing', async () => {
    // Confirm that a contact literally named "read" (edge case) would route to
    // the correct handler. The /read route (no :contactId segment) and the
    // /:contactId/read route are different depths — no collision.
    const { app } = makeWebhookHarness();
    // Hitting /api/inbox/read with a body (the phone route) must not 404 on
    // "contact not found" — it should 404 on "no_conversation_for_phone".
    const res = await auth(
      request(app).post('/api/inbox/read').send({ phone: '+15550000099' }),
    );
    // 404 means it reached the /read handler (not the /:contactId/read handler
    // which would 404 with a different message).
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_conversation_for_phone');
  });
});

// ---------------------------------------------------------------------------
// GET /api/inbox/unread-count (spec 4.4) - the nav badge's cheap read.
//
// EVERY unread fixture below carries `unread_flag: 'unread'`, because the badge
// reads the SPARSE byUnread index rather than the open partition: a row with an
// unread_count but no flag is simply NOT in the index. The real writers stamp
// the flag inside incrementUnread; these fixtures write the world map directly,
// so they have to state it, and a flagless one would dead-end the test
// green-and-empty while proving nothing.
// ---------------------------------------------------------------------------

interface BadgeCallCounts {
  queryUnreadPage: number;
  findByPhone: number;
  listByConversation: number;
}

/**
 * A world whose three unread-path repos are wrapped in counting proxies (the
 * recording-world idiom from groupTextWebhook.test.ts). The badge's whole claim
 * is ONE index Query and NO hydration; only a call count can tell "cheap" from
 * "cheap-looking", and the proxy forwards to the real fake so the counted run
 * is the same run the assertions read.
 */
function countingWorld(): { world: World; calls: BadgeCallCounts } {
  const world = createFakeWorld();
  const calls: BadgeCallCounts = { queryUnreadPage: 0, findByPhone: 0, listByConversation: 0 };
  const counted = <T extends object>(repo: T): T =>
    new Proxy(repo, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (typeof prop === 'string' && prop in calls) {
            calls[prop as keyof BadgeCallCounts] += 1;
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  world.conversationsRepo = counted(world.conversationsRepo);
  world.contactsRepo = counted(world.contactsRepo);
  world.messagesRepo = counted(world.messagesRepo);
  return { world, calls };
}

/** Distinct, ordered timestamps for the bulk fixtures. */
const isoAt = (minutes: number): string =>
  new Date(Date.UTC(2026, 5, 10, 10, 0, 0) + minutes * 60_000).toISOString();

describe('GET /api/inbox/unread-count (badge)', () => {
  it('401 without a session cookie', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/inbox/unread-count')
      .set('x-origin-verify', ORIGIN_SECRET);
    expect(res.status).toBe(401);
  });

  it('a fully-read world costs ONE index query and zero hydration reads', async () => {
    const { world, calls } = countingWorld();
    const { app } = makeWebhookHarness({ world });
    seedContact(world, { contactId: 'c-read', type: 'tenant', phone: '+15550000001' });
    // Read row: unread_count 0 AND no flag - exactly what resetUnread leaves.
    seedConversation(world, 'conv-read', {
      participant_phone: '+15550000001',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      unread_count: 0,
    });

    const res = await auth(request(app).get('/api/inbox/unread-count'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 0, capped: false, truncated: false });
    // The empty-index cost, pinned exhaustively: one Query, no contact
    // resolution, no message read.
    expect(calls).toEqual({ queryUnreadPage: 1, findByPhone: 0, listByConversation: 0 });
  });

  it('counts one row per contact, plus group and OPEN relay rows - a CLOSED relay is excluded', async () => {
    const { app, world } = makeWebhookHarness();
    for (const [i, id] of ['c-a', 'c-b', 'c-c'].entries()) {
      seedContact(world, { contactId: id, type: 'tenant', phone: `+1555000010${i}` });
      seedConversation(world, `conv-${id}`, {
        participant_phone: `+1555000010${i}`,
        last_activity_at: isoAt(i),
        unread_count: i + 1,
        unread_flag: 'unread',
      });
    }
    seedConversation(world, 'conv-group-text', {
      participant_phone: '+15559990002',
      type: 'group_text',
      status: GROUP_TEXT_STATUS,
      last_activity_at: isoAt(10),
      unread_count: 4,
      unread_flag: 'unread',
    });
    seedConversation(world, 'conv-relay-open', {
      participant_phone: '+15559990001',
      pool_number: '+15559990001',
      type: 'relay_group',
      status: 'open',
      last_activity_at: isoAt(11),
      unread_count: 5,
      unread_flag: 'unread',
      participants: [{ contactId: 'c-a', phone: '+15550000100' }],
    });
    // A CLOSED relay group that is still flagged: the close-reset zeroes both,
    // so this row can only exist as accrual (a pre-reset row, or a lagging GSI
    // image). The VISIBILITY rule - not index membership - is what drops it.
    seedConversation(world, 'conv-relay-closed', {
      participant_phone: '+15559990003',
      pool_number: '+15559990003',
      type: 'relay_group',
      status: 'closed',
      last_activity_at: isoAt(12),
      unread_count: 6,
      unread_flag: 'unread',
      participants: [{ contactId: 'c-b', phone: '+15550000101' }],
    });

    const res = await auth(request(app).get('/api/inbox/unread-count'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 5, capped: false, truncated: false });
  });

  it('counts a multi-thread contact ONCE, however many of its threads are unread', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-multi',
      type: 'tenant',
      phone: '+15550000201',
      email: 'multi@example.com',
      created_at: '2026-06-01T00:00:00.000Z',
    });
    // The second number goes through the repo so its phone-pointer item exists
    // (the byPhone resolution path a non-primary number actually relies on).
    await world.contactsRepo.addPhone('c-multi', { phone: '+15550000202' });
    seedConversation(world, 'conv-multi-a', {
      participant_phone: '+15550000201',
      last_activity_at: isoAt(1),
      unread_count: 2,
      unread_flag: 'unread',
    });
    seedConversation(world, 'conv-multi-b', {
      participant_phone: '+15550000202',
      last_activity_at: isoAt(2),
      unread_count: 3,
      unread_flag: 'unread',
    });
    seedConversation(world, 'conv-multi-email', {
      participant_phone: '',
      participant_email: 'multi@example.com',
      last_activity_at: isoAt(3),
      unread_count: 1,
      unread_flag: 'unread',
    });

    const res = await auth(request(app).get('/api/inbox/unread-count'));

    expect(res.status).toBe(200);
    // ONE row for the person - the badge counts ROWS, not threads or messages.
    expect(res.body).toEqual({ unreadCount: 1, capped: false, truncated: false });
  });

  it('caps at 100 candidates and says so (the 99+ contract)', async () => {
    const { app, world } = makeWebhookHarness();
    for (let i = 0; i < 101; i++) {
      const phone = `+1555${2000000 + i}`;
      seedConversation(world, `conv-many-${i}`, {
        participant_phone: phone,
        type: 'unknown_1to1',
        last_activity_at: isoAt(i),
        unread_count: 1,
        unread_flag: 'unread',
      });
    }

    const res = await auth(request(app).get('/api/inbox/unread-count'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 100, capped: true, truncated: false });
  });

  it('reports truncated (NOT capped) when the raw scan budget runs out first', async () => {
    const { world } = countingWorld();
    // The budget seam: ApiRouterDeps.unreadWalkLimit, forwarded into the inbox
    // router. Two raw items of allowance against five unread rows.
    const { app } = makeWebhookHarness({ world, unreadWalkLimit: 2 });
    for (let i = 0; i < 5; i++) {
      const phone = `+1555${3000000 + i}`;
      seedConversation(world, `conv-budget-${i}`, {
        participant_phone: phone,
        type: 'unknown_1to1',
        last_activity_at: isoAt(i),
        unread_count: 1,
        unread_flag: 'unread',
      });
    }

    const res = await auth(request(app).get('/api/inbox/unread-count'));

    expect(res.status).toBe(200);
    // A truncated count is small and REAL-SO-FAR (the client still decrements
    // it); a capped count is a ceiling. They are distinct fields for exactly
    // that reason, so pin both.
    expect(res.body).toEqual({ unreadCount: 2, capped: false, truncated: true });
  });

  it('500s when the index read throws (the client collapses any error to "no badge")', async () => {
    const world = createFakeWorld();
    const repo = world.conversationsRepo;
    world.conversationsRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop !== 'queryUnreadPage') return Reflect.get(target, prop, receiver) as unknown;
        return async () => {
          throw new Error('byUnread unavailable');
        };
      },
    });
    const { app } = makeWebhookHarness({ world });

    const res = await auth(request(app).get('/api/inbox/unread-count'));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
  });

  it('is matched by its own route, not swallowed by the :contactId param route', async () => {
    const { app, world } = makeWebhookHarness();
    // A contact whose id IS the literal path segment. The badge route is
    // registered ABOVE /:contactId/read; if a param route ever moved above it
    // (or a GET /:contactId were added there), this request would answer with
    // that contact's payload instead of the count.
    seedContact(world, { contactId: 'unread-count', type: 'tenant', phone: '+15550000301' });

    const res = await auth(request(app).get('/api/inbox/unread-count'));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['capped', 'truncated', 'unreadCount']);

    // ...and the reverse: the badge route did not annex the param route's
    // namespace - POST /api/inbox/<id>/read still reaches the fan-out handler.
    const fanOut = await auth(request(app).post('/api/inbox/unread-count/read'));
    expect(fanOut.status).toBe(200);
    expect(fanOut.body).toEqual({ ok: true });
  });
});

