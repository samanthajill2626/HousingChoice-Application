// Manual extraction trigger (design 4.5): POST /api/contacts/:contactId/extraction-run.
// Arms every eligible 1:1 thread of a contact for an IMMEDIATE run (dueAt = now,
// no debounce) under ONE requestId, and reports which threads were queued.
//
// The load-bearing rules under test:
//   - the seven refusals, each with its own machine-readable reason;
//   - the tenant_1to1 | unknown_1to1 filter (this route FANS OUT, and
//     conversationsForContact returns the raw phone+email union, which can
//     include a relay_group thread fronted by a pool number);
//   - a partial failure is a 200 naming both lists, NEVER a 500: once any write
//     lands a run is queued and will bill, so "nothing happened" would be false.
// Runs on the shared in-memory world (makeWebhookHarness).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
} from './helpers/twilioWebhookHarness.js';

type World = ReturnType<typeof createFakeWorld>;

const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

function seedContact(
  world: World,
  over: Partial<ContactItem> & { contactId: string; type: ContactItem['type'] },
): void {
  // The scalar phone is what conversationsForContact walks (contactPhones
  // materializes it), so no phone-ref pointer row is needed here.
  world.contacts.push({ status: 'active', phone: '+15550000001', ...over });
}

function seedConversation(world: World, id: string, type: ConversationItem['type']): void {
  world.conversations.set(id, {
    conversationId: id,
    status: 'open',
    type,
    ai_mode: 'auto',
    participant_phone: '+15550000001',
    last_activity_at: '2026-08-01T00:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
  });
}

// An EMAIL thread carries participant_email and NO participant_phone, so the
// phone leg of the union cannot reach it. Only conversationsForContact's email
// leg can - which is spec 4.5's stated reason for choosing it over the triage
// hook's narrower resolver.
function seedEmailConversation(world: World, id: string, email: string): void {
  world.conversations.set(id, {
    conversationId: id,
    status: 'open',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    participant_email: email,
    last_activity_at: '2026-08-01T00:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
  });
}

