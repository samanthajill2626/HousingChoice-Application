// Security tests for the service worker's notification-click routing (C1).
//
// The threat: a push payload is UNTRUSTED input that ends in a navigation. If
// the worker ever navigated to a payload-supplied URL, a pushed notification
// would be an open-redirect / phishing sink - `new URL(absolute, origin)` does
// NOT constrain an absolute off-origin URL. These tests lock the two properties
// that prevent that: the target is derived ONLY from known fields, and the last
// gate re-asserts same-origin + allow-list before any navigate/openWindow.
//
// public/sw.js inlines a VERBATIM copy of these functions (a classic worker
// cannot import an ES module). If you change one, change both - the copy in
// sw.js is what actually runs in the browser; this module is what is tested.
import { describe, it, expect } from 'vitest';
import { isPlausibleId, resolveSafePath, assertSameOriginPath } from './route.js';

const ORIGIN = 'https://app.housingchoice.org';

describe('isPlausibleId', () => {
  it('accepts an ordinary opaque id', () => {
    expect(isPlausibleId('CA1234567890abcdef')).toBe(true);
    expect(isPlausibleId('conv-abc_123')).toBe(true);
  });

  it('rejects anything that could break out of a path segment or carry a scheme', () => {
    expect(isPlausibleId('a/b')).toBe(false); // path separator
    expect(isPlausibleId('a\\b')).toBe(false); // windows separator
    expect(isPlausibleId('javascript:alert(1)')).toBe(false); // scheme colon
    expect(isPlausibleId('has space')).toBe(false);
    expect(isPlausibleId('nul\u0000byte')).toBe(false); // NUL control char
    expect(isPlausibleId('')).toBe(false);
    expect(isPlausibleId('x'.repeat(257))).toBe(false); // length bound
  });

  it('rejects non-strings rather than coercing them', () => {
    expect(isPlausibleId(undefined)).toBe(false);
    expect(isPlausibleId(null)).toBe(false);
    expect(isPlausibleId(42)).toBe(false);
    expect(isPlausibleId({ toString: () => 'abc' })).toBe(false);
  });
});

describe('resolveSafePath', () => {
  it('routes a message push to its conversation', () => {
    expect(resolveSafePath({ kind: 'message', conversationId: 'conv-1' })).toBe(
      '/conversations/conv-1',
    );
  });

  it('routes a MISSED CALL to the conversation too - the quick-reply surface does not exist', () => {
    // The original routed to /quick-reply/<callId>. That route was never
    // rebuilt, so sending a tap there would land on the NotFound catch-all.
    // The push payload carries conversationId alongside callId precisely so
    // this has a real destination.
    expect(
      resolveSafePath({ kind: 'missed_call', callId: 'CA123', conversationId: 'conv-9' }),
    ).toBe('/conversations/conv-9');
  });

  it('ignores the action id rather than routing on it', () => {
    expect(
      resolveSafePath({ kind: 'missed_call', callId: 'CA123', conversationId: 'conv-9' }, 'qr-0'),
    ).toBe('/conversations/conv-9');
  });

  it('NEVER derives a target from a payload-supplied url - the open-redirect guard', () => {
    const hostile = { kind: 'message', url: 'https://evil.example/phish' } as never;
    expect(resolveSafePath(hostile)).toBe('/');
  });

  it('falls back to / for an implausible or absent id', () => {
    expect(resolveSafePath({ kind: 'message', conversationId: '../../etc/passwd' })).toBe('/');
    expect(resolveSafePath({ kind: 'message' })).toBe('/');
    expect(resolveSafePath(undefined)).toBe('/');
    expect(resolveSafePath(null)).toBe('/');
  });

  it('URL-encodes the id it embeds', () => {
    expect(resolveSafePath({ kind: 'message', conversationId: 'a%b' })).toBe(
      '/conversations/a%25b',
    );
  });

  it('routes kind unmatched_email to /email', () => {
    // An unmatched email has NO conversation - the tap lands on the triage queue.
    expect(resolveSafePath({ kind: 'unmatched_email' })).toBe('/email');
  });

  it('conversationId still wins over kind', () => {
    expect(resolveSafePath({ kind: 'unmatched_email', conversationId: 'c1' })).toBe(
      '/conversations/c1',
    );
  });
});

describe('assertSameOriginPath - the LAST gate before navigation', () => {
  it('passes an allow-listed same-origin path through unchanged', () => {
    expect(assertSameOriginPath('/conversations/conv-1', ORIGIN)).toBe('/conversations/conv-1');
    expect(assertSameOriginPath('/', ORIGIN)).toBe('/');
  });

  it('REFUSES an absolute off-origin URL', () => {
    expect(assertSameOriginPath('https://evil.example/phish', ORIGIN)).toBe('/');
    expect(assertSameOriginPath('//evil.example/phish', ORIGIN)).toBe('/');
  });

  it('REFUSES a non-http scheme', () => {
    expect(assertSameOriginPath('javascript:alert(1)', ORIGIN)).toBe('/');
    expect(assertSameOriginPath('data:text/html,<script>1</script>', ORIGIN)).toBe('/');
  });

  it('REFUSES a same-origin path that is not on the allow-list', () => {
    // Defence in depth: even a legitimate in-app route is refused unless it is
    // one the worker is allowed to navigate to.
    expect(assertSameOriginPath('/settings/team', ORIGIN)).toBe('/');
    expect(assertSameOriginPath('/auth/callback?code=stolen', ORIGIN)).toBe('/');
  });

  it('REFUSES the retired quick-reply path so a stale worker cannot 404 a user', () => {
    expect(assertSameOriginPath('/quick-reply/CA123', ORIGIN)).toBe('/');
  });

  it('allowlist admits exact /email only', () => {
    // EXACT match, deliberately not a prefix: /email/quarantine is a second tab
    // and never a push target, and /emails is not a route at all.
    const origin = 'https://app.example';
    expect(assertSameOriginPath('/email', origin)).toBe('/email');
    expect(assertSameOriginPath('/email/quarantine', origin)).toBe('/');
    expect(assertSameOriginPath('/emails', origin)).toBe('/');
  });

  it('strips a host that a candidate smuggled in, keeping only the path', () => {
    expect(assertSameOriginPath(`${ORIGIN}/conversations/conv-1`, ORIGIN)).toBe(
      '/conversations/conv-1',
    );
  });

  it('falls back to / on an unparseable candidate rather than throwing', () => {
    expect(assertSameOriginPath('http://[', ORIGIN)).toBe('/');
  });
});
