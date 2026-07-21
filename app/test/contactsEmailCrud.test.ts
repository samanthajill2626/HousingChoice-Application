// Email-channel A1 route tests - the contact-emails CRUD added to the contacts
// router (the exact analog of contactPhones.test.ts):
//   GET    /api/contacts/:id             -> { contact } now includes `emails`
//   POST   /api/contacts/:id/emails      { email, label? } -> 200 { contact }
//   PATCH  /api/contacts/:id/emails/:email { primary?, label? } -> { contact }
//   DELETE /api/contacts/:id/emails/:email -> { contact }
//   POST   /api/contacts                 { ..., email? } -> 201 | 409 dedupe
// Run against the fake world (supertest), mirroring contactPhones.test.ts style.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactEmail, ContactItem } from '../src/repos/contactsRepo.js';
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

describe('GET /api/contacts/:id - emails serialization (A1)', () => {
  it('serves a scalar-only contact as emails=[{email,primary:true}] (back-compat)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'landlord', email: 'marcus@example.com' });

    const res = await auth(request(app).get('/api/contacts/c-1'));
    expect(res.status).toBe(200);
    // Legacy scalar intact (superset) ...
    expect(res.body.contact.email).toBe('marcus@example.com');
    // ... plus the derived emails[].
    expect(res.body.contact.emails).toEqual([{ email: 'marcus@example.com', primary: true }]);
  });

  it('serves stored emails[] verbatim', async () => {
    const { app, world } = makeWebhookHarness();
    const emails: ContactEmail[] = [
      { email: 'marcus@example.com', primary: true },
      { email: 'marcus.work@example.com', primary: false, label: 'work' },
    ];
    seedContact(world, { contactId: 'c-1', type: 'landlord', email: 'marcus@example.com', emails });

    const res = await auth(request(app).get('/api/contacts/c-1'));
    expect(res.body.contact.emails).toEqual(emails);
  });

  it('serves emails=[] for a contact with neither a scalar email nor emails[]', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-noemail', type: 'tenant' });

    const res = await auth(request(app).get('/api/contacts/c-noemail'));
    expect(res.status).toBe(200);
    expect(res.body.contact.emails).toEqual([]);
  });
});

describe('POST /api/contacts/:id/emails - attach (A1)', () => {
  it('attaches an address (200), normalizes it, updates emails[], audits', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'landlord', email: 'marcus@example.com' });

    const res = await auth(
      request(app).post('/api/contacts/c-1/emails').send({ email: '  Marcus.Work@Example.COM ', label: 'work' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.contact.emails).toEqual([
      expect.objectContaining({ email: 'marcus@example.com', primary: true }),
      expect.objectContaining({ email: 'marcus.work@example.com', primary: false, label: 'work' }),
    ]);
    // The attached address now resolves to this contact (pointer in place).
    const viaB = await world.contactsRepo.findByEmail('marcus.work@example.com');
    expect(viaB?.contactId).toBe('c-1');
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({ entityKey: 'contacts#c-1', event_type: 'contact_email_added' }),
    );
  });

  it('404s a missing contact', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(
      request(app).post('/api/contacts/ghost/emails').send({ email: 'x@example.com' }),
    );
    expect(res.status).toBe(404);
  });

  it('400s a missing/invalid email or bad label', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', email: 'a@example.com' });
    for (const body of [{}, { email: 'nope' }, { email: 'a@b' }, { email: 'x@example.com', label: 5 }]) {
      const res = await auth(request(app).post('/api/contacts/c-1/emails').send(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('409s when the address already belongs to a DIFFERENT contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', email: 'a@example.com' });
    seedContact(world, { contactId: 'c-2', type: 'landlord', email: 'b@example.com' });

    const res = await auth(
      request(app).post('/api/contacts/c-1/emails').send({ email: 'B@Example.com' }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('email_in_use');
    expect(res.body.contact.contactId).toBe('c-2');
  });

  it('is an idempotent no-op re-post of the same address (still 200)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', email: 'a@example.com' });
    await auth(request(app).post('/api/contacts/c-1/emails').send({ email: 'b@example.com' }));
    const again = await auth(request(app).post('/api/contacts/c-1/emails').send({ email: 'b@example.com' }));
    expect(again.status).toBe(200);
    expect(again.body.contact.emails.filter((e: ContactEmail) => e.email === 'b@example.com')).toHaveLength(1);
  });
});

