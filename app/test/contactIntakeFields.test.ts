// Task 5: structured intake fields on the contact (pets/evictions/tenure/lifEligible).
// Verifies that PATCH persists the fields, GET returns them, type validation fires,
// and POST create accepts them on creation.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';

describe('contact intake fields (pets/evictions/tenure/lifEligible)', () => {
  it('PATCH persists intake fields and GET returns them', async () => {
    const { app } = makeWebhookHarness();
    // Create a contact to triage/patch.
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant', firstName: 'Pat', lastName: 'Q' })
      .expect(201);
    const id = created.body.contact.contactId;

    await request(app)
      .patch(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ pets: '1 cat', evictions: 'none', tenure: '3 years', lifEligible: true })
      .expect(200);

    const got = await request(app)
      .get(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .expect(200);
    expect(got.body.contact.pets).toBe('1 cat');
    expect(got.body.contact.evictions).toBe('none');
    expect(got.body.contact.tenure).toBe('3 years');
    expect(got.body.contact.lifEligible).toBe(true);
  });

  it('rejects a non-string pets and a non-boolean lifEligible', async () => {
    const { app } = makeWebhookHarness();
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant', firstName: 'Pat', lastName: 'Q' })
      .expect(201);
    const id = created.body.contact.contactId;

    await request(app)
      .patch(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ pets: 5 })
      .expect(400);
    await request(app)
      .patch(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ lifEligible: 'yes' })
      .expect(400);
  });

  it('POST create accepts intake fields', async () => {
    const { app } = makeWebhookHarness();
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant', firstName: 'Lee', lastName: 'M', pets: 'none', lifEligible: false })
      .expect(201);
    expect(created.body.contact.pets).toBe('none');
    expect(created.body.contact.lifEligible).toBe(false);
  });
});
