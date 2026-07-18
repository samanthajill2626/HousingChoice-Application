// fake-twilio/test/voiceRest.test.ts
//
// Phase 6 / Task 6.1: the real Twilio voice REST surface the app's adapter calls —
// Calls.json (click-to-call → CallEngine.originateCall), AvailablePhoneNumbers +
// IncomingPhoneNumbers (number provisioning), and the recording-serve route that
// streams the canned MP3 the CallEngine mints `.mp3` URLs for.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { ManualClock } from '../src/engine/clock.js';
import { EventHub } from '../src/engine/eventHub.js';
import { CallEngine } from '../src/engine/callEngine.js';
import { NumberRegistry } from '../src/engine/numberRegistry.js';

function makeApp() {
  const config = loadFakeConfig({
    NODE_ENV: 'test',
    FAKE_TWILIO_PORT: '8889',
    TWILIO_AUTH_TOKEN: 't',
    APP_BASE_URL: 'http://localhost:8080',
    APP_PUBLIC_BASE_URL: 'http://localhost:5173',
  });
  const hub = new EventHub();
  const registry = new NumberRegistry();
  // A voice dispatcher stub: the inbound /voice fetch returns empty TwiML (no
  // <Dial>), so originateCall completes the call without driving a bridge — enough
  // to assert the REST route reached the engine.
  const dispatcher = {
    postForResponse: async () => ({ status: 200, body: '<Response/>' }),
    post: async () => 200,
    postJson: async () => 200,
  };
  const callEngine = new CallEngine({
    clock: new ManualClock('2026-06-16T00:00:00.000Z'),
    dispatcher,
    hub,
    registry,
    recordingServeBase: 'http://localhost:8889',
  });
  const app = buildFakeTwilioApp({ config, hub, callEngine, registry });
  return { app, callEngine, registry };
}

const ACCT = '/2010-04-01/Accounts/ACtest';

describe('voice REST: POST .../Calls.json (click-to-call)', () => {
  it('originates an outbound call and returns a Twilio-shaped Call resource', async () => {
    const { app, callEngine } = makeApp();
    const res = await request(app)
      .post(`${ACCT}/Calls.json`)
      .type('form')
      .send({ To: '+15550100001', From: '+15550009999', Url: 'http://localhost:8080/webhooks/twilio/voice' });
    expect(res.status).toBe(201);
    expect(res.body.sid).toMatch(/^CA/);
    expect(res.body.to).toBe('+15550100001');
    expect(res.body.from).toBe('+15550009999');
    expect(typeof res.body.status).toBe('string');
    // It actually drove the engine: a new outbound call exists.
    const call = callEngine.getCalls().find((c) => c.to === '+15550100001');
    expect(call).toBeDefined();
    expect(call?.kind).toBe('outbound');
  });

  it('returns a Twilio-shaped 400 when To/From/Url are missing', async () => {
    const { app } = makeApp();
    const res = await request(app).post(`${ACCT}/Calls.json`).type('form').send({});
    expect(res.status).toBe(400);
    expect(typeof res.body.more_info).toBe('string');
  });
});

describe('voice REST: GET .../AvailablePhoneNumbers/US/Local.json', () => {
  it('lists at least one voice+sms-capable number', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get(`${ACCT}/AvailablePhoneNumbers/US/Local.json`)
      .query({ VoiceEnabled: 'true', SmsEnabled: 'true' });
    expect(res.status).toBe(200);
    const list = res.body.available_phone_numbers;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].phone_number).toMatch(/^\+1/);
    expect(list[0].capabilities).toMatchObject({ voice: true, sms: true });
  });
});

describe('voice REST: POST .../IncomingPhoneNumbers.json (commit a chosen number)', () => {
  it('registers the chosen number as a pool number and returns a PN resource', async () => {
    const { app, registry } = makeApp();
    // Two-step: pick a candidate from AvailablePhoneNumbers, then commit it here.
    const avail = await request(app)
      .get(`${ACCT}/AvailablePhoneNumbers/US/Local.json`)
      .query({ VoiceEnabled: 'true', SmsEnabled: 'true' });
    const chosen: string = avail.body.available_phone_numbers[0].phone_number;
    expect(registry.isPool(chosen)).toBe(false);

    const res = await request(app)
      .post(`${ACCT}/IncomingPhoneNumbers.json`)
      .type('form')
      .send({
        PhoneNumber: chosen,
        SmsUrl: 'http://localhost:8080/webhooks/twilio/sms',
        VoiceUrl: 'http://localhost:8080/webhooks/twilio/voice',
      });
    expect(res.status).toBe(201);
    expect(res.body.sid).toMatch(/^PN/);
    expect(res.body.phone_number).toBe(chosen);
    expect(res.body.capabilities).toMatchObject({ voice: true, sms: true });
    // The committed number is now a recognized pool number (inbound → masked).
    expect(registry.isPool(chosen)).toBe(true);
    expect(registry.get(chosen)?.voiceUrl).toBe('http://localhost:8080/webhooks/twilio/voice');
  });

  it('returns 400 when PhoneNumber is missing', async () => {
    const { app } = makeApp();
    const res = await request(app).post(`${ACCT}/IncomingPhoneNumbers.json`).type('form').send({});
    expect(res.status).toBe(400);
    expect(typeof res.body.more_info).toBe('string');
  });
});

describe('voice REST: IncomingPhoneNumbers list + update (setVoiceWebhook path)', () => {
  it('lists by PhoneNumber then updates VoiceUrl by sid', async () => {
    const { app, registry } = makeApp();
    const avail = await request(app)
      .get(`${ACCT}/AvailablePhoneNumbers/US/Local.json`)
      .query({ VoiceEnabled: 'true', SmsEnabled: 'true' });
    const chosen: string = avail.body.available_phone_numbers[0].phone_number;
    const created = await request(app)
      .post(`${ACCT}/IncomingPhoneNumbers.json`)
      .type('form')
      .send({ PhoneNumber: chosen });
    const sid: string = created.body.sid;

    const listed = await request(app)
      .get(`${ACCT}/IncomingPhoneNumbers.json`)
      .query({ PhoneNumber: chosen });
    expect(listed.status).toBe(200);
    expect(listed.body.incoming_phone_numbers[0].sid).toBe(sid);

    const updated = await request(app)
      .post(`${ACCT}/IncomingPhoneNumbers/${sid}.json`)
      .type('form')
      .send({ VoiceUrl: 'http://localhost:8080/webhooks/twilio/voice' });
    expect(updated.status).toBe(200);
    expect(updated.body.sid).toBe(sid);
    expect(registry.get(chosen)?.voiceUrl).toBe('http://localhost:8080/webhooks/twilio/voice');
  });
});

describe('voice REST: GET /recordings/:callSid/:recordingSid.mp3', () => {
  it('streams the canned MP3 as audio/mpeg', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/recordings/CA1/RE1.mp3');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
    expect(res.body.length).toBeGreaterThan(0);
    // Valid MP3 frame sync at the start of the canned bytes.
    expect(res.body[0]).toBe(0xff);
  });
});
