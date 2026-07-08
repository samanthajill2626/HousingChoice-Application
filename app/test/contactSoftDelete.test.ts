// Soft-delete contacts: DELETE /api/contacts/:id (stamp deleted_at, keep all
// data) + POST /api/contacts/:id/restore, plus the visibility rules — deleted
// contacts vanish from the normal list, surface only in the ?deleted=true view,
// and are hidden from the inbox + today queues (record retained throughout).
// Runs on the shared in-memory world (makeWebhookHarness).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

type World = ReturnType<typeof createFakeWorld>;

const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

function seedContact(world: World, overrides: Partial<ContactItem> & { contactId: string; type: ContactItem['type'] }): void {
  world.contacts.push({ status: 'active', ...overrides });
}

function seedConversation(
  world: World,
  id: string,
  overrides: Partial<ConversationItem> & { participant_phone: string; last_activity_at: string },
): void {
  world.conversations.set(id, {
    conversationId: id,
    status: 'open',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: overrides.last_activity_at,
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
