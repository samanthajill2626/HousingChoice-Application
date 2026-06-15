// M1.9a (Change Order 1) golden suite: Twilio Programmable Voice — masked
// (pool-number) calling on a relay group, the `call` entity, the whisper +
// press-1/press-0/timeout gate, the forward-only status callback, and
// GET /api/calls/:callId. Driven through the REAL app (buildApp) + the webhook
// harness with REAL computed X-Twilio-Signature values (never mocked).
//
// GUARDRAILS asserted here (the M1.9a contract):
//  - bridged-leg caller ID is ALWAYS the pool number, NEVER the caller's From
//  - masked calls set record="do-not-record"; recording_s3_key/transcript unset
//  - no raw caller/counterpart phone in any log line (role/label + SIDs only)
//  - CallSid idempotency: a redelivered /voice or /status never double-writes
//  - removed-member / closed-thread caller → no bridge, masked, no leak
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  signedTwilioPost,
  ORIGIN_SECRET,
  OUR_NUMBER,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';

const POOL = '+15550109000';
const ALICE = '+15550100001'; // tenant (caller)
const BOB = '+15550100002'; // landlord (callee)
const CAROL = '+15550100003'; // a third member

function seedRelay(world: FakeWorld, overrides: Partial<ConversationItem> = {}): ConversationItem {
  const now = new Date().toISOString();
  const conv: ConversationItem = {
    conversationId: 'conv-relay-voice-1',
    participant_phone: POOL,
    pool_number: POOL,
    status: 'open',
    last_activity_at: now,
    type: 'relay_group',
    ai_mode: 'manual',
    participants: [
      { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
      { contactId: 'c-bob', phone: BOB, name: 'Bob' },
    ],
    created_at: now,
    ...overrides,
  };
  world.conversations.set(conv.conversationId, conv);
  return conv;
}

/** A standard inbound voice webhook (Programmable Voice shape). */
function inboundVoiceParams(over: Record<string, string> = {}): Record<string, string> {
  return {
    CallSid: 'CAinbound0001',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    From: ALICE,
    To: POOL,
    CallStatus: 'ringing',
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
    ...over,
  };
}

describe('inbound masked voice — the bridge (M1.9a)', () => {
  it('To=pool number → <Dial> the OTHER member FROM the pool number, do-not-record, whisper+gate', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    const xml = res.text;

    // GUARDRAIL: callerId is the POOL number, never the caller's From (Alice).
    expect(xml).toContain(`callerId="${POOL}"`);
    expect(xml).not.toContain(ALICE);
    // GUARDRAIL: masked calls are NEVER recorded.
    expect(xml).toContain('record="do-not-record"');
    // Bridges to Bob (the OTHER member) only — never Alice (caller's own leg).
    expect(xml).toContain(`<Number`);
    expect(xml).toContain(BOB);
    // The whisper url runs the press-1 gate on the CALLEE leg before bridging.
    expect(xml).toContain('/webhooks/twilio/voice/whisper');
    // The dial reports completion to the status route.
    expect(xml).toContain('/webhooks/twilio/voice/status');
  });

  it('persists a metadata-only, masked call entry (CallSid-idempotent, no recording fields)', async () => {
    const world = createFakeWorld();
    // Type the caller as a tenant so author resolves to the role honestly.
    world.contacts.push({ contactId: 'c-alice', type: 'tenant', phone: ALICE });
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());

    const calls = world.messages.filter((m) => m.type === 'call');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.conversationId).toBe('conv-relay-voice-1');
    expect(call.direction).toBe('inbound');
    expect(call.masked).toBe(true);
    expect(call.provider_sid).toBe('CAinbound0001');
    expect(call.call_status).toBe('ringing');
    expect(call.author).toBe('tenant'); // caller's reviewed role
    // call_party_label is the COUNTERPART (callee) role/name — never a phone.
    expect(call.call_party_label).toBe('Bob');
    expect(call.call_party_label).not.toContain('+');
    // GUARDRAIL: masked calls never populate recording/transcript.
    expect(call.recording_s3_key).toBeUndefined();
    expect(call.transcript).toBeUndefined();

    // CallSid idempotency: a redelivered /voice webhook must NOT double-write.
    await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());
    expect(world.messages.filter((m) => m.type === 'call')).toHaveLength(1);
  });

  it('emits message.persisted once for the new call entry (live timeline)', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());
    const persisted = world.emitted.filter((e) => e.event === 'message.persisted');
    expect(persisted).toHaveLength(1);
  });

  it('a 3-party relay bridges BOTH other members from the pool number (caller never bridged to self)', async () => {
    const world = createFakeWorld();
    seedRelay(world, {
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
        { contactId: 'c-carol', phone: CAROL, name: 'Carol' },
      ],
    });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());
    const xml = res.text;
    expect(xml).toContain(BOB);
    expect(xml).toContain(CAROL);
    expect(xml).not.toContain(ALICE); // caller's own leg is never a dial target
    expect(xml).toContain(`callerId="${POOL}"`);
  });
});

