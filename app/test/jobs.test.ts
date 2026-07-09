// Acceptance test 1 (M0.2): correlation context survives a job round-trip
// through the enqueue -> transport -> dispatch envelope path.
//
// Delay refactor: with no runAt, enqueue() routes through the SQS path
// (OutboundQueueAdapter). In tests the InProcess adapter dispatches immediate
// jobs in-process and records delayed ones for assertions. Delay ROUTING is
// covered by its own describe block below (SQS DelaySeconds vs EventBridge).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  defineJobHandler,
  dispatchJob,
  enqueue,
  enqueueImmediate,
  JOBS_SQS_MAX_DELAY_SECONDS,
} from '../src/jobs/jobs.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  getContext,
  newRequestId,
  runWithContext,
  type CorrelationContext,
} from '../src/lib/context.js';

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

describe('jobs: context survives a job round-trip', () => {
  let outbound: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
    // Scheduler is wired for the long-horizon branch (used by routing tests).
    configureScheduler(new InMemorySchedulerAdapter());
    // Keep test output clean: route the gates' logs to an in-memory capture.
    configureJobsLogger(createLogger({ level: 'info', destination: createLogCapture().stream }));
  });

  afterEach(() => {
    _resetForTests();
  });

  it('handler observes the enqueuer correlation context, a fresh jobRunId, hopCount 1, and a valid traceparent', async () => {
    const requestId = newRequestId();
    let observed: CorrelationContext | undefined;
    let observedPayload: unknown;

    defineJobHandler('demo.echo', (payload) => {
      observed = getContext();
      observedPayload = payload;
    });

    // No runAt → delaySeconds 0 → the in-process adapter dispatches immediately.
    await runWithContext({ requestId, conversationId: 'c1', tenantId: 't1' }, () =>
      enqueue('demo.echo', { hello: 'world' }),
    );
    await outbound.settle(); // immediate dispatch is deferred - drain it

    expect(observedPayload).toEqual({ hello: 'world' });
    expect(observed).toBeDefined();
    expect(observed?.conversationId).toBe('c1');
    expect(observed?.tenantId).toBe('t1');
    expect(observed?.requestId).toBe(requestId);
    expect(observed?.jobRunId).toBeDefined();
    expect(observed?.jobRunId).not.toBe(requestId);
    expect(observed?.hopCount).toBe(1);
    expect(observed?.traceparent).toMatch(TRACEPARENT_RE);
  });

  it('enqueue from inside a handler yields hopCount 2', async () => {
    const hops: number[] = [];

    defineJobHandler('demo.chain', async () => {
      await enqueue('demo.echo', {});
    });
    defineJobHandler('demo.echo', () => {
      hops.push(getContext()?.hopCount ?? -1);
    });

    // demo.chain dispatches in-process; its handler enqueues demo.echo, which
    // also dispatches in-process — both via the immediate (delay 0) path.
    await runWithContext({ requestId: newRequestId(), conversationId: 'c1' }, () =>
      enqueue('demo.chain', {}),
    );
    // Both dispatches are deferred; settle() also drains the nested demo.echo
    // enqueued from inside the demo.chain handler.
    await outbound.settle();

    expect(hops).toEqual([2]);
  });

  it('throws when hopCount would exceed 10 (runaway-loop guard)', async () => {
    await runWithContext({ requestId: newRequestId(), hopCount: 10 }, async () => {
      await expect(enqueue('demo.echo', {})).rejects.toThrow(/hopCount 11 exceeds/);
    });
  });

  it('propagates the enqueuer traceparent into the handler context', async () => {
    const traceparent = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
    let observed: string | undefined;

    defineJobHandler('demo.echo', () => {
      observed = getContext()?.traceparent;
    });

    await runWithContext({ requestId: newRequestId(), traceparent }, () =>
      enqueue('demo.echo', {}),
    );
    await outbound.settle(); // immediate dispatch is deferred - drain it

    expect(observed).toBe(traceparent);
  });

  it('rejects undispatchable events: no jobName, not an object, unknown job names', async () => {
    defineJobHandler('demo.echo', () => undefined);

    await expect(dispatchJob({ not: 'an envelope' })).rejects.toThrow(/missing jobName/);
    await expect(dispatchJob(null)).rejects.toThrow(/not an object/);

    // Capture a real envelope off the wire (the in-process adapter JSON
    // round-trips it before dispatch), then tamper the jobName and re-dispatch.
    let captured: unknown;
    defineJobHandler('demo.capture', (payload) => {
      captured = { jobName: 'demo.capture', payload, ...(getContext() ?? {}) };
    });
    await runWithContext({ requestId: newRequestId() }, () => enqueue('demo.capture', { a: 1 }));
    await outbound.settle(); // immediate dispatch is deferred - drain it
    expect(captured).toBeDefined();
    const tampered = { jobName: 'demo.unknown', payload: { a: 1 } };
    await expect(dispatchJob(JSON.parse(JSON.stringify(tampered)))).rejects.toThrow(
      /no handler registered/,
    );
  });

  describe('envelope-less payloads (§9 synthesize-and-run)', () => {
    it('runs a dispatchable bare payload under a synthesized context and WARNs', async () => {
      const capture = createLogCapture();
      configureJobsLogger(createLogger({ level: 'info', destination: capture.stream }));
      let observed: CorrelationContext | undefined;
      let observedPayload: unknown;
      defineJobHandler('demo.echo', (payload) => {
        observed = getContext();
        observedPayload = payload;
      });

      // Resolvable jobName + payload object, NO correlation fields at all.
      await dispatchJob({ jobName: 'demo.echo', payload: { hello: 'bare' } });

      expect(observedPayload).toEqual({ hello: 'bare' });
      expect(observed?.originType).toBe('synthesized');
      expect(observed?.jobRunId).toBeDefined();
      expect(observed?.jobId).toBeDefined(); // fresh — bare payloads carry none
      expect(observed?.traceparent).toMatch(TRACEPARENT_RE);
      const warn = capture
        .atLevel(40)
        .find((l) => String(l['msg']).includes('envelope-less payload — context synthesized'));
      expect(warn).toBeDefined();
      expect(typeof warn?.['correlationId']).toBe('string'); // never an orphan
    });

    it('synthesizes when correlation fields are INVALID (not just missing)', async () => {
      configureJobsLogger(createLogger({ level: 'info', destination: createLogCapture().stream }));
      let ran = false;
      defineJobHandler('demo.echo', () => {
        ran = true;
      });

      await dispatchJob({
        jobName: 'demo.echo',
        payload: {},
        correlationContext: 'not-an-object',
        traceparent: 42,
        enqueuedAt: null,
      });
      expect(ran).toBe(true);
    });

    it('still rejects a bare payload that is not an object (undispatchable)', async () => {
      defineJobHandler('demo.echo', () => undefined);
      await expect(dispatchJob({ jobName: 'demo.echo', payload: 'just a string' })).rejects.toThrow(
        /payload is not an object/,
      );
    });
  });
});

