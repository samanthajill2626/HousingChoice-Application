// M1.2: the worker-side SQS jobs consumer, unit-tested with a fake SQS client
// (no AWS calls anywhere). Covers the delete semantics contract:
// success -> delete; handler throw -> NO delete (visibility timeout -> DLQ);
// poison (unparseable body / malformed envelope) -> ERROR + delete; graceful
// shutdown drains in-flight work; consumer-level lines are never orphans.
import {
  DeleteMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqsJobConsumer, type SqsClientLike } from '../src/adapters/sqsJobConsumer.js';
import {
  MalformedJobEnvelopeError,
  _resetForTests,
  configureJobsLogger,
  defineJobHandler,
  dispatchJob,
} from '../src/jobs/jobs.js';
import type { JobEnvelope } from '../src/jobs/types.js';
import { loadConfig } from '../src/lib/config.js';
import { getContext, type CorrelationContext } from '../src/lib/context.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/hc-test-jobs';

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

function makeMessage(id: string, body: string): Message {
  return { MessageId: id, ReceiptHandle: `rh-${id}`, Body: body };
}

/**
 * Scripted fake: each ReceiveMessage consumes the next script entry (a batch
 * to deliver or an Error to throw); once exhausted it hangs like a real long
 * poll until stop()'s abort signal fires. Deletes are recorded.
 */