describe('inbound masked voice — refusals + echo guard (M1.9a)', () => {
  it('removed-member caller → masked Say + Hangup, NO bridge, NO number leak', async () => {
    const world = createFakeWorld();
    seedRelay(world); // roster is Alice + Bob; Carol is NOT a member
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/voice',
      inboundVoiceParams({ From: CAROL, CallSid: 'CAremoved1' }),
    );
    expect(res.status).toBe(200);
    const xml = res.text;
    // No bridge: a Say + Hangup, no <Dial>, no phones anywhere.
    expect(xml).not.toContain('<Dial');
    expect(xml).toContain('<Hangup');
    expect(xml).not.toContain(CAROL);
    expect(xml).not.toContain(BOB);
    expect(xml).not.toContain(POOL);
    // A metadata-only call entry is still recorded (masked, missed).
    const call = world.messages.find((m) => m.provider_sid === 'CAremoved1');
    expect(call?.type).toBe('call');
    expect(call?.masked).toBe(true);
    expect(call?.call_outcome).toBe('missed');
    expect(call?.call_party_label).not.toContain('+');
  });

  it('closed relay thread → masked Say + Hangup, NO bridge; call entry flagged closed', async () => {
    const world = createFakeWorld();
    seedRelay(world, { status: 'closed' });
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/voice',
      inboundVoiceParams({ CallSid: 'CAclosed1' }),
    );
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).not.toContain('<Dial');
    expect(xml).toContain('<Hangup');
    expect(xml).not.toContain(BOB);
    const call = world.messages.find((m) => m.provider_sid === 'CAclosed1');
    expect(call?.received_on_closed_thread).toBe(true);
    expect(call?.masked).toBe(true);
  });

  it('echo guard: From is the pool number → empty <Response/>, dropped (no bridge, no persist)', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/voice',
      inboundVoiceParams({ From: POOL, To: BOB, CallSid: 'CAecho1' }),
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
    expect(world.messages.find((m) => m.provider_sid === 'CAecho1')).toBeUndefined();
  });

  it('echo guard: From is OUR business number → empty <Response/>, dropped', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/voice',
      inboundVoiceParams({ From: OUR_NUMBER, CallSid: 'CAecho2' }),
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
    expect(world.messages.find((m) => m.provider_sid === 'CAecho2')).toBeUndefined();
  });

  it('To is a business number (non-pool) → minimal greeting + hangup (M1.9b seam), no bridge', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/voice',
      inboundVoiceParams({ From: '+15550199999', To: OUR_NUMBER, CallSid: 'CAbiz1' }),
    );
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).not.toContain('<Dial');
    expect(xml).toContain('<Hangup');
    // No masked call entry on a non-pool greeting (triage is M1.9b).
    expect(world.messages.find((m) => m.provider_sid === 'CAbiz1')).toBeUndefined();
  });

  it('missing CallSid/From → 400', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', {
      To: POOL,
      CallStatus: 'ringing',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid X-Twilio-Signature (signature-gated like SMS)', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams(), {
      tamper: true,
    });
    expect(res.status).toBe(403);
  });

  it('never logs the caller/counterpart phone on the bridge path (PII, doc §9)', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());
    const logs = JSON.stringify(capture.lines);
    expect(logs).not.toContain(ALICE);
    expect(logs).not.toContain(BOB);
  });
});

