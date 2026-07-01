// Task 2: structured landlord contact fields — contract_status/expected_rent/
// registered_landlord/rta_within_48h/pass_inspection_first_try/income_includes_voucher.
// Verifies that PATCH persists the fields, GET returns them, type validation fires,
// and POST create accepts them on creation. Mirrors contactIntakeFields.test.ts.
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
        expected_rent: 1450,
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
    expect(got.body.contact.expected_rent).toBe(1450);
    expect(got.body.contact.registered_landlord).toBe(true);
    expect(got.body.contact.rta_within_48h).toBe(true);
    expect(got.body.contact.pass_inspection_first_try).toBe(false);
    expect(got.body.contact.income_includes_voucher).toBe(true);
  });

  it('accepts expected_rent of 0 and contract_status unsigned', async () => {
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
      .send({ contract_status: 'unsigned', expected_rent: 0 })
      .expect(200);

    const got = await request(app)
      .get(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .expect(200);
    expect(got.body.contact.contract_status).toBe('unsigned');
    expect(got.body.contact.expected_rent).toBe(0);
  });

  it('rejects a non-enum contract_status, a string expected_rent, and a non-boolean flag', async () => {
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
      .send({ expected_rent: '1450' })
      .expect(400);
    await request(app)
      .patch(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ expected_rent: -5 })
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
        expected_rent: 1200,
        registered_landlord: false,
        income_includes_voucher: true,
      })
      .expect(201);
    expect(created.body.contact.contract_status).toBe('signed');
    expect(created.body.contact.expected_rent).toBe(1200);
    expect(created.body.contact.registered_landlord).toBe(false);
    expect(created.body.contact.income_includes_voucher).toBe(true);
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
