// fake-twilio/test/conversations.test.ts
//
// The Twilio Conversations emulation - the rail behind a native carrier group
// text (group-texting S8/T8.1). Green-field: nothing emulated Conversations
// before this slice, so these tests are the contract.
//
// The three claims worth pinning hardest, because each one is a real failure
// this fake could otherwise hide:
//   * the PARTICIPANT SHAPE (business = projected address only, member =
//     address only) - combining them is Twilio's 50407, and a permissive fake
//     would let a broken adapter pass;
//   * NO CLASSIC STATUS CALLBACK on a fan-out leg - firing one would manufacture
//     the unknown-provider-SID ERROR the reply-all e2e proves absent;
//   * NO RELAY GROUP from a Conversations fan-out - the two group products share
//     a fake and must not bleed into each other.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { ConversationsEngine } from '../src/engine/conversationsEngine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import type { WebhookParams } from '../src/engine/signer.js';

const BUSINESS = '+15550009999';
const ANN = '+15550100001';
const MARCUS = '+15550100002';
const CARLA = '+15550100003';

function makeApp() {
  const config = loadFakeConfig({
    NODE_ENV: 'test',
    TWILIO_AUTH_TOKEN: 't',
    APP_BASE_URL: 'http://localhost:8080',
    APP_PUBLIC_BASE_URL: 'http://localhost:5173',
  });
  const posted: Array<{ path: string; params: WebhookParams }> = [];
  const dispatcher = {
    post: async (path: string, params: WebhookParams) => {
      posted.push({ path, params });
      return 200;
    },
  };
  const clock = new ManualClock('2026-06-15T00:00:00.000Z');
  const hub = new EventHub();
  const engine = new FakeTwilioEngine({ clock, dispatcher, hub });
  const conversationsEngine = new ConversationsEngine({
    clock,
    dispatcher,
    hub: engine.hub,
    messaging: engine,
  });
  const app = buildFakeTwilioApp({ config, hub, engine, conversationsEngine });
  return { app, posted, clock, engine };
}

/** The bulk create the adapter prefers: business FIRST (projected), then members. */
function participantsFor(members: string[]): string[] {
  return [
    JSON.stringify({ messaging_binding: { projected_address: BUSINESS } }),
    ...members.map((address) => JSON.stringify({ messaging_binding: { address } })),
  ];
}

async function createRail(app: ReturnType<typeof makeApp>['app'], uniqueName: string, members: string[]) {
  const res = await request(app)
    .post('/v1/ConversationWithParticipants')
    .type('form')
    .send({
      UniqueName: uniqueName,
      MessagingServiceSid: 'MGfake000000000000000000000000000',
      Participant: participantsFor(members),
    });
  expect(res.status).toBe(201);
  return res.body as { sid: string };
}

