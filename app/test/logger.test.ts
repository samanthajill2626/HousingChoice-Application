// Acceptance test 2 (M0.2): orphan-log detection. A line logged outside any
// correlation context has no correlationId (orphan); inside a context it
// carries correlationId === requestId. M0.4's CloudWatch metric filter
// mirrors isOrphanLogLine().
import { describe, expect, it } from 'vitest';
import { newBootId, newJobRunId, newRequestId, runWithContext } from '../src/lib/context.js';
import { installProcessErrorHandlers } from '../src/lib/errors.js';
import { createLogger, isOrphanLogLine } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

describe('logger: orphan-log detection', () => {
  it('a line logged outside any context is an orphan (no correlationId)', () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });

    log.info('no context here');

    expect(capture.lines).toHaveLength(1);
    const line = capture.lines[0]!;
    expect(line['correlationId']).toBeUndefined();
    expect(isOrphanLogLine(line)).toBe(true);
  });

  it('a line logged inside a request context carries correlationId === requestId', () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const requestId = newRequestId();

    runWithContext({ requestId, tenantId: 't1' }, () => {
      log.info('inside context');
    });

    expect(capture.lines).toHaveLength(1);
    const line = capture.lines[0]!;
    expect(line['correlationId']).toBe(requestId);
    expect(line['requestId']).toBe(requestId);
    expect(line['tenantId']).toBe('t1');
    expect(isOrphanLogLine(line)).toBe(false);
  });

  it('jobRunId wins over requestId as the correlationId', () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const requestId = newRequestId();
    const jobRunId = newJobRunId();

    runWithContext({ requestId, jobRunId }, () => {
      log.info('job context');
    });

    expect(capture.lines[0]!['correlationId']).toBe(jobRunId);
  });

  it('a process-lifecycle line inside a boot context is NOT an orphan (correlationId === bootId)', () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const bootId = newBootId();

    runWithContext({ bootId }, () => {
      log.info({ port: 8080 }, 'app listening');
    });

    const line = capture.lines[0]!;
    expect(line['correlationId']).toBe(bootId);
    expect(isOrphanLogLine(line)).toBe(false);
  });

  it('request/job ids take precedence over bootId as the correlationId', () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const bootId = newBootId();
    const requestId = newRequestId();

    runWithContext({ bootId, requestId }, () => {
      log.info('request during boot context');
    });

    expect(capture.lines[0]!['correlationId']).toBe(requestId);
  });

  it('unhandledRejection logged outside any context falls back to the boot context (not orphan)', async () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const bootId = newBootId();

    const before = process.listeners('unhandledRejection');
    const beforeUncaught = process.listeners('uncaughtException');
    installProcessErrorHandlers(log, { bootId });
    const added = process
      .listeners('unhandledRejection')
      .filter((l) => !before.includes(l));
    const addedUncaught = process
      .listeners('uncaughtException')
      .filter((l) => !beforeUncaught.includes(l));
    try {
      // Invoke the handler directly — actually rejecting a promise in vitest
      // would fail the test run.
      for (const listener of added) {
        (listener as (reason: unknown, promise: Promise<unknown>) => void)(
          new Error('lost rejection'),
          Promise.resolve(),
        );
      }
      const line = capture.lines[0]!;
      expect(line['correlationId']).toBe(bootId);
      expect(isOrphanLogLine(line)).toBe(false);
    } finally {
      for (const listener of added) {
        process.removeListener('unhandledRejection', listener as NodeJS.UnhandledRejectionListener);
      }
      for (const listener of addedUncaught) {
        process.removeListener('uncaughtException', listener as NodeJS.UncaughtExceptionListener);
      }
    }
  });

  it('redacts credential headers as defense-in-depth', () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });

    log.info(
      { headers: { authorization: 'Bearer xyz', cookie: 'sid=1', 'x-origin-verify': 'secret', host: 'h' } },
      'header dump',
    );

    const headers = capture.lines[0]!['headers'] as Record<string, unknown>;
    expect(headers['authorization']).toBe('[REDACTED]');
    expect(headers['cookie']).toBe('[REDACTED]');
    expect(headers['x-origin-verify']).toBe('[REDACTED]');
    expect(headers['host']).toBe('h');
  });
});
