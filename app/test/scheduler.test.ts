// Acceptance test 6 (M0.2) + M1.2 SQS-target verification:
// EventBridgeSchedulerAdapter unit tests with a fake injected client —
// asserts ActionAfterCompletion: 'DELETE', the JSON envelope as Target.Input
// (for SQS targets the Input becomes the message BODY verbatim), the
// queue/role ARNs, and the near-term clamp (Scheduler rejects at() times in
// the past, so "now"/past runAts move to now + MIN_SCHEDULE_LEAD_MS). No AWS
// calls.
import type {
  CreateScheduleCommand,
  CreateScheduleCommandOutput,
} from '@aws-sdk/client-scheduler';
import type {
  SendMessageCommand,
  SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EventBridgeSchedulerAdapter,
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
  MIN_SCHEDULE_LEAD_MS,
  SQS_HARD_MAX_DELAY_SECONDS,
  SqsOutboundQueueAdapter,
  type OutboundSqsClientLike,
  type SchedulerClientLike,
} from '../src/adapters/scheduler.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import type { JobEnvelope } from '../src/jobs/types.js';

const QUEUE_ARN = 'arn:aws:sqs:us-east-1:000000000000:hc-dev-jobs';
const ROLE_ARN = 'arn:aws:iam::000000000000:role/hc-dev-scheduler';

function makeEnvelope(): JobEnvelope {
  return {
    v: 1,
    jobId: '11111111-2222-3333-4444-555555555555',
    jobName: 'demo.echo',
    payload: { hello: 'world' },
    correlationContext: { requestId: 'req-1', tenantId: 't1' },
    traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    hopCount: 1,
    enqueuedAt: '2026-06-11T00:00:00.000Z',
  };
}

function makeFakeClient(): { client: SchedulerClientLike; sent: CreateScheduleCommand[] } {
  const sent: CreateScheduleCommand[] = [];
  const client: SchedulerClientLike = {
    send: async (command) => {
      sent.push(command);
      return { $metadata: {} } as CreateScheduleCommandOutput;
    },
  };
  return { client, sent };
}

