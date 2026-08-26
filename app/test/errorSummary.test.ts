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
  it('keeps the discriminators and copies NOTHING else - the vendor MESSAGE included', () => {
    const summary = summarizeError(axiosLikeError());

    // NO `message` (fix wave 2, adversarial 10 / conformance F7). The adjudicated
    // allowlist is (name, code, status); `message` is the one field the vendor
    // authors freely, and Twilio's address/validation family echoes the offending
    // parameter back in it ("The 'To' number +1555... is not a valid phone
    // number"). A guarantee that "nothing raw leaves" cannot carry a field the
    // vendor writes.
    expect(summary).toEqual({
      name: 'AxiosError',
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

  it('keeps a Twilio RestException NUMERIC code, and does not report it as a bare Error', () => {
    // THE DEFECT (fix wave 2, adversarial 9). `RestException` sets `this.code`
    // as a NUMBER and never sets `this.name`, so the old string-only check
    // dropped the one discriminator that identifies the failure and the refusal
    // staff read was literally "posting to the rail failed: Error". The adapter's
    // own `twilioErrorCode` handled the numeric case correctly all along.
    class RestException extends Error {} // exactly the vendor's shape: no `name` set
    const rest = Object.assign(new RestException('Conversation is in state closed'), {
      code: 50353,
      status: 409,
    });
    expect(summarizeError(rest)).toEqual({ name: 'RestException', code: '50353', status: 409 });
  });

  it('preserves a real error name so an unexpected TypeError is still identifiable', () => {
    expect(summarizeError(new TypeError('x is not a function')).name).toBe('TypeError');
  });

  it('handles a non-Error throw without inventing fields', () => {
    expect(summarizeError('nope')).toEqual({ name: 'Error' });
  });

  it('CANNOT ITSELF THROW, even on the values that break String()', () => {
    // It runs inside catch blocks (fix wave 2, adversarial 32): a throw here
    // REPLACES the original error - on the boot fingerprint guard and on the
    // send path - so the thing that actually failed is never reported.
    const nullProto = Object.create(null) as object;
    expect(() => summarizeError(nullProto)).not.toThrow();
    expect(() => summarizeError(Symbol('boom'))).not.toThrow();
    expect(summarizeError(nullProto).name).toBe('Error');
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
    // The serializer (lib/logSerializers.ts) strips config/request/response
    // before redaction runs - the credential is ABSENT, not censored.
    expect(line).not.toContain('[REDACTED]');
  });

  it('a NETWORK-failed vendor call leaks no credential through err.request._header', () => {
    // THE PATH THE WAVE-1 LIST MISSED (fix wave 2, adversarial 5). axios sets
    // `this.request = request` as an own enumerable property, and Node's
    // http.ClientRequest carries an own-enumerable `_header`: the full serialized
    // request head, `Authorization: Basic <base64(sid:secret)>` included. pino's
    // default serializer copies it, so every generic `log.error({ err })` - the
    // Express error handler included - still wrote the credential.
    const { lines, stream } = captureLines();
    const log = createLogger({ destination: stream, level: 'warn' });
    const err = axiosLikeError() as Error & Record<string, unknown>;
    const head =
      'POST /v1/Conversations HTTP/1.1\r\n' +
      'Authorization: Basic U0tsaXZlOnNlY3JldC1hcGkta2V5\r\n' +
      'Host: conversations.twilio.com\r\n\r\n';
    err.request = { _header: head };
    err.response = { status: 500, request: { _header: head }, data: 'Body=Hi%20everyone' };

    log.warn({ err }, 'group rail creation failed');

    const line = lines.join('');
    expect(line).not.toContain('U0tsaXZlOnNlY3JldC1hcGkta2V5');
    // The serializer (lib/logSerializers.ts) strips config/request/response
    // before redaction runs - the credential is ABSENT, not censored.
    expect(line).not.toContain('[REDACTED]');
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
