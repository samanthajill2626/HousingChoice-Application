// voice.createTranscript + voice.reconcileTranscript (voice-transcription 3.2 /
// 3.4) golden suite, driven through the REAL jobs envelope machinery
// (enqueueImmediate -> InProcessOutboundQueue -> dispatchJob), mirroring
// missedCallAutoText.test.ts. The create leg is the recording handler's fallback;
// the reconcile leg is the webhook-loss self-heal (retry to a cap, then stamp
// failed). Both REUSE persistViTranscript. PII: no transcript text in any log.
//
// D8 (settle mechanics): InProcessOutboundQueueAdapter.settle() drains only
// delay-0 (immediate) dispatches - INCLUDING ones enqueued DURING settling - but
// NOT delayed (delaySeconds > 0) enqueues (those sit in queueAdapter.delayed for
// deliverDelayed). So: the happy-path reconcile (reconcileSeconds=1 -> delay 1)
// is asserted via queueAdapter.delayed WITHOUT running; the reconcile-chain test
// uses reconcileSeconds=0 so every re-enqueue is immediate and settle() drains
// the whole attempt 1..3 chain.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
  enqueueImmediate,
} from '../src/jobs/jobs.js';
import {
  CREATE_VOICE_TRANSCRIPT_JOB,
  RECONCILE_VOICE_TRANSCRIPT_JOB,
  parseCreateVoiceTranscriptPayload,
  parseReconcileVoiceTranscriptPayload,
  registerVoiceTranscriptJobHandlers,
} from '../src/jobs/voiceTranscript.js';
import { loadConfig, type AppConfig } from '../src/lib/config.js';
import { createLogger, type Logger } from '../src/lib/logger.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

const CALL_SID = 'CAbiz0001';
const RECORDING_SID = 'REbiz0001';

/** VI enabled + reconcileSeconds 1 by default (tests override for the chain). */
function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({ NODE_ENV: 'test', OUR_PHONE_NUMBERS: '+15550009999' } as NodeJS.ProcessEnv),
    twilioViServiceSid: 'GAsvc',
    voiceTranscriptReconcileSeconds: 1,
    ...over,
  };
}

