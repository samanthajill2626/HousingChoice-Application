// T6.1 - the job wrapper around ensureGroupRail.
//
// Detection ENQUEUES rather than creating inline (the webhook's 5s budget), so
// the async path has to be provably the SAME service the migration and the send
// backstop call. These tests pin that, plus the two properties the guardrail
// design leans on: the handler never throws a rail failure back at the queue
// (an infinite redelivery of a landline roster is worse than an inbound-only
// thread), and the producer goes through `jobs.enqueue()` so correlation and
// trace context survive the hop.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  dispatchJob,
} from '../src/jobs/jobs.js';
import type { JobEnvelope } from '../src/jobs/types.js';
import {
  GROUP_RAIL_ENSURE_JOB,
  createGroupRailEnqueuer,
  registerGroupRailJobHandler,
} from '../src/jobs/groupRail.js';
import type {
  GroupRailEnsurer,
  GroupRailRequest,
  GroupRailResult,
} from '../src/services/groupRail.js';
import { logger } from '../src/lib/logger.js';

function makeQueue() {
  const envelopes: JobEnvelope[] = [];
  return {
    envelopes,
    async enqueue(envelope: JobEnvelope) {
      envelopes.push(envelope);
    },
  };
}

function makeRail(
  result: GroupRailResult,
): GroupRailEnsurer & { calls: string[]; requests: GroupRailRequest[] } {
  const calls: string[] = [];
  // The WHOLE request, not just the id: what this job asks for is now part of
  // the contract (the binding-propagation opt-in).
  const requests: GroupRailRequest[] = [];
  return {
    calls,
    requests,
    async ensureGroupRail(request) {
      calls.push(request.conversationId);
      requests.push(request);
      return result;
    },
  };
}

describe('groupRail.ensure job', () => {
  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(logger);
  });
  afterEach(() => {
    _resetForTests();
  });

  it('runs ensureGroupRail for the payload conversation', async () => {
    const rail = makeRail({ status: 'created', twilioConversationSid: 'CH1' });
    registerGroupRailJobHandler({ rail, logger });

    await dispatchJob({ jobName: GROUP_RAIL_ENSURE_JOB, payload: { conversationId: 'convGroup:x' } });

    expect(rail.calls).toEqual(['convGroup:x']);
    // This caller OPTS IN to the binding-propagation ladder: no human is waiting
    // on a background job, and a fresh rail read as short of its roster is the
    // defect rail-binding-propagation-retry describes.
    expect(rail.requests[0]?.awaitBindingPropagation).toBe(true);
  });

  it('a rail FAILURE is a WARN, never a throw - the queue must not redeliver a landline forever', async () => {
    const rail = makeRail({ status: 'failed', reason: 'landline' });
    const warn = vi.fn();
    registerGroupRailJobHandler({
      rail,
      logger: { ...logger, warn, info: vi.fn(), error: vi.fn() } as never,
    });

    await expect(
      dispatchJob({ jobName: GROUP_RAIL_ENSURE_JOB, payload: { conversationId: 'convGroup:y' } }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'group_rail_job_incomplete', railStatus: 'failed' }),
      expect.any(String),
    );
  });

  it('the failure WARN never carries the reason string - it can name members', async () => {
    // The MB-map mismatch case builds its reason as
    // `rail participants do not cover the roster: <E.164>, <E.164>`, so logging
    // `reason` verbatim would put member phone numbers in the log sink. The
    // service already logs the SHAPE (a missing COUNT) and the full string is
    // persisted by recordRailFailure. This test fails if `reason` comes back.
    const rail = makeRail({
      status: 'failed',
      reason: 'rail participants do not cover the roster: +16174707727, +16783837896',
    });
    const warn = vi.fn();
    registerGroupRailJobHandler({
      rail,
      logger: { ...logger, warn, info: vi.fn(), error: vi.fn() } as never,
    });

    await dispatchJob({
      jobName: GROUP_RAIL_ENSURE_JOB,
      payload: { conversationId: 'convGroup:pii' },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).not.toHaveProperty('reason');
    // Belt and braces: no E.164 anywhere in the emitted line, whatever the key.
    expect(JSON.stringify({ fields, message })).not.toMatch(/\+1\d{10}/);
  });

  it('a malformed payload is logged and dropped, never retried', async () => {
    const rail = makeRail({ status: 'created' });
    const error = vi.fn();
    registerGroupRailJobHandler({
      rail,
      logger: { ...logger, error, info: vi.fn(), warn: vi.fn() } as never,
    });

    await dispatchJob({ jobName: GROUP_RAIL_ENSURE_JOB, payload: { nope: true } });

    expect(rail.calls).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'group_rail_job_payload_invalid' }),
      expect.any(String),
    );
  });

  it('the enqueuer produces a real job envelope through jobs.enqueue()', async () => {
    const queue = makeQueue();
    configureOutboundQueue(queue);

    const outcome = await createGroupRailEnqueuer({ logger }).enqueueGroupRail({
      conversationId: 'convGroup:z',
      members: [],
      reason: 'created',
    });

    expect(outcome.status).toBe('enqueued');
    expect(queue.envelopes).toHaveLength(1);
    expect(queue.envelopes[0]!.jobName).toBe(GROUP_RAIL_ENSURE_JOB);
    expect(queue.envelopes[0]!.payload).toEqual({
      conversationId: 'convGroup:z',
      reason: 'created',
    });
    expect(outcome.jobId).toBe(queue.envelopes[0]!.jobId);
  });

  it('an enqueue failure REPORTS rather than throwing - a rail never fails an inbound', async () => {
    // No outbound queue configured: enqueue() throws.
    const outcome = await createGroupRailEnqueuer({
      logger: { ...logger, warn: vi.fn() } as never,
    }).enqueueGroupRail({ conversationId: 'convGroup:q', members: [], reason: 'rail_missing' });

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('OutboundQueueAdapter');
  });
});
