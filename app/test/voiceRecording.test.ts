// M1.9c (Change Order 1) golden suite: founder-bridge call RECORDING +
// TRANSCRIPTION. The founder-bridge (M1.9b, masked:false) RECORDS — the
// recordingStatusCallback fetches the recording media (authed, SSRF-guarded) +
// streams it to S3 and stamps recording_s3_key/duration on the `call` entity; a
// separate transcription callback persists a VERBATIM transcript. MASKED relay
// calls (M1.9a, masked:true) STAY do-not-record / never-transcribe. Driven
// through the REAL app (buildApp) + the webhook harness with REAL computed
// X-Twilio-Signature values and simulated Twilio recording/transcription
// callbacks (no real audio, no real Twilio voice).
//
// GUARDRAILS asserted here (the M1.9c contract):
//  - ONLY founder-bridge (masked:false) calls record; the masked relay <Dial>
//    stays do-not-record, and a stray recording/transcription callback for a
//    masked call is REFUSED (never fetches the media)
//  - recording media fetch is SSRF-guarded + size-capped (adapter); the
//    recording-serving endpoint is AUTH-ONLY
//  - idempotency: a redelivered recording callback (same RecordingSid) never
//    re-fetches / re-stores; a redelivered transcription callback never
//    overwrites / duplicates
//  - no recording URL content / transcript text in ANY log line
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
import { TEST_SESSION_COOKIE, TEST_ADMIN_USER } from './helpers/authSession.js';

const CALLER = '+15550177777'; // a tenant calling the business number
// The inbound-voice-line HOLDER's verified cell — the number inbound calls ring
// (there is no env-var fallback; the harness assigns a verified holder).
const HOLDER_CELL = '+15550160000';
const POOL = '+15550109000';
const ALICE = '+15550100001';
const BOB = '+15550100002';

// A Twilio RecordingUrl always lives on api.twilio.com (the adapter's allowlist).
const RECORDING_URL = 'https://api.twilio.com/2010-04-01/Accounts/ACxxx/Recordings/RE1111';

/** A standard inbound voice webhook to the BUSINESS number (founder triage). */
function bizVoiceParams(over: Record<string, string> = {}): Record<string, string> {
  return {
    CallSid: 'CAbiz0001',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    From: CALLER,
    To: OUR_NUMBER,
    CallStatus: 'ringing',
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
    ...over,
  };
}

/** A simulated completed recordingStatusCallback. */
function recordingParams(over: Record<string, string> = {}): Record<string, string> {
  return {
    CallSid: 'CAbiz0001',
    RecordingSid: 'RE1111',
    RecordingStatus: 'completed',
    RecordingUrl: RECORDING_URL,
    RecordingDuration: '37',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    ApiVersion: '2010-04-01',
    ...over,
  };
}

/** A simulated completed transcription callback (legacy TranscriptionText shape). */
function transcriptionParams(over: Record<string, string> = {}): Record<string, string> {
  return {
    CallSid: 'CAbiz0001',
    TranscriptionStatus: 'completed',
    TranscriptionText: 'Hi, I am calling about the two bedroom unit on Main Street.',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    ApiVersion: '2010-04-01',
    ...over,
  };
}

function founderHarness(world: FakeWorld) {
  const harness = makeWebhookHarness({ world });
  // Voice Phase 1 (spec §6): inbound bridges to the inbound-voice-line HOLDER's
  // verified cell — assign the seeded admin as the holder so the bridge forms.
  const admin = harness.fakeUsers.users.get(TEST_ADMIN_USER.userId);
  if (admin) {
    admin.cell = HOLDER_CELL;
    admin.cell_verified_at = '2026-07-01T00:00:00.000Z';
    void harness.fakeUsers.repo.assignInboundVoiceLine(admin.userId);
  }
  return harness;
}

/** Run the inbound founder bridge once so a ringing founder-bridge call exists. */
async function seedFounderBridge(world: FakeWorld) {
  world.contacts.push({ contactId: 'c-caller', type: 'tenant', phone: CALLER, firstName: 'Jane', lastName: 'Doe' });
  const { app, capture } = founderHarness(world);
  await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
  return { app, capture };
}

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