describe('EventBridgeSchedulerAdapter', () => {
  // Fake clock: the adapter clamps against Date.now(), so wall-clock tests
  // would go stale the moment the hardcoded runAt slips into the past.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T15:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends CreateScheduleCommand with ActionAfterCompletion DELETE and the JSON envelope as target input', async () => {
    const { client, sent } = makeFakeClient();
    const adapter = new EventBridgeSchedulerAdapter({
      client,
      targetArn: QUEUE_ARN,
      roleArn: ROLE_ARN,
    });

    const envelope = makeEnvelope();
    const runAt = new Date('2026-06-12T15:30:00.000Z'); // 30 min out — no clamp
    await adapter.scheduleOnce(envelope, { runAt });

    expect(sent).toHaveLength(1);
    const input = sent[0]!.input;
    // One-off schedules must clean up after themselves.
    expect(input.ActionAfterCompletion).toBe('DELETE');
    expect(input.ScheduleExpression).toBe('at(2026-06-12T15:30:00)');
    expect(input.FlexibleTimeWindow).toEqual({ Mode: 'OFF' });
    expect(input.Name).toMatch(/^hc-demo\.echo-11111111/);
    // SQS target: the queue ARN + the role Scheduler assumes to SendMessage;
    // Input becomes the SQS message body verbatim — the worker's wire format.
    expect(input.Target?.Arn).toBe(QUEUE_ARN);
    expect(input.Target?.RoleArn).toBe(ROLE_ARN);
    expect(JSON.parse(input.Target?.Input ?? '')).toEqual(envelope);
  });

  it('clamps an immediate enqueue (no runAt) to now + MIN_SCHEDULE_LEAD_MS — Scheduler rejects past at() times', async () => {
    const { client, sent } = makeFakeClient();
    const adapter = new EventBridgeSchedulerAdapter({
      client,
      targetArn: QUEUE_ARN,
      roleArn: ROLE_ARN,
    });

    await adapter.scheduleOnce(makeEnvelope());

    expect(MIN_SCHEDULE_LEAD_MS).toBe(60_000);
    expect(sent[0]!.input.ScheduleExpression).toBe('at(2026-06-12T15:01:00)');
  });

  it('clamps a runAt in the past the same way', async () => {
    const { client, sent } = makeFakeClient();
    const adapter = new EventBridgeSchedulerAdapter({
      client,
      targetArn: QUEUE_ARN,
      roleArn: ROLE_ARN,
    });

    await adapter.scheduleOnce(makeEnvelope(), { runAt: new Date('2026-06-12T14:00:00.000Z') });

    expect(sent[0]!.input.ScheduleExpression).toBe('at(2026-06-12T15:01:00)');
  });

  it('never truncates the jobId tail of the schedule name — a long jobName loses ITS characters instead', async () => {
    const { client, sent } = makeFakeClient();
    const adapter = new EventBridgeSchedulerAdapter({
      client,
      targetArn: QUEUE_ARN,
      roleArn: ROLE_ARN,
    });

    const envelope: JobEnvelope = {
      ...makeEnvelope(),
      jobName: 'messaging.aVeryLongJobNameThatWouldPushTheScheduleNamePastSixtyFourCharacters',
    };
    await adapter.scheduleOnce(envelope, { runAt: new Date('2026-06-12T15:30:00.000Z') });

    const name = sent[0]!.input.Name!;
    expect(name.length).toBeLessThanOrEqual(64);
    // The UUID is the UNIQUE part — slicing it off would collide schedules
    // of long-named jobs. It must survive verbatim at the tail.
    expect(name.endsWith(`-${envelope.jobId}`)).toBe(true);
    expect(name.startsWith('hc-messaging.aVeryLongJobName')).toBe(false); // name segment truncated to fit
    expect(name.startsWith('hc-messaging.')).toBe(true);
  });

  it('passes a 60s-backoff retry (runAt exactly now + 60s) through unclamped', async () => {
    const { client, sent } = makeFakeClient();
    const adapter = new EventBridgeSchedulerAdapter({
      client,
      targetArn: QUEUE_ARN,
      roleArn: ROLE_ARN,
    });

    // retrySend attempt 1: new Date(Date.now() + 60_000).
    await adapter.scheduleOnce(makeEnvelope(), { runAt: new Date(Date.now() + 60_000) });

    expect(sent[0]!.input.ScheduleExpression).toBe('at(2026-06-12T15:01:00)');
  });
});

describe('InMemorySchedulerAdapter', () => {
  it('records envelopes and drains them through a dispatch fn (JSON wire round-trip)', async () => {
    const adapter = new InMemorySchedulerAdapter();
    const envelope = makeEnvelope();
    await adapter.scheduleOnce(envelope);

    const delivered: unknown[] = [];
    await adapter.deliverAll(async (rawEvent) => {
      delivered.push(rawEvent);
    });

    expect(delivered).toEqual([envelope]); // structurally equal
    expect(delivered[0]).not.toBe(envelope); // but a wire copy, not the same ref
    expect(adapter.scheduled).toHaveLength(0);
  });
});