function makeFakeSqs(script: Array<Message[] | Error>): {
  client: SqsClientLike;
  deletes: Array<{ QueueUrl?: string; ReceiptHandle?: string }>;
} {
  const deletes: Array<{ QueueUrl?: string; ReceiptHandle?: string }> = [];
  const client: SqsClientLike = {
    send: (command, options) => {
      if (command instanceof DeleteMessageCommand) {
        deletes.push({
          QueueUrl: command.input.QueueUrl,
          ReceiptHandle: command.input.ReceiptHandle,
        });
        return Promise.resolve({ $metadata: {} });
      }
      const next = script.shift();
      if (next instanceof Error) return Promise.reject(next);
      if (next) return Promise.resolve({ $metadata: {}, Messages: next });
      return new Promise<never>((_resolve, reject) => {
        const signal = options?.abortSignal;
        const onAbort = (): void => {
          reject(new Error('long poll aborted'));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
  return { client, deletes };
}

describe('SqsJobConsumer', () => {
  let capture: LogCapture;

  beforeEach(() => {
    _resetForTests();
    capture = createLogCapture();
    configureJobsLogger(createLogger({ level: 'info', destination: capture.stream }));
  });

  afterEach(() => {
    _resetForTests();
  });

  function makeConsumer(
    client: SqsClientLike,
    dispatch: (rawEvent: unknown) => Promise<void>,
    extra?: { baseContext?: CorrelationContext; receiveErrorBackoffMs?: number },
  ): SqsJobConsumer {
    return new SqsJobConsumer({
      client,
      queueUrl: QUEUE_URL,
      dispatch,
      baseContext: extra?.baseContext ?? { bootId: 'boot-1' },
      logger: createLogger({ level: 'info', destination: capture.stream }),
      ...(extra?.receiveErrorBackoffMs !== undefined && {
        receiveErrorBackoffMs: extra.receiveErrorBackoffMs,
      }),
    });
  }

  it('dispatches the parsed message body and deletes on success', async () => {
    const envelope = makeEnvelope();
    const { client, deletes } = makeFakeSqs([[makeMessage('m1', JSON.stringify(envelope))]]);
    const dispatched: unknown[] = [];

    const consumer = makeConsumer(client, async (rawEvent) => {
      dispatched.push(rawEvent);
    });
    consumer.start();
    await consumer.stop();

    expect(dispatched).toEqual([envelope]);
    expect(deletes).toEqual([{ QueueUrl: QUEUE_URL, ReceiptHandle: 'rh-m1' }]);
  });

  it('drives the REAL dispatchJob gate: handler sees payload + rehydrated context, message deleted', async () => {
    const envelope = makeEnvelope();
    const { client, deletes } = makeFakeSqs([[makeMessage('m1', JSON.stringify(envelope))]]);
    let observedPayload: unknown;
    let observed: CorrelationContext | undefined;
    defineJobHandler('demo.echo', (payload) => {
      observedPayload = payload;
      observed = getContext();
    });

    const consumer = makeConsumer(client, dispatchJob);
    consumer.start();
    await consumer.stop();

    expect(observedPayload).toEqual({ hello: 'world' });
    expect(observed?.requestId).toBe('req-1'); // enqueuer context survived the SQS hop
    expect(observed?.jobRunId).toBeDefined(); // fresh per-run id minted at dispatch
    expect(deletes).toHaveLength(1);
  });

  it('does NOT delete when the handler throws — visibility timeout redelivers toward the DLQ', async () => {
    const envelope = makeEnvelope();
    const { client, deletes } = makeFakeSqs([[makeMessage('m1', JSON.stringify(envelope))]]);

    const consumer = makeConsumer(client, async () => {
      throw new Error('handler exploded');
    });
    consumer.start();
    await consumer.stop();

    expect(deletes).toHaveLength(0);
    const warns = capture.atLevel(40);
    expect(
      warns.some((l) => String(l['msg']).includes('left for redelivery')),
    ).toBe(true);
  });

  it('deletes an unparseable body with a correlated ERROR and never dispatches it', async () => {
    const { client, deletes } = makeFakeSqs([[makeMessage('m1', 'this is not JSON')]]);
    const dispatch = vi.fn(async () => {});

    const consumer = makeConsumer(client, dispatch);
    consumer.start();
    await consumer.stop();

    expect(dispatch).not.toHaveBeenCalled();
    expect(deletes).toHaveLength(1);
    const errors = capture.atLevel(50);
    expect(errors.some((l) => String(l['msg']).includes('unparseable message body'))).toBe(true);
    // Doc §9: synthesized context — consumer lines must never be orphans.
    for (const line of capture.lines) {
      expect(line['correlationId']).toBe('boot-1');
    }
  });

  it('deletes a malformed envelope rejected by the real dispatchJob gate (poison, not DLQ-cycled)', async () => {
    const { client, deletes } = makeFakeSqs([[makeMessage('m1', '{"not":"an envelope"}')]]);

    const consumer = makeConsumer(client, dispatchJob);
    consumer.start();
    await consumer.stop();

    expect(deletes).toHaveLength(1);
    // dispatchJob ERROR-logged the rejection; the consumer adds the poison warn.
    expect(
      capture.atLevel(50).some((l) => String(l['msg']).includes('malformed job envelope rejected')),
    ).toBe(true);
    expect(
      capture.atLevel(40).some((l) => String(l['msg']).includes('deleting poison message')),
    ).toBe(true);
  });

  it('deletes an UNKNOWN jobName as poison (ERROR from the gate, warn + delete here) — never DLQ-cycled', async () => {
    const envelope = { ...makeEnvelope(), jobName: 'demo.unregistered' };
    const { client, deletes } = makeFakeSqs([[makeMessage('m1', JSON.stringify(envelope))]]);

    const consumer = makeConsumer(client, dispatchJob);
    consumer.start();
    await consumer.stop();

    expect(deletes).toHaveLength(1); // redelivery can never register the handler
    expect(
      capture.atLevel(50).some((l) => String(l['msg']).includes('malformed job envelope rejected')),
    ).toBe(true);
    expect(
      capture.atLevel(40).some((l) => String(l['msg']).includes('deleting poison message')),
    ).toBe(true);
  });

  it('runs an envelope-less but DISPATCHABLE payload (synthesized context) and deletes on success', async () => {
    const { client, deletes } = makeFakeSqs([
      [makeMessage('m1', JSON.stringify({ jobName: 'demo.echo', payload: { hello: 'bare' } }))],
    ]);
    let observedPayload: unknown;
    defineJobHandler('demo.echo', (payload) => {
      observedPayload = payload;
    });

    const consumer = makeConsumer(client, dispatchJob);
    consumer.start();
    await consumer.stop();

    expect(observedPayload).toEqual({ hello: 'bare' }); // ran, not deleted as poison
    expect(deletes).toHaveLength(1); // success delete
    expect(
      capture.atLevel(40).some((l) => String(l['msg']).includes('context synthesized')),
    ).toBe(true);
  });

  it('M3: the gate rejection ERROR always carries a correlationId (never an orphan log)', async () => {
    const { client } = makeFakeSqs([[makeMessage('m1', '{"not":"an envelope"}')]]);

    const consumer = makeConsumer(client, dispatchJob);
    consumer.start();
    await consumer.stop();

    const rejection = capture
      .atLevel(50)
      .find((l) => String(l['msg']).includes('malformed job envelope rejected'))!;
    expect(rejection).toBeDefined();
    expect(typeof rejection['correlationId']).toBe('string');
    expect((rejection['correlationId'] as string).length).toBeGreaterThan(0);
  });

  it('graceful shutdown: stop() waits for in-flight dispatches (and their deletes) to finish', async () => {
    const envelope = makeEnvelope();
    const { client, deletes } = makeFakeSqs([[makeMessage('m1', JSON.stringify(envelope))]]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatchStarted = false;

    const consumer = makeConsumer(client, async () => {
      dispatchStarted = true;
      await gate;
    });
    consumer.start();
    await vi.waitFor(() => expect(dispatchStarted).toBe(true));

    let stopped = false;
    const stopping = consumer.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false); // still draining — the job is mid-run
    expect(deletes).toHaveLength(0);

    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(deletes).toHaveLength(1); // in-flight job completed AND was deleted
  });

  it('logs a correlated ERROR and keeps polling after a ReceiveMessage failure', async () => {
    const envelope = makeEnvelope();
    const { client, deletes } = makeFakeSqs([
      new Error('socket hang up'),
      [makeMessage('m1', JSON.stringify(envelope))],
    ]);

    const consumer = makeConsumer(client, async () => {}, { receiveErrorBackoffMs: 1 });
    consumer.start();
    await vi.waitFor(() => expect(deletes).toHaveLength(1));
    await consumer.stop();

    const errors = capture.atLevel(50);
    expect(errors.some((l) => String(l['msg']).includes('ReceiveMessage failed'))).toBe(true);
    expect(errors[0]?.['correlationId']).toBe('boot-1');
  });
});

describe('MalformedJobEnvelopeError (the poison-message marker)', () => {
  it('dispatchJob throws it for malformed envelopes but NOT for handler failures', async () => {
    configureJobsLogger(createLogger({ level: 'info', destination: createLogCapture().stream }));
    await expect(dispatchJob({ not: 'an envelope' })).rejects.toBeInstanceOf(
      MalformedJobEnvelopeError,
    );

    defineJobHandler('demo.fails', () => {
      throw new Error('business logic failure');
    });
    const envelope = { ...makeEnvelope(), jobName: 'demo.fails' };
    const rejection = await dispatchJob(envelope).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(MalformedJobEnvelopeError);
    _resetForTests();
  });
});

describe('config: jobs queue plumbing', () => {
  it('reads JOBS_QUEUE_URL into jobsQueueUrl (unset locally)', () => {
    expect(loadConfig({ NODE_ENV: 'test', JOBS_QUEUE_URL: QUEUE_URL }).jobsQueueUrl).toBe(
      QUEUE_URL,
    );
    expect(loadConfig({ NODE_ENV: 'test' }).jobsQueueUrl).toBeUndefined();
  });
});