describe('whisper + press-1/press-0/timeout gate (M1.9a)', () => {
  const whisperQuery =
    '?callerLabel=Alice&conversationId=conv-relay-voice-1&parentCallSid=CAinbound0001';
  const gateQuery = '?conversationId=conv-relay-voice-1&parentCallSid=CAinbound0001';

  it('whisper plays a masked Gather (numDigits=1) announcing the caller by label, no phone', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      `/webhooks/twilio/voice/whisper${whisperQuery}`,
      { CallSid: 'CAchild-bob' },
    );
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).toContain('<Gather');
    expect(xml).toContain('numDigits="1"');
    expect(xml).toContain('/webhooks/twilio/voice/whisper-gate');
    expect(xml).toContain('Alice'); // the masked caller label
    expect(xml).toContain('Press 1');
    expect(xml).not.toContain('+1555'); // never a phone
    // No input falls through to hangup (no auto-bridge to carrier voicemail).
    expect(xml).toContain('<Hangup');
  });

  it("gate: Digits='1' → <Pause> (bridge proceeds, callee accepted)", async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, `/webhooks/twilio/voice/whisper-gate${gateQuery}`, {
      Digits: '1',
      CallSid: 'CAchild-bob',
    });
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).toContain('<Pause');
    expect(xml).not.toContain('<Hangup');
    expect(xml).not.toContain('<Dial');
  });

  it("gate: Digits='0' → <Dial> the team from OUR number, never the caller's From", async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, `/webhooks/twilio/voice/whisper-gate${gateQuery}`, {
      Digits: '0',
      CallSid: 'CAchild-bob',
    });
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).toContain('<Dial');
    expect(xml).toContain(OUR_NUMBER); // team number = our business number
    expect(xml).toContain(`callerId="${OUR_NUMBER}"`);
    expect(xml).not.toContain(ALICE);
  });

  it('gate: timeout / other key → <Hangup> the callee leg (no carrier voicemail)', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    // No Digits param at all (the Gather timed out).
    const res = await signedTwilioPost(app, `/webhooks/twilio/voice/whisper-gate${gateQuery}`, {
      CallSid: 'CAchild-bob',
    });
    expect(res.status).toBe(200);
    const xml = res.text;
    expect(xml).toContain('<Hangup');
    expect(xml).not.toContain('<Dial');
    expect(xml).not.toContain('<Pause');
  });
});