describe('SqsOutboundQueueAdapter (delay refactor)', () => {
  function makeFakeSqs(): { client: OutboundSqsClientLike; sent: SendMessageCommand[] } {
    const sent: SendMessageCommand[] = [];
    const client: OutboundSqsClientLike = {
      send: async (command) => {
        sent.push(command);
        return { $metadata: {} } as SendMessageCommandOutput;
      },
    };
    return { client, sent };
  }

  const logger = createLogger({ destination: createLogCapture().stream });

  it('SendMessage with DelaySeconds 0 for an immediate enqueue + the JSON envelope as body', async () => {
    const { client, sent } = makeFakeSqs();
    const adapter = new SqsOutboundQueueAdapter({ client, queueUrl: 'q-url', logger });

    const envelope = makeEnvelope();
    await adapter.enqueue(envelope);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.QueueUrl).toBe('q-url');
    expect(sent[0]!.input.DelaySeconds).toBe(0);
    expect(JSON.parse(sent[0]!.input.MessageBody ?? '')).toEqual(envelope);
  });

  it('passes an exact DelaySeconds through (e.g. 5/30/240 backoff — no 60s floor)', async () => {
    const { client, sent } = makeFakeSqs();
    const adapter = new SqsOutboundQueueAdapter({ client, queueUrl: 'q-url', logger });

    await adapter.enqueue(makeEnvelope(), { delaySeconds: 5 });
    await adapter.enqueue(makeEnvelope(), { delaySeconds: 240 });

    expect(sent.map((c) => c.input.DelaySeconds)).toEqual([5, 240]);
  });

  it('defensively clamps a DelaySeconds above the SQS hard cap (900) — never a rejected Send', async () => {
    const { client, sent } = makeFakeSqs();
    const adapter = new SqsOutboundQueueAdapter({ client, queueUrl: 'q-url', logger });

    await adapter.enqueue(makeEnvelope(), { delaySeconds: 5_000 });

    expect(sent[0]!.input.DelaySeconds).toBe(SQS_HARD_MAX_DELAY_SECONDS); // 900
  });
});

describe('InProcessOutboundQueueAdapter (delay refactor)', () => {
  it('IMMEDIATE (delay 0): dispatches in-process now, through the token bucket', async () => {
    const dispatched: unknown[] = [];
    const acquired: number[] = [];
    const adapter = new InProcessOutboundQueueAdapter({
      dispatch: async (e) => {
        dispatched.push(e);
      },
      tokenBucket: { acquire: async (n: number) => acquired.push(n) } as never,
    });

    const envelope = makeEnvelope();
    await adapter.enqueue(envelope); // delay 0

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual(envelope); // structurally equal (wire copy)
    expect(dispatched[0]).not.toBe(envelope);
    expect(acquired).toEqual([1]); // one token acquired before dispatch
    expect(adapter.delayed).toHaveLength(0);
  });

  it('DELAYED (delay > 0): records for deterministic draining, does NOT dispatch or sleep, no token spent', async () => {
    const dispatched: unknown[] = [];
    const acquired: number[] = [];
    const adapter = new InProcessOutboundQueueAdapter({
      dispatch: async (e) => {
        dispatched.push(e);
      },
      tokenBucket: { acquire: async (n: number) => acquired.push(n) } as never,
      // No scheduleTimer (tests omit it) → delayed jobs only accumulate.
    });

    const envelope = makeEnvelope();
    await adapter.enqueue(envelope, { delaySeconds: 20 });

    expect(dispatched).toHaveLength(0); // not dispatched yet
    expect(acquired).toHaveLength(0); // the producer doesn't throttle delayed jobs
    expect(adapter.delayed).toHaveLength(1);
    expect(adapter.delayed[0]!.delaySeconds).toBe(20);

    // deliverDelayed drains synchronously (no real sleep) through the dispatch fn.
    const drained: unknown[] = [];
    await adapter.deliverDelayed(async (e) => {
      drained.push(e);
    });
    expect(drained).toEqual([envelope]);
    expect(adapter.delayed).toHaveLength(0);
  });

  it('LOCAL DEV: an injected scheduleTimer fires the delayed dispatch after the delay', async () => {
    const dispatched: unknown[] = [];
    let scheduledDelay: number | undefined;
    let fire: (() => void) | undefined;
    const adapter = new InProcessOutboundQueueAdapter({
      dispatch: async (e) => {
        dispatched.push(e);
      },
      scheduleTimer: (run, delaySeconds) => {
        scheduledDelay = delaySeconds;
        fire = run; // capture instead of using a real timer
      },
    });

    await adapter.enqueue(makeEnvelope(), { delaySeconds: 10 });
    expect(scheduledDelay).toBe(10);
    expect(dispatched).toHaveLength(0); // not yet — timer hasn't fired

    fire!(); // simulate the timer firing
    await Promise.resolve(); // let the void-dispatch microtask settle
    expect(dispatched).toHaveLength(1);
  });
});
