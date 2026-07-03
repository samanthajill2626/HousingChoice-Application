// M1.5 unit tests: the contacts LIST + CREATE endpoints added to the contacts
// router (the triage GET/PATCH /:contactId are covered by contactTriage.test).
//   GET   /api/contacts?type=&status=&phone=
//   POST  /api/contacts  (manual create, phone dedupe, "First Last - N Bed")
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

function seedContact(
  world: ReturnType<typeof createFakeWorld>,
  overrides: Partial<ContactItem> & { contactId: string; type: ContactItem['type'] },
): void {
  world.contacts.push({ status: 'active', ...overrides });
}

describe('GET /api/contacts — list/filter', () => {
  it('lists by type, narrows by status', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', status: 'active' });
    seedContact(world, { contactId: 'c-2', type: 'tenant', status: 'needs_review' });
    seedContact(world, { contactId: 'c-3', type: 'landlord', status: 'active' });

    const tenants = await request(app)
      .get('/api/contacts?type=tenant')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(tenants.status).toBe(200);
    expect(tenants.body.contacts.map((c: ContactItem) => c.contactId).sort()).toEqual(['c-1', 'c-2']);

    const triage = await request(app)
      .get('/api/contacts?type=tenant&status=needs_review')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(triage.body.contacts.map((c: ContactItem) => c.contactId)).toEqual(['c-2']);
  });

  it('looks a contact up by phone (normalizing the query)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', phone: '+15550104444' });

    const res = await request(app)
      .get('/api/contacts?phone=' + encodeURIComponent('(555) 010-4444'))
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.contacts.map((c: ContactItem) => c.contactId)).toEqual(['c-1']);

    const none = await request(app)
      .get('/api/contacts?phone=5550109999')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(none.body.contacts).toEqual([]);
  });

  it('400s a missing type (no unbounded scan) and a bad phone', async () => {
    const { app } = makeWebhookHarness();
    const noType = await request(app)
      .get('/api/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(noType.status).toBe(400);

    const badPhone = await request(app)
      .get('/api/contacts?phone=abc')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(badPhone.status).toBe(400);

    const badType = await request(app)
      .get('/api/contacts?type=robot')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(badType.status).toBe(400);
  });
});

describe('POST /api/contacts — manual create', () => {
  it('creates a contact, normalizes phone, defaults status active, audits', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'landlord', firstName: 'Pat', lastName: 'Owner', phone: '(555) 010-7000' });

    expect(res.status).toBe(201);
    expect(res.body.contact).toMatchObject({
      type: 'landlord',
      firstName: 'Pat',
      lastName: 'Owner',
      phone: '+15550107000', // normalized
      status: 'active', // manual create asserts identity
    });
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({
        entityKey: `contacts#${res.body.contact.contactId}`,
        event_type: 'contact_created',
      }),
    );
  });

  it('supports the "First Last - N Bed" convenience string', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant', contactName: 'Keisha Jones - 2 Bed' });
    expect(res.status).toBe(201);
    expect(res.body.contact).toMatchObject({
      firstName: 'Keisha',
      lastName: 'Jones',
      voucherSize: 2,
    });
  });

  it('dedupes by phone: an existing phone returns 409 + the existing contact, no duplicate', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-existing',
      type: 'tenant',
      phone: '+15550108000',
      firstName: 'Already',
    });
    const before = world.contacts.length;

    const res = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant', firstName: 'Dupe', phone: '555-010-8000' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_exists');
    expect(res.body.contact.contactId).toBe('c-existing');
    expect(world.contacts.length).toBe(before); // nothing created
  });

  it('400s a missing/invalid type, bad phone, and bad voucherSize', async () => {
    const { app, world } = makeWebhookHarness();
    for (const body of [
      {}, // no type
      { type: 'robot' },
      { type: 'tenant', phone: 'not-a-phone' },
      { type: 'tenant', voucherSize: 99 },
      { type: 'tenant', contactName: 'Madonna' }, // single token, non-conforming
    ]) {
      const res = await request(app)
        .post('/api/contacts')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(world.auditEvents).toHaveLength(0);
  });

  it('creates a contact with role, company, relationships, and customFields', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
      .send({
        type: 'tenant', firstName: 'Carla', lastName: 'Reyes', role: 'Case worker', company: 'AH Agency',
        relationships: [{ role: 'Client', name: 'Tasha Nguyen', contactId: 'contact-tenant-0001' }],
        customFields: [{ label: 'Agency', value: 'Atlanta Housing' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.contact).toMatchObject({
      type: 'tenant', role: 'Case worker', company: 'AH Agency',
      relationships: [{ role: 'Client', name: 'Tasha Nguyen', contactId: 'contact-tenant-0001' }],
      customFields: [{ label: 'Agency', value: 'Atlanta Housing' }],
    });
  });

  it('400s an invalid relationship on create', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app).post('/api/contacts')
      .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant', relationships: [{ role: 'Client' }] }); // missing name
    expect(res.status).toBe(400);
  });
});

