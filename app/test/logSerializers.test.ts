// app/test/logSerializers.test.ts
import { describe, expect, it } from 'vitest';
import { LOG_SERIALIZER_KEYS, serializeLoggedError } from '../src/lib/logSerializers.js';

const FAKE_BASIC = 'Basic U0tmYWtlOnNlY3JldGZha2U='; // base64('SKfake:secretfake')

function axiosLikeError(): Error {
  const err = new Error('connect ECONNRESET 3.229.1.1:443') as Error & Record<string, unknown>;
  err.name = 'AxiosError';
  err.code = 'ECONNRESET';
  err.config = {
    url: 'https://api.twilio.com/2010-04-01/Accounts/ACfake/Messages.json',
    headers: { Authorization: FAKE_BASIC },
    data: 'To=%2B15551230000&Body=hello',
  };
  err.request = { _header: `POST /x HTTP/1.1\r\nAuthorization: ${FAKE_BASIC}\r\n\r\n` };
  err.response = { status: 500, data: 'To=%2B15551230000' };
  return err;
}

describe('serializeLoggedError', () => {
  it('exports the four wired keys', () => {
    expect([...LOG_SERIALIZER_KEYS]).toEqual(['err', 'error', 'cause', 'reason']);
  });

  it('passes primitives through unchanged (domain reason/error fields)', () => {
    expect(serializeLoggedError('signature mismatch')).toBe('signature mismatch');
    expect(serializeLoggedError(30007)).toBe(30007);
    expect(serializeLoggedError(undefined)).toBeUndefined();
    expect(serializeLoggedError(null)).toBeNull();
  });

  it('passes non-Error objects through unchanged (summarizeError / err:{name} shapes)', () => {
    const summary = { name: 'RestException', code: '30007', status: 400 };
    expect(serializeLoggedError(summary)).toBe(summary);
    const nameOnly = { name: 'ProvisioningRefused' };
    expect(serializeLoggedError(nameOnly)).toBe(nameOnly);
  });

  it('allowlists an Error: no config/request/response survive; type prefers the declared name', () => {
    const out = serializeLoggedError(axiosLikeError()) as Record<string, unknown>;
    const json = JSON.stringify(out);
    expect(json).not.toContain('U0tmYWtlOnNlY3JldGZha2U=');
    expect(json).not.toContain('15551230000');
    expect(out['type']).toBe('AxiosError');
    expect(out['message']).toContain('ECONNRESET');
    expect(typeof out['stack']).toBe('string');
    expect(out['code']).toBe('ECONNRESET');
    expect(out['status']).toBe(500); // lifted from response.status pre-drop
    expect(Object.keys(out).every((k) =>
      ['type', 'message', 'stack', 'code', 'status', 'statusCode', 'moreInfo', '$metadata', 'cause', 'aggregateErrors'].includes(k),
    )).toBe(true);
  });

  it('a plain Error and a TypeError keep their identities', () => {
    expect((serializeLoggedError(new Error('x')) as Record<string, unknown>)['type']).toBe('Error');
    expect((serializeLoggedError(new TypeError('x')) as Record<string, unknown>)['type']).toBe('TypeError');
  });

  it('projects AWS $metadata and Twilio moreInfo', () => {
    const err = new Error('boom') as Error & Record<string, unknown>;
    err.$metadata = { httpStatusCode: 400, requestId: 'r-1', attempts: 3, totalRetryDelay: 120, extra: 'DROP-ME' };
    err.moreInfo = 'https://www.twilio.com/docs/errors/30007';
    const out = serializeLoggedError(err) as Record<string, unknown>;
    expect(out['$metadata']).toEqual({ httpStatusCode: 400, requestId: 'r-1', attempts: 3, totalRetryDelay: 120 });
    expect(out['moreInfo']).toBe('https://www.twilio.com/docs/errors/30007');
  });

  it('recurses Error causes to depth 3 and DROPS non-Error causes', () => {
    const leaf = new Error('leaf');
    const mid = new Error('mid');
    (mid as Error & { cause?: unknown }).cause = leaf;
    const top = new Error('top');
    (top as Error & { cause?: unknown }).cause = mid;
    const out = serializeLoggedError(top) as { cause?: { message?: string; cause?: { message?: string } } };
    expect(out.cause?.message).toBe('mid');
    expect(out.cause?.cause?.message).toBe('leaf');

    const smuggler = new Error('outer');
    (smuggler as Error & { cause?: unknown }).cause = { config: { headers: { Authorization: FAKE_BASIC } } };
    const smuggled = serializeLoggedError(smuggler) as Record<string, unknown>;
    expect(JSON.stringify(smuggled)).not.toContain('U0tmYWtlOnNlY3JldGZha2U=');
    expect(smuggled['cause']).toBeUndefined();
  });

  it('caps AggregateError members at 5 and serializes each', () => {
    const agg = new AggregateError([1, 2, 3, 4, 5, 6, 7].map((n) => new Error(`e${n}`)), 'many');
    const out = serializeLoggedError(agg) as { aggregateErrors?: Array<{ message?: string }> };
    expect(out.aggregateErrors).toHaveLength(5);
    expect(out.aggregateErrors?.[0]?.message).toBe('e1');
  });

  it('normalizes numeric codes to strings (Twilio RestException)', () => {
    const err = new Error('rest') as Error & Record<string, unknown>;
    err.code = 30007;
    const out = serializeLoggedError(err) as Record<string, unknown>;
    expect(out['code']).toBe('30007');
  });

  it('never throws, even on hostile getters', () => {
    const hostile = new Error('h');
    Object.defineProperty(hostile, 'code', { get() { throw new Error('trap'); }, enumerable: true });
    expect(() => serializeLoggedError(hostile)).not.toThrow();
    const out = serializeLoggedError(hostile) as Record<string, unknown>;
    expect(out['type']).toBe('UnserializableError');
  });
});
