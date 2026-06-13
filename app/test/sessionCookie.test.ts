// M1.3 unit tests: the sealed-cookie primitive (lib/sessionCookie.ts) —
// round-trip, tamper rejection (any modified segment fails the GCM tag),
// expiry sealed INSIDE the token, and the minimal Cookie-header parser.
import { describe, expect, it } from 'vitest';
import { open, parseCookies, seal } from '../src/lib/sessionCookie.js';

const SECRET = 'unit-test-session-secret';

describe('seal/open round-trip', () => {
  it('opens its own output with data, issuedAt and expiresAt intact', () => {
    const now = Date.parse('2026-06-12T10:00:00.000Z');
    const token = seal({ userId: 'usr_1', role: 'va' }, { secret: SECRET, ttlMs: 1000, now });

    const opened = open(token, SECRET, now + 500);
    expect(opened).toBeDefined();
    expect(opened!.data).toEqual({ userId: 'usr_1', role: 'va' });
    expect(opened!.issuedAt).toBe(now);
    expect(opened!.expiresAt).toBe(now + 1000);
  });

  it('produces a fresh token every seal (random IV) — both still open', () => {
    const a = seal({ x: 1 }, { secret: SECRET, ttlMs: 60_000 });
    const b = seal({ x: 1 }, { secret: SECRET, ttlMs: 60_000 });
    expect(a).not.toBe(b);
    expect(open(a, SECRET)!.data).toEqual({ x: 1 });
    expect(open(b, SECRET)!.data).toEqual({ x: 1 });
  });

  it('tokens are opaque: the payload never appears in the token text', () => {
    const token = seal({ email: 'someone@housingchoice.org' }, { secret: SECRET, ttlMs: 60_000 });
    expect(token).not.toContain('someone');
    expect(token).not.toContain('housingchoice');
  });
});

describe('tamper rejection', () => {
  it('rejects a flipped character in ANY segment (version, iv, ciphertext, tag)', () => {
    const token = seal({ userId: 'usr_1' }, { secret: SECRET, ttlMs: 60_000 });
    const segments = token.split('.');
    for (let i = 0; i < segments.length; i++) {
      const tampered = [...segments] as string[];
      const seg = tampered[i] as string;
      // Flip the first character to something definitely different.
      tampered[i] = (seg[0] === 'A' ? 'B' : 'A') + seg.slice(1);
      expect(open(tampered.join('.'), SECRET), `segment ${i}`).toBeUndefined();
    }
  });

  it('rejects a token sealed with a DIFFERENT secret', () => {
    const token = seal({ userId: 'usr_1' }, { secret: 'other-secret', ttlMs: 60_000 });
    expect(open(token, SECRET)).toBeUndefined();
  });

  it('rejects garbage without throwing', () => {
    for (const garbage of [
      '',
      'v1',
      'v1..',
      'v1.a.b.c',
      'v2.AAAA.AAAA.AAAA', // wrong version
      'not even close',
      'v1.%%%.$$$.@@@',
      `v1.${'A'.repeat(16)}.${'A'.repeat(16)}.${'A'.repeat(22)}`,
    ]) {
      expect(open(garbage, SECRET), JSON.stringify(garbage)).toBeUndefined();
    }
  });
});

describe('expiry (sealed inside the token — clients cannot extend it)', () => {
  it('opens just inside the window, refuses at and beyond exp', () => {
    const now = Date.parse('2026-06-12T10:00:00.000Z');
    const token = seal({ s: 1 }, { secret: SECRET, ttlMs: 10_000, now });
    expect(open(token, SECRET, now + 9_999)).toBeDefined();
    expect(open(token, SECRET, now + 10_000)).toBeUndefined();
    expect(open(token, SECRET, now + 1_000_000)).toBeUndefined();
  });
});

describe('parseCookies', () => {
  it('parses a multi-cookie header', () => {
    expect(parseCookies('a=1; hc_session=tok.en; b=x=y')).toEqual({
      a: '1',
      hc_session: 'tok.en',
      b: 'x=y', // value keeps its own = signs
    });
  });

  it('handles quotes, URL-encoding, whitespace and malformed pairs', () => {
    expect(parseCookies(' a = "quoted" ;;; =nope; bare; b=%20hi ')).toEqual({
      a: 'quoted',
      b: ' hi',
    });
  });

  it('first occurrence wins on duplicates; empty header → empty object', () => {
    expect(parseCookies('dup=first; dup=second')).toEqual({ dup: 'first' });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });
});
