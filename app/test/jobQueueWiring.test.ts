// Shared job-queue wiring (configureJobQueues) - the ONE place that decides which
// OutboundQueueAdapter + SchedulerAdapter a process gets, so the app and worker
// entrypoints cannot drift.
//
// PROD INCIDENT 2026-08-16: this wiring lived inline in index.ts (the app) and was
// simply absent from worker.ts, so EVERY jobs.enqueue() inside a job handler threw
// 'no OutboundQueueAdapter configured'. That silently disabled every worker-side
// continuation and retry path - voice.reconcileTranscript's attempt+1 (a voicemail
// stuck on "Transcribing..." forever) and relay.numberReady's relay.intro hand-off
// were both observed failing in prod. The last test in this file is the guard that
// keeps both entrypoints wired.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetForTests, configureJobsLogger, enqueue } from '../src/jobs/jobs.js';
import { configureJobQueues } from '../src/jobs/queueWiring.js';
import { loadConfig, type AppConfig } from '../src/lib/config.js';
import { createLogger, type Logger } from '../src/lib/logger.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import type { SendMessageCommand } from '@aws-sdk/client-sqs';

function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({ NODE_ENV: 'test', BUSINESS_PHONE_NUMBER: '+15550009999' } as NodeJS.ProcessEnv),
    ...over,
  };
}

/** Records SendMessage inputs instead of touching AWS. */
function fakeSqs(): { sent: Record<string, unknown>[]; client: { send: (c: SendMessageCommand) => Promise<never> } } {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    client: {
      send: async (command: SendMessageCommand) => {
        sent.push(command.input as unknown as Record<string, unknown>);
        return { MessageId: 'm1', $metadata: {} } as never;
      },
    },
  };
}

describe('configureJobQueues (shared job-queue wiring)', () => {
  let capture: LogCapture;
  let logger: Logger;

  beforeEach(() => {
    _resetForTests();
    capture = createLogCapture();
    logger = createLogger({ level: 'info', destination: capture.stream });
    // Keep jobs.enqueue()'s own boot/enqueue lines off the suite's stdout; the
    // "wiring stays silent" assertion below reads `capture` only for THIS logger.
    configureJobsLogger(logger);
  });

  afterEach(() => {
    _resetForTests();
  });

  it('JOBS_QUEUE_URL set -> the SQS adapter is wired and enqueue() reaches the queue', async () => {
    const sqs = fakeSqs();
    const wiring = await configureJobQueues({
      config: testConfig({ jobsQueueUrl: 'https://sqs.test/hc-test-jobs' }),
      logger,
      dispatch: async () => {},
      clients: { sqs: sqs.client },
    });
    expect(wiring.outbound).toBe('sqs');
    // THE REGRESSION: without this wiring the next line throws
    // 'no OutboundQueueAdapter configured'.
    await enqueue('voice.reconcileTranscript', { callSid: 'CA1' });
    expect(sqs.sent).toHaveLength(1);
    expect(sqs.sent[0]!.QueueUrl).toBe('https://sqs.test/hc-test-jobs');
  });

  it('JOBS_QUEUE_URL unset -> the in-process adapter is wired and enqueue() dispatches locally', async () => {
    const dispatched: unknown[] = [];
    const wiring = await configureJobQueues({
      config: testConfig({ jobsQueueUrl: undefined }),
      logger,
      dispatch: async (raw) => {
        dispatched.push(raw);
      },
    });
    expect(wiring.outbound).toBe('in-process');
    await enqueue('voice.reconcileTranscript', { callSid: 'CA1' });
    // The in-process adapter defers immediate dispatches; drain via the notice-free
    // public path (a microtask turn is enough for the delay-0 branch).
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatched).toHaveLength(1);
  });

  it('scheduler ARNs present -> EventBridge; absent -> in-memory (both leave enqueue usable)', async () => {
    const withArns = await configureJobQueues({
      config: testConfig({
        jobsQueueUrl: 'https://sqs.test/q',
        schedulerTargetArn: 'arn:aws:sqs:us-east-1:1:q',
        schedulerRoleArn: 'arn:aws:iam::1:role/r',
      }),
      logger,
      dispatch: async () => {},
      clients: { sqs: fakeSqs().client },
    });
    expect(withArns.scheduler).toBe('eventbridge');

    _resetForTests();
    const withoutArns = await configureJobQueues({
      config: testConfig({ jobsQueueUrl: 'https://sqs.test/q', schedulerTargetArn: undefined, schedulerRoleArn: undefined }),
      logger,
      dispatch: async () => {},
      clients: { sqs: fakeSqs().client },
    });
    expect(withoutArns.scheduler).toBe('in-memory');
  });

  it('returns boot notices for the caller to log in ITS OWN correlation context (never orphan logs)', async () => {
    const wiring = await configureJobQueues({
      config: testConfig({ jobsQueueUrl: undefined }),
      logger,
      dispatch: async () => {},
    });
    // Local dev warns on BOTH halves: no scheduler ARNs, no jobs queue.
    expect(wiring.notices.filter((n) => n.level === 'warn')).toHaveLength(2);
    expect(JSON.stringify(wiring.notices)).toContain('JOBS_QUEUE_URL unset');
    // The wiring itself stays silent - the entrypoint owns the logging.
    expect(capture.lines).toHaveLength(0);
  });

  // GUARD (the actual 2026-08-16 regression): one entrypoint was wired and the
  // other was not. Any future entrypoint that dispatches jobs must call the shared
  // wiring - a source-level assertion because these modules self-execute on import
  // (OTel, config, DynamoDB) and cannot be imported into a unit test.
  it('BOTH process entrypoints call configureJobQueues', () => {
    for (const entry of ['../src/index.ts', '../src/worker.ts']) {
      const source = readFileSync(fileURLToPath(new URL(entry, import.meta.url)), 'utf8');
      expect(source, `${entry} must wire the job queues`).toContain('configureJobQueues');
    }
  });
});
