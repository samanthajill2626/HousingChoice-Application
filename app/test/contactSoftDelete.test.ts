// Soft-delete contacts: DELETE /api/contacts/:id (stamp deleted_at, keep all
// data) + POST /api/contacts/:id/restore, plus the visibility rules — deleted
// contacts vanish from the normal list, surface only in the ?deleted=true view,
// and are hidden from the inbox + today queues (record retained throughout).
// Runs on the shared in-memory world (makeWebhookHarness).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { unreadFlagFor } from './helpers/unreadIndexFake.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import {
  createFakeWorld,
  inboundSmsParams,
  makeWebhookHarness,
  ORIGIN_SECRET,
  signedTwilioPost,
  TENANT_PHONE,
} from './helpers/twilioWebhookHarness.js';

type World = ReturnType<typeof createFakeWorld>;

const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

function seedContact(world: World, overrides: Partial<ContactItem> & { contactId: string; type: ContactItem['type'] }): void {
  world.contacts.push({ status: 'active', ...overrides });
}

function seedConversation(
  world: World,
  id: string,
  // participant_phone is NOT required: an email-channel thread is addressed by
  // participant_email only, and the delete fan-out must cover both (the
  // conversationsForContact union resolves phones THEN emails).
  overrides: Partial<ConversationItem> & { last_activity_at: string },
): void {
  world.conversations.set(id, {
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
  });
}