describe('voice transcript jobs (voice-transcription 3.2 / 3.4)', () => {
  let world: FakeWorld;
  let capture: LogCapture;
  let logger: Logger;
  let queueAdapter: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    capture = createLogCapture();
    logger = createLogger({ level: 'info', destination: capture.stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    queueAdapter = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(queueAdapter);
  });

  afterEach(async () => {
    await queueAdapter.settle();
    _resetForTests();
  });

  // Registered per-test so each can pin its own config (VI SID + reconcile delay).
  function register(config: AppConfig): void {
    registerVoiceTranscriptJobHandlers({
      config,
      adapter: world.adapter,
      messagesRepo: world.messagesRepo,
      events: world.events,
      logger,
    });
  }

  function seedCall(over: Record<string, unknown> = {}): void {
    world.messages.push({
      conversationId: 'conv-1',
      tsMsgId: CALL_SID,
      type: 'call',
      direction: 'inbound',
      provider_sid: CALL_SID,
      delivery_status: 'delivered',
      masked: false,
      call_outcome: 'missed',
      ...over,
    } as never);
  }

  it('create: happy path creates with customerKey=callSid and enqueues reconcile attempt 1', async () => {
    register(testConfig());
    seedCall();
    await enqueueImmediate(CREATE_VOICE_TRANSCRIPT_JOB, { callSid: CALL_SID, recordingSid: RECORDING_SID });
    await queueAdapter.settle();

    expect(world.viCreates).toEqual([
      { serviceSid: 'GAsvc', recordingSid: RECORDING_SID, customerKey: CALL_SID },
    ]);
    // reconcile enqueued with the ~10min delay (reconcileSeconds=1 -> delaySeconds
    // 1), so it lands in queueAdapter.delayed and does NOT run under settle().
    expect(queueAdapter.delayed).toHaveLength(1);
    const d = queueAdapter.delayed[0]!;
    expect(d.envelope.jobName).toBe(RECONCILE_VOICE_TRANSCRIPT_JOB);
    expect(d.envelope.payload).toEqual({ callSid: CALL_SID, transcriptSid: 'GTfake1', attempt: 1 });
    expect(d.delaySeconds).toBe(1);
  });

  it('create: skips masked / missing / already-transcribed (no VI create)', async () => {
    register(testConfig());
    seedCall({ tsMsgId: 'CAmask', provider_sid: 'CAmask', masked: true });
    seedCall({ tsMsgId: 'CAdone', provider_sid: 'CAdone', transcript: 'already here' });
    await enqueueImmediate(CREATE_VOICE_TRANSCRIPT_JOB, { callSid: 'CAmask', recordingSid: 'RE1' });
    await enqueueImmediate(CREATE_VOICE_TRANSCRIPT_JOB, { callSid: 'CAdone', recordingSid: 'RE2' });
    await enqueueImmediate(CREATE_VOICE_TRANSCRIPT_JOB, { callSid: 'CAmissing', recordingSid: 'RE3' });
    await queueAdapter.settle();
    expect(world.viCreates).toHaveLength(0);
    expect(queueAdapter.delayed).toHaveLength(0);
  });

  it('create: VI service unset -> skips (no VI create)', async () => {
    register(testConfig({ twilioViServiceSid: undefined }));
    seedCall();
    await enqueueImmediate(CREATE_VOICE_TRANSCRIPT_JOB, { callSid: CALL_SID, recordingSid: RECORDING_SID });
    await queueAdapter.settle();
    expect(world.viCreates).toHaveLength(0);
  });

  it('create: adapter failure re-enqueues itself with attempt+1 (delayed, no throw)', async () => {
    register(testConfig()); // reconcileSeconds 1 -> the retry lands in queueAdapter.delayed
    seedCall({ transcript_status: 'pending' });
    world.viCreateError = new Error('twilio down');
    await dispatchJob({
      jobName: CREATE_VOICE_TRANSCRIPT_JOB,
      payload: { callSid: CALL_SID, recordingSid: RECORDING_SID, attempt: 1 },
    });
    expect(world.viCreates).toHaveLength(0);
    expect(queueAdapter.delayed).toHaveLength(1);
    const retry = queueAdapter.delayed[0]!;
    expect(retry.envelope.jobName).toBe(CREATE_VOICE_TRANSCRIPT_JOB);
    expect(retry.envelope.payload).toEqual({ callSid: CALL_SID, recordingSid: RECORDING_SID, attempt: 2 });
    // Not exhausted yet -> the lifecycle stays pending (the retry owns closing it).
    expect(world.messages[0]!.transcript_status).toBe('pending');
  });

  it('create: exhausts CREATE_MAX_ATTEMPTS then stamps transcript_status failed + emits SSE', async () => {
    register(testConfig({ voiceTranscriptReconcileSeconds: 0 })); // immediate retries -> settle drains the chain
    seedCall({ transcript_status: 'pending' });
    world.viCreateError = new Error('twilio down');
    await enqueueImmediate(CREATE_VOICE_TRANSCRIPT_JOB, {
      callSid: CALL_SID,
      recordingSid: RECORDING_SID,
      attempt: 1,
    });
    await queueAdapter.settle();
    expect(world.viCreates).toHaveLength(0);
    expect(queueAdapter.delayed).toHaveLength(0); // no further retries queued
    expect(world.messages[0]!.transcript_status).toBe('failed');
    expect(world.emitted.some((e) => e.event === 'message.persisted')).toBe(true);
    expect(JSON.stringify(capture.lines)).toContain('createVoiceTranscript: exhausted attempts');
  });

  it('create: legacy payload without attempt parses as attempt 1; invalid attempt rejected', () => {
    expect(parseCreateVoiceTranscriptPayload({ callSid: 'CA1', recordingSid: 'RE1' })).toEqual({
      callSid: 'CA1',
      recordingSid: 'RE1',
      attempt: 1,
    });
    expect(() =>
      parseCreateVoiceTranscriptPayload({ callSid: 'CA1', recordingSid: 'RE1', attempt: 0 }),
    ).toThrow();
  });

  it('reconcile: transcript already present -> no adapter fetch (webhook won)', async () => {
    register(testConfig());
    seedCall({ transcript: 'the caller left a message', transcript_status: 'completed' });
    let fetches = 0;
    const realFetch = world.adapter.fetchViTranscript.bind(world.adapter);
    world.adapter.fetchViTranscript = async (sid: string) => {
      fetches += 1;
      return realFetch(sid);
    };
    await enqueueImmediate(RECONCILE_VOICE_TRANSCRIPT_JOB, {
      callSid: CALL_SID,
      transcriptSid: 'GTfake1',
      attempt: 1,
    });
    await queueAdapter.settle();
    expect(fetches).toBe(0);
  });

  it('reconcile: completed -> persists via the shared helper (transcript saved + status completed)', async () => {
    register(testConfig());
    seedCall({ transcript_status: 'pending' });
    world.viTranscripts.set('GTfake1', {
      status: 'completed',
      customerKey: CALL_SID,
      sentences: [{ text: 'hello there', mediaChannel: 1 }],
    });
    await enqueueImmediate(RECONCILE_VOICE_TRANSCRIPT_JOB, {
      callSid: CALL_SID,
      transcriptSid: 'GTfake1',
      attempt: 1,
    });
    await queueAdapter.settle();
    const call = world.messages.find((m) => m.provider_sid === CALL_SID)!;
    expect(call.transcript).toBe('hello there');
    expect(call.transcript_status).toBe('completed');
  });

  it('reconcile: in-progress re-enqueues until attempt 3 then stamps failed', async () => {
    // reconcileSeconds 0 -> every re-enqueue is immediate so settle() drains the
    // whole attempt 1..3 chain (see the D8 note at the top).
    register(testConfig({ voiceTranscriptReconcileSeconds: 0 }));
    seedCall({ transcript_status: 'pending' });
    world.viTranscripts.set('GTfake1', { status: 'in-progress', customerKey: CALL_SID, sentences: [] });
    await enqueueImmediate(RECONCILE_VOICE_TRANSCRIPT_JOB, {
      callSid: CALL_SID,
      transcriptSid: 'GTfake1',
      attempt: 1,
    });
    await queueAdapter.settle();
    const call = world.messages.find((m) => m.provider_sid === CALL_SID)!;
    expect(call.transcript_status).toBe('failed');
    expect(call.transcript).toBeUndefined();
  });

  it('reconcile: VI status failed stamps transcript_status failed immediately', async () => {
    register(testConfig());
    seedCall({ transcript_status: 'pending' });
    world.viTranscripts.set('GTfail', { status: 'failed', customerKey: CALL_SID, sentences: [] });
    await enqueueImmediate(RECONCILE_VOICE_TRANSCRIPT_JOB, {
      callSid: CALL_SID,
      transcriptSid: 'GTfail',
      attempt: 1,
    });
    await queueAdapter.settle();
    const call = world.messages.find((m) => m.provider_sid === CALL_SID)!;
    expect(call.transcript_status).toBe('failed');
  });

  it('never logs the transcript text (PII, doc section 9)', async () => {
    register(testConfig());
    seedCall({ transcript_status: 'pending' });
    const secret = 'super secret voicemail body words';
    world.viTranscripts.set('GTfake1', {
      status: 'completed',
      customerKey: CALL_SID,
      sentences: [{ text: secret, mediaChannel: 1 }],
    });
    await enqueueImmediate(RECONCILE_VOICE_TRANSCRIPT_JOB, {
      callSid: CALL_SID,
      transcriptSid: 'GTfake1',
      attempt: 1,
    });
    await queueAdapter.settle();
    expect(JSON.stringify(capture.lines)).not.toContain(secret);
  });

  it('parsers reject malformed payloads', () => {
    expect(() => parseCreateVoiceTranscriptPayload({})).toThrow();
    expect(() => parseCreateVoiceTranscriptPayload({ callSid: 'x' })).toThrow();
    expect(parseCreateVoiceTranscriptPayload({ callSid: 'x', recordingSid: 'r' })).toEqual({
      callSid: 'x',
      recordingSid: 'r',
      attempt: 1,
    });
    expect(() => parseReconcileVoiceTranscriptPayload({ callSid: 'x', transcriptSid: 't' })).toThrow();
    expect(() =>
      parseReconcileVoiceTranscriptPayload({ callSid: 'x', transcriptSid: 't', attempt: 0 }),
    ).toThrow();
    expect(
      parseReconcileVoiceTranscriptPayload({ callSid: 'x', transcriptSid: 't', attempt: 2 }),
    ).toEqual({ callSid: 'x', transcriptSid: 't', attempt: 2 });
  });
});