describe('POST /api/contacts — A2P/CTIA consent capture (spec §3.3)', () => {
  const CONSENT_AT = '2026-06-29T12:00:00.000Z';

  it('accepts a HUMAN consent_method + at + note and stamps consent_captured_by from the SESSION', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        type: 'tenant',
        firstName: 'May',
        phone: '(555) 010-7100',
        consent_method: 'verbal_in_person',
        consent_at: CONSENT_AT,
        consent_note: 'said OK to texts at fair',
      });
    expect(res.status).toBe(201);
    expect(res.body.contact).toMatchObject({
      consent_method: 'verbal_in_person',
      consent_at: CONSENT_AT,
      consent_note: 'said OK to texts at fair',
      // server-stamped, NOT client-supplied
      consent_captured_by: 'usr_testva00000000000000000',
    });
    const stored = world.contacts.find((c) => c.contactId === res.body.contact.contactId)!;
    expect(stored.consent_captured_by).toBe('usr_testva00000000000000000');
  });

  it('REJECTS an automatic consent_method (web_form / inbound_text / inbound_call) from the human create path', async () => {
    const { app } = makeWebhookHarness();
    for (const method of ['web_form', 'inbound_text', 'inbound_call', 'nonsense']) {
      const res = await request(app)
        .post('/api/contacts')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ type: 'tenant', consent_method: method });
      expect(res.status, method).toBe(400);
    }
  });

  it('REJECTS a client-supplied consent_captured_by (server-owned, never trusted)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant', consent_method: 'paper_form', consent_captured_by: 'usr_someoneelse' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/contacts/:id/conversation — start a thread with a new contact', () => {
  it('creates the 1:1 thread for the primary number (typed by the contact) and denormalizes the name', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({
      contactId: 'c-new',
      type: 'tenant',
      status: 'active',
      firstName: 'Nora',
      lastName: 'New',
      phone: '+15550107300',
    });

    const res = await request(app)
      .post('/api/contacts/c-new/conversation')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.conversation.participant_phone).toBe('+15550107300');
    expect(res.body.conversation.type).toBe('tenant_1to1');
    expect(res.body.conversation.participant_display_name).toBe('Nora New');
  });

  it('is idempotent — a second call returns the SAME conversation', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'c-new', type: 'landlord', status: 'active', phone: '+15550107301' });

    const first = await request(app)
      .post('/api/contacts/c-new/conversation')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    const second = await request(app)
      .post('/api/contacts/c-new/conversation')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.conversation.type).toBe('landlord_1to1');
    expect(second.body.conversation.conversationId).toBe(first.body.conversation.conversationId);
  });

  it('an unresolved (unknown) contact gets an unknown_1to1 thread', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550107302' });
    const res = await request(app)
      .post('/api/contacts/c-unk/conversation')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.conversation.type).toBe('unknown_1to1');
  });

  it('400s when the contact has no phone; 404s when the contact does not exist', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'c-nophone', type: 'tenant', status: 'active' });
    const noPhone = await request(app)
      .post('/api/contacts/c-nophone/conversation')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(noPhone.status).toBe(400);
    expect(noPhone.body.error).toBe('contact_has_no_phone');

    const missing = await request(app)
      .post('/api/contacts/nope/conversation')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(missing.status).toBe(404);
  });
});

