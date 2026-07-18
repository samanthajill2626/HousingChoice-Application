// Voice Intelligence completion webhook (voice-transcription spec 3.3) golden
// suite: POST /webhooks/twilio/voice/intelligence. Twilio POSTs a JSON body
// carrying ONLY a transcript_sid; the handler re-fetches the transcript + its
// sentences from the VI API (the world fake adapter here), joins them, and
// persists via the idempotent setCallTranscript seam. These cases MIGRATE the
// guardrail intents from the deleted legacy transcription endpoint: signature-gated
// (JSON bodySHA256 variant), never-overwrite, masked refusal, non-completed no-op,
// API-failure 500. PII: the transcript text is NEVER logged.
import { describe, expect, it } from 'vitest';
import {
  createFakeWorld,
  makeWebhookHarness,
  signedJsonPost,
  signedTwilioPost,
  OUR_NUMBER,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';
import { TEST_ADMIN_USER } from './helpers/authSession.js';

const CALLER = '+15550177777';
// The inbound-voice-line HOLDER's verified cell (there is no env-var fallback).
const HOLDER_CELL = '+15550160000';
const VI_PATH = '/webhooks/twilio/voice/intelligence';

/** A VI-agnostic founder harness (the webhook path does not read the VI SID). */
function founderHarness(world: FakeWorld) {
  const harness = makeWebhookHarness({ world });
  const admin = harness.fakeUsers.users.get(TEST_ADMIN_USER.userId);
  if (admin) {
    admin.cell = HOLDER_CELL;
    admin.cell_verified_at = '2026-07-01T00:00:00.000Z';
    void harness.fakeUsers.repo.assignInboundVoiceLine(admin.userId);
  }
  return harness;
}

/** Drive the inbound founder bridge once so a ringing founder-bridge call exists. */
async function seedFounderBridge(world: FakeWorld) {
  world.contacts.push({ contactId: 'c-caller', type: 'tenant', phone: CALLER, firstName: 'Jane', lastName: 'Doe' });
  const { app, capture } = founderHarness(world);
  await signedTwilioPost(app, '/webhooks/twilio/voice', {
    CallSid: 'CAbiz0001',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    From: CALLER,
    To: OUR_NUMBER,
    CallStatus: 'ringing',
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
  });
  return { app, capture };
}

describe('VI completion webhook - POST /voice/intelligence (voice-transcription 3.3)', () => {
  it('rejects a tampered signature (403)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    const res = await signedJsonPost(app, VI_PATH, { transcript_sid: 'GTfake1' }, { tamper: true });
    expect(res.status).toBe(403);
  });

  it('400s when transcript_sid is missing', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    const res = await signedJsonPost(app, VI_PATH, { not_it: 'x' });
    expect(res.status).toBe(400);
  });

  it('persists joined sentences on a completed transcript and emits message.persisted', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    world.viTranscripts.set('GTfake1', {
      status: 'completed',
      customerKey: 'CAbiz0001',
      sentences: [
        { text: 'hello', mediaChannel: 1 },
        { text: 'hi', mediaChannel: 2 },
      ],
    });
    const before = world.emitted.filter((e) => e.event === 'message.persisted').length;

    const res = await signedJsonPost(app, VI_PATH, { transcript_sid: 'GTfake1' });
    expect(res.status).toBe(200);

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    // Two distinct media channels + the inbound founder-bridge role map
    // ({ "1":"client","2":"staff" } stamped at ring time) -> source-attributed
    // Staff:/Client: prefixes by RAW channel (voice-extraction Layer 1).
    expect(call.transcript).toBe('Client: hello\nStaff: hi');
    expect(call.transcript_status).toBe('completed');
    const after = world.emitted.filter((e) => e.event === 'message.persisted').length;
    expect(after).toBeGreaterThan(before);
  });

  it('single-channel sentences join without speaker prefixes (voicemail shape)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    world.viTranscripts.set('GTvm', {
      status: 'completed',
      customerKey: 'CAbiz0001',
      sentences: [
        { text: 'Please call me back.', mediaChannel: 1 },
        { text: 'Thanks.', mediaChannel: 1 },
      ],
    });
    const res = await signedJsonPost(app, VI_PATH, { transcript_sid: 'GTvm' });
    expect(res.status).toBe(200);
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.transcript).toBe('Please call me back.\nThanks.');
  });

  it('a redelivered webhook never overwrites (transcript unchanged, 200)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    world.viTranscripts.set('GTfake1', {
      status: 'completed',
      customerKey: 'CAbiz0001',
      sentences: [{ text: 'first and only', mediaChannel: 1 }],
    });
    const first = await signedJsonPost(app, VI_PATH, { transcript_sid: 'GTfake1' });
    expect(first.status).toBe(200);
    // A late edit to the sentences must NOT overwrite the saved transcript.
    world.viTranscripts.set('GTfake1', {
      status: 'completed',
      customerKey: 'CAbiz0001',
      sentences: [{ text: 'DIFFERENT redelivered text', mediaChannel: 1 }],
    });
    const second = await signedJsonPost(app, VI_PATH, { transcript_sid: 'GTfake1' });
    expect(second.status).toBe(200);
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.transcript).toBe('first and only');
  });

  it('a transcript with no customerKey is ignored with 200 (not ours)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    world.viTranscripts.set('GTnokey', {
      status: 'completed',
      sentences: [{ text: 'someone elses transcript', mediaChannel: 1 }],
    });
    const res = await signedJsonPost(app, VI_PATH, { transcript_sid: 'GTnokey' });
    expect(res.status).toBe(200);
    expect(world.messages.find((m) => m.provider_sid === 'CAbiz0001')!.transcript).toBeUndefined();
  });

  it('a MASKED call transcript is refused (200, nothing saved)', async () => {
    const world = createFakeWorld();
    // A masked relay call must never carry a transcript, even if a stray VI
    // event points its customerKey at it.
    world.messages.push({
      conversationId: 'conv-relay',
      tsMsgId: 'CAmask1',
      type: 'call',
      direction: 'inbound',
      provider_sid: 'CAmask1',
      delivery_status: 'delivered',
      masked: true,
      call_outcome: 'missed',
    } as never);
    world.viTranscripts.set('GTmask', {
      status: 'completed',
      customerKey: 'CAmask1',
      sentences: [{ text: 'should never be saved', mediaChannel: 1 }],
    });
    const { app } = makeWebhookHarness({ world });
    const res = await signedJsonPost(app, VI_PATH, { transcript_sid: 'GTmask' });
    expect(res.status).toBe(200);
    expect(world.messages.find((m) => m.provider_sid === 'CAmask1')!.transcript).toBeUndefined();
  });

  it('a FAILED-status event for a MASKED call is refused before any stamp (defense-in-depth)', async () => {
    // The masked guardrail must precede the failed-stamp branch: a stray VI
    // 'failed' event whose customerKey points at a masked call must not touch
    // transcript_status (masked calls have no transcript lifecycle at all).
    const world = createFakeWorld();
    world.messages.push({
      conversationId: 'conv-relay',
      tsMsgId: 'CAmask2',
      type: 'call',
      direction: 'inbound',
      provider_sid: 'CAmask2',
      delivery_status: 'delivered',
      masked: true,
      call_outcome: 'missed',
    } as never);
    world.viTranscripts.set('GTmaskfail', { status: 'failed', customerKey: 'CAmask2', sentences: [] });
    const { app } = makeWebhookHarness({ world });
    const res = await signedJsonPost(app, VI_PATH, { transcript_sid: 'GTmaskfail' });
    expect(res.status).toBe(200);
    const entry = world.messages.find((m) => m.provider_sid === 'CAmask2')!;
    expect(entry.transcript_status).toBeUndefined();
    expect(entry.transcript).toBeUndefined();
  });

  it('a queued/in-progress transcript is a 200 no-op - nothing persisted (adjudication F4b)', async () => {
    // Spec 3.3: any non-completed, non-failed status (Twilio's 'queued' /
    // 'in-progress') acks 200 with NO writes - the reconcile job is the safety
    // net that re-checks later. Pinned at the WEBHOOK level here (previously
    // only exercised through the reconcile-job suite).
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    world.viTranscripts.set('GTinprog', {
      status: 'in-progress',
      customerKey: 'CAbiz0001',
      sentences: [{ text: 'not ready yet', mediaChannel: 1 }],
    });
    const res = await signedJsonPost(app, VI_PATH, { transcript_sid: 'GTinprog' });
    expect(res.status).toBe(200);
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.transcript).toBeUndefined();
    expect(call.transcript_status).toBeUndefined();
  });

  it('status failed stamps transcript_status=failed (200)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    // A transcript can only fail from pending (the create leg stamps pending).
    await world.messagesRepo.setTranscriptPending('CAbiz0001');
    world.viTranscripts.set('GTfail', { status: 'failed', customerKey: 'CAbiz0001', sentences: [] });
    const res = await signedJsonPost(app, VI_PATH, { transcript_sid: 'GTfail' });
    expect(res.status).toBe(200);
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.transcript_status).toBe('failed');
    expect(call.transcript).toBeUndefined();
  });

  it('a Twilio API failure returns 500 (redelivery-safe)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    // GTmissing is not seeded -> the fake fetchViTranscript throws -> the route
    // 500s so Twilio redelivers (the idempotent persist makes that safe).
    const res = await signedJsonPost(app, VI_PATH, { transcript_sid: 'GTmissing' });
    expect(res.status).toBe(500);
  });

  it('never logs the transcript text (PII, doc section 9)', async () => {
    const world = createFakeWorld();
    const { app, capture } = await seedFounderBridge(world);
    const secret = 'super secret verbatim transcript body words';
    world.viTranscripts.set('GTfake1', {
      status: 'completed',
      customerKey: 'CAbiz0001',
      sentences: [{ text: secret, mediaChannel: 1 }],
    });
    await signedJsonPost(app, VI_PATH, { transcript_sid: 'GTfake1' });
    expect(JSON.stringify(capture.lines)).not.toContain(secret);
  });
});
