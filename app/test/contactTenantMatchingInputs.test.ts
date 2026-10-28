// WP1 B1 (spec 2026-10-26 D2): the four tenant matching inputs on the
// contacts PATCH and create. Trimmed; '' and null CLEAR (REMOVE - the
// voucher_expiration_date pattern, not the pets / tenure '' store); exact
// error copy; the audit row names them; not type-gated. The value rules are
// unit-tested in tenantMatchingInputs.test.ts - this suite proves both
// parsers apply them. In-memory harness.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';

type App = ReturnType<typeof makeWebhookHarness>['app'];

function post(app: App, body: Record<string, unknown>) {
  return request(app)
    .post('/api/contacts')
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

function patch(app: App, id: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/contacts/${id}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send(body);
}

async function stored(app: App, id: string): Promise<Record<string, unknown>> {
  const res = await request(app)
    .get(`/api/contacts/${id}`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .expect(200);
  return res.body.contact as Record<string, unknown>;
}

async function newContact(app: App, type: 'tenant' | 'landlord' = 'tenant'): Promise<string> {
  const res = await post(app, { type, firstName: 'Pat', lastName: 'Q' });
  expect(res.status).toBe(201);
  return res.body.contact.contactId as string;
}

const PORTION_ERROR = 'Maximum tenant portion must be a whole dollar amount from 0 to 20000.';

describe('contacts PATCH - the tenant matching inputs (WP1 B1 spec D2)', () => {
  it('stores all four - text trimmed, the portion a number - and GET returns them', async () => {
    const { app } = makeWebhookHarness();
    const id = await newContact(app);
    const res = await patch(app, id, {
      area_preference: '  Decatur or Tucker ',
      max_tenant_portion: 1200,
      accessibility_need: ' No stairs ',
      preferences_constraints: 'Needs a yard\nNo apartments',
    });
    expect(res.status).toBe(200);
    const contact = await stored(app, id);
    expect(contact['area_preference']).toBe('Decatur or Tucker');
    expect(contact['max_tenant_portion']).toBe(1200);
    expect(contact['accessibility_need']).toBe('No stairs');
    expect(contact['preferences_constraints']).toBe('Needs a yard\nNo apartments');
  });

  it('the contact_updated audit row names the fields', async () => {
    const { app, world } = makeWebhookHarness();
    const id = await newContact(app);
    expect((await patch(app, id, { area_preference: 'Decatur', max_tenant_portion: 900 })).status).toBe(200);
    const audit = world.auditEvents.find(
      (e) => e.event_type === 'contact_updated' && e.entityKey === `contacts#${id}`,
    );
    expect(audit?.payload).toMatchObject({
      fields: expect.arrayContaining(['area_preference', 'max_tenant_portion']),
    });
  });

  it("'' and null CLEAR - the attribute is removed, never stored as ''", async () => {
    const { app } = makeWebhookHarness();
    const id = await newContact(app);
    await patch(app, id, {
      area_preference: 'Decatur',
      max_tenant_portion: 900,
      accessibility_need: 'No stairs',
      preferences_constraints: 'Needs a yard',
    }).expect(200);
    const res = await patch(app, id, {
      area_preference: '',
      max_tenant_portion: null,
      accessibility_need: '   ',
      preferences_constraints: null,
    });
    expect(res.status).toBe(200);
    const contact = await stored(app, id);
    for (const key of ['area_preference', 'max_tenant_portion', 'accessibility_need', 'preferences_constraints']) {
      expect(key in contact, key).toBe(false);
    }
    // '' clears the portion too.
    await patch(app, id, { max_tenant_portion: 500 }).expect(200);
    await patch(app, id, { max_tenant_portion: '' }).expect(200);
    expect('max_tenant_portion' in (await stored(app, id))).toBe(false);
  });

  it('501 characters after the trim is a 400 naming the label, and nothing is written', async () => {
    const { app } = makeWebhookHarness();
    const id = await newContact(app);
    await patch(app, id, { accessibility_need: 'No stairs' }).expect(200);
    const res = await patch(app, id, { accessibility_need: 'x'.repeat(501), firstName: 'Patrice' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Accessibility need must be 500 characters or fewer.');
    const contact = await stored(app, id);
    expect(contact['accessibility_need']).toBe('No stairs');
    expect(contact['firstName']).toBe('Pat');
  });

  it('a bad portion is a 400 with the spec copy', async () => {
    const { app } = makeWebhookHarness();
    const id = await newContact(app);
    for (const bad of [20001, -1, 1200.5, '1200']) {
      const res = await patch(app, id, { max_tenant_portion: bad });
      expect(res.status, String(bad)).toBe(400);
      expect(res.body.error, String(bad)).toBe(PORTION_ERROR);
    }
  });

  it('is not type-gated: a landlord PATCH stores them too (tenant-only is a UI guarantee)', async () => {
    const { app } = makeWebhookHarness();
    const id = await newContact(app, 'landlord');
    expect((await patch(app, id, { area_preference: 'Decatur' })).status).toBe(200);
    expect((await stored(app, id))['area_preference']).toBe('Decatur');
  });
});

describe('contacts POST - the tenant matching inputs (WP1 B1 spec D2)', () => {
  it('accepts them, trimmed; a clear on create stores nothing', async () => {
    const { app } = makeWebhookHarness();
    const res = await post(app, {
      type: 'tenant',
      firstName: 'Lee',
      lastName: 'M',
      area_preference: ' Decatur ',
      max_tenant_portion: 0,
      accessibility_need: '',
      preferences_constraints: null,
    });
    expect(res.status).toBe(201);
    const contact = res.body.contact as Record<string, unknown>;
    expect(contact['area_preference']).toBe('Decatur');
    expect(contact['max_tenant_portion']).toBe(0);
    expect('accessibility_need' in contact).toBe(false);
    expect('preferences_constraints' in contact).toBe(false);
  });

  it('refuses a bad value with the same copy as the PATCH', async () => {
    const { app } = makeWebhookHarness();
    const bad = await post(app, { type: 'tenant', firstName: 'Lee', max_tenant_portion: '900' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe(PORTION_ERROR);
    const notText = await post(app, { type: 'tenant', firstName: 'Lee', preferences_constraints: 7 });
    expect(notText.status).toBe(400);
    expect(notText.body.error).toBe('Preferences and constraints must be a string.');
  });
});
