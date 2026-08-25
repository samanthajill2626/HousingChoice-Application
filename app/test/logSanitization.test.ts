// app/test/logSanitization.test.ts
// END-TO-END CREDENTIAL PROBE (log-hygiene spec section 3 guard 1): a real
// createLogger over a capture stream, fed a synthetic AxiosError-shaped
// Error carrying a FAKE credential sentinel, under each wired key and as the
// first-arg form. The sentinel is clearly fake - never a real credential.
import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger } from '../src/lib/logger.js';
import { LOG_SERIALIZER_KEYS } from '../src/lib/logSerializers.js';
import { summarizeError } from '../src/lib/errors.js';

const FAKE_BASIC = 'Basic U0tmYWtlOnNlY3JldGZha2U=';

function capture(): { lines: string[]; stream: DestinationStream } {
  const lines: string[] = [];
  return { lines, stream: { write(line: string) { lines.push(line); } } };
}

function syntheticAxiosError(): Error {
  const err = new Error('connect ECONNRESET') as Error & Record<string, unknown>;
  err.name = 'AxiosError';
  err.code = 'ECONNRESET';
  err.config = { headers: { Authorization: FAKE_BASIC }, data: 'To=%2B15551230000&Body=hello' };
  err.request = { _header: `POST /x HTTP/1.1\r\nAuthorization: ${FAKE_BASIC}\r\n\r\n` };
  err.response = { status: 500, config: { headers: { Authorization: FAKE_BASIC } }, data: 'To=%2B15551230000' };
  return err;
}

describe('log sanitization - the credential class is structurally closed', () => {
  for (const key of LOG_SERIALIZER_KEYS) {
    it(`a raw vendor error under '${key}' leaks neither credential nor body`, () => {
      const { lines, stream } = capture();
      const log = createLogger({ destination: stream, level: 'warn' });
      log.warn({ [key]: syntheticAxiosError() }, 'vendor call failed');
      const joined = lines.join('');
      expect(joined).not.toContain('U0tmYWtlOnNlY3JldGZha2U=');
      expect(joined).not.toContain('15551230000');
      // ABSENT, not censored: under the pre-serializer redact list the err
      // key would show [REDACTED] here - this line is what makes the probe
      // discriminating on `err` (the other three keys leak outright).
      expect(joined).not.toContain('[REDACTED]');
      expect(joined).toContain('ECONNRESET'); // message survives
    });
  }

  it('the first-arg form (logger.warn(err, msg)) is covered too', () => {
    const { lines, stream } = capture();
    const log = createLogger({ destination: stream, level: 'warn' });
    log.warn(syntheticAxiosError(), 'vendor call failed');
    const joined = lines.join('');
    expect(joined).not.toContain('U0tmYWtlOnNlY3JldGZha2U=');
    // Same discriminator as the keyed cases: absent, not censored.
    expect(joined).not.toContain('[REDACTED]');
  });

  it('a primitive under each wired key passes through unchanged', () => {
    const { lines, stream } = capture();
    const log = createLogger({ destination: stream, level: 'warn' });
    log.warn({ reason: 'signature mismatch', error: 'refused' }, 'domain line');
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['reason']).toBe('signature mismatch');
    expect(parsed['error']).toBe('refused');
  });

  it('a summarizeError object under err passes through with its name intact', () => {
    const { lines, stream } = capture();
    const log = createLogger({ destination: stream, level: 'warn' });
    const restLike = new Error('x') as Error & Record<string, unknown>;
    restLike.code = 30007;
    restLike.status = 400;
    log.warn({ err: summarizeError(restLike) }, 'terse line');
    const parsed = JSON.parse(lines[0]!) as { err?: { name?: string; code?: string } };
    expect(parsed.err?.name).toBe('Error');
    expect(parsed.err?.code).toBe('30007');
  });
});
