// call.missedAutoText (M1.9b) — the milestone golden tests for the zero-tap
// missed-call auto-text job in ISOLATION: settings-gated send through the
// throttled, opt-out-gated send wrapper, and the CallSid idempotency (one
// auto-text per missed call, EVER — even across re-enqueues with different
// jobIds). Driven through the real jobs envelope machinery (enqueueImmediate →
// InProcessOutboundQueue → dispatchJob) so the marker idempotency is exercised
// for real. PII: no caller phone/name in any log line.
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
  MISSED_CALL_AUTOTEXT_JOB,
  parseMissedCallAutoTextPayload,
  registerMissedCallAutoTextJobHandler,
} from '../src/jobs/missedCallAutoText.js';
import { TokenBucket } from '../src/lib/tokenBucket.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

const CALLER = '+15550177777';
const CONV_ID = 'conv-caller-1';
const CALL_SID = 'CAmissed0001';

function seedCallerConversation(world: FakeWorld, overrides: Partial<ConversationItem> = {}): void {
  const now = new Date().toISOString();
  world.conversations.set(CONV_ID, {
    conversationId: CONV_ID,
    participant_phone: CALLER,
    status: 'open',
    last_activity_at: now,
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: now,
    ...overrides,
  });
}

describe('call.missedAutoText (M1.9b)', () => {
  let world: FakeWorld;
  let capture: LogCapture;
  // Immediate dispatch now DEFERS (SQS semantics) - settle() drains the run.
  let queueAdapter: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    seedCallerConversation(world);
    registerMissedCallAutoTextJobHandler({
      settingsRepo: world.settingsRepo,
      messagesRepo: world.messagesRepo,
      sendMessageService: createSendMessageService({
        config: loadConfig({ NODE_ENV: 'test', OUR_PHONE_NUMBERS: '+15550009999' } as NodeJS.ProcessEnv),
        logger,
        adapter: world.adapter,
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        contactsRepo: world.contactsRepo,
        auditRepo: world.auditRepo,
        events: world.events,
      }),
      tokenBucket: new TokenBucket({ capacity: 5, refillPerSec: 5 }),
      logger,
    });
    queueAdapter = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(queueAdapter);
  });

  afterEach(async () => {
    await queueAdapter.settle();
    _resetForTests();
  });

  it('enabled → sends the auto-text into the caller conversation (automated)', async () => {
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();

    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]!.to).toBe(CALLER);
    expect(world.sent[0]!.body).toBe(world.settings.missedCallAutoText);
    // Persisted outbound message authored by the team, automated.
    const msg = world.messages.find((m) => m.conversationId === CONV_ID && m.direction === 'outbound');
    expect(msg?.author).toBe('teammate');
  });

  it('disabled in settings → marks done + skips (no send)', async () => {
    world.settings.missedCallAutoTextEnabled = false;
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(world.sent).toHaveLength(0);
  });

  it('caller opted out → SendRefusedError → skipped, NOT retried', async () => {
    seedCallerConversation(world, { sms_opt_out: true });
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(world.sent).toHaveLength(0);
  });

  it('GUARDRAIL: idempotent per CallSid — re-enqueue (fresh jobId) never double-sends', async () => {
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    // A redelivered status callback enqueues a SECOND job with a different
    // jobId; the CallSid marker (not the jobId) is the dedupe key.
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(world.sent).toHaveLength(1);
    // The CallSid marker was claimed exactly once.
    expect(world.jobExecutionMarkers.has(CALL_SID)).toBe(true);
  });

  it('never logs the caller phone (PII, doc §9)', async () => {
    await enqueueImmediate(MISSED_CALL_AUTOTEXT_JOB, { callSid: CALL_SID, conversationId: CONV_ID });
    await queueAdapter.settle();
    expect(JSON.stringify(capture.lines)).not.toContain(CALLER);
  });

  it('parseMissedCallAutoTextPayload rejects a malformed payload', () => {
    expect(() => parseMissedCallAutoTextPayload({})).toThrow();
    expect(() => parseMissedCallAutoTextPayload({ callSid: 'x' })).toThrow();
    expect(() => parseMissedCallAutoTextPayload({ conversationId: 'c' })).toThrow();
    expect(parseMissedCallAutoTextPayload({ callSid: 'x', conversationId: 'c' })).toEqual({
      callSid: 'x',
      conversationId: 'c',
    });
  });
});