describe('DELETE /api/contacts/:id (soft delete) + restore', () => {
  it('soft-deletes: stamps deleted_at, keeps the record, hides it from the list', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', firstName: 'Dana', phone: '+15550000001' });

    const del = await auth(request(app).delete('/api/contacts/c-1'));
    expect(del.status).toBe(200);
    expect(typeof del.body.contact.deleted_at).toBe('string');
    // The record is RETAINED (data intact), not removed.
    const stored = world.contacts.find((c) => c.contactId === 'c-1');
    expect(stored).toBeDefined();
    expect(stored?.firstName).toBe('Dana');

    // Gone from the normal tenant list…
    const list = await auth(request(app).get('/api/contacts?type=tenant'));
    expect(list.body.contacts.map((c: ContactItem) => c.contactId)).not.toContain('c-1');

    // …but present in the Deleted view.
    const deletedView = await auth(request(app).get('/api/contacts?type=tenant&deleted=true'));
    expect(deletedView.body.contacts.map((c: ContactItem) => c.contactId)).toEqual(['c-1']);
  });

  it('restore clears deleted_at and brings the contact back into the list', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-2', type: 'landlord', firstName: 'Lee', phone: '+15550000002' });

    await auth(request(app).delete('/api/contacts/c-2'));
    const restore = await auth(request(app).post('/api/contacts/c-2/restore'));
    expect(restore.status).toBe(200);
    expect(restore.body.contact.deleted_at).toBeUndefined();

    const list = await auth(request(app).get('/api/contacts?type=landlord'));
    expect(list.body.contacts.map((c: ContactItem) => c.contactId)).toContain('c-2');
    const deletedView = await auth(request(app).get('/api/contacts?type=landlord&deleted=true'));
    expect(deletedView.body.contacts.map((c: ContactItem) => c.contactId)).not.toContain('c-2');
  });

  it('the default list excludes deleted; only the deleted view shows them', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'live', type: 'tenant', phone: '+15550000010' });
    seedContact(world, { contactId: 'gone', type: 'tenant', phone: '+15550000011', deleted_at: '2026-06-18T00:00:00.000Z' });

    const live = await auth(request(app).get('/api/contacts?type=tenant'));
    expect(live.body.contacts.map((c: ContactItem) => c.contactId)).toEqual(['live']);

    const deleted = await auth(request(app).get('/api/contacts?type=tenant&deleted=true'));
    expect(deleted.body.contacts.map((c: ContactItem) => c.contactId)).toEqual(['gone']);
  });

  it('404s when deleting or restoring a contact that does not exist', async () => {
    const { app } = makeWebhookHarness();
    expect((await auth(request(app).delete('/api/contacts/nope'))).status).toBe(404);
    expect((await auth(request(app).post('/api/contacts/nope/restore'))).status).toBe(404);
  });

  it('hides a deleted contact from the inbox feed', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-live', type: 'tenant', firstName: 'Liv', phone: '+15550000020' });
    seedContact(world, { contactId: 'c-del', type: 'tenant', firstName: 'Del', phone: '+15550000021', deleted_at: '2026-06-18T00:00:00.000Z' });
    seedConversation(world, 'conv-live', { participant_phone: '+15550000020', last_activity_at: '2026-06-10T10:00:00.000Z', unread_count: 1 });
    seedConversation(world, 'conv-del', { participant_phone: '+15550000021', last_activity_at: '2026-06-11T10:00:00.000Z', unread_count: 1 });

    const res = await auth(request(app).get('/api/inbox'));
    expect(res.status).toBe(200);
    const ids = res.body.rows.map((r: { contactId?: string }) => r.contactId);
    expect(ids).toContain('c-live');
    expect(ids).not.toContain('c-del');
  });

  it('re-emits conversation.updated for the contact threads on delete AND restore (live views refetch)', async () => {
    // The delete/restore doesn't touch the conversation row, so without this
    // fan-out nothing would signal live views (Today/inbox) to drop/return the
    // contact's card until a manual reload (the reported bug).
    const { app, world } = makeWebhookHarness();
    const emitted = world.emitted;
    seedContact(world, { contactId: 'c-fan', type: 'tenant', phone: '+15550000040' });
    seedConversation(world, 'conv-fan', {
      participant_phone: '+15550000040',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      unread_count: 1,
    });
    const conversationUpdatedFor = (id: string): number =>
      emitted.filter(
        (e) =>
          e.event === 'conversation.updated' &&
          (e.payload as { conversationId?: string }).conversationId === id,
      ).length;

    emitted.length = 0;
    await auth(request(app).delete('/api/contacts/c-fan'));
    expect(conversationUpdatedFor('conv-fan')).toBeGreaterThan(0);

    emitted.length = 0;
    await auth(request(app).post('/api/contacts/c-fan/restore'));
    expect(conversationUpdatedFor('conv-fan')).toBeGreaterThan(0);
  });

  it('hides a deleted unknown contact from the today queue', async () => {
    const { app, world } = makeWebhookHarness();
    // An untriaged unknown contact in the triage partition — normally a
    // needs_you_now row — that has been soft-deleted.
    seedContact(world, {
      contactId: 'c-unknown',
      type: 'unknown',
      status: 'needs_review',
      phone: '+15550000030',
      deleted_at: '2026-06-18T00:00:00.000Z',
    });

    const res = await auth(request(app).get('/api/today'));
    expect(res.status).toBe(200);
    const refIds = (res.body.items as { refId: string }[]).map((i) => i.refId);
    expect(refIds).not.toContain('c-unknown');
  });
});

