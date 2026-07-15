// Input sanitization (founder decision 2026-07-14): every string field in a
// JSON request body is deep-trimmed at the edge (middleware/trimStrings.ts),
// so a "firstName" can never persist as "Cameron   ". Urlencoded bodies
// (Twilio webhooks) keep byte fidelity. Also pins the part-wise display-name
// join (legacy padded parts must not render "Cameron   Abt").
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { deepTrimStrings, trimJsonBody } from '../src/middleware/trimStrings.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';

describe('deepTrimStrings', () => {
  it('trims string values at every depth; leaves keys and non-strings alone', () => {
    const input = {
      firstName: '  Cameron  ',
      count: 3,
      flag: true,
      none: null,
      nested: { notes: '\tline\n', keep: 7 },
      list: ['  a ', 42, { label: ' b  ' }],
    };
    expect(deepTrimStrings(input)).toEqual({
      firstName: 'Cameron',
      count: 3,
      flag: true,
      none: null,
      nested: { notes: 'line', keep: 7 },
      list: ['a', 42, { label: 'b' }],
    });
  });

  it('collapses a whitespace-only string to empty (the "clear the field" value)', () => {
    expect(deepTrimStrings({ company: '   ' })).toEqual({ company: '' });
  });

  it('leaves interior whitespace alone (only the ends are trimmed)', () => {
    expect(deepTrimStrings({ name: ' Mary  Ann ' })).toEqual({ name: 'Mary  Ann' });
  });
});

describe('trimJsonBody middleware', () => {
  function echoApp(): express.Express {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(trimJsonBody());
    app.post('/echo', (req, res) => void res.json(req.body));
    return app;
  }

  it('trims a JSON body (nested included)', async () => {
    const res = await request(echoApp())
      .post('/echo')
      .send({ firstName: '  Cameron  ', address: { city: ' Atlanta ' } });
    expect(res.body).toEqual({ firstName: 'Cameron', address: { city: 'Atlanta' } });
  });

  it('does NOT touch an urlencoded body (webhook/provider fidelity)', async () => {
    const res = await request(echoApp())
      .post('/echo')
      .type('form')
      .send({ Body: '  yes  ' });
    expect(res.body).toEqual({ Body: '  yes  ' });
  });
});

describe('padded input through the REAL contact routes', () => {
  it('POST + PATCH store trimmed fields; the display-name join has no interior gap', async () => {
    const { app } = makeWebhookHarness();
    const created = await request(app)
      .post('/api/contacts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ type: 'tenant', firstName: '  Cameron  ', lastName: ' Abt ' })
      .expect(201);
    const id = created.body.contact.contactId;
    expect(created.body.contact.firstName).toBe('Cameron');
    expect(created.body.contact.lastName).toBe('Abt');

    await request(app)
      .patch(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ notes: '  likes townhomes  ', housingAuthority: ' atlanta_housing ' })
      .expect(200);

    const got = await request(app)
      .get(`/api/contacts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .expect(200);
    expect(got.body.contact.firstName).toBe('Cameron');
    expect(got.body.contact.lastName).toBe('Abt');
    expect(got.body.contact.notes).toBe('likes townhomes');
    expect(got.body.contact.housingAuthority).toBe('atlanta_housing');
  });
});
