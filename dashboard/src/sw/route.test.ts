// Unit tests for the SW notification-click routing core (C1 security fix).
// These lock the same-origin / allow-list guarantees that public/sw.js mirrors.
import { describe, expect, it } from 'vitest';
import { assertSameOriginPath, isPlausibleId, resolveSafePath } from './route';

const ORIGIN = 'https://app.housingchoice.test';

describe('isPlausibleId', () => {
  it('accepts a plain opaque id', () => {
    expect(isPlausibleId('call-abc123')).toBe(true);
    expect(isPlausibleId('conv_42')).toBe(true);
  });
  it('rejects ids with a slash (path traversal)', () => {
    expect(isPlausibleId('a/b')).toBe(false);
    expect(isPlausibleId('../../etc/passwd')).toBe(false);
    expect(isPlausibleId('a\\b')).toBe(false);
  });
  it('rejects ids with a scheme colon (javascript:/data:)', () => {
    expect(isPlausibleId('javascript:alert(1)')).toBe(false);
    expect(isPlausibleId('data:text/html,x')).toBe(false);
  });
  it('rejects empty / whitespace / non-string', () => {
    expect(isPlausibleId('')).toBe(false);
    expect(isPlausibleId('a b')).toBe(false);
    expect(isPlausibleId(undefined)).toBe(false);
    expect(isPlausibleId(null)).toBe(false);
    expect(isPlausibleId(42)).toBe(false);
  });
});

describe('resolveSafePath', () => {
  it('maps a missed_call + callId to the quick-reply path', () => {
    expect(resolveSafePath({ kind: 'missed_call', callId: 'call-1' })).toBe('/quick-reply/call-1');
  });
  it('appends the action as a hash for the Android action path', () => {
    expect(resolveSafePath({ kind: 'missed_call', callId: 'call-1' }, 'qr-0')).toBe(
      '/quick-reply/call-1#action=qr-0',
    );
  });
  it('maps a conversationId to the conversation path', () => {
    expect(resolveSafePath({ kind: 'message', conversationId: 'conv-9' })).toBe(
      '/conversations/conv-9',
    );
  });
  it('URL-encodes ids', () => {
    // (A '%' is a plausible id char; verify it is encoded, not passed raw.)
    expect(resolveSafePath({ kind: 'message', conversationId: 'a%b' })).toBe('/conversations/a%25b');
  });
  it('IGNORES any payload-supplied url (no open-redirect)', () => {
    // The router never reads `url`; an off-origin url is simply not used.
    const data = { kind: 'message', conversationId: 'c1', url: 'https://evil.example/phish' } as Record<
      string,
      unknown
    >;
    expect(resolveSafePath(data)).toBe('/conversations/c1');
  });
  it('falls back to / for an off-list kind with no ids', () => {
    expect(resolveSafePath({ kind: 'test' })).toBe('/');
    expect(resolveSafePath({})).toBe('/');
    expect(resolveSafePath(undefined)).toBe('/');
  });
  it('falls back to / when a callId is implausible (slash / scheme)', () => {
    expect(resolveSafePath({ kind: 'missed_call', callId: '../evil' })).toBe('/');
    expect(resolveSafePath({ kind: 'missed_call', callId: 'javascript:alert(1)' })).toBe('/');
  });
});

describe('assertSameOriginPath', () => {
  it('passes through an allow-listed same-origin path', () => {
    expect(assertSameOriginPath('/quick-reply/call-1', ORIGIN)).toBe('/quick-reply/call-1');
    expect(assertSameOriginPath('/conversations/c1', ORIGIN)).toBe('/conversations/c1');
    expect(assertSameOriginPath('/', ORIGIN)).toBe('/');
  });
  it('rejects an absolute OFF-ORIGIN url → /', () => {
    expect(assertSameOriginPath('https://evil.example/phish', ORIGIN)).toBe('/');
    // Protocol-relative also resolves off-origin.
    expect(assertSameOriginPath('//evil.example/x', ORIGIN)).toBe('/');
  });
  it('rejects a javascript:/data: pseudo-url → /', () => {
    expect(assertSameOriginPath('javascript:alert(1)', ORIGIN)).toBe('/');
    expect(assertSameOriginPath('data:text/html,x', ORIGIN)).toBe('/');
  });
  it('rejects a same-origin path NOT on the allow-list → /', () => {
    expect(assertSameOriginPath('/admin/users', ORIGIN)).toBe('/');
    expect(assertSameOriginPath('/settings', ORIGIN)).toBe('/');
  });
  it('preserves the #action hash on a valid quick-reply path', () => {
    expect(assertSameOriginPath('/quick-reply/call-1#action=qr-0', ORIGIN)).toBe(
      '/quick-reply/call-1#action=qr-0',
    );
  });
});
