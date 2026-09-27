// app/test/sendOutcome.test.ts
// Spec D1/D2: every provider send failure is classified rejected / retryable /
// unknown. The fixtures mirror the REAL twilio-node 6.0.2 error objects (the
// SOR build spike, Q3-Q6): a Twilio rejection is a RestException with a NUMERIC
// code and a NUMERIC status; a network failure is an AxiosError with a STRING
// code and no status. Nothing here keys on `err.name` (a RestException and a
// dropped-socket AxiosError both say 'Error').
import { describe, expect, it } from 'vitest';
import { SmsSendingDisabledError } from '../src/adapters/messagingErrors.js';
import { classifySendFailure, isProviderCode } from '../src/lib/sendOutcome.js';

const restException = (status: number, code?: number | string) =>
  Object.assign(new Error('x'), { status, ...(code !== undefined && { code }) });
const networkError = (code: string) => Object.assign(new Error(code), { code });

describe('classifySendFailure (spec D1/D2)', () => {
  it('a code the arms already recognize classifies by code whatever the status says', () => {
    expect(classifySendFailure({ code: 30007 })).toMatchObject({ kind: 'rejected', code: '30007' });
    expect(classifySendFailure({ code: 30005 })).toMatchObject({ kind: 'rejected', code: '30005' });
    expect(classifySendFailure({ code: 30006 })).toMatchObject({ kind: 'rejected', code: '30006' });
    expect(classifySendFailure({ code: 429 })).toMatchObject({ kind: 'retryable', code: '429' });
    expect(classifySendFailure({ code: '30022' })).toMatchObject({ kind: 'retryable', code: '30022' });
    expect(classifySendFailure(restException(500, 30007))).toMatchObject({ kind: 'rejected', code: '30007' });
  });

  it('HTTP 5xx is unknown even with a Twilio code', () => {
    expect(classifySendFailure(restException(503, 20500))).toMatchObject({ kind: 'unknown', code: '20500', status: 503 });
  });

  it('HTTP 4xx is rejected except the rate limit', () => {
    expect(classifySendFailure(restException(400, 21211))).toMatchObject({ kind: 'rejected', code: '21211', status: 400 });
    expect(classifySendFailure(restException(401, 20003))).toMatchObject({ kind: 'rejected', code: '20003' });
    expect(classifySendFailure(restException(429, 20429))).toMatchObject({ kind: 'retryable', code: '20429', status: 429 });
    expect(classifySendFailure(restException(429))).toMatchObject({ kind: 'retryable', status: 429 });
  });

  it('a 4xx with no code (unparseable body) is still rejected - Review Focus 1', () => {
    expect(classifySendFailure(restException(400))).toEqual({ kind: 'rejected', status: 400 });
  });

  it('a code of 0 is no code', () => {
    expect(classifySendFailure(restException(400, 0))).toEqual({ kind: 'rejected', status: 400 });
    expect(classifySendFailure(restException(400, '0'))).toEqual({ kind: 'rejected', status: 400 });
  });

  it('a connection that never opened is retryable', () => {
    for (const c of ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']) {
      expect(classifySendFailure(networkError(c))).toMatchObject({ kind: 'retryable', code: c });
    }
  });

  it('a timeout or a dropped socket is unknown', () => {
    for (const c of ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']) {
      expect(classifySendFailure(networkError(c))).toMatchObject({ kind: 'unknown', code: c });
    }
  });

  it('anything it cannot place is unknown (D2), with no code', () => {
    expect(classifySendFailure(new Error('boom'))).toEqual({ kind: 'unknown' });
    expect(classifySendFailure(undefined)).toEqual({ kind: 'unknown' });
  });

  it('the adapter-level kill switch is rejected with the sms_sending_disabled token', () => {
    expect(classifySendFailure(new SmsSendingDisabledError('off'))).toEqual({ kind: 'rejected', code: 'sms_sending_disabled' });
  });

  it('classifies the real SDK error shapes, whatever their name says (build spike Q6)', () => {
    // RestException from a 400 / 21211 reject: name 'Error', numeric status and code.
    const reject = Object.assign(new Error('fail-next-send: rejected by the fake'), {
      status: 400,
      code: 21211,
      moreInfo: 'https://www.twilio.com/docs/errors/21211',
    });
    // AxiosError from a destroyed socket: name copied from its cause ('Error'),
    // a string code, and no status (drop_before_create and accept_then_drop).
    const dropped = Object.assign(new Error('socket hang up'), { isAxiosError: true, code: 'ECONNRESET' });
    // AxiosError from the SDK's own request timeout: ECONNABORTED, never ETIMEDOUT.
    const timedOut = Object.assign(new Error('timeout of 30000ms exceeded'), {
      name: 'AxiosError',
      isAxiosError: true,
      code: 'ECONNABORTED',
    });
    // RestException from a list or fetch 500.
    const unavailable = Object.assign(new Error('fail-list: provider unavailable'), { status: 500, code: 20500 });
    expect(classifySendFailure(reject)).toEqual({ kind: 'rejected', code: '21211', status: 400 });
    expect(classifySendFailure(dropped)).toEqual({ kind: 'unknown', code: 'ECONNRESET' });
    expect(classifySendFailure(timedOut)).toEqual({ kind: 'unknown', code: 'ECONNABORTED' });
    expect(classifySendFailure(unavailable)).toEqual({ kind: 'unknown', code: '20500', status: 500 });
    // The name never decides: the same timeout renamed 'Error' classifies the same.
    expect(classifySendFailure(Object.assign(timedOut, { name: 'Error' }))).toEqual({ kind: 'unknown', code: 'ECONNABORTED' });
  });

  it('isProviderCode is true for digits only', () => {
    expect(isProviderCode('20429')).toBe(true);
    expect(isProviderCode('ECONNREFUSED')).toBe(false);
    expect(isProviderCode(undefined)).toBe(false);
    expect(isProviderCode('')).toBe(false);
    expect(isProviderCode('sms_sending_disabled')).toBe(false);
    expect(isProviderCode('x20429')).toBe(false);
    expect(isProviderCode('20429x')).toBe(false);
  });
});
