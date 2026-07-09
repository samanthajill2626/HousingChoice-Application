// fake-twilio/test/rest.test.ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import { normalizeMediaUrls } from '../src/routes/rest.js';

function makeApp() {
  const config = loadFakeConfig({ NODE_ENV: 'test', TWILIO_AUTH_TOKEN: 't', APP_BASE_URL: 'http://localhost:8080', APP_PUBLIC_BASE_URL: 'http://localhost:5173' });
  const engine = new FakeTwilioEngine({ clock: new ManualClock('2026-06-15T00:00:00.000Z'), dispatcher: { post: async () => 200 }, hub: new EventHub() });
  return { app: buildFakeTwilioApp({ config, engine }), engine };
}

describe('REST impersonation: POST /2010-04-01/Accounts/:sid/Messages.json', () => {
  it('accepts a form-encoded create and returns a Twilio-shaped Message', async () => {
    const { app, engine } = makeApp();
    const res = await request(app)
      .post('/2010-04-01/Accounts/ACtest/Messages.json')
      .type('form')
      .send({ To: '+15550100001', From: '+15550009999', Body: 'hello tenant' });
    expect(res.status).toBe(201);
    expect(res.body.sid).toMatch(/^SM/);
    expect(res.body.status).toBe('queued');
    expect(res.body.to).toBe('+15550100001');
    // Recorded into the recipient's thread.
    const thread = engine.listThreads().find((t) => t.partyNumber === '+15550100001');
    expect(thread?.messages[0]).toMatchObject({ direction: 'outbound', body: 'hello tenant' });
  });

  it('accepts MessagingServiceSid instead of From (the app uses a Messaging Service)', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/2010-04-01/Accounts/ACtest/Messages.json')
      .type('form')
      .send({ To: '+15550100001', MessagingServiceSid: 'MGtest', Body: 'hi' });
    expect(res.status).toBe(201);
  });

  it('returns a Twilio-shaped 400 when To is missing', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ Body: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(21604); // Twilio's "a 'To' phone number is required"
  });

  it('records a SINGLE MediaUrl (string) as one outbound media leg', async () => {
    const { app, engine } = makeApp();
    const res = await request(app)
      .post('/2010-04-01/Accounts/ACtest/Messages.json')
      .type('form')
      .send({ To: '+15550100002', From: '+15550009999', Body: 'one photo', MediaUrl: 'http://ex/a.png' });
    expect(res.status).toBe(201);
    expect(res.body.num_media).toBe('1');
    expect(res.body.sid).toMatch(/^MM/); // media => MM SID prefix
    const thread = engine.listThreads().find((t) => t.partyNumber === '+15550100002');
    expect(thread?.messages[0]?.mediaUrls).toEqual(['http://ex/a.png']);
  });

  it('records REPEATED MediaUrl params (array) as multiple outbound media legs', async () => {
    const { app, engine } = makeApp();
    // supertest form-encodes an array field as repeated MediaUrl=... params,
    // exactly as the Twilio SDK does for a multi-attachment send.
    const res = await request(app)
      .post('/2010-04-01/Accounts/ACtest/Messages.json')
      .type('form')
      .send({ To: '+15550100003', From: '+15550009999', Body: 'two photos', MediaUrl: ['http://ex/a.png', 'http://ex/b.png'] });
    expect(res.status).toBe(201);
    expect(res.body.num_media).toBe('2');
    const thread = engine.listThreads().find((t) => t.partyNumber === '+15550100003');
    expect(thread?.messages[0]?.mediaUrls).toEqual(['http://ex/a.png', 'http://ex/b.png']);
  });

  it('Calls.json is no longer a 501 stub - voiceRest handles it (400 on empty body)', async () => {
    // Phase 6 replaced the 501 voice/number-provisioning stubs with real handlers
    // (see voiceRest.test.ts). An empty Calls.json POST now hits the real handler,
    // which 400s on the missing To/From/Url - NOT 501.
    const { app } = makeApp();
    const calls = await request(app).post('/2010-04-01/Accounts/ACtest/Calls.json').type('form').send({});
    expect(calls.status).toBe(400);
    expect(calls.status).not.toBe(501);
  });
});

describe('normalizeMediaUrls: string | string[] param', () => {
  it('wraps a single string in a one-element array', () => {
    expect(normalizeMediaUrls('http://ex/a.png')).toEqual(['http://ex/a.png']);
  });
  it('passes an array of strings through unchanged', () => {
    expect(normalizeMediaUrls(['http://ex/a.png', 'http://ex/b.png'])).toEqual([
      'http://ex/a.png',
      'http://ex/b.png',
    ]);
  });
  it('returns undefined for a missing param (num_media stays 0)', () => {
    expect(normalizeMediaUrls(undefined)).toBeUndefined();
  });
  it('returns undefined for an empty array', () => {
    expect(normalizeMediaUrls([])).toBeUndefined();
  });
});