describe('founder-bridge recording — the <Dial> markup (M1.9c)', () => {
  it('founder bridge enables recording + the recordingStatusCallback', async () => {
    const world = createFakeWorld();
    const { app } = founderHarness(world);
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    const xml = res.text;
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain('/webhooks/twilio/voice/recording');
    expect(xml).toContain('recordingStatusCallbackEvent="completed"');
    // GUARDRAIL: NOT do-not-record on the founder bridge.
    expect(xml).not.toContain('record="do-not-record"');
  });

  it('GUARDRAIL: the MASKED relay <Dial> stays do-not-record (unchanged)', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', {
      CallSid: 'CAmasked1',
      From: ALICE,
      To: POOL,
      CallStatus: 'ringing',
      Direction: 'inbound',
      ApiVersion: '2010-04-01',
    });
    const xml = res.text;
    // The masked relay bridge records NOTHING and wires NO recording callback.
    expect(xml).toContain('record="do-not-record"');
    expect(xml).not.toContain('record-from-answer');
    expect(xml).not.toContain('/webhooks/twilio/voice/recording');
  });
});

describe('recording callback — POST /voice/recording (M1.9c)', () => {
  it('completed → fetches media (authed), streams to S3, stamps recording_s3_key + duration; emits live', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    const before = world.emitted.filter((e) => e.event === 'message.persisted').length;

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    expect(res.status).toBe(200);

    // The media was streamed to S3 under recordings/<callSid>/<recordingSid>.
    expect(world.mediaPuts).toHaveLength(1);
    const put = world.mediaPuts[0]!;
    expect(put.key).toBe('recordings/CAbiz0001/RE1111');
    expect(put.bytes).toBeGreaterThan(0);
    expect(put.contentType).toBe('audio/mpeg');

    // The call entity now carries the recording key + duration (+ the
    // RecordingSid for idempotency).
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.recording_s3_key).toBe('recordings/CAbiz0001/RE1111');
    expect(call.recording_sid).toBe('RE1111');
    expect(call.recording_duration).toBe(37);

    // A live timeline update fired for the now-recorded call.
    const after = world.emitted.filter((e) => e.event === 'message.persisted').length;
    expect(after).toBeGreaterThan(before);
  });

  it('GUARDRAIL: idempotent per RecordingSid — a redelivered callback never re-fetches / re-stores', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);

    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    expect(world.mediaPuts).toHaveLength(1);

    // Redeliver the SAME completed callback twice more — no second fetch/store.
    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    expect(world.mediaPuts).toHaveLength(1);

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.recording_s3_key).toBe('recordings/CAbiz0001/RE1111');
  });

  it('FIX 4: claim-before-fetch — two CONCURRENT first-time callbacks fetch the media ONCE (no double-fetch/orphan)', async () => {
    const world = createFakeWorld();
    // Count + delay the recording fetch so two concurrent callbacks genuinely
    // interleave AROUND the fetch await — without claim-before-fetch, BOTH would
    // pass the layer-1 (no-key-yet) check and fetch twice.
    let fetches = 0;
    const realGet = world.adapter.getRecordingStream.bind(world.adapter);
    world.adapter.getRecordingStream = async (url: string) => {
      fetches += 1;
      await new Promise((r) => setTimeout(r, 10)); // hold the await open
      return realGet(url);
    };
    const { app } = await seedFounderBridge(world);

    // Fire the SAME completed callback twice concurrently.
    await Promise.all([
      signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams()),
      signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams()),
    ]);

    // The claim (conditional setCallRecording) is won once, so the media is
    // fetched + put EXACTLY once — no double-fetch, no orphaned S3 object.
    expect(fetches).toBe(1);
    expect(world.mediaPuts).toHaveLength(1);
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.recording_s3_key).toBe('recordings/CAbiz0001/RE1111');
    expect(call.recording_sid).toBe('RE1111');
  });

  it('FIX 4: a failed fetch RELEASES the claim so a later redelivery re-fetches + stores', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    // First delivery: the fetch fails → the claim must be released (no key left).
    world.failRecordingUrls.add(`${RECORDING_URL}.mp3`);
    world.failRecordingUrls.add(RECORDING_URL);
    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    let call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(world.mediaPuts).toHaveLength(0);
    expect(call.recording_s3_key).toBeUndefined();
    expect(call.recording_sid).toBeUndefined(); // claim was rolled back

    // Twilio redelivers later; this time the fetch succeeds → stored normally.
    world.failRecordingUrls.clear();
    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(world.mediaPuts).toHaveLength(1);
    expect(call.recording_s3_key).toBe('recordings/CAbiz0001/RE1111');
    expect(call.recording_sid).toBe('RE1111');
  });

  it('GUARDRAIL: a MASKED relay call → recording callback REFUSED, no media fetch (masked never records)', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });
    // Create a MASKED call entry via the masked bridge.
    await signedTwilioPost(app, '/webhooks/twilio/voice', {
      CallSid: 'CAmasked1',
      From: ALICE,
      To: POOL,
      CallStatus: 'ringing',
      Direction: 'inbound',
      ApiVersion: '2010-04-01',
    });
    const maskedCall = world.messages.find((m) => m.provider_sid === 'CAmasked1')!;
    expect(maskedCall.masked).toBe(true);

    // A stray recording callback for the masked CallSid must be refused.
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', {
      CallSid: 'CAmasked1',
      RecordingSid: 'REmask',
      RecordingStatus: 'completed',
      RecordingUrl: RECORDING_URL,
      RecordingDuration: '10',
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(200);
    // NO media fetched/stored; the masked call has no recording.
    expect(world.mediaPuts).toHaveLength(0);
    expect(world.messages.find((m) => m.provider_sid === 'CAmasked1')!.recording_s3_key).toBeUndefined();
  });

  it('unknown CallSid → 200, no fetch, no write', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams({ CallSid: 'CA-never-seen' }));
    expect(res.status).toBe(200);
    expect(world.mediaPuts).toHaveLength(0);
  });

  it('a failed media fetch never 5xxs and leaves no recording key (redelivery-safe)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    world.failRecordingUrls.add(`${RECORDING_URL}.mp3`); // the adapter throws
    world.failRecordingUrls.add(RECORDING_URL);

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    expect(res.status).toBe(200);
    expect(world.mediaPuts).toHaveLength(0);
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.recording_s3_key).toBeUndefined();
  });

  it('missing CallSid/RecordingSid → 400', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', {
      RecordingStatus: 'completed',
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid X-Twilio-Signature (signature-gated)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams(), {
      tamper: true,
    });
    expect(res.status).toBe(403);
  });

  it('never logs the RecordingUrl content (PII, doc §9)', async () => {
    const world = createFakeWorld();
    const { app, capture } = await seedFounderBridge(world);
    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    const logs = JSON.stringify(capture.lines);
    expect(logs).not.toContain(RECORDING_URL);
    // The IDs/SIDs ARE allowed in logs (correlation) — sanity that we logged.
    expect(logs).toContain('RE1111');
  });
});