describe('PATCH /api/contacts/:id/emails/:email - promote/label (A1)', () => {
  it('promotes an address to primary (scalar swaps, exactly one primary) and updates label', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-1',
      type: 'landlord',
      email: 'a@example.com',
      emails: [
        { email: 'a@example.com', primary: true },
        { email: 'b@example.com', primary: false },
      ],
    });

    const res = await auth(
      request(app)
        .patch(`/api/contacts/c-1/emails/${encodeURIComponent('b@example.com')}`)
        .send({ primary: true, label: 'main' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.contact.email).toBe('b@example.com'); // scalar swapped
    const primaries = res.body.contact.emails.filter((e: ContactEmail) => e.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].email).toBe('b@example.com');
    expect(
      res.body.contact.emails.find((e: ContactEmail) => e.email === 'b@example.com').label,
    ).toBe('main');
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({ entityKey: 'contacts#c-1', event_type: 'contact_email_updated' }),
    );
  });

  it('404s an address not on the contact, and 400s an empty/invalid body', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', email: 'a@example.com' });

    const missing = await auth(
      request(app)
        .patch(`/api/contacts/c-1/emails/${encodeURIComponent('z@example.com')}`)
        .send({ primary: true }),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('contact_or_email_not_found');

    const empty = await auth(
      request(app).patch(`/api/contacts/c-1/emails/${encodeURIComponent('a@example.com')}`).send({}),
    );
    expect(empty.status).toBe(400);
  });

  it('400s an invalid :email param', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', email: 'a@example.com' });
    const res = await auth(
      request(app).patch(`/api/contacts/c-1/emails/${encodeURIComponent('not-an-email')}`).send({ primary: true }),
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/contacts/:id/emails/:email - detach (A1)', () => {
  it('removes a non-primary address (200), audits', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-1',
      type: 'landlord',
      email: 'a@example.com',
      emails: [
        { email: 'a@example.com', primary: true },
        { email: 'b@example.com', primary: false },
      ],
    });

    const res = await auth(
      request(app).delete(`/api/contacts/c-1/emails/${encodeURIComponent('b@example.com')}`),
    );
    expect(res.status).toBe(200);
    expect(res.body.contact.emails.map((e: ContactEmail) => e.email)).toEqual(['a@example.com']);
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({ entityKey: 'contacts#c-1', event_type: 'contact_email_removed' }),
    );
  });

  it('rejects removing the primary while other addresses exist (409 cannot_remove_primary)', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, {
      contactId: 'c-1',
      type: 'landlord',
      email: 'a@example.com',
      emails: [
        { email: 'a@example.com', primary: true },
        { email: 'b@example.com', primary: false },
      ],
    });

    const res = await auth(
      request(app).delete(`/api/contacts/c-1/emails/${encodeURIComponent('a@example.com')}`),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_remove_primary');
  });

  it('404s an address not on the contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', email: 'a@example.com' });
    const res = await auth(
      request(app).delete(`/api/contacts/c-1/emails/${encodeURIComponent('z@example.com')}`),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('contact_or_email_not_found');
  });
});

describe('POST /api/contacts - create with optional email (A1)', () => {
  it('creates a contact with a normalized email (scalar) and serializes emails[]', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(
      request(app)
        .post('/api/contacts')
        .send({ type: 'landlord', firstName: 'Pat', email: '  Pat.Owner@Example.COM ' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.contact.email).toBe('pat.owner@example.com'); // normalized scalar
  });

  it('dedupes by email: an existing address returns 409 + the existing contact, no duplicate', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-existing', type: 'landlord', email: 'dupe@example.com', firstName: 'Already' });
    const before = world.contacts.length;

    const res = await auth(
      request(app).post('/api/contacts').send({ type: 'landlord', firstName: 'Dupe', email: 'DUPE@example.com' }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_exists');
    expect(res.body.contact.contactId).toBe('c-existing');
    expect(world.contacts.length).toBe(before); // nothing created
  });

  it('400s an invalid email on create', async () => {
    const { app } = makeWebhookHarness();
    const res = await auth(
      request(app).post('/api/contacts').send({ type: 'tenant', email: 'not-an-email' }),
    );
    expect(res.status).toBe(400);
  });
});
