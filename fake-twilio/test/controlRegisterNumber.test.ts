// relay-number-buying T9: POST /control/register-number simulates Twilio's A2P
// Event Streams "number-registration.successful" signal for a PREVIOUSLY-PROVISIONED
// pool number, so the connect-when-ready path can be driven end-to-end without real
// Twilio. The CRITICAL invariant: the emitted event's data.phonenumbersid is the SAME
// PN sid the fake minted when the app provisioned the number (D2 correlation) - that
// is exactly what the app's events sink keys on to promote the warming record.
//
// Tested at the router level with an INJECTED postEventsBatch stub (mirrors the
// control.test.ts stub-dispatcher idiom) so the batch shape + correlation are asserted
// without a live app server.
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createControlRouter } from '../src/routes/control.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import { NumberRegistry } from '../src/engine/numberRegistry.js';

const REG_SUCCESS_TYPE = 'com.twilio.messaging.compliance.number-registration.successful';

interface CapturedBatch {
  path: string;
  batch: unknown;
}

interface RegistrationEnvelope {
  specversion: string;
  type: string;
  id: string;
  datacontenttype: string;
  time: string;
  data: { phonenumbersid: string; phonenumber: string; messagingservicesid: string };
}

function makeApp(postStatus = 200): {
  app: express.Express;
  registry: NumberRegistry;
  posted: CapturedBatch[];
} {
  const engine = new FakeTwilioEngine({
    clock: new ManualClock('2026-06-15T00:00:00.000Z'),
    dispatcher: { post: async () => 200 },
    hub: new EventHub(),
  });
  const registry = new NumberRegistry();
  const posted: CapturedBatch[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createControlRouter(engine, {
      registry,
      postEventsBatch: async (path, batch) => {
        posted.push({ path, batch });
        return postStatus;
      },
    }),
  );
  return { app, registry, posted };
}

describe('POST /control/register-number (T9 A2P registration simulation)', () => {
  it('fires a well-formed registration batch carrying the minted PN sid for a provisioned number', async () => {
    const { app, registry, posted } = makeApp();
    // The app "provisioned" this number earlier; the fake minted its PN sid.
    const { phoneNumber, sid } = registry.provisionSpecific('+15550190123');

    const res = await request(app).post('/control/register-number').send({ phoneNumber });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(posted).toHaveLength(1);
    expect(posted[0]?.path).toBe('/webhooks/twilio/events');
    const batch = posted[0]?.batch as unknown[];
    expect(Array.isArray(batch)).toBe(true);
    expect(batch).toHaveLength(1);
    const ev = batch[0] as RegistrationEnvelope;
    expect(ev.specversion).toBe('1.0');
    expect(ev.type).toBe(REG_SUCCESS_TYPE);
    // THE correlation: data.phonenumbersid is the SAME sid the fake minted (D2).
    expect(ev.data.phonenumbersid).toBe(sid);
    // Real Event Streams shape: bare digits, NO leading '+' (D1).
    expect(ev.data.phonenumber).toBe('15550190123');
    expect(typeof ev.data.messagingservicesid).toBe('string');
    expect(ev.data.messagingservicesid.length).toBeGreaterThan(0);
  });

  it('400s a number that was never provisioned (no minted sid to correlate)', async () => {
    const { app, posted } = makeApp();
    const res = await request(app)
      .post('/control/register-number')
      .send({ phoneNumber: '+15550190999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a provisioned pool number/i);
    expect(posted).toHaveLength(0);
  });

  it('400s a missing phoneNumber', async () => {
    const { app, posted } = makeApp();
    const res = await request(app).post('/control/register-number').send({});
    expect(res.status).toBe(400);
    expect(posted).toHaveLength(0);
  });

  it('surfaces a non-2xx from the app events sink as a 400 (not swallowed)', async () => {
    const { app, registry } = makeApp(403);
    const { phoneNumber } = registry.provisionSpecific('+15550190555');
    const res = await request(app).post('/control/register-number').send({ phoneNumber });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/403/);
  });
});
