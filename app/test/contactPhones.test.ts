// BE1/C1 route tests — the contact-phones CRUD added to the contacts router:
//   GET    /api/contacts/:id            → { contact } now includes `phones`
//   POST   /api/contacts/:id/phones     { phone, label? } → 201 { contact }
//   PATCH  /api/contacts/:id/phones/:phone { primary?, label? } → { contact }
//   DELETE /api/contacts/:id/phones/:phone → { contact }
// Run against the fake world (supertest), mirroring contactsCrud.test.ts style.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem, ContactPhone } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

function seedContact(
  world: ReturnType<typeof createFakeWorld>,
  overrides: Partial<ContactItem> & { contactId: string; type: ContactItem['type'] },
): void {
  world.contacts.push({ status: 'active', ...overrides });
}

const auth = (req: request.Test) =>
  req.set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

describe('GET /api/contacts/:id — phones serialization (C1)', () => {
  it('serves a scalar-only contact as phones=[{phone,primary:true}] (back-compat)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', phone: '+15550100001' });

    const res = await auth(request(app).get('/api/contacts/c-1'));
    expect(res.status).toBe(200);
    // Legacy scalar intact (superset) …
    expect(res.body.contact.phone).toBe('+15550100001');
    // … plus the derived phones[].
    expect(res.body.contact.phones).toEqual([{ phone: '+15550100001', primary: true }]);
  });

  it('serves stored phones[] verbatim', async () => {
    const { app, world } = makeWebhookHarness();
    const phones: ContactPhone[] = [
      { phone: '+15550100001', primary: true },
      { phone: '+15550100002', primary: false, label: 'work' },
    ];
    seedContact(world, { contactId: 'c-1', type: 'tenant', phone: '+15550100001', phones });

    const res = await auth(request(app).get('/api/contacts/c-1'));
    expect(res.body.contact.phones).toEqual(phones);
  });

  it('404s a missing contact', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(request(app).get('/api/contacts/nope'));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/contacts/:id/phones — attach (C1)', () => {
  it('attaches a number (201), normalizes it, updates phones[], audits', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', phone: '+15550100001' });

    const res = await auth(
      request(app).post('/api/contacts/c-1/phones').send({ phone: '(555) 010-0002', label: 'work' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.contact.phones).toEqual([
      expect.objectContaining({ phone: '+15550100001', primary: true }),
      expect.objectContaining({ phone: '+15550100002', primary: false, label: 'work' }),
    ]);
    // The attached number now resolves to this contact (pointer in place).
    const viaB = await world.contactsRepo.findByPhone('+15550100002');
    expect(viaB?.contactId).toBe('c-1');
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({ entityKey: 'contacts#c-1', event_type: 'contact_phone_added' }),
    );
  });

  it('404s a missing contact', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(request(app).post('/api/contacts/ghost/phones').send({ phone: '5550100002' }));
    expect(res.status).toBe(404);
  });

  it('400s a missing/invalid phone or bad label', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', phone: '+15550100001' });
    for (const body of [{}, { phone: 'nope' }, { phone: '5550100002', label: 5 }]) {
      const res = await auth(request(app).post('/api/contacts/c-1/phones').send(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('409s when the number already belongs to a DIFFERENT contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', phone: '+15550100001' });
    seedContact(world, { contactId: 'c-2', type: 'landlord', phone: '+15550100002' });

    const res = await auth(
      request(app).post('/api/contacts/c-1/phones').send({ phone: '+15550100002' }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('phone_in_use');
    expect(res.body.contact.contactId).toBe('c-2');
  });
});

describe('PATCH /api/contacts/:id/phones/:phone — promote/label (C1)', () => {
  it('promotes a number to primary (scalar swaps, exactly one primary) and updates label', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-1',
      type: 'tenant',
      phone: '+15550100001',
      phones: [
        { phone: '+15550100001', primary: true },
        { phone: '+15550100002', primary: false },
      ],
    });

    const res = await auth(
      request(app)
        .patch(`/api/contacts/c-1/phones/${encodeURIComponent('+15550100002')}`)
        .send({ primary: true, label: 'main cell' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.contact.phone).toBe('+15550100002'); // scalar swapped
    const primaries = res.body.contact.phones.filter((p: ContactPhone) => p.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].phone).toBe('+15550100002');
    expect(res.body.contact.phones.find((p: ContactPhone) => p.phone === '+15550100002').label).toBe(
      'main cell',
    );
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({ entityKey: 'contacts#c-1', event_type: 'contact_phone_updated' }),
    );
  });

  it('404s a phone not on the contact, and 400s an empty/invalid body', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', phone: '+15550100001' });

    const missing = await auth(
      request(app)
        .patch(`/api/contacts/c-1/phones/${encodeURIComponent('+15550100009')}`)
        .send({ primary: true }),
    );
    expect(missing.status).toBe(404);

    const empty = await auth(
      request(app).patch(`/api/contacts/c-1/phones/${encodeURIComponent('+15550100001')}`).send({}),
    );
    expect(empty.status).toBe(400);
  });
});

describe('DELETE /api/contacts/:id/phones/:phone — detach (C1)', () => {
  it('removes a non-primary number (200), audits', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-1',
      type: 'tenant',
      phone: '+15550100001',
      phones: [
        { phone: '+15550100001', primary: true },
        { phone: '+15550100002', primary: false },
      ],
    });

    const res = await auth(
      request(app).delete(`/api/contacts/c-1/phones/${encodeURIComponent('+15550100002')}`),
    );
    expect(res.status).toBe(200);
    expect(res.body.contact.phones.map((p: ContactPhone) => p.phone)).toEqual(['+15550100001']);
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({ entityKey: 'contacts#c-1', event_type: 'contact_phone_removed' }),
    );
  });

  it('rejects removing the primary while other numbers exist (409)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-1',
      type: 'tenant',
      phone: '+15550100001',
      phones: [
        { phone: '+15550100001', primary: true },
        { phone: '+15550100002', primary: false },
      ],
    });

    const res = await auth(
      request(app).delete(`/api/contacts/c-1/phones/${encodeURIComponent('+15550100001')}`),
    );
    expect(res.status).toBe(409);
  });

  it('404s a phone not on the contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', phone: '+15550100001' });
    const res = await auth(
      request(app).delete(`/api/contacts/c-1/phones/${encodeURIComponent('+15550100009')}`),
    );
    expect(res.status).toBe(404);
  });
});
