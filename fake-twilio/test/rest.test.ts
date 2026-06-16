// fake-twilio/test/rest.test.ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';

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

  it('501s voice + number-provisioning stubs (deferred channels)', async () => {
    const { app } = makeApp();
    const calls = await request(app).post('/2010-04-01/Accounts/ACtest/Calls.json').type('form').send({});
    expect(calls.status).toBe(501);
  });
});
