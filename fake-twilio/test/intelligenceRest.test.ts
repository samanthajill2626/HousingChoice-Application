// Task 12: the fake Voice Intelligence REST surface + signed JSON completion webhook.
//
// The app's twilio v6 client (via the origin-rewriting httpClient) calls:
//   POST /v2/Transcripts                 (create; form ServiceSid/Channel/CustomerKey)
//   GET  /v2/Transcripts/:sid            (instance; snake_case JSON)
//   GET  /v2/Transcripts/:sid/Sentences  (page; meta.key sentences + next_page_url null)
// A create schedules the signed JSON webhook to /webhooks/twilio/voice/intelligence;
// scenario.viWebhook 'drop' suppresses it (exercises the app's reconcile leg). Sentences
// are built from scenario.transcript: bridge recordings alternate media_channel 1/2.
import { describe, expect, it, afterEach } from 'vitest';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import twilio from 'twilio';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { ManualClock } from '../src/engine/clock.js';
import { EventHub } from '../src/engine/eventHub.js';
import { CallEngine } from '../src/engine/callEngine.js';
import { WebhookDispatcher } from '../src/engine/dispatcher.js';
import { NumberRegistry } from '../src/engine/numberRegistry.js';
import type { WebhookParams } from '../src/engine/signer.js';