describe('transcription callback — POST /voice/transcription (M1.9c)', () => {
  it('completed → saves the verbatim transcript on the call; emits live', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    const before = world.emitted.filter((e) => e.event === 'message.persisted').length;

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/transcription', transcriptionParams());
    expect(res.status).toBe(200);

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.transcript).toBe('Hi, I am calling about the two bedroom unit on Main Street.');

    const after = world.emitted.filter((e) => e.event === 'message.persisted').length;
    expect(after).toBeGreaterThan(before);
  });

  it('accepts a Voice Intelligence transcript body shape (lenient field)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    // No TranscriptionText — the transcript rides a `Transcript` field instead.
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/transcription', {
      CallSid: 'CAbiz0001',
      TranscriptionStatus: 'completed',
      Transcript: 'Verbatim from Voice Intelligence.',
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(200);
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.transcript).toBe('Verbatim from Voice Intelligence.');
  });

  it('GUARDRAIL: a redelivered transcription callback never overwrites / duplicates', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);

    await signedTwilioPost(app, '/webhooks/twilio/voice/transcription', transcriptionParams());
    // A redelivery with DIFFERENT text must NOT overwrite the saved transcript.
    await signedTwilioPost(app, '/webhooks/twilio/voice/transcription', transcriptionParams({ TranscriptionText: 'DIFFERENT redelivered text' }));

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.transcript).toBe('Hi, I am calling about the two bedroom unit on Main Street.');
  });

  it('an empty-transcript redelivery never clobbers a saved transcript', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    await signedTwilioPost(app, '/webhooks/twilio/voice/transcription', transcriptionParams());
    // Empty redelivery → nothing to save, existing transcript preserved.
    await signedTwilioPost(app, '/webhooks/twilio/voice/transcription', transcriptionParams({ TranscriptionText: '' }));
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.transcript).toBe('Hi, I am calling about the two bedroom unit on Main Street.');
  });

  it('GUARDRAIL: a MASKED relay call → transcription REFUSED (masked never transcribes)', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });
    await signedTwilioPost(app, '/webhooks/twilio/voice', {
      CallSid: 'CAmasked1',
      From: ALICE,
      To: POOL,
      CallStatus: 'ringing',
      Direction: 'inbound',
      ApiVersion: '2010-04-01',
    });
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/transcription', {
      CallSid: 'CAmasked1',
      TranscriptionStatus: 'completed',
      TranscriptionText: 'should never be saved',
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(200);
    expect(world.messages.find((m) => m.provider_sid === 'CAmasked1')!.transcript).toBeUndefined();
  });

  it('never logs the transcript text (PII, doc §9)', async () => {
    const world = createFakeWorld();
    const { app, capture } = await seedFounderBridge(world);
    await signedTwilioPost(app, '/webhooks/twilio/voice/transcription', transcriptionParams());
    const logs = JSON.stringify(capture.lines);
    expect(logs).not.toContain('two bedroom unit on Main Street');
  });

  it('rejects an invalid X-Twilio-Signature (signature-gated)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world);
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/transcription', transcriptionParams(), {
      tamper: true,
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/calls/:callId/recording (M1.9c, authed)', () => {
  /** Seed a founder bridge AND store its recording via the callback. */
  async function seedRecordedCall(world: FakeWorld) {
    const { app } = await seedFounderBridge(world);
    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    return app;
  }

  it('streams the recording bytes for a recorded call (authed)', async () => {
    const world = createFakeWorld();
    const app = await seedRecordedCall(world);

    const res = await request(app)
      .get('/api/calls/CAbiz0001/recording')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
    // The bytes round-trip from what the recording callback stored.
    expect((res.body as Buffer).toString()).toContain('recording-bytes-for:');
  });

  it('404 when the call has no recording', async () => {
    const world = createFakeWorld();
    // A founder bridge exists but NO recording callback fired.
    await seedFounderBridge(world);
    const { app } = founderHarness(world);

    const res = await request(app)
      .get('/api/calls/CAbiz0001/recording')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('recording_not_found');
  });

  it('404 for an unknown callId', async () => {
    const world = createFakeWorld();
    const { app } = founderHarness(world);
    const res = await request(app)
      .get('/api/calls/CA-nope/recording')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
  });

  it('GUARDRAIL: requires auth (no session cookie → 401/403) — recordings are never public', async () => {
    const world = createFakeWorld();
    const app = await seedRecordedCall(world);
    const res = await request(app)
      .get('/api/calls/CAbiz0001/recording')
      .set('x-origin-verify', ORIGIN_SECRET);
    expect([401, 403]).toContain(res.status);
  });

  it('never logs the recording content/key bytes on the serving path (PII)', async () => {
    const world = createFakeWorld();
    const { app, capture } = founderHarness(world);
    world.contacts.push({ contactId: 'c-caller', type: 'tenant', phone: CALLER, firstName: 'Jane', lastName: 'Doe' });
    await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    await request(app)
      .get('/api/calls/CAbiz0001/recording')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    const logs = JSON.stringify(capture.lines);
    expect(logs).not.toContain('recording-bytes-for');
  });
});
