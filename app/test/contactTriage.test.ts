// M1.4 unit tests: the contact-triage routes —
//   GET   /api/contacts/:contactId
//   PATCH /api/contacts/:contactId
// Asserts the needs_review resolution flow: setting type=tenant|landlord
// PROPAGATES the conversation type (unknown_1to1 → tenant_1to1/landlord_1to1),
// the contact_updated audit, validation, the "First Last - N Bed" parse, and
// the no-overwrite-of-an-unset-field merge.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;
const PHONE = '+15550100777';

function seedUnknownContactAndThread(world: ReturnType<typeof createFakeWorld>) {
  world.contacts.push({
    contactId: 'contact-triage-1',
    type: 'unknown',
    status: 'needs_review',
    phone: PHONE,
    capture_source: 'inbound_sms',
    captured_at: '2026-06-12T10:00:00.000Z',
    created_at: '2026-06-12T10:00:00.000Z',
  });
  world.conversations.set('conv-triage-1', {
    conversationId: 'conv-triage-1',
    participant_phone: PHONE,
    status: 'open',
    last_activity_at: '2026-06-12T10:00:00.000Z',
    type: 'unknown_1to1',
    ai_mode: 'auto',
    created_at: '2026-06-12T09:00:00.000Z',
    participants: [{ contactId: 'contact-triage-1', phone: PHONE }],
  });
}

