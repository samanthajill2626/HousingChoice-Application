// summarizeError + the logger's vendor-SDK redact paths (fix wave 5,
// adversarial finding 4).
//
// THE DEFECT THESE PIN. A Twilio SDK network failure (ECONNRESET, a socket hang
// up) surfaces as a raw AxiosError, and axios sets `this.config = config` as an
// OWN ENUMERABLE property. pino's default `err` serializer copies every
// enumerable key, so `log.warn({ err })` wrote `config.headers.Authorization`
// (Basic base64 of the API key sid AND secret) and `config.data` (the
// form-encoded request body: every group member's phone number, and the full
// message text) into CloudWatch. The logger's existing redact list matched
// none of it - wrong paths, and pino's redact is case-sensitive.
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { summarizeError } from '../src/lib/errors.js';
import { createLogger } from '../src/lib/logger.js';

/** An AxiosError, in the shape the vendored axios actually produces. */
function axiosLikeError(): Error {
  const err = new Error('socket hang up') as Error & Record<string, unknown>;
  err.name = 'AxiosError';
  err.code = 'ECONNRESET';
  err.config = {
    url: 'https://conversations.twilio.com/v1/Conversations',
    method: 'post',
    headers: {
      Authorization: 'Basic U0tsaXZlOnNlY3JldC1hcGkta2V5',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    data: 'Author=%2B15550000000&Body=Hi%20everyone&Participant=%2B15551110001',
  };
  return err;
}

function captureLines(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, stream };
}

describe('summarizeError', () => {
  it('keeps the discriminators and copies NOTHING else', () => {
    const summary = summarizeError(axiosLikeError());

    expect(summary).toEqual({
      name: 'AxiosError',
      message: 'socket hang up',
      code: 'ECONNRESET',
    });
    // The whole point: no config, no headers, no request body, no roster.
    expect(JSON.stringify(summary)).not.toContain('Basic ');
    expect(JSON.stringify(summary)).not.toContain('15551110001');
    expect(JSON.stringify(summary)).not.toContain('config');
  });

  it('lifts an HTTP status off either shape the SDKs use', () => {
    const withStatus = Object.assign(new Error('bad'), { status: 429 });
    expect(summarizeError(withStatus).status).toBe(429);

    const withResponse = Object.assign(new Error('bad'), { response: { status: 401 } });
    expect(summarizeError(withResponse).status).toBe(401);
  });

  it('handles a non-Error throw without inventing fields', () => {
    expect(summarizeError('nope')).toEqual({ name: 'Error', message: 'nope' });
  });
});

describe('logger redaction, as defense in depth', () => {
  it('a raw vendor error logged as { err } leaks NEITHER the credential NOR the body', () => {
    const { lines, stream } = captureLines();
    const log = createLogger({ destination: stream, level: 'warn' });

    log.warn({ err: axiosLikeError() }, 'group rail creation failed');

    const line = lines.join('');
    expect(line).not.toContain('U0tsaXZlOnNlY3JldC1hcGkta2V5');
    expect(line).not.toContain('15551110001');
    expect(line).toContain('[REDACTED]');
  });

  it('the summarized form is what a call site should log - and it is clean by construction', () => {
    const { lines, stream } = captureLines();
    const log = createLogger({ destination: stream, level: 'warn' });

    log.warn({ err: summarizeError(axiosLikeError()) }, 'group rail creation failed');

    const line = lines.join('');
    expect(line).toContain('ECONNRESET');
    expect(line).not.toContain('U0tsaXZlOnNlY3JldC1hcGkta2V5');
    expect(line).not.toContain('15551110001');
  });
});
