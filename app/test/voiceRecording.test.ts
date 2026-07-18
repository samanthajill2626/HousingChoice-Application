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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureOutboundQueue,
  configureScheduler,
} from '../src/jobs/jobs.js';
import type { JobEnvelope } from '../src/jobs/types.js';
import {
  CREATE_VOICE_TRANSCRIPT_JOB,
  RECONCILE_VOICE_TRANSCRIPT_JOB,
} from '../src/jobs/voiceTranscript.js';

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

describe('recording callback create-leg - VI transcription request (voice-transcription 3.2)', () => {
  // The recording handler's create leg enqueues jobs, so the jobs pipeline must
  // be wired. A RECORDER dispatch captures every dispatched envelope WITHOUT
  // running a handler (we assert the enqueue, not the job's effects here).
  let dispatched: JobEnvelope[];
  let queueAdapter: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    configureScheduler(new InMemorySchedulerAdapter());
    dispatched = [];
    queueAdapter = new InProcessOutboundQueueAdapter({
      dispatch: async (raw) => {
        dispatched.push(raw as JobEnvelope);
      },
    });
    configureOutboundQueue(queueAdapter);
  });

  afterEach(async () => {
    await queueAdapter.settle();
    _resetForTests();
  });

  /** A founder harness with Voice Intelligence CONFIGURED (VI SID + reconcile secs). */
  function viFounderHarness(world: FakeWorld) {
    const harness = makeWebhookHarness({
      world,
      env: { TWILIO_VI_SERVICE_SID: 'GAsvc', VOICE_TRANSCRIPT_RECONCILE_SECONDS: '1' },
    });
    const admin = harness.fakeUsers.users.get(TEST_ADMIN_USER.userId);
    if (admin) {
      admin.cell = HOLDER_CELL;
      admin.cell_verified_at = '2026-07-01T00:00:00.000Z';
      void harness.fakeUsers.repo.assignInboundVoiceLine(admin.userId);
    }
    return harness;
  }

  async function seedFounderBridgeVi(world: FakeWorld) {
    world.contacts.push({ contactId: 'c-caller', type: 'tenant', phone: CALLER, firstName: 'Jane', lastName: 'Doe' });
    const { app, capture } = viFounderHarness(world);
    await signedTwilioPost(app, '/webhooks/twilio/voice', bizVoiceParams());
    return { app, capture };
  }

  it('completed founder-bridge recording stamps transcript_status=pending, creates VI inline, enqueues reconcile', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridgeVi(world);

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    expect(res.status).toBe(200);

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.transcript_status).toBe('pending');
    // Inline VI create fired with customerKey = the CallSid.
    expect(world.viCreates).toEqual([
      { serviceSid: 'GAsvc', recordingSid: 'RE1111', customerKey: 'CAbiz0001' },
    ]);
    // One reconcile enqueued with the ~10min delay (delaySeconds 1 -> delayed[]).
    expect(queueAdapter.delayed).toHaveLength(1);
    const d = queueAdapter.delayed[0]!;
    expect(d.envelope.jobName).toBe(RECONCILE_VOICE_TRANSCRIPT_JOB);
    expect(d.envelope.payload).toMatchObject({ callSid: 'CAbiz0001', transcriptSid: 'GTfake1', attempt: 1 });
  });

  it('inline create failure falls back to the createVoiceTranscript job and still 200s', async () => {
    const world = createFakeWorld();
    world.viCreateError = new Error('twilio down');
    const { app } = await seedFounderBridgeVi(world);

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    expect(res.status).toBe(200);

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    // pending is stamped BEFORE the create attempt, so the indicator is correct
    // even while the fallback job retries.
    expect(call.transcript_status).toBe('pending');
    expect(world.viCreates).toHaveLength(0);
    // No reconcile (create failed); a createVoiceTranscript fallback was enqueued
    // (delay 0 -> drained by settle() into the recorder).
    expect(queueAdapter.delayed).toHaveLength(0);
    await queueAdapter.settle();
    const createJobs = dispatched.filter((e) => e.jobName === CREATE_VOICE_TRANSCRIPT_JOB);
    expect(createJobs).toHaveLength(1);
    expect(createJobs[0]!.payload).toMatchObject({ callSid: 'CAbiz0001', recordingSid: 'RE1111' });
  });

  it('a reconcile-enqueue failure AFTER a successful inline create logs an error and never enqueues the create job (adjudication F1)', async () => {
    // The inline create SUCCEEDED - VI transcript #1 is minted. If the reconcile
    // enqueue then throws (an SQS hiccup), falling back to the create job would
    // mint a DUPLICATE VI transcript for the same recording (double Twilio cost):
    // the create-job idempotency guard checks the PERSISTED transcript, which VI
    // (async) has not delivered yet. Required: 200, error logged, NO create job -
    // the completion webhook still delivers; only this call's self-heal is lost.
    const world = createFakeWorld();
    const { app, capture } = await seedFounderBridgeVi(world);
    // Fail ONLY the reconcile enqueue: wrap the recorder adapter so a create-job
    // fallback (the bug) would still be captured in `dispatched` below.
    configureOutboundQueue({
      enqueue: async (envelope, opts) => {
        if (envelope.jobName === RECONCILE_VOICE_TRANSCRIPT_JOB) throw new Error('sqs down');
        return queueAdapter.enqueue(envelope, opts);
      },
    });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    // A lost self-heal never 5xxs the callback (the recording is already safe).
    expect(res.status).toBe(200);

    // The inline create ran exactly once...
    expect(world.viCreates).toHaveLength(1);
    // ...and NOTHING was enqueued: no reconcile (it threw) and - the point - no
    // duplicate-minting createVoiceTranscript fallback.
    expect(queueAdapter.delayed).toHaveLength(0);
    await queueAdapter.settle();
    expect(dispatched.filter((e) => e.jobName === CREATE_VOICE_TRANSCRIPT_JOB)).toHaveLength(0);

    // The failure is reported for what it IS (a reconcile-enqueue failure after a
    // successful create), never as the untrue 'inline vi create failed'.
    const logs = JSON.stringify(capture.lines);
    expect(logs).toContain('reconcile enqueue failed after successful create');
    expect(logs).not.toContain('inline vi create failed');
  });

  it('inline create failure + fallback enqueue failure stamps transcript_status failed (no stuck pending)', async () => {
    // The pipeline gave up IMMEDIATELY: no VI transcript exists and no job will
    // ever retry. Leaving transcript_status 'pending' would show "Transcribing..."
    // forever - spec 3.7 requires 'failed' when the pipeline gives up.
    const world = createFakeWorld();
    world.viCreateError = new Error('twilio down');
    const { app } = await seedFounderBridgeVi(world);
    configureOutboundQueue({
      enqueue: async (envelope, opts) => {
        if (envelope.jobName === CREATE_VOICE_TRANSCRIPT_JOB) throw new Error('sqs down');
        return queueAdapter.enqueue(envelope, opts);
      },
    });

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    expect(res.status).toBe(200); // recording is safe; never 5xx

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.transcript_status).toBe('failed');
    // The failed transition is announced live (SSE) like every other transition.
    expect(world.emitted.some((e) => e.event === 'message.persisted')).toBe(true);
  });

  it('VI unset -> no pending stamp, no create, no jobs (recording still stored)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridge(world); // VI OFF harness

    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    expect(res.status).toBe(200);

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.transcript_status).toBeUndefined();
    // The recording is still mirrored + stamped (the create leg is additive).
    expect(call.recording_s3_key).toBe('recordings/CAbiz0001/RE1111');
    expect(world.viCreates).toHaveLength(0);
    expect(queueAdapter.delayed).toHaveLength(0);
    await queueAdapter.settle();
    expect(dispatched).toHaveLength(0);
  });

  it('masked recording still refused before any VI activity', async () => {
    const world = createFakeWorld();
    seedRelay(world);
    const { app } = makeWebhookHarness({
      world,
      env: { TWILIO_VI_SERVICE_SID: 'GAsvc', VOICE_TRANSCRIPT_RECONCILE_SECONDS: '1' },
    });
    await signedTwilioPost(app, '/webhooks/twilio/voice', {
      CallSid: 'CAmasked1',
      From: ALICE,
      To: POOL,
      CallStatus: 'ringing',
      Direction: 'inbound',
      ApiVersion: '2010-04-01',
    });
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice/recording', {
      CallSid: 'CAmasked1',
      RecordingSid: 'REmask',
      RecordingStatus: 'completed',
      RecordingUrl: RECORDING_URL,
      RecordingDuration: '10',
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(200);
    // Masked calls are refused before the mirror, so no VI create + no pending.
    expect(world.viCreates).toHaveLength(0);
    expect(world.messages.find((m) => m.provider_sid === 'CAmasked1')!.transcript_status).toBeUndefined();
  });

  it('a redelivered recording callback does not double-create (recording_s3_key present -> early 200)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridgeVi(world);

    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    expect(world.viCreates).toHaveLength(1);

    // Redeliver: the "already stored" early return fires before requestTranscription.
    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams());
    expect(world.viCreates).toHaveLength(1);
  });

  // --- Voicemail classification (voice-transcription spec 4.2) ---------------
  // A completed recording on a MISSED inbound founder-bridge call IS a voicemail:
  // upgrade the outcome (conditional, idempotent), fire the "New voicemail" push,
  // and request transcription (shared create leg). A near-empty (<2s) recording is
  // discarded before the mirror. Answered/masked/outbound never become voicemail.

  /** Drive the seeded founder bridge to a terminal MISS (no-answer Dial summary). */
  async function driveToMissed(app: Parameters<typeof signedTwilioPost>[0]) {
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'no-answer',
      ApiVersion: '2010-04-01',
    });
  }

  it('a completed recording on a MISSED inbound founder-bridge call becomes a voicemail: outcome upgraded, New-voicemail push, transcription requested', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridgeVi(world);
    await driveToMissed(app);
    world.pushSends.length = 0; // drop the missed-call push; assert only the voicemail push

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/voice/recording',
      recordingParams({ RecordingDuration: '6' }),
    );
    expect(res.status).toBe(200);

    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    // The outcome was upgraded 'missed' -> 'voicemail'.
    expect(call.call_outcome).toBe('voicemail');
    // The recording is stored + transcription requested (voicemail rides the create leg).
    expect(call.recording_s3_key).toBe('recordings/CAbiz0001/RE1111');
    expect(world.viCreates).toHaveLength(1);
    // Exactly one "New voicemail" push to the founder, masked (no raw caller phone).
    const vmPush = world.pushSends.filter((p) => p.notification.kind === 'voicemail');
    expect(vmPush).toHaveLength(1);
    expect(vmPush[0]!.notification.payload.kind).toBe('voicemail');
    expect(vmPush[0]!.notification.payload.title).toBe('New voicemail');
    expect(vmPush[0]!.notification.payload.callId).toBe('CAbiz0001');
    expect(JSON.stringify(vmPush[0]!.notification.payload)).not.toContain(CALLER);
  });

  it('a redelivered voicemail recording callback upgrades + pushes only once', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridgeVi(world);
    await driveToMissed(app);
    world.pushSends.length = 0;

    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams({ RecordingDuration: '6' }));
    expect(world.messages.find((m) => m.provider_sid === 'CAbiz0001')!.call_outcome).toBe('voicemail');
    expect(world.pushSends.filter((p) => p.notification.kind === 'voicemail')).toHaveLength(1);

    // Redeliver: recording_s3_key present -> early 200 before any upgrade/push.
    await signedTwilioPost(app, '/webhooks/twilio/voice/recording', recordingParams({ RecordingDuration: '6' }));
    expect(world.pushSends.filter((p) => p.notification.kind === 'voicemail')).toHaveLength(1);
  });

  it('a sub-2s voicemail is discarded: no store, outcome stays missed, no push, no VI', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridgeVi(world);
    await driveToMissed(app);
    world.pushSends.length = 0;

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/voice/recording',
      recordingParams({ RecordingDuration: '1' }),
    );
    expect(res.status).toBe(200);
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.call_outcome).toBe('missed'); // never upgraded
    expect(call.recording_s3_key).toBeUndefined(); // not stored
    expect(world.mediaPuts).toHaveLength(0);
    expect(world.pushSends.filter((p) => p.notification.kind === 'voicemail')).toHaveLength(0);
    expect(world.viCreates).toHaveLength(0); // discarded before the create leg
  });

  it('an ANSWERED call recording never upgrades outcome or fires the voicemail push', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridgeVi(world);
    // Accept the bridge (press-1), then a completed Dial summary WITH duration -> answered.
    await signedTwilioPost(
      app,
      '/webhooks/twilio/voice/whisper-gate?conversationId=x&parentCallSid=CAbiz0001&leg=founder',
      { Digits: '1', CallSid: 'CAfounder-leg' },
    );
    await signedTwilioPost(app, '/webhooks/twilio/voice/status', {
      CallSid: 'CAbiz0001',
      DialCallStatus: 'completed',
      DialCallDuration: '42',
      ApiVersion: '2010-04-01',
    });
    expect(world.messages.find((m) => m.provider_sid === 'CAbiz0001')!.call_outcome).toBe('answered');
    world.pushSends.length = 0;

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/voice/recording',
      recordingParams({ RecordingDuration: '6' }),
    );
    expect(res.status).toBe(200);
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.call_outcome).toBe('answered'); // never upgraded to voicemail
    expect(call.recording_s3_key).toBe('recordings/CAbiz0001/RE1111'); // bridge recording stored
    expect(world.pushSends.filter((p) => p.notification.kind === 'voicemail')).toHaveLength(0);
    expect(world.viCreates).toHaveLength(1); // transcription still requested for the bridge
  });

  it('a voicemail push failure never breaks the callback (200, recording stored, outcome upgraded)', async () => {
    const world = createFakeWorld();
    const { app } = await seedFounderBridgeVi(world);
    await driveToMissed(app);
    // Make the push throw for the voicemail push (contained, best-effort posture).
    world.pushService.sendToUser = async () => {
      throw new Error('push down');
    };

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/voice/recording',
      recordingParams({ RecordingDuration: '6' }),
    );
    expect(res.status).toBe(200);
    const call = world.messages.find((m) => m.provider_sid === 'CAbiz0001')!;
    expect(call.call_outcome).toBe('voicemail'); // upgrade still happened
    expect(call.recording_s3_key).toBe('recordings/CAbiz0001/RE1111'); // recording still stored
  });
});