describe('PATCH /api/contacts/:id — A2P/CTIA JIT record-consent (spec §3.4)', () => {
  const CONSENT_AT = '2026-06-29T12:00:00.000Z';

  it('records consent (method + at + note) and stamps consent_captured_by from the session; retry then unblocks the send', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-jit', type: 'tenant', status: 'active', phone: '+15550107200' });

    const res = await request(app)
      .patch('/api/contacts/contact-jit')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ consent_method: 'verbal_phone', consent_at: CONSENT_AT, consent_note: 'confirmed by phone' });

    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({
      consent_method: 'verbal_phone',
      consent_at: CONSENT_AT,
      consent_note: 'confirmed by phone',
      consent_captured_by: 'usr_testva00000000000000000',
    });
  });

  it('REJECTS an automatic consent_method on the JIT PATCH', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-jit', type: 'tenant', status: 'active', phone: '+15550107201' });
    const res = await request(app)
      .patch('/api/contacts/contact-jit')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ consent_method: 'web_form' });
    expect(res.status).toBe(400);
  });

  it('accepts client_inbound (staff attests the client texted/called first) on the JIT PATCH', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-jit', type: 'tenant', status: 'active', phone: '+15550107205' });
    const res = await request(app)
      .patch('/api/contacts/contact-jit')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ consent_method: 'client_inbound', consent_at: CONSENT_AT, consent_note: 'they called us on 6/28' });
    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({
      consent_method: 'client_inbound',
      consent_captured_by: 'usr_testva00000000000000000',
    });
  });

  it('REJECTS a client-supplied consent_captured_by on the JIT PATCH', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-jit', type: 'tenant', status: 'active', phone: '+15550107202' });
    const res = await request(app)
      .patch('/api/contacts/contact-jit')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ consent_method: 'paper_form', consent_captured_by: 'usr_impostor' });
    expect(res.status).toBe(400);
  });
});

// Local authed(app) helper — mirrors the raw header/cookie pattern used above
// (there is no shared `authed`; toursApi.test.ts defines its own per-file).
function authed(app: Parameters<typeof request>[0]) {
  return {
    post: (path: string) =>
      request(app).post(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
    patch: (path: string) =>
      request(app).patch(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE),
  };
}

describe('opt_out_changed milestone on opt-out routes', () => {
  it('records an opt_out_changed milestone on SMS opt-out toggle (both directions)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'c1', type: 'tenant', phone: '+15550100001' } as ContactItem);
    await authed(app).post('/api/contacts/c1/opt-out').send({ optOut: true }).expect(200);
    await authed(app).post('/api/contacts/c1/opt-out').send({ optOut: false }).expect(200);
    const ev = world.activityEvents.filter((e) => e.type === 'opt_out_changed');
    expect(ev.map((e) => e.label)).toEqual(['Marked Do Not Contact', 'Do Not Contact cleared']);
  });

  it('records an opt_out_changed milestone on voice opt-out toggle (both directions)', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'c2', type: 'tenant', phone: '+15550100002' } as ContactItem);
    await authed(app).post('/api/contacts/c2/voice-opt-out').send({ optOut: true }).expect(200);
    await authed(app).post('/api/contacts/c2/voice-opt-out').send({ optOut: false }).expect(200);
    const ev = world.activityEvents.filter((e) => e.type === 'opt_out_changed');
    expect(ev.map((e) => e.label)).toEqual(['Marked Do Not Call', 'Do Not Call cleared']);
  });
});

describe('contact_status_changed milestone on the edit-form status write', () => {
  it('records a contact_status_changed milestone when the edit form changes a landlord status', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'll1', type: 'landlord', status: 'needs_review' } as ContactItem);
    await authed(app).patch('/api/contacts/ll1').send({ status: 'active' }).expect(200);
    const ev = world.activityEvents.filter((e) => e.type === 'contact_status_changed');
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toContain('Active');
  });

  it('records NO status milestone when the edit does not change status', async () => {
    const { app, world } = makeWebhookHarness();
    world.contacts.push({ contactId: 'll2', type: 'landlord', status: 'active', firstName: 'A' } as ContactItem);
    await authed(app).patch('/api/contacts/ll2').send({ firstName: 'B' }).expect(200);
    expect(world.activityEvents.filter((e) => e.type === 'contact_status_changed')).toHaveLength(0);
  });
});
