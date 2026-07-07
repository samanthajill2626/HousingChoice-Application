// fake-twilio/test/control.test.ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import type { WebhookParams } from '../src/engine/signer.js';

function makeApp() {
  const config = loadFakeConfig({ NODE_ENV: 'test', TWILIO_AUTH_TOKEN: 't', APP_BASE_URL: 'http://localhost:8080', APP_PUBLIC_BASE_URL: 'http://localhost:5173' });
  const posted: Array<{ path: string; params: WebhookParams }> = [];
  const engine = new FakeTwilioEngine({
    clock: new ManualClock('2026-06-15T00:00:00.000Z'),
    dispatcher: { post: async (path, params) => { posted.push({ path, params }); return 200; } },
    hub: new EventHub(),
  });
  return { app: buildFakeTwilioApp({ config, engine }), posted };
}

describe('control API', () => {
  it('POST /control/send-as-party dispatches an inbound webhook and returns the sid', async () => {
    const { app, posted } = makeApp();
    const res = await request(app).post('/control/send-as-party').send({ from: '+15550100001', body: 'hi there' });
    expect(res.status).toBe(200);
    expect(res.body.sid).toMatch(/^SM/);
    expect(posted[0]?.path).toBe('/webhooks/twilio/sms');
  });

  it('GET /control/threads returns the conversation store', async () => {
    const { app } = makeApp();
    await request(app).post('/control/send-as-party').send({ from: '+15550100001', body: 'hi' });
    const res = await request(app).get('/control/threads');
    expect(res.status).toBe(200);
    expect(res.body.threads.find((t: { partyNumber: string }) => t.partyNumber === '+15550100001')).toBeTruthy();
  });

  it('POST /control/personas/ad-hoc mints a persona', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/control/personas/ad-hoc').send({ label: 'Unknown', role: 'tenant' });
    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^\+1555/);
  });

  it('POST /control/delivery-outcome sets the next outbound profile', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/control/delivery-outcome').send({ partyNumber: '+15550100001', profile: { kind: 'fail', errorCode: '30005' } });
    expect(res.status).toBe(200);
  });

  it('POST /control/reset clears threads', async () => {
    const { app } = makeApp();
    await request(app).post('/control/send-as-party').send({ from: '+15550100001', body: 'hi' });
    await request(app).post('/control/reset').send({});
    const res = await request(app).get('/control/threads');
    expect(res.body.threads).toHaveLength(0);
  });

  it('400s send-as-party from an unknown number', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/control/send-as-party').send({ from: '+15559999999', body: 'x' });
    expect(res.status).toBe(400);
  });

  it('400s send-as-party with an invalid mediaUrl (engine validation surfaces as 400)', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/control/send-as-party')
      .send({ from: '+15550100001', mediaUrls: ['ftp://not-http/cat.jpg'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mediaUrl/i);
  });

  it('GET /control/dispatch-errors returns 200 with an errors array', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/control/dispatch-errors');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it('GET /control/groups returns traffic-inferred relay groups', async () => {
    const { app } = makeApp();
    await request(app)
      .post('/control/send-as-party')
      .send({ from: '+15550100001', to: '+15550160001', body: 'hi group' });
    const res = await request(app).get('/control/groups');
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0]).toMatchObject({ poolNumber: '+15550160001' });
    expect(res.body.groups[0].members).toEqual([{ number: '+15550100001', label: 'Tasha Nguyen (tenant)' }]);
    expect(res.body.groups[0].entries[0]).toMatchObject({ kind: 'inbound', from: '+15550100001', body: 'hi group' });
    expect(typeof res.body.groups[0].lastActivityAt).toBe('string');
  });

  it('POST /control/reset clears groups too', async () => {
    const { app } = makeApp();
    await request(app)
      .post('/control/send-as-party')
      .send({ from: '+15550100001', to: '+15550160001', body: 'hi group' });
    await request(app).post('/control/reset').send({});
    const res = await request(app).get('/control/groups');
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(0);
  });
});
