import { describe, expect, it } from 'vitest';
import { classifyCloudWatchError } from '../src/adapters/cloudwatch.js';

// classifyCloudWatchError turns a thrown SDK error into a coarse, PII-free kind
// so a degraded System Status read is diagnosable in the logs (the HTTP `reason`
// stays the stable `cloudwatch_error`).
describe('classifyCloudWatchError', () => {
  it('classifies credential / client-token resolution failures', () => {
    expect(classifyCloudWatchError({ name: 'CredentialsProviderError' })).toBe('credentials');
    expect(classifyCloudWatchError({ name: 'UnrecognizedClientException' })).toBe('credentials');
    expect(classifyCloudWatchError({ name: 'InvalidSignatureException' })).toBe('credentials');
    expect(classifyCloudWatchError({ name: 'ExpiredTokenException' })).toBe('credentials');
  });

  it('classifies IAM authorization denials', () => {
    expect(classifyCloudWatchError({ name: 'AccessDeniedException' })).toBe('unauthorized');
  });

  it('classifies throttling', () => {
    expect(classifyCloudWatchError({ name: 'ThrottlingException' })).toBe('throttled');
  });

  it('classifies network / timeout unreachability (SDK name or node code/errno)', () => {
    expect(classifyCloudWatchError({ name: 'TimeoutError' })).toBe('unreachable');
    expect(classifyCloudWatchError({ code: 'ECONNREFUSED' })).toBe('unreachable');
    expect(classifyCloudWatchError({ errno: 'ENOTFOUND' })).toBe('unreachable');
  });

  it('falls back to unknown for unrecognized / non-error inputs', () => {
    expect(classifyCloudWatchError(new Error('boom'))).toBe('unknown');
    expect(classifyCloudWatchError(null)).toBe('unknown');
    expect(classifyCloudWatchError(undefined)).toBe('unknown');
  });
});
