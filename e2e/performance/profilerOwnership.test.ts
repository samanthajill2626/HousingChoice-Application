import { describe, expect, it, vi } from 'vitest';
import {
  assertProfilerPingIdentity,
  profilerOwnerToken,
  sendProfilerReady,
} from '../../scripts/lib/profilerOwnership.mjs';

const TOKEN = '0123456789abcdef0123456789abcdef';

describe('profiler launcher ownership contract', () => {
  it('accepts only absent or exact random-hex owner tokens', () => {
    expect(profilerOwnerToken(undefined)).toBeNull();
    expect(profilerOwnerToken(TOKEN)).toBe(TOKEN);
    expect(() => profilerOwnerToken('')).toThrowError('profiler_owner_token_invalid');
    expect(() => profilerOwnerToken('not-a-token')).toThrowError('profiler_owner_token_invalid');
  });

  it('requires the launched app to echo both the exact commit and owner token', () => {
    expect(() => assertProfilerPingIdentity({
      expectedCommit: 'abcdef1',
      expectedOwnerToken: TOKEN,
      body: { appCommit: 'abcdef1', profilerOwnerToken: TOKEN },
    })).not.toThrow();
    expect(() => assertProfilerPingIdentity({
      expectedCommit: '',
      expectedOwnerToken: TOKEN,
      body: { appCommit: '', profilerOwnerToken: TOKEN },
    })).toThrowError('profiler_commit_identity_mismatch');
    expect(() => assertProfilerPingIdentity({
      expectedCommit: 'abcdef1',
      expectedOwnerToken: TOKEN,
      body: { appCommit: 'abcdef1', profilerOwnerToken: 'fedcba9876543210fedcba9876543210' },
    })).toThrowError('profiler_owner_identity_mismatch');
  });

  it('sends readiness only through the direct child IPC channel', () => {
    const send = vi.fn();
    sendProfilerReady(TOKEN, send);
    expect(send).toHaveBeenCalledWith({ type: 'e2e-session-ready' });
    expect(() => sendProfilerReady(TOKEN, undefined)).toThrowError('profiler_ipc_unavailable');
    expect(() => sendProfilerReady(null, undefined)).not.toThrow();
  });
});