// Soft-delete now ZEROES unread across the contact's threads (inbox-unread-index
// spec 4.2, human ruling at the spec gate). Without it a deleted contact's
// threads stay resident in the sparse byUnread index forever: invisible to every
// reader, yet permanently inflating the badge's walk. DECLARED PRODUCT CHANGE: a
// restored contact returns with unread 0. Resurfacing is UNAFFECTED - that rule
// requires a POST-deletion inbound, and the inbound itself re-increments unread.
describe('DELETE /api/contacts/:id resets unread across the contact threads', () => {
  it('resets EVERY thread it finds (phone AND email), read ones included', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-reset',
      type: 'tenant',
      firstName: 'Dana',
      phone: '+15550000050',
      email: 'dana@example.com',
    });
    seedConversation(world, 'conv-unread-phone', {
      participant_phone: '+15550000050',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      unread_count: 2,
    });
    seedConversation(world, 'conv-unread-email', {
      participant_email: 'dana@example.com',
      last_activity_at: '2026-06-11T10:00:00.000Z',
      unread_count: 3,
    });
    // Already read - and reset ANYWAY (adversarial finding 2). The fan-out used
    // to skip these, but the thread list comes from the eventually-consistent
    // participant GSIs, so "already read" is a claim this handler cannot trust;
    // see the stale-image test below. resetUnread is idempotent and conditional,
    // so the cost is one IDEMPOTENT write per already-read thread of a contact
    // being deleted - a REAL write, not a no-op: resetUnread's condition is
    // attribute_exists(conversationId), which a live row always satisfies. The
    // benefit is that no unread thread is skipped FOREVER.
    seedConversation(world, 'conv-read-phone', {
      participant_phone: '+15550000050',
      last_activity_at: '2026-06-09T10:00:00.000Z',
      unread_count: 0,
    });

    const del = await auth(request(app).delete('/api/contacts/c-reset'));

    expect(del.status).toBe(200);
    // Sorted, so the assertion pins WHICH threads were reset without pinning the
    // Promise.all fan-out order.
    expect([...world.unreadResets].sort()).toEqual([
      'conv-read-phone',
      'conv-unread-email',
      'conv-unread-phone',
    ]);
    for (const id of ['conv-unread-phone', 'conv-unread-email', 'conv-read-phone']) {
      const conv = world.conversations.get(id);
      expect(conv?.unread_count).toBe(0);
      // The FLAG is what index membership keys on - absence is the whole point.
      expect(conv?.unread_flag).toBeUndefined();
    }
  });

  // ADVERSARIAL FINDING 2. conversationsForContact resolves through
  // byParticipantPhone/byParticipantEmail, GSIs that lag independently of
  // byUnread. An inbound at t=0 flags the thread; a delete at t=0.3s reads a
  // participant image that still says unread_count 0. The old `unread_count > 0`
  // pre-filter dropped that thread, and NOTHING re-runs this fan-out for an
  // already-deleted contact - so the row stayed in byUnread permanently, costing
  // a resurfacing probe on every badge request forever. The reset must therefore
  // depend on the thread SET the GSI returns, never on the unread values in it.
  it('STALE GSI: resets a flagged thread whose participant-GSI image still says read', async () => {
    const world = createFakeWorld();
    const real = world.conversationsRepo;
    world.conversationsRepo = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== 'findByParticipantPhone' || typeof value !== 'function') return value;
        // The GSI's own projection, one replication beat behind the base table:
        // a COPY reporting the pre-inbound counter, while the stored row (which
        // resetUnread writes and the index reads) is unread and flagged.
        return async (phone: string) => {
          const items = (await (value as (p: string) => Promise<ConversationItem[]>).call(
            target,
            phone,
          )) as ConversationItem[];
          return items.map((c) => ({ ...c, unread_count: 0, unread_flag: undefined }));
        };
      },
    });
    const { app } = makeWebhookHarness({ world });
    seedContact(world, { contactId: 'c-stale', type: 'tenant', phone: '+15550000053' });
    seedConversation(world, 'conv-stale', {
      participant_phone: '+15550000053',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      unread_count: 1,
    });
    expect(world.conversations.get('conv-stale')?.unread_flag).toBe('unread');

    const del = await auth(request(app).delete('/api/contacts/c-stale'));

    expect(del.status).toBe(200);
    expect(world.unreadResets).toEqual(['conv-stale']);
    const conv = world.conversations.get('conv-stale');
    expect(conv?.unread_count).toBe(0);
    // The row is OUT of the sparse byUnread index - the point of the whole reset.
    expect(conv?.unread_flag).toBeUndefined();
  });

  // CONFORMANCE FINDING 3 / adversarial 2 (tail). The block's comment promised
  // best-effort, but only ConditionalCheckFailedException was swallowed and the
  // thread LOOKUP was unguarded - so a transient repo error 500'd a delete whose
  // deleted_at was already durable AND skipped propagateContactPresenceChange,
  // leaving every dashboard showing a contact the database considers deleted.
  it('a transient thread-lookup failure neither fails the delete nor skips the presence fan-out', async () => {
    const world = createFakeWorld();
    const real = world.conversationsRepo;
    let firstLookup = true;
    world.conversationsRepo = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== 'findByParticipantPhone' || typeof value !== 'function') return value;
        // ONE-SHOT: the unread fan-out's lookup throws, the presence fan-out's
        // succeeds. A permanent throw could not tell "the request survived" from
        // "the presence fan-out ran".
        return async (phone: string) => {
          if (firstLookup) {
            firstLookup = false;
            throw new Error('dynamo throttled');
          }
          return (value as (p: string) => Promise<ConversationItem[]>).call(target, phone);
        };
      },
    });
    const { app } = makeWebhookHarness({ world });
    seedContact(world, { contactId: 'c-flaky', type: 'tenant', phone: '+15550000054' });
    seedConversation(world, 'conv-flaky', {
      participant_phone: '+15550000054',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      unread_count: 1,
    });

    const del = await auth(request(app).delete('/api/contacts/c-flaky'));

    expect(del.status).toBe(200);
    expect(typeof del.body.contact.deleted_at).toBe('string');
    // The delete is durable...
    expect(typeof world.contacts.find((c) => c.contactId === 'c-flaky')?.deleted_at).toBe('string');
    // ...and the live views still got told, so no dashboard keeps the card.
    expect(
      world.emitted.filter(
        (e) =>
          e.event === 'conversation.updated' &&
          (e.payload as { conversationId?: string }).conversationId === 'conv-flaky',
      ),
    ).toHaveLength(1);
  });

  it('emits conversation.updated carrying unread 0 from the RESET ITSELF, and emits it LAST', async () => {
    // ADVERSARIAL A6, corrected in fix wave 2 (adversarial r2 finding 5). The
    // reset's own ALL_NEW return values are authoritative and were being
    // discarded, while propagateContactPresenceChange re-reads through the
    // participant GSIs, which lag, so the image IT broadcasts still carries the
    // pre-reset count. No dashboard consumer reads unread_count off this event
    // today (every handler is a refetch trigger), so this is about keeping the
    // WIRE honest for one that might - which means the authoritative emit has
    // to be the LAST word, not merely present. Fix wave 1 emitted it FIRST and
    // asserted only `toContain(0)`, which passes whatever the order is.
    const world = createFakeWorld();
    const real = world.conversationsRepo;
    world.conversationsRepo = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== 'findByParticipantPhone' || typeof value !== 'function') return value;
        // The GSI image, frozen one beat behind: it keeps reporting the
        // pre-reset count no matter what the base table now says.
        return async (phone: string) => {
          const items = (await (value as (p: string) => Promise<ConversationItem[]>).call(
            target,
            phone,
          )) as ConversationItem[];
          return items.map((c) => ({ ...c, unread_count: 7, unread_flag: 'unread' as const }));
        };
      },
    });
    const { app } = makeWebhookHarness({ world });
    seedContact(world, { contactId: 'c-emit', type: 'tenant', phone: '+15550000055' });
    seedConversation(world, 'conv-emit', {
      participant_phone: '+15550000055',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      unread_count: 7,
    });

    const del = await auth(request(app).delete('/api/contacts/c-emit'));

    expect(del.status).toBe(200);
    const counts = world.emitted
      .filter(
        (e) =>
          e.event === 'conversation.updated' &&
          (e.payload as { conversationId?: string }).conversationId === 'conv-emit',
      )
      .map((e) => (e.payload as { unread_count?: number }).unread_count);
    // The stale fan-out emit still happens - it carries the frozen 7 - so this
    // assertion can genuinely fail: it is ORDER-SENSITIVE, and it fails if the
    // authoritative emit moves back ahead of the presence fan-out.
    expect(counts).toContain(7);
    expect(counts[counts.length - 1]).toBe(0);
  });

  it('a ConditionalCheckFailedException from one reset does not fail the delete', async () => {
    // The row can vanish between the thread read and the reset (a racing retract
    // or a concurrent close). The delete has ALREADY persisted at that point, so
    // a fan-out hiccup must never turn a successful delete into a 500.
    const world = createFakeWorld();
    const real = world.conversationsRepo;
    world.conversationsRepo = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== 'resetUnread' || typeof value !== 'function') return value;
        return async (conversationId: string) => {
          if (conversationId === 'conv-boom') {
            throw new ConditionalCheckFailedException({ message: 'gone', $metadata: {} });
          }
          return (value as (id: string) => Promise<unknown>).call(target, conversationId);
        };
      },
    });
    const { app } = makeWebhookHarness({ world });
    seedContact(world, { contactId: 'c-race', type: 'tenant', phone: '+15550000051' });
    seedConversation(world, 'conv-boom', {
      participant_phone: '+15550000051',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      unread_count: 1,
    });
    seedConversation(world, 'conv-ok', {
      participant_phone: '+15550000051',
      last_activity_at: '2026-06-11T10:00:00.000Z',
      unread_count: 4,
    });

    const del = await auth(request(app).delete('/api/contacts/c-race'));

    expect(del.status).toBe(200);
    expect(typeof del.body.contact.deleted_at).toBe('string');
    // The sibling thread still got its reset - one failure does not abort the rest.
    expect(world.unreadResets).toEqual(['conv-ok']);
    expect(world.conversations.get('conv-ok')?.unread_flag).toBeUndefined();
  });

  it('restore triggers ZERO resetUnread calls, so post-deletion unread survives', async () => {
    // THE reason the fan-out is inline in the DELETE handler and not in the
    // shared propagateContactPresenceChange (which restore also calls): a reset
    // on restore would zero exactly the unread the resurfacing rule depends on.
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-restore', type: 'tenant', phone: '+15550000052' });
    seedConversation(world, 'conv-restore', {
      participant_phone: '+15550000052',
      last_activity_at: '2026-06-10T10:00:00.000Z',
      unread_count: 1,
    });

    await auth(request(app).delete('/api/contacts/c-restore'));
    expect(world.unreadResets).toEqual(['conv-restore']);
    // A post-deletion inbound arrives (the resurfacing precondition) and bumps
    // the thread back to unread through the REAL primitive.
    await world.conversationsRepo.incrementUnread('conv-restore');
    world.unreadResets.length = 0;

    const restore = await auth(request(app).post('/api/contacts/c-restore/restore'));

    expect(restore.status).toBe(200);
    expect(world.unreadResets).toEqual([]);
    const conv = world.conversations.get('conv-restore');
    expect(conv?.unread_count).toBe(1);
    expect(conv?.unread_flag).toBe('unread');
  });

  it('an inbound AFTER the delete leaves the thread unread + flagged (resurfacing input intact)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-resurface', type: 'tenant', phone: TENANT_PHONE });
    seedConversation(world, 'conv-resurface', {
      participant_phone: TENANT_PHONE,
      last_activity_at: '2026-06-10T10:00:00.000Z',
      unread_count: 2,
    });

    await auth(request(app).delete('/api/contacts/c-resurface'));
    expect(world.conversations.get('conv-resurface')?.unread_flag).toBeUndefined();

    const inbound = await signedTwilioPost(
      app,
      '/webhooks/twilio/sms',
      inboundSmsParams({ MessageSid: 'SMafterdelete01', Body: 'still here' }),
    );

    expect(inbound.status).toBe(200);
    expect(world.unreadIncrements).toContain('conv-resurface');
    const conv = world.conversations.get('conv-resurface');
    expect(conv?.unread_count).toBe(1);
    expect(conv?.unread_flag).toBe('unread');
  });
});
