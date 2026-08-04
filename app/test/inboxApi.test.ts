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
    // ...and the group text they are in keeps its unread: viewing a 1:1 tab must
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