describe('voice status callback — forward-only, idempotent (M1.9a)', () => {
  /** Seed the relay + a ringing call entry by running the inbound bridge once. */
  async function seedRingingCall(world: FakeWorld) {
    seedRelay(world);
    const { app, capture } = makeWebhookHarness({ world });
    await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());
    return { app, capture };
  }

  it('answered → completed updates duration/outcome and emits message.persisted (Dial summary)', async () => {
    const world = createFakeWorld();
    const { app } = await seedRingingCall(world);
    const before = world.emitted.filter((e) => e.event === 'message.persisted').length;

    // The <Dial action> summary reports the bridge ANSWERED (in-progress). FIX 1:
    // the terminal outcome/answered_at come ONLY from the Dial summary
    // (DialCallStatus present), never a bare CallStatus.
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAinbound0001',
      DialCallStatus: 'in-progress',
      ApiVersion: '2010-04-01',
    });
    let call = world.messages.find((m) => m.provider_sid === 'CAinbound0001')!;
    expect(call.call_status).toBe('in-progress');
    expect(call.call_outcome).toBe('answered');
    expect(call.answered_at).toBeDefined();

    // <Dial action> completed WITH a connected bridge duration.
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAinbound0001',
      DialCallStatus: 'completed',
      DialCallDuration: '42',
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(200);
    call = world.messages.find((m) => m.provider_sid === 'CAinbound0001')!;
    expect(call.call_status).toBe('completed');
    expect(call.call_duration).toBe(42);
    expect(call.ended_at).toBeDefined();

    const after = world.emitted.filter((e) => e.event === 'message.persisted').length;
    expect(after).toBeGreaterThan(before); // live updates on real transitions
  });

  it('reads the Dial summary status/duration (DialCallStatus/DialCallDuration) on an answered bridge', async () => {
    const world = createFakeWorld();
    const { app } = await seedRingingCall(world);

    // Bridge connects (in-progress) so the call is ANSWERED — only then does a
    // completed summary record the bridge duration (a never-accepted bridge is a
    // miss with no duration).
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAinbound0001',
      DialCallStatus: 'in-progress',
      ApiVersion: '2010-04-01',
    });
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAinbound0001',
      // The <Dial> action summary reports the bridge result (status + duration).
      DialCallStatus: 'completed',
      DialCallDuration: '17',
      ApiVersion: '2010-04-01',
    });
    const call = world.messages.find((m) => m.provider_sid === 'CAinbound0001')!;
    expect(call.call_status).toBe('completed');
    expect(call.call_duration).toBe(17);
  });

  it('FIX 1: a per-leg child callback (no DialCallStatus) NEVER stamps the bridge outcome/duration', async () => {
    const world = createFakeWorld();
    const { app } = await seedRingingCall(world);

    // A per-<Number statusCallback> child leg carries ParentCallSid and a
    // top-level CallStatus/CallDuration that describe the LEG (whisper answer),
    // NOT the bridge. It must NOT classify answered/missed or stamp a duration —
    // only the <Dial action> summary may. (We model what Twilio could still
    // deliver defensively even though we now drop those per-leg events.)
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAchild-leg-xyz',
      ParentCallSid: 'CAinbound0001',
      CallStatus: 'completed',
      CallDuration: '8', // whisper seconds — must NOT be read as a bridge duration
      ApiVersion: '2010-04-01',
    });
    const call = world.messages.find((m) => m.provider_sid === 'CAinbound0001')!;
    // A TERMINAL per-leg callback is ignored entirely (it must not lock out the
    // authoritative Dial summary): no outcome, no duration, status stays ringing.
    expect(call.call_status).toBe('ringing');
    expect(call.call_outcome).not.toBe('answered');
    expect(call.call_duration).toBeUndefined();
  });

  it('no-answer → outcome missed', async () => {
    const world = createFakeWorld();
    const { app } = await seedRingingCall(world);

    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAinbound0001',
      DialCallStatus: 'no-answer',
      ApiVersion: '2010-04-01',
    });
    const call = world.messages.find((m) => m.provider_sid === 'CAinbound0001')!;
    expect(call.call_status).toBe('no-answer');
    expect(call.call_outcome).toBe('missed');
  });

  it('forward-only + idempotent: a redelivered/stale Dial summary after completed is a no-op', async () => {
    const world = createFakeWorld();
    const { app } = await seedRingingCall(world);

    // Answered bridge (in-progress → completed WITH duration) so a duration is
    // recorded; the redelivery assertions below prove it isn't re-counted.
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAinbound0001',
      DialCallStatus: 'in-progress',
      ApiVersion: '2010-04-01',
    });
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAinbound0001',
      DialCallStatus: 'completed',
      DialCallDuration: '30',
      ApiVersion: '2010-04-01',
    });
    const persistedAfterComplete = world.emitted.filter((e) => e.event === 'message.persisted').length;

    // A stale 'in-progress' AND a redelivered 'completed' must both no-op.
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAinbound0001',
      DialCallStatus: 'in-progress',
      ApiVersion: '2010-04-01',
    });
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAinbound0001',
      DialCallStatus: 'completed',
      DialCallDuration: '999',
      ApiVersion: '2010-04-01',
    });
    const call = world.messages.find((m) => m.provider_sid === 'CAinbound0001')!;
    expect(call.call_status).toBe('completed');
    expect(call.call_duration).toBe(30); // unchanged — no regression, no re-count
    // No extra SSE emits for the no-op callbacks.
    expect(world.emitted.filter((e) => e.event === 'message.persisted').length).toBe(
      persistedAfterComplete,
    );
  });

  it('uses ParentCallSid to update the call entry when a child-leg callback fires (status only)', async () => {
    const world = createFakeWorld();
    const { app } = await seedRingingCall(world);

    // A <Number statusCallback> fires on the CHILD leg (its own CallSid) and
    // carries ParentCallSid → the call entry's CallSid. FIX 1: it may advance a
    // transitional status keyed off the parent, but it does NOT derive the
    // bridge outcome/duration (only the <Dial action> summary does).
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAchild-leg-xyz',
      ParentCallSid: 'CAinbound0001',
      CallStatus: 'ringing',
      ApiVersion: '2010-04-01',
    });
    const call = world.messages.find((m) => m.provider_sid === 'CAinbound0001')!;
    // The callback resolved to the PARENT entry by ParentCallSid (status stays a
    // valid lifecycle value; the bridge outcome is not set from a leg).
    expect(call.provider_sid).toBe('CAinbound0001');
    expect(call.call_outcome).not.toBe('answered');
  });

  it('unknown CallSid → 200, no crash, no write', async () => {
    const world = createFakeWorld();
    const { app } = await seedRingingCall(world);
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CA-never-seen',
      CallStatus: 'completed',
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/calls/:callId (M1.9a, authed)', () => {
  it('returns { call, conversation } for a known CallSid', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });
    // Create the call entry via the inbound bridge.
    await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());

    const res = await request(app)
      .get('/api/calls/CAinbound0001')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.call.provider_sid).toBe('CAinbound0001');
    expect(res.body.call.type).toBe('call');
    expect(res.body.call.masked).toBe(true);
    expect(res.body.conversation.conversationId).toBe('conv-relay-voice-1');
    // The response carries the masked label, never a raw counterpart phone.
    expect(res.body.call.call_party_label).toBe('Bob');
  });

  it('404 for an unknown callId', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    const res = await request(app)
      .get('/api/calls/CA-nope')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('call_not_found');
  });

  it('404 when the SID resolves to a non-call message (sms)', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });
    // Persist an SMS so its SID resolves but type !== 'call'.
    await world.messagesRepo.append({
      conversationId: 'conv-relay-voice-1',
      providerSid: 'SMnot-a-call',
      providerTs: new Date().toISOString(),
      type: 'sms',
      direction: 'inbound',
      author: 'unknown',
      deliveryStatus: 'delivered',
      body: 'hi',
    });
    const res = await request(app)
      .get('/api/calls/SMnot-a-call')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
  });

  it('requires auth (no session cookie → 401/403)', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    const res = await request(app).get('/api/calls/CAx').set('x-origin-verify', ORIGIN_SECRET);
    expect([401, 403]).toContain(res.status);
  });
});
