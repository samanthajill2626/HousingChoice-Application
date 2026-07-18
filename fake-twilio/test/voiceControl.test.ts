// Task 7.1: the voice CONTROL API over HTTP (place-call + step endpoints + list).
//
// Mirrors control.test.ts's supertest idiom but for the CallEngine. The app's
// default CallEngine uses a RealClock; here we INJECT a CallEngine built on a
// ManualClock + a stub dispatcher so a scenario auto-run completes deterministically:
// the control handler kicks off placeCall and returns promptly, then the test drives
// the clock (clock.flush() + engine.settle()) on the held references before asserting.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { CallEngine } from '../src/engine/callEngine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import { NumberRegistry } from '../src/engine/numberRegistry.js';
import type { WebhookParams } from '../src/engine/signer.js';

const MASKED_DIAL = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+15550199001" record="do-not-record" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status" method="POST"><Number url="https://app/webhooks/twilio/voice/whisper?callerLabel=Tenant&leg=callee" statusCallback="https://app/webhooks/twilio/voice/status">+15550199001</Number></Dial></Response>`;
const WHISPER_GATHER = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="https://app/webhooks/twilio/voice/whisper-gate?leg=callee" method="POST"><Say>Press 1 to accept, or press 0 to reach the team.</Say></Gather><Hangup/></Response>`;
const GATE_ACCEPT = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/></Response>`;

function makeStubDispatcher() {
  const reply = (path: string): string => {
    if (path.startsWith('/webhooks/twilio/voice/whisper-gate')) return GATE_ACCEPT;
    if (path.startsWith('/webhooks/twilio/voice/whisper')) return WHISPER_GATHER;
    if (path.startsWith('/webhooks/twilio/voice/status')) return '';
    if (path === '/webhooks/twilio/voice') return MASKED_DIAL;
    return '';
  };
  return {
    async postForResponse(_path: string, _params: WebhookParams) {
      return { status: 200, body: reply(_path) };
    },
    async post(_path: string, _params: WebhookParams) {
      return 200;
    },
    async postJson(_path: string, _body: Record<string, unknown>) {
      return 200;
    },
  };
}

function makeApp() {
  const config = loadFakeConfig({
    NODE_ENV: 'test',
    TWILIO_AUTH_TOKEN: 't',
    APP_BASE_URL: 'http://localhost:8080',
    APP_PUBLIC_BASE_URL: 'http://localhost:5173',
  });
  const clock = new ManualClock('2026-06-15T00:00:00.000Z');
  const registry = new NumberRegistry();
  registry.provision(); // mints +15550190001 → routes masked
  const callEngine = new CallEngine({
    clock,
    dispatcher: makeStubDispatcher(),
    hub: new EventHub(),
    registry,
  });
  return { app: buildFakeTwilioApp({ config, callEngine, registry }), clock, callEngine };
}

describe('voice control API (Task 7.1)', () => {
  it('POST /control/place-call WITH a scenario drives the call to a terminal status', async () => {
    const { app, clock, callEngine } = makeApp();
    const res = await request(app)
      .post('/control/place-call')
      .send({ from: '+15550100001', to: '+15550190001', scenario: { answerLeg: 'callee', digit: '1', outcome: 'answered' } });
    expect(res.status).toBe(200);
    expect(res.body.callSid).toMatch(/^CA/);

    // The handler returns promptly; drive the injected clock to completion.
    clock.flush();
    await callEngine.settle();

    const call = callEngine.getCalls().find((c) => c.callSid === res.body.callSid);
    expect(call?.status).toBe('completed');
  });

  it('GET /control/calls lists placed calls with callSid + status', async () => {
    const { app, clock, callEngine } = makeApp();
    await request(app)
      .post('/control/place-call')
      .send({ from: '+15550100001', to: '+15550190001', scenario: { answerLeg: 'callee', digit: '1', outcome: 'answered' } });
    clock.flush();
    await callEngine.settle();

    const res = await request(app).get('/control/calls');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.calls)).toBe(true);
    expect(res.body.calls[0]).toMatchObject({ callSid: expect.stringMatching(/^CA/), status: 'completed' });
  });

  it('POST /control/calls/:sid/press advances a PAUSED call (placed without a scenario)', async () => {
    const { app } = makeApp();
    const placed = await request(app).post('/control/place-call').send({ from: '+15550100001', to: '+15550190001' });
    expect(placed.status).toBe(200);
    const sid = placed.body.callSid as string;

    // Paused after interpret — still ringing.
    const before = await request(app).get('/control/calls');
    expect(before.body.calls.find((c: { callSid: string }) => c.callSid === sid)?.status).toBe('ringing');

    // press awaits the step internally and returns the updated call state.
    const res = await request(app).post(`/control/calls/${sid}/press`).send({ digit: '1' });
    expect(res.status).toBe(200);
    expect(res.body.call.status).toBe('completed');

    const after = await request(app).get('/control/calls');
    expect(after.body.calls.find((c: { callSid: string }) => c.callSid === sid)?.status).toBe('completed');
  });

  it('POST /control/calls/:sid/hangup drives a paused call to no-answer', async () => {
    const { app } = makeApp();
    const placed = await request(app).post('/control/place-call').send({ from: '+15550100001', to: '+15550190001' });
    const sid = placed.body.callSid as string;
    const res = await request(app).post(`/control/calls/${sid}/hangup`).send({});
    expect(res.status).toBe(200);
    expect(res.body.call.status).toBe('no-answer');
  });

  it('400s place-call missing `from`', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/control/place-call').send({ to: '+15550190001' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from/i);
  });

  it('400s place-call missing `to`', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/control/place-call').send({ from: '+15550100001' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/to/i);
  });

  it('400s place-call with an obviously-bad scenario type', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/control/place-call')
      .send({ from: '+15550100001', to: '+15550190001', scenario: { digit: 'nope', outcome: 'exploded' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scenario/i);
  });

  it('400s press with a missing digit', async () => {
    const { app } = makeApp();
    const placed = await request(app).post('/control/place-call').send({ from: '+15550100001', to: '+15550190001' });
    const sid = placed.body.callSid as string;
    const res = await request(app).post(`/control/calls/${sid}/press`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/digit/i);
  });

  it('400s press on an unknown :sid', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/control/calls/CAdoesnotexist/press').send({ digit: '1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/call/i);
  });
});
