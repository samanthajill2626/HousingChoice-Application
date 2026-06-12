// Acceptance test 6 (M0.2): EventBridgeSchedulerAdapter unit test with a fake
// injected client — asserts ActionAfterCompletion: 'DELETE' and the JSON
// envelope in the command input. No AWS calls.
import type {
  CreateScheduleCommand,
  CreateScheduleCommandOutput,
} from '@aws-sdk/client-scheduler';
import { describe, expect, it } from 'vitest';
import {
  EventBridgeSchedulerAdapter,
  InMemorySchedulerAdapter,
  type SchedulerClientLike,
} from '../src/adapters/scheduler.js';
import type { JobEnvelope } from '../src/jobs/types.js';

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

describe('EventBridgeSchedulerAdapter', () => {
  it('sends CreateScheduleCommand with ActionAfterCompletion DELETE and the JSON envelope as target input', async () => {
    const sent: CreateScheduleCommand[] = [];
    const fakeClient: SchedulerClientLike = {
      send: async (command) => {
        sent.push(command);
        return { $metadata: {} } as CreateScheduleCommandOutput;
      },
    };
    const adapter = new EventBridgeSchedulerAdapter({
      client: fakeClient,
      targetArn: 'arn:aws:lambda:us-east-1:000000000000:function:hc-dev-worker-dispatch',
      roleArn: 'arn:aws:iam::000000000000:role/hc-dev-scheduler-invoke',
    });

    const envelope = makeEnvelope();
    const runAt = new Date('2026-06-12T15:30:00.000Z');
    await adapter.scheduleOnce(envelope, { runAt });

    expect(sent).toHaveLength(1);
    const input = sent[0]!.input;
    // One-off schedules must clean up after themselves.
    expect(input.ActionAfterCompletion).toBe('DELETE');
    expect(input.ScheduleExpression).toBe('at(2026-06-12T15:30:00)');
    expect(input.FlexibleTimeWindow).toEqual({ Mode: 'OFF' });
    expect(input.Name).toMatch(/^hc-demo\.echo-11111111/);
    expect(input.Target?.Arn).toBe(
      'arn:aws:lambda:us-east-1:000000000000:function:hc-dev-worker-dispatch',
    );
    expect(input.Target?.RoleArn).toBe('arn:aws:iam::000000000000:role/hc-dev-scheduler-invoke');
    expect(JSON.parse(input.Target?.Input ?? '')).toEqual(envelope);
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