describe('jobs.enqueue: delay routing (SQS DelaySeconds vs EventBridge)', () => {
  // A FIXED clock so runAt -> delaySeconds is exact and deterministic.
  const NOW = new Date('2026-06-12T15:00:00.000Z').getTime();
  let outbound: InProcessOutboundQueueAdapter;
  let scheduler: InMemorySchedulerAdapter;

  beforeEach(() => {
    _resetForTests();
    configureJobsClock(() => NOW);
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    scheduler = new InMemorySchedulerAdapter();
    configureOutboundQueue(outbound);
    configureScheduler(scheduler);
    configureJobsLogger(createLogger({ level: 'info', destination: createLogCapture().stream }));
    // A no-op handler so dispatched immediate jobs don't blow up.
    defineJobHandler('demo.job', () => undefined);
  });

  afterEach(() => {
    _resetForTests();
  });

  it('the SQS DelaySeconds cap is the conservative 720s (12min), under SQS hard 900', async () => {
    expect(JOBS_SQS_MAX_DELAY_SECONDS).toBe(720);
  });

  it('no runAt → SQS SendMessage with DelaySeconds 0 (immediate), NOT EventBridge', async () => {
    let dispatched = false;
    _resetForTests();
    configureJobsClock(() => NOW);
    const adapter = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(adapter);
    configureScheduler(scheduler);
    configureJobsLogger(createLogger({ level: 'info', destination: createLogCapture().stream }));
    defineJobHandler('demo.job', () => {
      dispatched = true;
    });

    await enqueue('demo.job', { x: 1 });
    await adapter.settle(); // delay 0 defers the dispatch - drain it

    // delay 0 takes the immediate in-process path; nothing recorded as delayed,
    // nothing handed to EventBridge.
    expect(dispatched).toBe(true);
    expect(scheduler.scheduled).toHaveLength(0);
  });

  it('runAt +30s → SQS DelaySeconds 30 (exact, not EventBridge, not clamped to 60)', async () => {
    await enqueue('demo.job', { x: 1 }, { runAt: new Date(NOW + 30_000) });

    expect(scheduler.scheduled).toHaveLength(0);
    expect(outbound.delayed).toHaveLength(1);
    expect(outbound.delayed[0]!.delaySeconds).toBe(30);
  });

  it('runAt +240s → SQS DelaySeconds 240 (exact, not EventBridge)', async () => {
    await enqueue('demo.job', { x: 1 }, { runAt: new Date(NOW + 240_000) });

    expect(scheduler.scheduled).toHaveLength(0);
    expect(outbound.delayed).toHaveLength(1);
    expect(outbound.delayed[0]!.delaySeconds).toBe(240);
  });

  it('runAt at exactly the cap (720s) → still the SQS path', async () => {
    await enqueue('demo.job', { x: 1 }, { runAt: new Date(NOW + 720_000) });

    expect(scheduler.scheduled).toHaveLength(0);
    expect(outbound.delayed).toHaveLength(1);
    expect(outbound.delayed[0]!.delaySeconds).toBe(720);
  });

  it('runAt +13min (>720s) → EventBridge scheduleOnce (long-horizon branch), NOT SQS', async () => {
    const runAt = new Date(NOW + 13 * 60_000); // 780s > 720
    await enqueue('demo.job', { x: 1 }, { runAt });

    expect(outbound.delayed).toHaveLength(0);
    expect(scheduler.scheduled).toHaveLength(1);
    expect(scheduler.scheduled[0]!.runAt).toEqual(runAt);
    expect(scheduler.scheduled[0]!.envelope.jobName).toBe('demo.job');
  });

  it('a past runAt → delaySeconds floored at 0 → immediate SQS path', async () => {
    let dispatched = false;
    _resetForTests();
    configureJobsClock(() => NOW);
    const adapter = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(adapter);
    configureScheduler(scheduler);
    configureJobsLogger(createLogger({ level: 'info', destination: createLogCapture().stream }));
    defineJobHandler('demo.job', () => {
      dispatched = true;
    });

    await enqueue('demo.job', { x: 1 }, { runAt: new Date(NOW - 5_000) });
    await adapter.settle(); // floored-to-0 delay defers the dispatch - drain it

    expect(dispatched).toBe(true);
    expect(scheduler.scheduled).toHaveLength(0);
  });

  it('enqueueImmediate is enqueue with no runAt → immediate SQS path (delay 0)', async () => {
    let dispatched = false;
    _resetForTests();
    const adapter = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(adapter);
    configureScheduler(scheduler);
    configureJobsLogger(createLogger({ level: 'info', destination: createLogCapture().stream }));
    defineJobHandler('demo.job', () => {
      dispatched = true;
    });

    await enqueueImmediate('demo.job', { x: 1 });
    await adapter.settle(); // enqueueImmediate defers the dispatch - drain it

    expect(dispatched).toBe(true);
    expect(scheduler.scheduled).toHaveLength(0);
  });

  it('the SQS adapter sends DelaySeconds on the SendMessage command (injected fake client)', async () => {
    // Drive the real SqsOutboundQueueAdapter with a fake SQS client to assert
    // the wire shape (DelaySeconds present on the command input).
    const { SqsOutboundQueueAdapter } = await import('../src/adapters/scheduler.js');
    const sent: { DelaySeconds?: number; MessageBody?: string }[] = [];
    const fakeClient = {
      send: async (command: { input: { DelaySeconds?: number; MessageBody?: string } }) => {
        sent.push(command.input);
        return { $metadata: {} } as never;
      },
    };
    _resetForTests();
    configureJobsClock(() => NOW);
    configureScheduler(scheduler);
    configureOutboundQueue(
      new SqsOutboundQueueAdapter({
        client: fakeClient as never,
        queueUrl: 'https://sqs.example/hc-dev-jobs',
        logger: createLogger({ level: 'info', destination: createLogCapture().stream }),
      }),
    );
    configureJobsLogger(createLogger({ level: 'info', destination: createLogCapture().stream }));
    defineJobHandler('demo.job', () => undefined);

    await enqueue('demo.job', { x: 1 }, { runAt: new Date(NOW + 45_000) });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.DelaySeconds).toBe(45);
    expect(JSON.parse(sent[0]!.MessageBody ?? '{}').jobName).toBe('demo.job');
  });

  it('uses the injected clock (vi fake timers not required)', async () => {
    // Sanity: the routing math reads the injected clock, not Date.now().
    vi.useRealTimers();
    await enqueue('demo.job', { x: 1 }, { runAt: new Date(NOW + 100_000) });
    expect(outbound.delayed[0]!.delaySeconds).toBe(100);
  });
});
