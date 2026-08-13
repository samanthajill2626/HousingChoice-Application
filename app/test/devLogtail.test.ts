// The dev-only WARN+ERROR ring buffer behind GET /__dev/logtail (S8/T8.0).
//
// Two things are worth pinning and nothing else is:
//   1. the GATE - the ring must be structurally absent unless the /__dev/*
//      triple gate is open, because the read side is only as safe as the write
//      side and a production process must never retain log lines in memory;
//   2. the CAPTURE CONTRACT - WARN+ only, downstream of pino's serialization
//      (so redaction and the correlationId mixin are already applied), oldest
//      dropped first, and the filters an e2e spec actually uses.
import { describe, it, expect, beforeEach } from 'vitest';
import type { DestinationStream } from 'pino';
import {
  clearDevLogTail,
  createDevLogTailStream,
  createLogger,
  devLogTailEnabled,
  readDevLogTail,
  DEV_LOG_TAIL_CAPACITY,
  DEV_LOG_TAIL_MIN_LEVEL,
} from '../src/lib/logger.js';

/** A destination that keeps every serialized line, so the wrapper's pass-through
 *  half is observable without writing to the real stdout. */
function captureStream(): { lines: string[]; stream: DestinationStream } {
  const lines: string[] = [];
  return { lines, stream: { write: (line: string) => void lines.push(line) } };
}

describe('devLogTailEnabled - the /__dev/* triple gate', () => {
  const base = {
    DEV_AUTH_ENABLED: '1',
    NODE_ENV: 'development',
    DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
  } as NodeJS.ProcessEnv;

  it('is open only for a hermetic local stack', () => {
    expect(devLogTailEnabled(base)).toBe(true);
    expect(devLogTailEnabled({ ...base, DEV_AUTH_ENABLED: 'true' })).toBe(true);
    expect(devLogTailEnabled({ ...base, DEV_AUTH_ENABLED: 'yes' })).toBe(true);
  });

  it('is closed without DEV_AUTH_ENABLED', () => {
    expect(devLogTailEnabled({ ...base, DEV_AUTH_ENABLED: '' })).toBe(false);
    expect(devLogTailEnabled({ ...base, DEV_AUTH_ENABLED: 'false' })).toBe(false);
    const { DEV_AUTH_ENABLED: _unset, ...withoutFlag } = base;
    expect(devLogTailEnabled(withoutFlag)).toBe(false);
  });

  it('is closed in production even with the flag set', () => {
    expect(devLogTailEnabled({ ...base, NODE_ENV: 'production' })).toBe(false);
  });

  it('is closed without a local DynamoDB endpoint (a cloud stack)', () => {
    expect(devLogTailEnabled({ ...base, DYNAMODB_ENDPOINT: '' })).toBe(false);
    const { DYNAMODB_ENDPOINT: _unset, ...withoutEndpoint } = base;
    expect(devLogTailEnabled(withoutEndpoint)).toBe(false);
  });
});

describe('the log-tail ring', () => {
  beforeEach(() => {
    clearDevLogTail();
  });

  it('retains WARN and ERROR and never INFO or DEBUG', () => {
    const capture = captureStream();
    const log = createLogger({ level: 'debug', destination: createDevLogTailStream(capture.stream) });

    log.debug({ event: 'noise_debug' }, 'debug line');
    log.info({ event: 'noise_info' }, 'info line');
    log.warn({ event: 'group_envelope_missing' }, 'a tripwire');
    log.error({ event: 'group_crosscheck_inbound_missing' }, 'a miss');

    // Everything still reaches the underlying destination - the wrapper is a
    // tee, not a filter, so stdout output is unchanged.
    expect(capture.lines).toHaveLength(4);

    const tail = readDevLogTail();
    expect(tail.map((l) => l['event'])).toEqual([
      'group_envelope_missing',
      'group_crosscheck_inbound_missing',
    ]);
    expect(tail.every((l) => l.level >= DEV_LOG_TAIL_MIN_LEVEL)).toBe(true);
  });

  it('keeps the structured fields and the message pino serialized', () => {
    const capture = captureStream();
    const log = createLogger({ destination: createDevLogTailStream(capture.stream) });
    log.warn({ event: 'group_rail_ensure_failed', conversationId: 'conv-x' }, 'the reason');

    const [line] = readDevLogTail();
    expect(line?.msg).toBe('the reason');
    expect(line?.['event']).toBe('group_rail_ensure_failed');
    expect(line?.['conversationId']).toBe('conv-x');
    expect(typeof line?.time).toBe('number');
  });

  it('applies pino redaction before the ring sees the line', () => {
    const capture = captureStream();
    const log = createLogger({ destination: createDevLogTailStream(capture.stream) });
    log.error({ headers: { authorization: 'Bearer super-secret' } }, 'redacted?');

    const [line] = readDevLogTail();
    expect(JSON.stringify(line)).not.toContain('super-secret');
    expect(JSON.stringify(line)).toContain('[REDACTED]');
  });

  it('drops the OLDEST line past capacity', () => {
    const capture = captureStream();
    const log = createLogger({ destination: createDevLogTailStream(capture.stream) });
    for (let i = 0; i < DEV_LOG_TAIL_CAPACITY + 5; i++) log.warn({ seq: i }, 'filler');

    const tail = readDevLogTail();
    expect(tail).toHaveLength(DEV_LOG_TAIL_CAPACITY);
    expect(tail[0]?.['seq']).toBe(5);
    expect(tail[tail.length - 1]?.['seq']).toBe(DEV_LOG_TAIL_CAPACITY + 4);
  });

  it('filters by level, event, message substring and limit', () => {
    const capture = captureStream();
    const log = createLogger({ destination: createDevLogTailStream(capture.stream) });
    log.warn({ event: 'group_envelope_missing' }, 'group envelope missing on an MM inbound');
    log.error({ event: 'group_send_receipts_stale' }, 'group delivery receipts silent');
    log.warn({ event: 'other' }, 'unrelated');

    expect(readDevLogTail({ minLevel: 50 }).map((l) => l['event'])).toEqual([
      'group_send_receipts_stale',
    ]);
    expect(readDevLogTail({ event: 'group_envelope_missing' })).toHaveLength(1);
    expect(readDevLogTail({ contains: 'receipts silent' })).toHaveLength(1);
    expect(readDevLogTail({ limit: 1 }).map((l) => l['event'])).toEqual(['other']);
  });

  it('filters by `since`, which is how a spec scopes to its own window', () => {
    const capture = captureStream();
    const log = createLogger({ destination: createDevLogTailStream(capture.stream) });
    log.warn({ event: 'before' }, 'old');
    const cut = Date.now() + 1;
    log.warn({ event: 'after' }, 'new');

    const scoped = readDevLogTail({ sinceMs: cut });
    expect(scoped.every((l) => l['event'] !== 'before')).toBe(true);
  });

  it('survives a non-JSON write instead of throwing on the log path', () => {
    const stream = createDevLogTailStream({ write: () => undefined });
    expect(() => stream.write('not json at all\n')).not.toThrow();
    expect(readDevLogTail()).toHaveLength(0);
  });

  it('clearDevLogTail reports what it dropped', () => {
    const capture = captureStream();
    const log = createLogger({ destination: createDevLogTailStream(capture.stream) });
    log.warn('one');
    log.warn('two');
    expect(clearDevLogTail()).toBe(2);
    expect(readDevLogTail()).toHaveLength(0);
  });
});
