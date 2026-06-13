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
});