describe('GET /api/contacts/:contactId', () => {
  it('returns the contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);
    const res = await request(app)
      .get('/api/contacts/contact-triage-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ contactId: 'contact-triage-1', type: 'unknown' });
  });

  it('404s an unknown contact', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/contacts/nope')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/contacts/:contactId — triage', () => {
  it('setting type=tenant propagates the unknown_1to1 thread → tenant_1to1, auto-advances status, denormalizes the name, emits, and audits', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);

    const res = await request(app)
      .patch('/api/contacts/contact-triage-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant', firstName: 'Keisha', lastName: 'Jones', voucherSize: 2 });

    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ type: 'tenant', firstName: 'Keisha', lastName: 'Jones', voucherSize: 2 });
    // AUTO-ADVANCE (Cluster A): resolving identity clears needs_review.
    expect(res.body.contact.status).toBe('active');
    // PROPAGATION: the linked thread's type flips.
    expect(world.conversations.get('conv-triage-1')?.type).toBe('tenant_1to1');
    // DENORMALIZE (Cluster D): the resolved "First Last" lands on the thread.
    expect(world.conversations.get('conv-triage-1')?.participant_display_name).toBe('Keisha Jones');

    // LIVE EMIT (Cluster C): one conversation.updated carrying the new wire
    // shape (type + assignment + the denormalized resolved name) for the
    // touched thread.
    expect(world.emitted).toEqual([
      {
        event: 'conversation.updated',
        payload: {
          conversationId: 'conv-triage-1',
          last_activity_at: '2026-06-12T10:00:00.000Z',
          type: 'tenant_1to1',
          unread_count: 0,
          assignment: null,
          participant_display_name: 'Keisha Jones',
        },
      },
    ]);

    const audit = world.auditEvents.find((e) => e.event_type === 'contact_updated');
    expect(audit?.entityKey).toBe('contacts#contact-triage-1');
    expect(audit?.payload).toMatchObject({
      // 'status' is appended by the auto-advance (the audit records it).
      fields: ['type', 'firstName', 'lastName', 'voucherSize', 'status'],
      propagatedConversations: 1,
      conversationType: 'tenant_1to1',
    });
    expect(audit?.payload?.['actor']).toBe('usr_testva00000000000000000');
  });

  it('setting type=landlord propagates → landlord_1to1 and auto-advances status', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);
    const res = await request(app)
      .patch('/api/contacts/contact-triage-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'landlord' });
    expect(world.conversations.get('conv-triage-1')?.type).toBe('landlord_1to1');
    expect(res.body.contact.status).toBe('active');
  });

  it('does NOT auto-advance status when the caller set status explicitly (explicit status wins)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);
    const res = await request(app)
      .patch('/api/contacts/contact-triage-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant', status: 'needs_review' });
    expect(res.status).toBe(200);
    // Explicit status is honored, not overwritten by the auto-advance.
    expect(res.body.contact.status).toBe('needs_review');
    // Type still propagates.
    expect(world.conversations.get('conv-triage-1')?.type).toBe('tenant_1to1');
    const audit = world.auditEvents.find((e) => e.event_type === 'contact_updated');
    // 'status' appears once (the explicit one), not duplicated by auto-advance.
    expect(audit?.payload?.['fields']).toEqual(['type', 'status']);
  });

  it('a name-only PATCH denormalizes participant_display_name WITHOUT flipping the type', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);
    const res = await request(app)
      .patch('/api/contacts/contact-triage-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ firstName: 'Keisha', lastName: 'Jones' });
    expect(res.status).toBe(200);
    // No type was set — the thread stays unknown_1to1 (identity unresolved)…
    expect(world.conversations.get('conv-triage-1')?.type).toBe('unknown_1to1');
    // …but the name still surfaces in the inbox (Cluster D).
    expect(world.conversations.get('conv-triage-1')?.participant_display_name).toBe('Keisha Jones');
    // Naming alone does NOT resolve identity → status is untouched.
    expect(res.body.contact.status).toBe('needs_review');
    // And the inbox got a live update for the name change.
    expect(world.emitted).toHaveLength(1);
    expect(world.emitted[0]).toMatchObject({ event: 'conversation.updated' });
  });

  it('does NOT re-type a thread already resolved to a different identity', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);
    // Pre-resolve the thread to tenant_1to1.
    world.conversations.get('conv-triage-1')!.type = 'tenant_1to1';
    await request(app)
      .patch('/api/contacts/contact-triage-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'landlord' });
    // Stays tenant_1to1 — only unknown_1to1 threads are flipped (conflict left
    // for the human to reconcile, never silently overwritten).
    expect(world.conversations.get('conv-triage-1')?.type).toBe('tenant_1to1');
  });

  it('setting type=pm/team_member/unknown does NOT propagate a 1:1 type, auto-advance status, or emit', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);
    const res = await request(app)
      .patch('/api/contacts/contact-triage-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'pm' });
    expect(world.conversations.get('conv-triage-1')?.type).toBe('unknown_1to1');
    // pm/team_member/unknown do not resolve a 1:1 identity → no auto-advance.
    expect(res.body.contact.status).toBe('needs_review');
    // No name known and no type flip → nothing to denormalize → no live emit.
    expect(world.emitted).toHaveLength(0);
  });

  it('a partial patch (only status) leaves an already-set name untouched', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'contact-named',
      type: 'tenant',
      status: 'needs_review',
      phone: '+15550100888',
      firstName: 'Existing',
      lastName: 'Name',
      created_at: '2026-06-12T10:00:00.000Z',
    });
    const res = await request(app)
      .patch('/api/contacts/contact-named')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ status: 'active' });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ firstName: 'Existing', lastName: 'Name', status: 'active' });
  });

  it('accepts a raw "First Last - N Bed" string via contactName', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);
    const res = await request(app)
      .patch('/api/contacts/contact-triage-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ contactName: 'Anna Smith-Jones - 3 Bed', type: 'tenant' });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({
      firstName: 'Anna',
      lastName: 'Smith-Jones',
      voucherSize: 3,
      type: 'tenant',
    });
  });

  it('edits the company field (landlord) via the SET-merge + audits it', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'contact-ll',
      type: 'landlord',
      status: 'active',
      phone: '+15550100999',
      firstName: 'Pat',
      lastName: 'Owner',
      created_at: '2026-06-12T10:00:00.000Z',
    });
    const res = await request(app)
      .patch('/api/contacts/contact-ll')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ company: 'Acme Property Mgmt' });
    expect(res.status).toBe(200);
    expect(res.body.contact.company).toBe('Acme Property Mgmt');
    const audit = world.auditEvents.find(
      (e) => e.event_type === 'contact_updated' && e.entityKey === 'contacts#contact-ll',
    );
    expect(audit?.payload?.['fields']).toEqual(['company']);
  });

  it('edits housingAuthority (the byHousingAuthority GSI key — camelCase)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'contact-t2',
      type: 'tenant',
      status: 'active',
      phone: '+15550100222',
      housingAuthority: 'atlanta_housing',
      created_at: '2026-06-12T10:00:00.000Z',
    });
    const res = await request(app)
      .patch('/api/contacts/contact-t2')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ housingAuthority: 'dekalb_housing' });
    expect(res.status).toBe(200);
    expect(res.body.contact.housingAuthority).toBe('dekalb_housing');
    expect(world.contacts.find((c) => c.contactId === 'contact-t2')?.['housingAuthority']).toBe(
      'dekalb_housing',
    );
  });

  it('edits a structured address, storing only the non-empty parts', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'contact-t3',
      type: 'tenant',
      status: 'active',
      phone: '+15550100333',
      created_at: '2026-06-12T10:00:00.000Z',
    });
    const res = await request(app)
      .patch('/api/contacts/contact-t3')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ address: { line1: '123 Main St', line2: '  ', city: 'Atlanta', state: 'GA', zip: '30301' } });
    expect(res.status).toBe(200);
    // line2 was whitespace-only → dropped; the rest persists.
    expect(res.body.contact.address).toEqual({
      line1: '123 Main St',
      city: 'Atlanta',
      state: 'GA',
      zip: '30301',
    });
  });

  it('allowlists status — accepts a known lifecycle value, rejects an unknown one (L1)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);

    // A known lifecycle value is accepted.
    const ok = await request(app)
      .patch('/api/contacts/contact-triage-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ status: 'active' });
    expect(ok.status).toBe(200);
    expect(ok.body.contact.status).toBe('active');

    // An arbitrary status that would pollute the byTypeStatus GSI is refused.
    const bad = await request(app)
      .patch('/api/contacts/contact-triage-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ status: 'totally_made_up' });
    expect(bad.status).toBe(400);
    // The stored status was NOT changed to the bogus value.
    expect(world.contacts.find((c) => c.contactId === 'contact-triage-1')?.status).toBe('active');
  });

  it('400s validation failures', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnknownContactAndThread(world);
    for (const body of [
      {}, // no updatable fields
      { type: 'wizard' }, // bad type
      { voucherSize: -1 }, // out of range
      { voucherSize: 1.5 }, // not integer
      { status: '' }, // empty status
      { status: 'bogus_status' }, // not an allowlisted lifecycle value (L1)
      { contactName: 'SingleToken - 2 Bed' }, // not "First Last"
      { firstName: 5 }, // wrong type
      { company: 5 }, // wrong type
      { housingAuthority: 5 }, // wrong type
      { address: 'nope' }, // not an object
      { address: { line1: 5 } }, // address part wrong type
    ]) {
      const res = await request(app)
        .patch('/api/contacts/contact-triage-1')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('404s patching an unknown contact', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .patch('/api/contacts/nope')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/contacts/:contactId/opt-out — manual Do-Not-Contact toggle', () => {
  function seedActive(world: ReturnType<typeof createFakeWorld>): void {
    world.contacts.push({ contactId: 'c-opt', type: 'tenant', status: 'active', phone: '+15550101010' });
  }

  it('sets sms_opt_out=true, returns the updated contact (with phones), and audits the actor', async () => {
    const { app, world } = makeWebhookHarness();
    seedActive(world);
    const res = await request(app)
      .post('/api/contacts/c-opt/opt-out')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ optOut: true });
    expect(res.status).toBe(200);
    expect(res.body.contact.sms_opt_out).toBe(true);
    expect(Array.isArray(res.body.contact.phones)).toBe(true); // serialized via withPhones()
    expect(world.contacts.find((c) => c.contactId === 'c-opt')?.sms_opt_out).toBe(true);
    const audit = world.auditEvents.find((e) => e.event_type === 'contact_opt_out_changed');
    expect(audit?.entityKey).toBe('contacts#c-opt');
    expect(audit?.payload).toMatchObject({ optOut: true });
    expect(audit?.payload?.['actor']).toBe('usr_testva00000000000000000');
  });

  it('clears sms_opt_out when optOut=false (staff re-enable)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'c-opt',
      type: 'tenant',
      status: 'active',
      phone: '+15550101010',
      sms_opt_out: true,
    });
    const res = await request(app)
      .post('/api/contacts/c-opt/opt-out')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ optOut: false });
    expect(res.status).toBe(200);
    expect(res.body.contact.sms_opt_out).toBe(false);
    expect(world.contacts.find((c) => c.contactId === 'c-opt')?.sms_opt_out).toBe(false);
  });

  it('400s a missing / non-boolean optOut', async () => {
    const { app, world } = makeWebhookHarness();
    seedActive(world);
    for (const body of [{}, { optOut: 'yes' }, { optOut: 1 }]) {
      const res = await request(app)
        .post('/api/contacts/c-opt/opt-out')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('404s an unknown contact', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/contacts/nope/opt-out')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ optOut: true });
    expect(res.status).toBe(404);
  });
});
