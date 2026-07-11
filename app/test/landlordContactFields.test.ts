// Task 2: structured landlord contact fields — contract_status/
// registered_landlord/rta_within_48h/pass_inspection_first_try/income_includes_voucher.
// Verifies that PATCH persists the fields, GET returns them, type validation fires,
// and POST create accepts them on creation. Mirrors contactIntakeFields.test.ts.
//
// NOTE (2026-07-10): expected_rent + the preference defaults (accepts_programs/
// lease_terms/pet_policy) MOVED to the UNIT — the contact parsers no longer
// accept them (ignored as unknown keys; pinned at the bottom of this file).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';

describe('structured landlord fields', () => {
  it('PATCH persists the landlord fields and GET returns them', async () => {
    const { app } = makeWebhookHarness();
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'landlord', firstName: 'Pat', lastName: 'Owner' })
      .expect(201);
    const id = created.body.contact.contactId;

    await request(app)
      .patch(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        contract_status: 'signed',
        registered_landlord: true,
        rta_within_48h: true,
        pass_inspection_first_try: false,
        income_includes_voucher: true,
      })
      .expect(200);

    const got = await request(app)
      .get(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .expect(200);
    expect(got.body.contact.contract_status).toBe('signed');
    expect(got.body.contact.registered_landlord).toBe(true);
    expect(got.body.contact.rta_within_48h).toBe(true);
    expect(got.body.contact.pass_inspection_first_try).toBe(false);
    expect(got.body.contact.income_includes_voucher).toBe(true);
  });

  it('rejects a non-enum contract_status and a non-boolean flag', async () => {
    const { app } = makeWebhookHarness();
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'landlord' })
      .expect(201);
    const id = created.body.contact.contactId;

    await request(app)
      .patch(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ contract_status: 'maybe' })
      .expect(400);
    await request(app)
      .patch(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ registered_landlord: 'yes' })
      .expect(400);
  });

  it('POST create accepts the landlord fields', async () => {
    const { app } = makeWebhookHarness();
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        type: 'landlord',
        contract_status: 'signed',
        registered_landlord: false,
        income_includes_voucher: true,
      })
      .expect(201);
    expect(created.body.contact.contract_status).toBe('signed');
    expect(created.body.contact.registered_landlord).toBe(false);
    expect(created.body.contact.income_includes_voucher).toBe(true);
  });
});

// MOVED TO THE UNIT (2026-07-10): expected_rent + the preference defaults
// (accepts_programs / lease_terms / pet_policy) are per-property facts now
// (rent_min-rent_max / accepted_programs / lease_terms / pets on UnitItem).
// The contact parsers treat them like any other unknown key — silently
// ignored, never persisted — so a stale client sending them cannot resurrect
// contact-level copies.
describe('moved-to-unit fields are ignored on the contact', () => {
  it('PATCH ignores the moved fields (200, nothing persisted)', async () => {
    const { app } = makeWebhookHarness();
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'landlord', firstName: 'Pat', lastName: 'Owner' })
      .expect(201);
    const id = created.body.contact.contactId;

    await request(app)
      .patch(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        // Ride alongside a REAL field so the PATCH itself is valid.
        company: 'Shelton Homes',
        expected_rent: 1450,
        accepts_programs: ['HCV'],
        lease_terms: '12-month minimum',
        pet_policy: 'No pets',
      })
      .expect(200);

    const got = await request(app)
      .get(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .expect(200);
    expect(got.body.contact.company).toBe('Shelton Homes');
    expect(got.body.contact.expected_rent).toBeUndefined();
    expect(got.body.contact.accepts_programs).toBeUndefined();
    expect(got.body.contact.lease_terms).toBeUndefined();
    expect(got.body.contact.pet_policy).toBeUndefined();
  });

  it('POST create ignores the moved fields', async () => {
    const { app } = makeWebhookHarness();
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        type: 'landlord',
        expected_rent: 1200,
        accepts_programs: ['HCV'],
        lease_terms: 'Year lease',
        pet_policy: 'No pets',
      })
      .expect(201);
    expect(created.body.contact.expected_rent).toBeUndefined();
    expect(created.body.contact.accepts_programs).toBeUndefined();
    expect(created.body.contact.lease_terms).toBeUndefined();
    expect(created.body.contact.pet_policy).toBeUndefined();
  });
});

// Task 4a: park_reason is settable via the generic PATCH (today it's only written
// by the /tenant-status route on a `parked` move). The edit form persists a park
// reason alongside a status change, so the generic PATCH must accept it.
describe('park_reason via the generic PATCH', () => {
  it('PATCH persists park_reason and GET returns it', async () => {
    const { app } = makeWebhookHarness();
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'landlord', firstName: 'Dana', lastName: 'Owner' })
      .expect(201);
    const id = created.body.contact.contactId;

    await request(app)
      .patch(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ park_reason: 'Declined the program' })
      .expect(200);

    const got = await request(app)
      .get(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .expect(200);
    expect(got.body.contact.park_reason).toBe('Declined the program');
  });

  it('rejects a non-string park_reason', async () => {
    const { app } = makeWebhookHarness();
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'landlord' })
      .expect(201);
    const id = created.body.contact.contactId;

    await request(app)
      .patch(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ park_reason: 42 })
      .expect(400);
  });

  it('POST create accepts park_reason', async () => {
    const { app } = makeWebhookHarness();
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'landlord', park_reason: 'Never signed' })
      .expect(201);
    expect(created.body.contact.park_reason).toBe('Never signed');
  });
});
