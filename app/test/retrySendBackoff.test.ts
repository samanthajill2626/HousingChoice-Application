// retry-send-window D13: the one-to-one retry backoff lane seam
// (E2E_SEND_RETRY_BACKOFF_MS) and the explicit-runAt producer. Mirrors the
// relay seam's tests ('relay.retryLeg backoff seam', relayRetryLeg.test.ts):
// the override is honored only in the one topology where a lane exists
// (JOBS_QUEUE_URL unset) and only when it parses to a positive integer, so a
// stray value in a deployed environment can never reshape a real retry.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsClock,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
} from '../src/jobs/jobs.js';
import {
  enqueueSendRetry,
  resolveSendRetryBackoffMs,
  RETRY_SEND_JOB,
} from '../src/jobs/retrySend.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  makeWebhookHarness,
  signedTwilioPost,
  statusParams,
  TENANT_PHONE,
} from './helpers/twilioWebhookHarness.js';

const ENV_KEY = 'E2E_SEND_RETRY_BACKOFF_MS';
/** The TOPOLOGY discriminator: set in every deployed environment, unset in the
 *  hermetic lane and local dev (the relay seam's guard, relayRetryLeg.ts). */
const QUEUE_KEY = 'JOBS_QUEUE_URL';
const PROD_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/hc-prod-jobs';

describe('messaging.retrySend backoff seam (E2E_SEND_RETRY_BACKOFF_MS, retry-send-window D13)', () => {
  let outbound: InProcessOutboundQueueAdapter;
  let savedOverride: string | undefined;
  let savedQueueUrl: string | undefined;

  beforeEach(() => {
    _resetForTests();
    savedOverride = process.env[ENV_KEY];
    savedQueueUrl = process.env[QUEUE_KEY];
    delete process.env[ENV_KEY];
    delete process.env[QUEUE_KEY];
    const logger = createLogger({ destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    outbound = new InProcessOutboundQueueAdapter({ dispatch: async () => {}, logger });
    configureOutboundQueue(outbound);
  });

  afterEach(() => {
    if (savedOverride === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedOverride;
    if (savedQueueUrl === undefined) delete process.env[QUEUE_KEY];
    else process.env[QUEUE_KEY] = savedQueueUrl;
    _resetForTests();
  });

  const backoffs = (): number[] => [1, 2, 3].map((attempt) => resolveSendRetryBackoffMs(attempt));

  it('is retryBackoffMs (60/120/240s) with the override ABSENT', () => {
    expect(backoffs()).toEqual([60_000, 120_000, 240_000]);
  });

  it.each(['abc', '0', '-5', '', '  '])('ignores the malformed value %j', (value) => {
    process.env[ENV_KEY] = value;
    expect(backoffs()).toEqual([60_000, 120_000, 240_000]);
  });

  it('returns the override for EVERY attempt on a valid positive value with JOBS_QUEUE_URL unset', () => {
    process.env[ENV_KEY] = '10000';
    expect(backoffs()).toEqual([10_000, 10_000, 10_000]);
  });

  it('IGNORES the override in production topology (JOBS_QUEUE_URL set)', () => {
    process.env[ENV_KEY] = '10000';
    process.env[QUEUE_KEY] = PROD_QUEUE_URL;
    expect(backoffs()).toEqual([60_000, 120_000, 240_000]);
  });

  // An EMPTY queue URL is not a deployed topology: shells and `.env` files
  // routinely carry an unset value as the empty string.
  it('treats an EMPTY JOBS_QUEUE_URL as unset', () => {
    process.env[ENV_KEY] = '10000';
    process.env[QUEUE_KEY] = '';
    expect(backoffs()).toEqual([10_000, 10_000, 10_000]);
  });

  it('enqueueSendRetry schedules at EXACTLY the runAt it is given - the attempt no longer picks the delay (D7)', async () => {
    const now = Date.now();
    configureJobsClock(() => now);
    await enqueueSendRetry(
      { providerSid: 'SMseam0001', conversationId: 'conv-seam', attempt: 3 },
      new Date(now + 37_000),
    );
    expect(outbound.delayed).toHaveLength(1);
    const { envelope, delaySeconds } = outbound.delayed[0]!;
    expect(envelope.jobName).toBe(RETRY_SEND_JOB);
    expect(envelope.payload).toEqual({ providerSid: 'SMseam0001', conversationId: 'conv-seam', attempt: 3 });
    // 37s, not attempt 3's 240s: the caller's runAt - the instant it also
    // writes as retry_due_at - IS the schedule.
    expect(delaySeconds).toBe(37);
  });

  it('the status webhook schedules a 30003 retry on the lane override (the seam reaches the arm)', async () => {
    process.env[ENV_KEY] = '10000';
    const { app, world } = makeWebhookHarness();
    const conversation = await world.conversationsRepo.createOrGetByParticipantPhone(
      TENANT_PHONE,
      'tenant_1to1',
    );
    // Sent just now, so any send-window check applied to this chain is open.
    await world.messagesRepo.append({
      conversationId: conversation.conversationId,
      providerSid: 'SMseam0002',
      providerTs: new Date().toISOString(),
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'lane body',
      deliveryStatus: 'queued',
    });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/status',
      statusParams({ MessageSid: 'SMseam0002', MessageStatus: 'undelivered', ErrorCode: '30003' }),
    );

    expect(res.status).toBe(200);
    expect(outbound.delayed).toHaveLength(1);
    expect(outbound.delayed[0]!.envelope.jobName).toBe(RETRY_SEND_JOB);
    // The lane's 10s, not attempt 1's 60s.
    expect(outbound.delayed[0]!.delaySeconds).toBe(10);
  });
});
