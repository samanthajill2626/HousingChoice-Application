// jobs/pollLoop.ts: every worker poll TICK runs inside a fresh pollRunId
// correlation context, so no poll line is ever an orphan (prod incident
// 2026-08-16 - the extraction poll's ~40-47 orphan lines a day kept
// hc-prod-orphan-logs flapping). The manual `schedule` seam makes the timer
// deterministic; no test starts a real interval.
import { describe, expect, it } from 'vitest';
import { newJobRunId, runWithContext } from '../src/lib/context.js';
import { createLogger, isOrphanLogLine } from '../src/lib/logger.js';
import { startPoll } from '../src/jobs/pollLoop.js';
import { createLogCapture } from './helpers/logCapture.js';

describe('startPoll: a poll tick is never an orphan', () => {
  it('lines logged by the polled work carry correlationId === pollRunId', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    let tick: (() => void) | undefined;

    startPoll(
      'extraction',
      async () => {
        // Log from INSIDE the awaited work, the way runDueExtractions does.
        await Promise.resolve();
        logger.info({ count: 1 }, 'extraction poll: processing due rows');
      },
      {
        logger,
        intervalMs: 30_000,
        schedule: (fn) => {
          tick = fn;
        },
      },
    );

    tick!();
    await new Promise((r) => setImmediate(r));

    expect(capture.lines).toHaveLength(1);
    const line = capture.lines[0]!;
    expect(isOrphanLogLine(line)).toBe(false);
    expect(typeof line['pollRunId']).toBe('string');
    expect(line['correlationId']).toBe(line['pollRunId']);
  });

  it('each tick gets its OWN pollRunId (ticks are separately traceable)', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    let tick: (() => void) | undefined;

    startPoll(
      'extraction',
      async () => {
        await Promise.resolve();
        logger.info('tick work');
      },
      { logger, intervalMs: 30_000, schedule: (fn) => { tick = fn; } },
    );

    tick!();
    await new Promise((r) => setImmediate(r));
    tick!();
    await new Promise((r) => setImmediate(r));

    expect(capture.lines).toHaveLength(2);
    const [first, second] = capture.lines;
    expect(first!['correlationId']).not.toBe(second!['correlationId']);
  });

  it('a REJECTED tick logs its error inside the context and does not throw', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    let tick: (() => void) | undefined;

    startPoll('tour reminder', async () => { throw new Error('repo exploded'); }, {
      logger,
      intervalMs: 30_000,
      schedule: (fn) => { tick = fn; },
    });

    // The whole point: a timer callback has no caller, so this must not throw.
    expect(() => tick!()).not.toThrow();
    await new Promise((r) => setImmediate(r));

    const errors = capture.atLevel(50);
    expect(errors).toHaveLength(1);
    const line = errors[0]!;
    // The regression that mattered: this used to be an orphan ERROR.
    expect(isOrphanLogLine(line)).toBe(false);
    expect(line['correlationId']).toBe(line['pollRunId']);
    expect(line['poll']).toBe('tour reminder');
    expect(line['msg']).toBe('tour reminder poll error');
  });

  it('merges baseContext (bootId) under the tick id, and pollRunId still wins', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    let tick: (() => void) | undefined;

    startPoll('group guardrail', async () => { logger.info('work'); }, {
      logger,
      intervalMs: 30_000,
      baseContext: { bootId: 'boot-abc' },
      schedule: (fn) => { tick = fn; },
    });

    tick!();
    await new Promise((r) => setImmediate(r));

    const line = capture.lines[0]!;
    expect(line['bootId']).toBe('boot-abc');
    expect(line['correlationId']).toBe(line['pollRunId']);
    expect(line['correlationId']).not.toBe('boot-abc');
  });

  it('a job dispatched inside a tick reports its OWN jobRunId, not the tick id', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    const jobRunId = newJobRunId();
    let tick: (() => void) | undefined;

    startPoll(
      'roster action',
      async () => {
        // dispatchJob opens a nested context for the job it runs.
        runWithContext({ jobRunId }, () => { logger.info('job started'); });
      },
      { logger, intervalMs: 30_000, schedule: (fn) => { tick = fn; } },
    );

    tick!();
    await new Promise((r) => setImmediate(r));

    expect(capture.lines[0]!['correlationId']).toBe(jobRunId);
  });

  it('schedules on the interval it was given', () => {
    const capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    let seenMs: number | undefined;

    startPoll('extraction', async () => {}, {
      logger,
      intervalMs: 30_000,
      schedule: (_fn, ms) => { seenMs = ms; },
    });

    expect(seenMs).toBe(30_000);
  });
});
