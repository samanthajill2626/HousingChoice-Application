// Acceptance test 1 (M0.2): correlation context survives a job round-trip
// through the enqueue -> scheduler -> dispatch envelope path.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySchedulerAdapter } from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureScheduler,
  defineJobHandler,
  dispatchJob,
  enqueue,
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
  let adapter: InMemorySchedulerAdapter;

  beforeEach(() => {
    _resetForTests();
    adapter = new InMemorySchedulerAdapter();
    configureScheduler(adapter);
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

    await runWithContext({ requestId, conversationId: 'c1', tenantId: 't1' }, () =>
      enqueue('demo.echo', { hello: 'world' }),
    );
    await adapter.deliverAll(dispatchJob);

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

    await runWithContext({ requestId: newRequestId(), conversationId: 'c1' }, () =>
      enqueue('demo.chain', {}),
    );
    await adapter.deliverAll(dispatchJob); // drains demo.chain, which enqueues demo.echo
    await adapter.deliverAll(dispatchJob); // drains demo.echo

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
    await adapter.deliverAll(dispatchJob);

    expect(observed).toBe(traceparent);
  });

  it('rejects undispatchable events: no jobName, not an object, unknown job names', async () => {
    defineJobHandler('demo.echo', () => undefined);

    await expect(dispatchJob({ not: 'an envelope' })).rejects.toThrow(/missing jobName/);
    await expect(dispatchJob(null)).rejects.toThrow(/not an object/);

    await runWithContext({ requestId: newRequestId() }, () => enqueue('demo.echo', {}));
    const item = adapter.scheduled.shift();
    expect(item).toBeDefined();
    const tampered = { ...item!.envelope, jobName: 'demo.unknown' };
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