describe('Conversations REST - create and adopt', () => {
  it('creates a rail with the business number as its OWN projected-address participant', async () => {
    const { app } = makeApp();
    const { sid } = await createRail(app, 'conv-group-1', [ANN, MARCUS]);
    expect(sid).toMatch(/^CHfake/);

    const res = await request(app).get(`/v1/Conversations/${sid}/Participants`);
    expect(res.status).toBe(200);
    const participants = res.body.participants as {
      sid: string;
      messaging_binding: { address?: string; projected_address?: string };
    }[];
    expect(participants).toHaveLength(3);

    // THE SHAPE THAT COST AN HOUR LIVE: exactly one field per participant.
    const business = participants.find((p) => p.messaging_binding.projected_address !== undefined)!;
    expect(business.messaging_binding.projected_address).toBe(BUSINESS);
    expect(business.messaging_binding.address).toBeUndefined();
    for (const member of participants.filter((p) => p !== business)) {
      expect(member.messaging_binding.address).toMatch(/^\+1555/);
      expect(member.messaging_binding.projected_address).toBeUndefined();
      expect(member.sid).toMatch(/^MBfake/);
    }
  });

  it('resolves a Conversation by UNIQUE NAME, which is how adopt-or-create works', async () => {
    const { app } = makeApp();
    const { sid } = await createRail(app, 'conv-group-adopt', [ANN, MARCUS]);
    const res = await request(app).get('/v1/Conversations/conv-group-adopt');
    expect(res.status).toBe(200);
    expect(res.body.sid).toBe(sid);
    expect(res.body.unique_name).toBe('conv-group-adopt');
    expect(res.body.state).toBe('active');
  });

  it('404s an unknown Conversation with code 20404 - the adapter maps that to "no rail"', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/v1/Conversations/conv-group-nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(20404);
  });

  it('409s a duplicate UniqueName with code 50353 - the claim logic is written against it', async () => {
    const { app } = makeApp();
    await createRail(app, 'conv-group-dup', [ANN, MARCUS]);
    const res = await request(app)
      .post('/v1/Conversations')
      .type('form')
      .send({ UniqueName: 'conv-group-dup' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(50353);
  });

  it('refuses a participant carrying BOTH an address and a projected address (50407)', async () => {
    const { app } = makeApp();
    const { sid } = await createRail(app, 'conv-group-50407', [ANN]);
    const res = await request(app)
      .post(`/v1/Conversations/${sid}/Participants`)
      .type('form')
      .send({
        'MessagingBinding.Address': MARCUS,
        'MessagingBinding.ProjectedAddress': BUSINESS,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(50407);
  });

  it('adds a participant individually - the adapter fallback path', async () => {
    const { app } = makeApp();
    const created = await request(app)
      .post('/v1/Conversations')
      .type('form')
      .send({ UniqueName: 'conv-group-individual' });
    const sid = created.body.sid as string;
    const business = await request(app)
      .post(`/v1/Conversations/${sid}/Participants`)
      .type('form')
      .send({ 'MessagingBinding.ProjectedAddress': BUSINESS });
    expect(business.status).toBe(201);
    const member = await request(app)
      .post(`/v1/Conversations/${sid}/Participants`)
      .type('form')
      .send({ 'MessagingBinding.Address': ANN });
    expect(member.status).toBe(201);
    expect(member.body.messaging_binding.address).toBe(ANN);
  });

  it('DELETEs a Conversation - the production preflight capability check', async () => {
    const { app } = makeApp();
    const { sid } = await createRail(app, 'conv-group-delete', [ANN]);
    expect((await request(app).delete(`/v1/Conversations/${sid}`)).status).toBe(204);
    expect((await request(app).get(`/v1/Conversations/${sid}`)).status).toBe(404);
  });
});

describe('Conversations REST - posting a message', () => {
  it('fans out to every member FROM the business number and reports per-member receipts', async () => {
    const { app, posted, clock } = makeApp();
    const { sid } = await createRail(app, 'conv-group-post', [ANN, MARCUS]);

    const res = await request(app)
      .post(`/v1/Conversations/${sid}/Messages`)
      .type('form')
      .send({ Author: BUSINESS, Body: 'Confirming Saturday at 10.' });
    expect(res.status).toBe(201);
    const messageSid = res.body.sid as string;
    expect(messageSid).toMatch(/^IMfake/);

    // Each member's ORDINARY fake-phone thread got the message, from the
    // business number (never a pool number).
    const threads = (await request(app).get('/control/threads')).body.threads as {
      partyNumber: string;
      messages: { from: string; to: string; body?: string; state: string }[];
    }[];
    for (const member of [ANN, MARCUS]) {
      const thread = threads.find((t) => t.partyNumber === member);
      expect(thread?.messages.some((m) => m.from === BUSINESS && m.body?.includes('Saturday'))).toBe(
        true,
      );
    }

    clock.flush();

    const receipts = posted.filter((p) => p.params['EventType'] === 'onDeliveryUpdated');
    expect(receipts).toHaveLength(4); // two members x (sent, delivered)
    for (const receipt of receipts) {
      // ONE route, both event kinds (spec 16.1).
      expect(receipt.path).toBe('/webhooks/twilio/conversations');
      expect(receipt.params['ConversationSid']).toBe(sid);
      expect(receipt.params['MessageSid']).toBe(messageSid);
      expect(receipt.params['ParticipantSid']).toMatch(/^MBfake/);
      // BOTH join keys the receipts design needs.
      expect(receipt.params['ChannelMessageSid']).toMatch(/^SMfake/);
    }
    expect(receipts.map((r) => r.params['Status']).sort()).toEqual([
      'delivered',
      'delivered',
      'sent',
      'sent',
    ]);
  });

  it('fires ZERO classic status callbacks - Conversations sends do not produce them', async () => {
    const { app, posted, clock } = makeApp();
    const { sid } = await createRail(app, 'conv-group-noclassic', [ANN, MARCUS]);
    await request(app)
      .post(`/v1/Conversations/${sid}/Messages`)
      .type('form')
      .send({ Author: BUSINESS, Body: 'no classic callbacks please' });
    clock.flush();

    // This is the whole reason the reply-all e2e can assert "no unknown-SID
    // ERROR": a classic callback here would carry an SMxx the app has no
    // message row for.
    expect(posted.filter((p) => p.path === '/webhooks/twilio/status')).toHaveLength(0);
  });

  it('creates ZERO relay groups - the two group products never bleed together', async () => {
    const { app, clock } = makeApp();
    const { sid } = await createRail(app, 'conv-group-norelay', [ANN, MARCUS]);
    await request(app)
      .post(`/v1/Conversations/${sid}/Messages`)
      .type('form')
      .send({ Author: BUSINESS, Body: 'not a relay group' });
    clock.flush();

    const groups = (await request(app).get('/control/groups')).body.groups as unknown[];
    expect(groups).toHaveLength(0);
  });

  // ARMING models a 21610 Twilio reports for a leg it DID create (a carrier-level
  // refusal we never saw a STOP for). It is NOT the opted-out case any more -
  // see the skip tests below, which are what a handset STOP actually produces.
  it('honours an armed per-member 21610 through the SAME control API a 1:1 send uses', async () => {
    const { app, posted, clock } = makeApp();
    const { sid } = await createRail(app, 'conv-group-21610', [ANN, MARCUS]);
    await request(app)
      .post('/control/delivery-outcome')
      .send({
        partyNumber: MARCUS,
        profile: { kind: 'fail', failState: 'undelivered', errorCode: '21610' },
      });

    await request(app)
      .post(`/v1/Conversations/${sid}/Messages`)
      .type('form')
      .send({ Author: BUSINESS, Body: 'one member has stopped' });
    clock.flush();

    const receipts = posted.filter((p) => p.params['EventType'] === 'onDeliveryUpdated');
    const marcusMb = ((await request(app).get(`/v1/Conversations/${sid}/Participants`)).body
      .participants as { sid: string; messaging_binding: { address?: string } }[]).find(
      (p) => p.messaging_binding.address === MARCUS,
    )!.sid;

    const marcusFinal = receipts.filter((r) => r.params['ParticipantSid'] === marcusMb).at(-1)!;
    expect(marcusFinal.params['Status']).toBe('undelivered');
    expect(marcusFinal.params['ErrorCode']).toBe('21610');

    // The OTHER member still delivers - a partial delivery, not a failed send.
    const annMb = ((await request(app).get(`/v1/Conversations/${sid}/Participants`)).body
      .participants as { sid: string; messaging_binding: { address?: string } }[]).find(
      (p) => p.messaging_binding.address === ANN,
    )!.sid;
    expect(receipts.filter((r) => r.params['ParticipantSid'] === annMb).at(-1)!.params['Status']).toBe(
      'delivered',
    );
  });

  // LIVE QA ROUND 2. GROUND TRUTH, from the Messages API after a member sent
  // STOP: there is NO Twilio message record for that leg at all. Conversations
  // SKIPS the participant. The fake used to fan out to everyone and let a spec
  // arm a 21610 instead, which manufactured a receipt production never sends -
  // and that receipt is exactly what hid the app defect (a slot stuck `queued`
  // forever, raising a FALSE "receipts silent" alarm on every later send).
  it('SKIPS an opted-out participant entirely - no leg, and no receipt EVER', async () => {
    const { app, posted, clock } = makeApp();
    const { sid } = await createRail(app, 'conv-group-optout', [ANN, MARCUS]);
    await request(app).post('/control/personas/ad-hoc').send({ label: 'Marcus', role: 'tenant', number: MARCUS });

    // Marcus stops. Twilio's own suppression list takes him, whatever the app does.
    await request(app)
      .post('/control/send-as-party')
      .send({ from: MARCUS, body: 'STOP' });

    await request(app)
      .post(`/v1/Conversations/${sid}/Messages`)
      .type('form')
      .send({ Author: BUSINESS, Body: 'Still on for Saturday' });
    clock.flush();

    const participants = (await request(app).get(`/v1/Conversations/${sid}/Participants`)).body
      .participants as { sid: string; messaging_binding: { address?: string } }[];
    const marcusMb = participants.find((p) => p.messaging_binding.address === MARCUS)!.sid;
    const annMb = participants.find((p) => p.messaging_binding.address === ANN)!.sid;

    const receipts = posted.filter((p) => p.params['EventType'] === 'onDeliveryUpdated');
    // NOT "an undelivered receipt" - NO receipt. Nothing will ever move his slot.
    expect(receipts.filter((r) => r.params['ParticipantSid'] === marcusMb)).toHaveLength(0);
    // The rest of the group is untouched: a partial send, not a failed one.
    expect(
      receipts.filter((r) => r.params['ParticipantSid'] === annMb).at(-1)!.params['Status'],
    ).toBe('delivered');

    // And no carrier message reached his handset either.
    const threads = (await request(app).get('/control/threads')).body.threads as {
      partyNumber: string;
      messages: { body?: string }[];
    }[];
    const marcusThread = threads.find((t) => t.partyNumber === MARCUS);
    expect(marcusThread?.messages.some((m) => m.body?.includes('Saturday'))).toBe(false);
  });

  it('START puts a skipped participant back in the fan-out', async () => {
    const { app, posted, clock } = makeApp();
    const { sid } = await createRail(app, 'conv-group-optin', [ANN, MARCUS]);
    await request(app).post('/control/personas/ad-hoc').send({ label: 'Marcus', role: 'tenant', number: MARCUS });

    await request(app).post('/control/send-as-party').send({ from: MARCUS, body: 'STOP' });
    await request(app).post('/control/send-as-party').send({ from: MARCUS, body: 'START' });

    await request(app)
      .post(`/v1/Conversations/${sid}/Messages`)
      .type('form')
      .send({ Author: BUSINESS, Body: 'back in the room' });
    clock.flush();

    const marcusMb = ((await request(app).get(`/v1/Conversations/${sid}/Participants`)).body
      .participants as { sid: string; messaging_binding: { address?: string } }[]).find(
      (p) => p.messaging_binding.address === MARCUS,
    )!.sid;
    expect(
      posted
        .filter((p) => p.params['EventType'] === 'onDeliveryUpdated')
        .filter((r) => r.params['ParticipantSid'] === marcusMb).at(-1)!.params['Status'],
    ).toBe('delivered');
  });

  it('matches the WHOLE body, so "stop by at 5" never mutes a persona', async () => {
    const { app, posted, clock } = makeApp();
    const { sid } = await createRail(app, 'conv-group-nearmiss', [ANN, MARCUS]);
    await request(app).post('/control/personas/ad-hoc').send({ label: 'Marcus', role: 'tenant', number: MARCUS });

    await request(app).post('/control/send-as-party').send({ from: MARCUS, body: 'stop by at 5' });

    await request(app)
      .post(`/v1/Conversations/${sid}/Messages`)
      .type('form')
      .send({ Author: BUSINESS, Body: 'see you then' });
    clock.flush();

    const marcusMb = ((await request(app).get(`/v1/Conversations/${sid}/Participants`)).body
      .participants as { sid: string; messaging_binding: { address?: string } }[]).find(
      (p) => p.messaging_binding.address === MARCUS,
    )!.sid;
    expect(
      posted
        .filter((p) => p.params['EventType'] === 'onDeliveryUpdated')
        .filter((r) => r.params['ParticipantSid'] === marcusMb),
    ).not.toHaveLength(0);
  });

  it('produces NO onMessageAdded echo for our own post unless X-Twilio-Webhook-Enabled is set', async () => {
    const { app, posted } = makeApp();
    const { sid } = await createRail(app, 'conv-group-echo', [ANN]);

    await request(app)
      .post(`/v1/Conversations/${sid}/Messages`)
      .type('form')
      .send({ Author: BUSINESS, Body: 'silent' });
    expect(posted.filter((p) => p.params['EventType'] === 'onMessageAdded')).toHaveLength(0);

    await request(app)
      .post(`/v1/Conversations/${sid}/Messages`)
      .type('form')
      .set('X-Twilio-Webhook-Enabled', 'true')
      .send({ Author: BUSINESS, Body: 'echoed' });
    const echoes = posted.filter((p) => p.params['EventType'] === 'onMessageAdded');
    expect(echoes).toHaveLength(1);
    // API-sourced: the cross-check must IGNORE it, and this is how a spec proves so.
    expect(echoes[0]?.params['Source']).toBe('API');
  });
});

describe('POST /control/send-group-as-party - inbound carrier group injection', () => {
  it('carries the INDEXED OtherRecipients envelope', async () => {
    const { app, posted } = makeApp();
    const res = await request(app)
      .post('/control/send-group-as-party')
      .send({ from: ANN, otherRecipients: [MARCUS, CARLA], body: 'hi both' });
    expect(res.status).toBe(200);

    const inbound = posted.find((p) => p.path === '/webhooks/twilio/sms')!;
    expect(inbound.params['From']).toBe(ANN);
    expect(inbound.params['To']).toBe(BUSINESS);
    expect(inbound.params['OtherRecipients0']).toBe(MARCUS);
    expect(inbound.params['OtherRecipients1']).toBe(CARLA);
    expect(inbound.params['NumMedia']).toBe('0');
  });

  it('carries the SINGLE (bare-key) envelope the parser accepts defensively', async () => {
    const { app, posted } = makeApp();
    await request(app)
      .post('/control/send-group-as-party')
      .send({ from: ANN, otherRecipients: [MARCUS], otherRecipientsShape: 'single', body: 'hi' });

    const inbound = posted.find((p) => p.path === '/webhooks/twilio/sms')!;
    expect(inbound.params['OtherRecipients']).toBe(MARCUS);
    expect(inbound.params['OtherRecipients0']).toBeUndefined();
  });

  it('carries MEDIA on a group inbound', async () => {
    const { app, posted } = makeApp();
    await request(app).post('/control/send-group-as-party').send({
      from: ANN,
      otherRecipients: [MARCUS],
      body: 'look',
      mediaUrls: ['http://127.0.0.1:8889/canned/room.png'],
    });
    const inbound = posted.find((p) => p.path === '/webhooks/twilio/sms')!;
    expect(inbound.params['NumMedia']).toBe('1');
    expect(inbound.params['MediaContentType0']).toBe('image/png');
    expect(inbound.params['MessageSid']).toMatch(/^MMfake/);
  });

  it('A28: can emit the TRIPWIRE shape - MM prefix, NumMedia 0, no envelope', async () => {
    const { app, posted } = makeApp();
    const res = await request(app)
      .post('/control/send-as-party')
      .send({ from: ANN, body: 'a group text with no envelope', sidShape: 'MM' });
    expect(res.status).toBe(200);

    const inbound = posted.find((p) => p.path === '/webhooks/twilio/sms')!;
    // The shape a SILENTLY REMOVED OtherRecipients contract would produce. The
    // engine otherwise derives the prefix from media presence alone, so without
    // this override the tripwire is untestable.
    expect(inbound.params['MessageSid']).toMatch(/^MMfake/);
    expect(inbound.params['NumMedia']).toBe('0');
    expect(inbound.params['OtherRecipients0']).toBeUndefined();
    expect(inbound.params['OtherRecipients']).toBeUndefined();
  });

  it('refuses a malformed OtherRecipients address rather than deriving a short roster', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/control/send-group-as-party')
      .send({ from: ANN, otherRecipients: ['not-a-number'], body: 'x' });
    expect(res.status).toBe(400);
  });

  it('binds to the rail and fires a carrier-sourced onMessageAdded when the sender is a member', async () => {
    const { app, posted } = makeApp();
    const { sid } = await createRail(app, 'conv-group-inbound', [ANN, MARCUS]);

    const res = await request(app)
      .post('/control/send-group-as-party')
      .send({ from: ANN, otherRecipients: [MARCUS], body: 'bound to the rail' });
    expect(res.body.conversationSid).toBe(sid);

    const added = posted.filter((p) => p.params['EventType'] === 'onMessageAdded');
    expect(added).toHaveLength(1);
    expect(added[0]?.path).toBe('/webhooks/twilio/conversations');
    expect(added[0]?.params['Source']).toBe('SMS');
    expect(added[0]?.params['Author']).toBe(ANN);
    expect(added[0]?.params['ParticipantSid']).toMatch(/^MBfake/);
    expect(added[0]?.params['MessageSid']).toMatch(/^IMfake/);
  });

  it('fires NO Conversations event for an UNRAILED roster - the honest coverage gap', async () => {
    const { app, posted } = makeApp();
    await request(app)
      .post('/control/send-group-as-party')
      .send({ from: ANN, otherRecipients: [MARCUS], body: 'no rail yet' });
    expect(posted.filter((p) => p.params['EventType'] === 'onMessageAdded')).toHaveLength(0);
  });

  it('railEvent:false manufactures the guardrail failure - a classic inbound the channel never reported', async () => {
    const { app, posted } = makeApp();
    await createRail(app, 'conv-group-silent', [ANN, MARCUS]);
    await request(app)
      .post('/control/send-group-as-party')
      .send({ from: ANN, otherRecipients: [MARCUS], body: 'silent channel', railEvent: false });
    expect(posted.filter((p) => p.params['EventType'] === 'onMessageAdded')).toHaveLength(0);
  });
});

describe('control - inspection, injection and reset', () => {
  it('GET /control/conversations lists the rails a spec asserts against', async () => {
    const { app } = makeApp();
    await createRail(app, 'conv-group-list', [ANN, MARCUS]);
    const res = await request(app).get('/control/conversations');
    expect(res.status).toBe(200);
    const [rail] = res.body.conversations as { uniqueName: string; participants: unknown[] }[];
    expect(rail?.uniqueName).toBe('conv-group-list');
    expect(rail?.participants).toHaveLength(3);
  });

  it('POST /control/conversations/inject-event fires an event with NO classic counterpart', async () => {
    const { app, posted } = makeApp();
    const { sid } = await createRail(app, 'conv-group-inject', [ANN, MARCUS]);
    const res = await request(app)
      .post('/control/conversations/inject-event')
      .send({ conversationSid: sid, author: ANN, body: 'never reached the classic webhook' });
    expect(res.status).toBe(200);

    const added = posted.filter((p) => p.params['EventType'] === 'onMessageAdded');
    expect(added).toHaveLength(1);
    expect(added[0]?.params['Source']).toBe('SMS');
    expect(posted.filter((p) => p.path === '/webhooks/twilio/sms')).toHaveLength(0);
  });

  it('injects an API-sourced event too, so the Source filter is exercised for real', async () => {
    const { app, posted } = makeApp();
    await createRail(app, 'conv-group-api', [ANN]);
    await request(app)
      .post('/control/conversations/inject-event')
      .send({ uniqueName: 'conv-group-api', author: BUSINESS, source: 'API' });
    expect(posted.at(-1)?.params['Source']).toBe('API');
  });

  it('rejects an inject-event for a rail that does not exist', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/control/conversations/inject-event')
      .send({ conversationSid: 'CHnope' });
    expect(res.status).toBe(400);
  });

  it('POST /control/reset clears the rails, so no CHxx map leaks across specs', async () => {
    const { app } = makeApp();
    await createRail(app, 'conv-group-reset', [ANN, MARCUS]);
    await request(app).post('/control/reset').send({});
    expect((await request(app).get('/control/conversations')).body.conversations).toHaveLength(0);
    // And the UniqueName is reusable, which is what "clean slate" has to mean.
    await createRail(app, 'conv-group-reset', [ANN, MARCUS]);
  });
});
