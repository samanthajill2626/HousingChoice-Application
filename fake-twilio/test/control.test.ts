// fake-twilio/test/control.test.ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import type { WebhookParams } from '../src/engine/signer.js';

function makeApp(clock: ManualClock = new ManualClock('2026-06-15T00:00:00.000Z')) {
  const config = loadFakeConfig({ NODE_ENV: 'test', TWILIO_AUTH_TOKEN: 't', APP_BASE_URL: 'http://localhost:8080', APP_PUBLIC_BASE_URL: 'http://localhost:5173' });
  const posted: Array<{ path: string; params: WebhookParams }> = [];
  const engine = new FakeTwilioEngine({
    clock,
    dispatcher: { post: async (path, params) => { posted.push({ path, params }); return 200; } },
    hub: new EventHub(),
  });
  return { app: buildFakeTwilioApp({ config, engine }), engine, posted };
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

  it('POST /control/delivery-outcome preserves explicit transport evidence', async () => {
    const { app, engine } = makeApp();
    const res = await request(app).post('/control/delivery-outcome').send({
      partyNumber: '+15550100001',
      profile: {
        kind: 'normal',
        transportEvidence: {
          from: 'rcs:agent',
          to: '+15550100001',
          channelPrefix: 'rcs',
          channelMetadata: { type: 'rcs' },
        },
      },
    });
    expect(res.status).toBe(200);
    const profile = engine.takeDeliveryProfile('+15550100001');
    expect(profile.transportEvidence).toEqual({
      from: 'rcs:agent',
      to: '+15550100001',
      channelPrefix: 'rcs',
      channelMetadata: { type: 'rcs' },
    });
  });

  it('rejects fabricated SMS or MMS ChannelPrefix evidence', async () => {
    const { app } = makeApp();
    const response = await request(app).post('/control/delivery-outcome').send({
      partyNumber: '+15550100001',
      profile: { kind: 'normal', transportEvidence: { channelPrefix: 'sms' } },
    });
    expect(response.status).toBe(400);
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

// ---------------------------------------------------------------------------
// The send-outcome seams (spec D19): fail-next-send drives the three ambiguous
// or rejected create outcomes; fail-list makes the reconcile's lookup fail.
// ---------------------------------------------------------------------------

const ACCOUNT_PATH = '/2010-04-01/Accounts/ACtest';
const PARTY = '+16175550100';
const OTHER_PARTY = '+16175550199';
const FROM = '+15550009999';
const DROPPED = /socket hang up|ECONNRESET|aborted/;

function create(app: Express, body: string, to: string = PARTY) {
  return request(app).post(`${ACCOUNT_PATH}/Messages.json`).type('form').send({ To: to, From: FROM, Body: body });
}
function listTo(app: Express, to?: string) {
  return request(app)
    .get(`${ACCOUNT_PATH}/Messages.json`)
    .query(to === undefined ? {} : { To: to, From: FROM });
}
function fetchSid(app: Express, sid: string) {
  return request(app).get(`${ACCOUNT_PATH}/Messages/${sid}.json`);
}
function threadOf(engine: FakeTwilioEngine, party: string = PARTY) {
  return engine.listThreads().find((t) => t.partyNumber === party)?.messages ?? [];
}
function statusCallbacks(posted: Array<{ path: string; params: WebhookParams }>, sid: string) {
  return posted
    .filter((p) => p.path === '/webhooks/twilio/status' && p.params['MessageSid'] === sid)
    .map((p) => [p.params['MessageStatus'], p.params['ErrorCode']]);
}

describe('control API: the fail-next-send and fail-list seams (spec D19)', () => {
  it('fail-next-send reject answers a Twilio 4xx, records nothing, and is consumed', async () => {
    const { app, engine } = makeApp();
    await request(app)
      .post('/control/fail-next-send')
      .send({ partyNumber: PARTY, mode: 'reject', code: 21211 })
      .expect(200, { ok: true });
    const r = await create(app, 'x');
    expect(r.status).toBe(400);
    // Exactly { code, message, more_info, status }: twilio-node builds a
    // RestException from it (a string `type` AND `title` would not be one).
    expect(r.body).toEqual({
      code: 21211,
      message: 'fail-next-send: rejected by the fake',
      more_info: 'https://www.twilio.com/docs/errors/21211',
      status: 400,
    });
    expect(threadOf(engine)).toHaveLength(0);
    await create(app, 'y').expect(201);
    expect(threadOf(engine).map((m) => m.body)).toEqual(['y']);
  });

  it('reject defaults the code to 21211 and carries a chosen one', async () => {
    const { app } = makeApp();
    await request(app).post('/control/fail-next-send').send({ partyNumber: PARTY, mode: 'reject' }).expect(200);
    expect((await create(app, 'a')).body.code).toBe(21211);
    await request(app).post('/control/fail-next-send').send({ partyNumber: PARTY, mode: 'reject', code: 21610 }).expect(200);
    const r = await create(app, 'b');
    expect(r.body).toMatchObject({ code: 21610, status: 400 });
  });

  it('accept_then_drop records the message, drops the connection, and still fires its status callbacks', async () => {
    const clock = new ManualClock('2026-06-15T00:00:00.000Z');
    const { app, engine, posted } = makeApp(clock);
    await request(app).post('/control/fail-next-send').send({ partyNumber: PARTY, mode: 'accept_then_drop' }).expect(200);
    await expect(create(app, 'z')).rejects.toThrow(DROPPED);
    expect(threadOf(engine).map((m) => m.body)).toEqual(['z']);
    const sid = threadOf(engine)[0]!.sid;
    clock.flush();
    expect(statusCallbacks(posted, sid)).toEqual([['sent', undefined], ['delivered', undefined]]);
    await create(app, 'after').expect(201);
  });

  it('drop_before_create records nothing, drops the connection, and is consumed', async () => {
    const { app, engine } = makeApp();
    await request(app).post('/control/fail-next-send').send({ partyNumber: PARTY, mode: 'drop_before_create' }).expect(200);
    await expect(create(app, 'lost')).rejects.toThrow(DROPPED);
    expect(threadOf(engine)).toHaveLength(0);
    await create(app, 'redriven').expect(201);
    expect(threadOf(engine).map((m) => m.body)).toEqual(['redriven']);
  });

  it('count arms that many creates to that party; another party is unaffected', async () => {
    const { app, engine } = makeApp();
    await request(app)
      .post('/control/fail-next-send')
      .send({ partyNumber: PARTY, mode: 'reject', count: 2 })
      .expect(200);
    await create(app, 'other', OTHER_PARTY).expect(201);
    expect((await create(app, 'a')).status).toBe(400);
    expect((await create(app, 'b')).status).toBe(400);
    await create(app, 'c').expect(201);
    expect(threadOf(engine).map((m) => m.body)).toEqual(['c']);
    expect(threadOf(engine, OTHER_PARTY).map((m) => m.body)).toEqual(['other']);
  });

  it('reject and drop_before_create leave an armed delivery profile for the NEXT create (T11-6)', async () => {
    const clock = new ManualClock('2026-06-15T00:00:00.000Z');
    const { app, posted } = makeApp(clock);
    await request(app)
      .post('/control/delivery-outcome')
      .send({ partyNumber: PARTY, profile: { kind: 'fail', errorCode: '30005' } })
      .expect(200);
    await request(app).post('/control/fail-next-send').send({ partyNumber: PARTY, mode: 'reject' }).expect(200);
    expect((await create(app, 'refused')).status).toBe(400);
    await request(app).post('/control/fail-next-send').send({ partyNumber: PARTY, mode: 'drop_before_create' }).expect(200);
    await expect(create(app, 'dropped')).rejects.toThrow(DROPPED);
    const next = await create(app, 'next').expect(201);
    clock.flush();
    expect(statusCallbacks(posted, next.body.sid as string)).toEqual([['sent', undefined], ['failed', '30005']]);
  });

  it('fail-list makes the next list and fetch for that party answer 500, then recovers', async () => {
    const { app } = makeApp();
    const created = await create(app, 'w');
    await request(app).post('/control/fail-list').send({ partyNumber: PARTY, count: 2 }).expect(200, { ok: true });
    const listed = await listTo(app, PARTY);
    expect(listed.status).toBe(500);
    expect(listed.body).toEqual({
      code: 20500,
      message: 'fail-list: provider unavailable',
      more_info: 'https://www.twilio.com/docs/errors/20500',
      status: 500,
    });
    expect((await fetchSid(app, created.body.sid as string)).status).toBe(500);
    expect((await listTo(app, PARTY)).status).toBe(200);
    expect((await fetchSid(app, created.body.sid as string)).status).toBe(200);
  });

  it('fail-list keys on the list To and on the fetched resource to; nothing else consumes it', async () => {
    const { app } = makeApp();
    const mine = await create(app, 'mine');
    const theirs = await create(app, 'theirs', OTHER_PARTY);
    await request(app).post('/control/fail-list').send({ partyNumber: PARTY }).expect(200);
    expect((await listTo(app, OTHER_PARTY)).status).toBe(200);
    expect((await fetchSid(app, theirs.body.sid as string)).status).toBe(200);
    expect((await listTo(app)).status).toBe(200); // no To filter
    expect((await fetchSid(app, 'SMnope')).status).toBe(404);
    expect((await fetchSid(app, mine.body.sid as string)).status).toBe(500);
    expect((await fetchSid(app, mine.body.sid as string)).status).toBe(200);
  });

  it('POST /control/reset clears an armed fail-next-send and fail-list (T11-7)', async () => {
    const { app } = makeApp();
    await request(app).post('/control/fail-next-send').send({ partyNumber: PARTY, mode: 'reject' }).expect(200);
    await request(app).post('/control/fail-list').send({ partyNumber: PARTY }).expect(200);
    await request(app).post('/control/reset').send({}).expect(200);
    await create(app, 'after reset').expect(201);
    expect((await listTo(app, PARTY)).status).toBe(200);
  });

  it('the seam routes 400 a bad arming and arm nothing', async () => {
    const { app } = makeApp();
    const bad: Array<[string, Record<string, unknown>]> = [
      ['/control/fail-next-send', { mode: 'reject' }],
      ['/control/fail-next-send', { partyNumber: '', mode: 'reject' }],
      ['/control/fail-next-send', { partyNumber: '6175550100', mode: 'reject' }],
      ['/control/fail-next-send', { partyNumber: PARTY }],
      ['/control/fail-next-send', { partyNumber: PARTY, mode: 'explode' }],
      ['/control/fail-next-send', { partyNumber: PARTY, mode: 'reject', count: 0 }],
      ['/control/fail-next-send', { partyNumber: PARTY, mode: 'reject', count: 1.5 }],
      ['/control/fail-next-send', { partyNumber: PARTY, mode: 'reject', count: '2' }],
      ['/control/fail-next-send', { partyNumber: PARTY, mode: 'reject', code: '21211' }],
      ['/control/fail-next-send', { partyNumber: PARTY, mode: 'reject', code: 0 }],
      ['/control/fail-next-send', { partyNumber: PARTY, mode: 'drop_before_create', code: 21211 }],
      ['/control/fail-list', {}],
      ['/control/fail-list', { partyNumber: 'nope' }],
      ['/control/fail-list', { partyNumber: PARTY, count: 0 }],
      ['/control/fail-list', { partyNumber: PARTY, count: -1 }],
    ];
    for (const [path, body] of bad) {
      const r = await request(app).post(path).send(body);
      expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(typeof r.body.error).toBe('string');
    }
    await create(app, 'unaffected').expect(201);
    expect((await listTo(app, PARTY)).status).toBe(200);
  });
});
