// fake-twilio/test/rest.test.ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import { normalizeMediaUrls, smartEncode } from '../src/routes/rest.js';

function makeApp(clock: ManualClock = new ManualClock('2026-06-15T00:00:00.000Z')) {
  const config = loadFakeConfig({ NODE_ENV: 'test', TWILIO_AUTH_TOKEN: 't', APP_BASE_URL: 'http://localhost:8080', APP_PUBLIC_BASE_URL: 'http://localhost:5173' });
  const engine = new FakeTwilioEngine({ clock, dispatcher: { post: async () => 200 }, hub: new EventHub() });
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

// ---------------------------------------------------------------------------
// Messages list + fetch (spec D19; the reconcile's lookup). The shapes are the
// ones twilio-node 6.0.2 needs (build-research spike, "Task 11" rules 1-10):
// the list answers 200 with `messages` as its only non-meta key, next_page_uri
// is a percent-encoded PATH, and every resource carries date_created and an
// explicit date_sent (null while queued) - an omitted date reads as NOW.
// ---------------------------------------------------------------------------

const ACCOUNT_PATH = '/2010-04-01/Accounts/ACtest';
const TO = '+16175550100';
const OTHER_TO = '+16175550199';
/** The fake's own app number; a From equal to it keeps relay-group inference out. */
const FROM = '+15550009999';

function create(app: Express, fields: Record<string, string | string[]>) {
  return request(app).post(`${ACCOUNT_PATH}/Messages.json`).type('form').send(fields);
}
function list(app: Express, query: Record<string, string | number>) {
  return request(app).get(`${ACCOUNT_PATH}/Messages.json`).query(query);
}
function fetchSid(app: Express, sid: string) {
  return request(app).get(`${ACCOUNT_PATH}/Messages/${sid}.json`);
}
function bodies(page: { body: { messages: Array<{ body: string }> } }): string[] {
  return page.body.messages.map((m) => m.body);
}

describe('REST impersonation: Messages list and fetch (spec D19)', () => {
  it('lists messages by To and From newest first with Twilio paging', async () => {
    const { app } = makeApp();
    for (const b of ['one', 'two', 'three']) await create(app, { To: TO, From: FROM, Body: b }).expect(201);
    const page1 = await list(app, { To: TO, From: FROM, PageSize: 2 });
    expect(page1.status).toBe(200);
    // The ManualClock never advances: all three share one createdAt, so this
    // order can only come from REVERSE STORE ORDER, never a createdAt sort.
    expect(bodies(page1)).toEqual(['three', 'two']);
    expect(page1.body.page_size).toBe(2);
    expect(page1.body.next_page_uri).toMatch(/PageToken=/);
    const page2 = await request(app).get(page1.body.next_page_uri);
    expect(page2.status).toBe(200);
    expect(bodies(page2)).toEqual(['one']);
    expect(page2.body.next_page_uri).toBeNull();
    expect(page1.body.messages[0]).toMatchObject({
      to: TO, from: FROM, status: 'queued', num_media: '0', error_code: null, direction: 'outbound-api',
    });
    expect(typeof page1.body.messages[0].date_created).toBe('string');
  });

  it('next_page_uri is a percent-encoded PATH repeating every filter (a raw + empties page 2)', async () => {
    const { app } = makeApp();
    for (const b of ['a', 'b', 'c']) await create(app, { To: TO, From: FROM, Body: b }).expect(201);
    const page1 = await list(app, { To: TO, From: FROM, PageSize: 2 });
    const next = page1.body.next_page_uri as string;
    expect(next.startsWith(`${ACCOUNT_PATH}/Messages.json?`)).toBe(true);
    expect(next).toContain('To=%2B16175550100');
    expect(next).toContain('From=%2B15550009999');
    expect(next).toContain('PageSize=2');
    expect(next).toContain('PageToken=2');
    expect(next).not.toContain('+');
    // The SDK takes the ONE non-meta key as the records (Page.loadPage).
    expect(Object.keys(page1.body).sort()).toEqual([
      'end', 'first_page_uri', 'messages', 'next_page_uri', 'page', 'page_size', 'previous_page_uri', 'start', 'uri',
    ]);
    expect(page1.body).toMatchObject({ page: 0, start: 0, end: 1, previous_page_uri: null });
    const page2 = await request(app).get(next);
    expect(bodies(page2)).toEqual(['a']);
    expect(page2.body).toMatchObject({ page: 1, page_size: 2, start: 2, end: 2 });
    expect(page2.body.previous_page_uri).toEqual(expect.any(String));
  });

  it('filters on the RESOURCE from: a send created with no From never matches a From filter', async () => {
    const { app } = makeApp();
    await create(app, { To: TO, From: FROM, Body: 'pinned' }).expect(201);
    // The Messaging Service picks the sender; the fake stores its own number
    // (== FROM) for the phones UI, but the resource reports from: null.
    const unpinned = await create(app, { To: TO, MessagingServiceSid: 'MGtest', Body: 'unpinned' }).expect(201);
    await create(app, { To: OTHER_TO, From: FROM, Body: 'someone else' }).expect(201);
    expect(bodies(await list(app, { To: TO, From: FROM }))).toEqual(['pinned']);
    expect(bodies(await list(app, { To: TO }))).toEqual(['unpinned', 'pinned']);
    expect(bodies(await list(app, { To: OTHER_TO, From: FROM }))).toEqual(['someone else']);
    const fetched = await fetchSid(app, unpinned.body.sid as string);
    expect(fetched.body).toMatchObject({ from: null, messaging_service_sid: 'MGtest' });
  });

  it('stores the Smart-Encoded body the way Twilio does; the thread keeps the SUBMITTED body', async () => {
    const { app, engine } = makeApp();
    const submitted = 'HC \u2019q\u2019 d\u2014d m\u2026';
    const created = await create(app, { To: TO, From: FROM, Body: submitted });
    expect(created.status).toBe(201);
    expect(created.body.body).toBe(submitted);
    const fetched = await fetchSid(app, created.body.sid as string);
    expect(fetched.body.body).toBe("HC 'q' d-d m...");
    expect(bodies(await list(app, { To: TO, From: FROM }))).toEqual(["HC 'q' d-d m..."]);
    // The phones UI and e2e getOutboundTo read the thread store: never encoded.
    expect(engine.listThreads().find((t) => t.partyNumber === TO)!.messages[0]!.body).toBe(submitted);
  });

  it('smartEncode rewrites exactly the Smart Encoding characters and nothing else', () => {
    expect(smartEncode('\u2018a\u2019 \u201cb\u201d c\u2013d\u2014e f\u2026 g\u00a0h')).toBe('\'a\' "b" c-d-e f... g h');
    expect(smartEncode('plain ASCII stays')).toBe('plain ASCII stays');
    expect(smartEncode('caf\u00e9 \u{1f600}')).toBe('caf\u00e9 \u{1f600}');
  });

  it('fetch of an unknown SID is a Twilio 404', async () => {
    const { app } = makeApp();
    const r = await fetchSid(app, 'SMnope');
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 20404, status: 404 });
    expect(typeof r.body.message).toBe('string');
    expect(typeof r.body.more_info).toBe('string');
  });

  it('a queued resource carries date_sent: null and error_code: null EXPLICITLY (create, fetch and list)', async () => {
    const { app } = makeApp();
    const created = await create(app, { To: TO, From: FROM, Body: 'q' });
    const fetched = await fetchSid(app, created.body.sid as string);
    const listed = await list(app, { To: TO });
    for (const resource of [created.body, fetched.body, listed.body.messages[0]]) {
      expect(Object.prototype.hasOwnProperty.call(resource, 'date_sent')).toBe(true);
      expect(resource.date_sent).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(resource, 'error_code')).toBe(true);
      expect(resource.error_code).toBeNull();
    }
  });

  it('a message still queued after its queued-step callback ran keeps date_sent: null', async () => {
    // On the lane the queued-step callback fires at once (RealClock, delay 0):
    // it must not count as leaving queued.
    const clock = new ManualClock('2026-06-15T00:00:00.000Z');
    const { app } = makeApp(clock);
    await request(app)
      .post('/control/delivery-outcome')
      .send({ partyNumber: TO, profile: { kind: 'stall', stallAt: 'queued' } })
      .expect(200);
    const created = await create(app, { To: TO, From: FROM, Body: 'stuck' });
    clock.advance(3000);
    clock.flush(); // runs the queued-step callback, and nothing else
    const fetched = await fetchSid(app, created.body.sid as string);
    expect(fetched.body).toMatchObject({ status: 'queued', date_sent: null });
  });

  it('date_sent is when the message FIRST left queued, in RFC 2822; a later transition never moves it', async () => {
    const clock = new ManualClock('2026-06-15T00:00:00.000Z');
    const { app, engine } = makeApp(clock);
    await request(app)
      .post('/control/delivery-outcome')
      .send({ partyNumber: TO, profile: { kind: 'stall', stallAt: 'sent' } })
      .expect(200);
    const created = await create(app, { To: TO, From: FROM, Body: 's' });
    clock.advance(2000);
    clock.flush(); // queued -> sent, at 00:00:02
    clock.advance(5000);
    engine.advanceLegState(created.body.sid as string, TO, 'delivered'); // at 00:00:07
    const fetched = await fetchSid(app, created.body.sid as string);
    expect(fetched.body).toMatchObject({
      status: 'delivered',
      date_created: 'Mon, 15 Jun 2026 00:00:00 +0000',
      date_sent: 'Mon, 15 Jun 2026 00:00:02 +0000',
    });
  });

  it('the create response, the list and the fetch share ONE clock: the stored createdAt', async () => {
    // The engine clock sits months away from the wall clock, so a second clock
    // anywhere in the path shows up as a different date_created.
    const { app } = makeApp();
    const created = await create(app, { To: TO, From: FROM, Body: 'c' });
    const listed = await list(app, { To: TO, From: FROM });
    const fetched = await fetchSid(app, created.body.sid as string);
    expect(created.body.date_created).toBe('Mon, 15 Jun 2026 00:00:00 +0000');
    expect(listed.body.messages[0].date_created).toBe(created.body.date_created);
    expect(fetched.body.date_created).toBe(created.body.date_created);
  });

  it('pages at 50 by default, caps PageSize at 1000 and echoes the effective size', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 51; i += 1) await create(app, { To: TO, From: FROM, Body: `m${i}` }).expect(201);
    const byDefault = await list(app, { To: TO, From: FROM });
    expect(byDefault.body.page_size).toBe(50);
    expect(byDefault.body.messages).toHaveLength(50);
    expect(byDefault.body.messages[0].body).toBe('m50');
    expect(byDefault.body.next_page_uri).toContain('PageToken=50');
    const last = await request(app).get(byDefault.body.next_page_uri);
    expect(bodies(last)).toEqual(['m0']);
    expect(last.body.next_page_uri).toBeNull();
    const whole = await list(app, { To: TO, From: FROM, PageSize: 51 });
    expect(whole.body.messages).toHaveLength(51);
    expect(whole.body.next_page_uri).toBeNull();
    const capped = await list(app, { To: TO, From: FROM, PageSize: 5000 });
    expect(capped.body.page_size).toBe(1000);
    expect(capped.body.messages).toHaveLength(51);
    expect((await list(app, { To: TO, From: FROM, PageSize: 1000 })).body.page_size).toBe(1000);
  });

  it('an inbound message reads back as received, dated when it arrived; a To filter on its sender excludes it', async () => {
    const { app } = makeApp();
    const party = '+15550100001'; // a seeded persona
    const inbound = await request(app).post('/control/send-as-party').send({ from: party, body: 'hi' }).expect(200);
    await create(app, { To: party, From: FROM, Body: 'reply' }).expect(201);
    const fetched = await fetchSid(app, inbound.body.sid as string);
    expect(fetched.body).toMatchObject({
      direction: 'inbound', status: 'received', from: party, to: FROM,
      date_sent: 'Mon, 15 Jun 2026 00:00:00 +0000',
    });
    expect(bodies(await list(app, { To: party }))).toEqual(['reply']);
    expect(bodies(await list(app, {}))).toEqual(['reply', 'hi']);
  });

  it('a resource reports num_media as a string and a failure code as an integer', async () => {
    const clock = new ManualClock('2026-06-15T00:00:00.000Z');
    const { app } = makeApp(clock);
    await request(app)
      .post('/control/delivery-outcome')
      .send({ partyNumber: TO, profile: { kind: 'fail', failState: 'undelivered', errorCode: '30003' } })
      .expect(200);
    const created = await create(app, {
      To: TO, From: FROM, Body: 'pics', MediaUrl: ['http://ex/a.png', 'http://ex/b.png'],
    });
    clock.flush();
    const fetched = await fetchSid(app, created.body.sid as string);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({
      sid: created.body.sid, status: 'undelivered', num_media: '2', error_code: 30003, direction: 'outbound-api',
    });
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