const FOUNDER_DIAL = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="2"/><Dial callerId="+15550199001" record="record-from-answer-dual" recordingStatusCallback="https://app/webhooks/twilio/voice/recording" answerOnBridge="true" action="https://app/webhooks/twilio/voice/status"><Number url="https://app/webhooks/twilio/voice/whisper?leg=founder">+15551230000</Number></Dial></Response>`;
const WHISPER_GATHER = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="https://app/webhooks/twilio/voice/whisper-gate?leg=founder" method="POST"><Say>Press 1 to accept, or press 0 to reach the team.</Say></Gather><Hangup/></Response>`;
const GATE_ACCEPT = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/></Response>`;
const VI_SERVICE = 'GAfakeservice';

interface Posted { method: 'post' | 'postForResponse' | 'postJson'; path: string; body?: Record<string, unknown> }

function makeApp() {
  const config = loadFakeConfig({
    NODE_ENV: 'test',
    TWILIO_AUTH_TOKEN: 't',
    APP_BASE_URL: 'http://localhost:8080',
    APP_PUBLIC_BASE_URL: 'http://localhost:5173',
    TWILIO_VI_SERVICE_SID: VI_SERVICE,
  });
  const posted: Posted[] = [];
  const reply = (path: string): string => {
    if (path.startsWith('/webhooks/twilio/voice/whisper-gate')) return GATE_ACCEPT;
    if (path.startsWith('/webhooks/twilio/voice/whisper')) return WHISPER_GATHER;
    if (path === '/webhooks/twilio/voice') return FOUNDER_DIAL;
    return '';
  };
  const dispatcher = {
    async postForResponse(path: string, _params: WebhookParams) {
      posted.push({ method: 'postForResponse', path });
      return { status: 200, body: reply(path) };
    },
    async post(path: string, _params: WebhookParams) {
      posted.push({ method: 'post', path });
      return 200;
    },
    async postJson(path: string, body: Record<string, unknown>) {
      posted.push({ method: 'postJson', path, body });
      return 200;
    },
  };
  const clock = new ManualClock('2026-06-16T00:00:00.000Z');
  const registry = new NumberRegistry();
  const callEngine = new CallEngine({ clock, dispatcher, hub: new EventHub(), registry, recordingServeBase: 'http://localhost:8889' });
  const app = buildFakeTwilioApp({ config, callEngine, registry });
  return { app, callEngine, clock, posted };
}

/** Drive a founder bridge to a recorded, completed state and return its ids. */
async function recordFounderBridge(
  callEngine: CallEngine,
  clock: ManualClock,
  scenario: { transcript?: string; viWebhook?: 'deliver' | 'drop' } = {},
) {
  await callEngine.placeCall({
    from: '+15550100001',
    to: '+15551230000',
    scenario: { answerLeg: 'founder', digit: '1', record: true, outcome: 'answered', ...scenario },
  });
  clock.flush();
  await callEngine.settle();
  const call = callEngine.getCalls()[0]!;
  return { callSid: call.callSid, recordingSid: call.recordingSid! };
}

describe('fake VI REST: POST /v2/Transcripts', () => {
  it('registers a transcript from the pending recording and fires the signed JSON webhook', async () => {
    const { app, callEngine, clock, posted } = makeApp();
    const { callSid, recordingSid } = await recordFounderBridge(callEngine, clock, { transcript: 'Hello there.' });

    const res = await request(app)
      .post('/v2/Transcripts')
      .type('form')
      .send({ ServiceSid: VI_SERVICE, Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }), CustomerKey: callSid });
    expect(res.status).toBe(201);
    expect(res.body.sid).toMatch(/^GTfake/);
    expect(res.body.customer_key).toBe(callSid);

    clock.flush();
    await callEngine.settle();
    const hook = posted.find((p) => p.method === 'postJson' && p.path.startsWith('/webhooks/twilio/voice/intelligence'));
    expect(hook).toBeDefined();
    expect(hook?.body?.['transcript_sid']).toBe(res.body.sid);
  });

  it('rejects a ServiceSid that does not match the configured fake service (does not mint)', async () => {
    const { app, callEngine, clock } = makeApp();
    const { recordingSid } = await recordFounderBridge(callEngine, clock, { transcript: 'x.' });
    const res = await request(app)
      .post('/v2/Transcripts')
      .type('form')
      .send({ ServiceSid: 'GAsomeoneelse', Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }), CustomerKey: 'CA1' });
    expect(res.status).toBe(400);
    expect(typeof res.body.more_info).toBe('string');
  });

  it('viWebhook drop: registers the transcript but never posts the webhook', async () => {
    const { app, callEngine, clock, posted } = makeApp();
    const { callSid, recordingSid } = await recordFounderBridge(callEngine, clock, { transcript: 'Reconciled.', viWebhook: 'drop' });

    const res = await request(app)
      .post('/v2/Transcripts')
      .type('form')
      .send({ ServiceSid: VI_SERVICE, Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }), CustomerKey: callSid });
    expect(res.status).toBe(201);

    clock.flush();
    await callEngine.settle();
    expect(posted.some((p) => p.method === 'postJson')).toBe(false);
  });
});

describe('fake VI REST: GET /v2/Transcripts/:sid + /Sentences', () => {
  it('serve SDK-shaped JSON (meta.key sentences, next_page_url null)', async () => {
    const { app, callEngine, clock } = makeApp();
    const { callSid, recordingSid } = await recordFounderBridge(callEngine, clock, { transcript: 'Hello there.' });
    const created = await request(app).post('/v2/Transcripts').type('form').send(
      { ServiceSid: VI_SERVICE, Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }), CustomerKey: callSid },
    );
    const sid: string = created.body.sid;

    const inst = await request(app).get(`/v2/Transcripts/${sid}`);
    expect(inst.status).toBe(200);
    expect(inst.body.sid).toBe(sid);
    expect(inst.body.status).toBe('completed');
    expect(inst.body.customer_key).toBe(callSid);

    const sents = await request(app).get(`/v2/Transcripts/${sid}/Sentences`);
    expect(sents.status).toBe(200);
    expect(sents.body.meta.key).toBe('sentences');
    expect(sents.body.meta.next_page_url).toBeNull();
    expect(Array.isArray(sents.body.sentences)).toBe(true);
    expect(sents.body.sentences[0].transcript).toBe('Hello there.');
    expect(typeof sents.body.sentences[0].media_channel).toBe('number');
  });

  it('bridge recordings alternate media_channel 1/2 across sentences', async () => {
    const { app, callEngine, clock } = makeApp();
    const { callSid, recordingSid } = await recordFounderBridge(callEngine, clock, { transcript: 'One. Two. Three.' });
    const created = await request(app).post('/v2/Transcripts').type('form').send(
      { ServiceSid: VI_SERVICE, Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }), CustomerKey: callSid },
    );
    const sents = await request(app).get(`/v2/Transcripts/${created.body.sid}/Sentences`);
    const channels = (sents.body.sentences as Array<{ media_channel: number }>).map((s) => s.media_channel);
    expect(channels).toEqual([1, 2, 1]);
  });
});

describe('fake VI webhook: signature', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it('the JSON completion webhook validates with the bodySHA256 scheme', async () => {
    const TOKEN = 'shared-secret-token';
    let captured: { sig: string; body: string; url: string } | undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        if ((req.url ?? '').startsWith('/webhooks/twilio/voice/intelligence')) {
          captured = {
            sig: String(req.headers['x-twilio-signature'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
            url: req.url ?? '',
          };
        }
        res.statusCode = 200;
        res.end('');
      });
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const addr = server!.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${addr.port}`;

    const clock = new ManualClock('2026-06-16T00:00:00.000Z');
    const dispatcher = new WebhookDispatcher({ appBaseUrl: base, appPublicBaseUrl: base, authToken: TOKEN });
    const engine = new CallEngine({ clock, dispatcher, hub: new EventHub(), registry: new NumberRegistry() });
    engine.createViTranscript({ serviceSid: VI_SERVICE, customerKey: 'CAfake00000001', sourceSid: 'REfake00000001' });
    clock.flush();
    await engine.settle();

    expect(captured).toBeDefined();
    const fullUrl = `${base}${captured!.url}`;
    expect(twilio.validateRequestWithBody(TOKEN, captured!.sig, fullUrl, captured!.body)).toBe(true);
  });
});