describe('POST /api/contacts/:contactId/extraction-run', () => {
  it('schedules every eligible 1:1 thread and returns their ids', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    seedConversation(world, 'conv-b', 'unknown_1to1');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(200);
    expect(res.body.scheduled.sort()).toEqual(['conv-a', 'conv-b']);
    expect(res.body.failed).toEqual([]);
    expect(typeof res.body.requestId).toBe('string');
  });

  it('fans out across the EMAIL half of the union as well as the phone half', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', email: 'tenant@example.test' });
    seedConversation(world, 'conv-phone', 'tenant_1to1');
    seedEmailConversation(world, 'conv-email', 'tenant@example.test');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(200);
    expect(res.body.scheduled.sort()).toEqual(['conv-email', 'conv-phone']);
    expect(world.manualExtractionRequests.map((c) => c.conversationId).sort())
      .toEqual(['conv-email', 'conv-phone']);
  });

  it('schedules an EMAIL-ONLY contact thread (no phone thread exists at all)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', email: 'tenant@example.test' });
    seedEmailConversation(world, 'conv-email', 'tenant@example.test');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(200);
    expect(res.body.scheduled).toEqual(['conv-email']);
    expect(res.body.failed).toEqual([]);
  });

  it('gives one press ONE requestId across threads and no debounce', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    seedConversation(world, 'conv-b', 'unknown_1to1');
    const before = Date.now();
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    const after = Date.now();

    expect(res.status).toBe(200);
    const calls = world.manualExtractionRequests;
    expect(calls.map((c) => c.conversationId).sort()).toEqual(['conv-a', 'conv-b']);
    // One correlation key per press - the client waits on it (design 4.4b).
    expect(new Set(calls.map((c) => c.requestId))).toEqual(new Set([res.body.requestId]));
    for (const call of calls) {
      // dueAt = now: a manual press is immediate, never debounced forward.
      const dueAt = Date.parse(call.dueAt);
      expect(dueAt).toBeGreaterThanOrEqual(before);
      expect(dueAt).toBeLessThanOrEqual(after);
    }
  });

  it('EXCLUDES relay_group and landlord_1to1', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-ok', 'tenant_1to1');
    seedConversation(world, 'conv-relay', 'relay_group');
    seedConversation(world, 'conv-ll', 'landlord_1to1');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.body.scheduled).toEqual(['conv-ok']);
    expect(world.manualExtractionRequests.map((c) => c.conversationId)).toEqual(['conv-ok']);
  });

  it('404s an unknown contact and a phone-pointer id', async () => {
    const { app } = makeWebhookHarness();
    expect((await auth(request(app).post('/api/contacts/nope/extraction-run'))).status).toBe(404);
    const ref = await auth(
      request(app).post(
        `/api/contacts/${encodeURIComponent('phoneref#+15550000001')}/extraction-run`,
      ),
    );
    expect(ref.status).toBe(404);
    expect(ref.body.error).toBe('contact_not_found');
  });

  it('refuses a soft-deleted contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-1',
      type: 'tenant',
      deleted_at: '2026-08-01T00:00:00.000Z',
    });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_deleted');
    expect(world.manualExtractionRequests).toEqual([]);
  });

  it('refuses when the kill switch is off', async () => {
    const { app, world } = makeWebhookHarness({ env: { AI_EXTRACTION_ENABLED: 'false' } });
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('extraction_disabled');
    expect(world.manualExtractionRequests).toEqual([]);
  });

  it.each(['landlord', 'partner', 'team_member'] as const)('refuses a %s contact', async (type) => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ineligible_contact_type');
  });

  it('distinguishes no threads from no ELIGIBLE threads', async () => {
    const a = makeWebhookHarness();
    seedContact(a.world, { contactId: 'c-1', type: 'tenant' });
    const noThreads = await auth(request(a.app).post('/api/contacts/c-1/extraction-run'));
    expect(noThreads.status).toBe(409);
    expect(noThreads.body.error).toBe('no_conversations');

    const b = makeWebhookHarness();
    seedContact(b.world, { contactId: 'c-2', type: 'tenant' });
    seedConversation(b.world, 'conv-relay', 'relay_group');
    const noEligible = await auth(request(b.app).post('/api/contacts/c-2/extraction-run'));
    expect(noEligible.status).toBe(409);
    expect(noEligible.body.error).toBe('no_eligible_conversations');
  });

  it('appends an audit entry with the counts', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    const entry = world.auditEvents.find((e) => e.event_type === 'extraction_run_requested');
    expect(entry).toBeDefined();
    expect(entry!.entityKey).toBe('contacts#c-1');
    expect(entry!.actorId).toBe('usr_testva00000000000000000');
    expect(entry!.payload).toMatchObject({
      requestId: res.body.requestId,
      scheduled: 1,
      failed: 0,
    });
  });

  it('is a 200 with a partial list when one write fails, never a 500', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    seedConversation(world, 'conv-b', 'unknown_1to1');
    world.failManualExtractionFor.add('conv-b');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(200);
    expect(res.body.scheduled).toEqual(['conv-a']);
    expect(res.body.failed).toEqual(['conv-b']);
    const entry = world.auditEvents.find((e) => e.event_type === 'extraction_run_requested');
    expect(entry!.payload).toMatchObject({ scheduled: 1, failed: 1 });
  });

  it('is a 500 only when NOTHING was scheduled', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    world.failManualExtractionFor.add('conv-a');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('schedule_failed');
  });

  it('audits the press that started NOTHING too, with scheduled: 0', async () => {
    // Design 4.5 step 6 calls the entry unconditional: an audit that cannot
    // distinguish a press that started three runs from one that started none
    // has lost most of its value for a money-spending action.
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    world.failManualExtractionFor.add('conv-a');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(500);
    const entry = world.auditEvents.find((e) => e.event_type === 'extraction_run_requested');
    expect(entry).toBeDefined();
    expect(entry!.entityKey).toBe('contacts#c-1');
    expect(entry!.payload).toMatchObject({ scheduled: 0, failed: 1 });
  });

  it('a THROWING audit append still answers 200 with the queued list', async () => {
    // By this point the queued runs will bill. A 500 from the observability
    // write would carry no reason code, so the UI would render "could not be
    // started - try again" over a press that in fact started runs.
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    seedConversation(world, 'conv-b', 'unknown_1to1');
    world.failAuditAppendFor.add('extraction_run_requested');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(200);
    expect(res.body.scheduled.sort()).toEqual(['conv-a', 'conv-b']);
    expect(res.body.failed).toEqual([]);
    expect(typeof res.body.requestId).toBe('string');
    expect(world.auditEvents.find((e) => e.event_type === 'extraction_run_requested'))
      .toBeUndefined();
  });
});
