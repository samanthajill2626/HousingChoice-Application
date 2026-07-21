// Email-channel A1: unit tests for the email address helpers (lib/email.ts).
// normalizeEmailAddress = trim + lowercase; isValidEmailAddress = a pragmatic
// RFC subset (/^[^\s@]+@[^\s@]+\.[^\s@]+$/) applied AFTER normalize. Mirrors the
// posture of lib/phone.ts: normalize is total (always returns a string),
// validity is a separate predicate.
import { describe, expect, it } from 'vitest';
import { isValidEmailAddress, normalizeEmailAddress } from '../src/lib/email.js';

describe('normalizeEmailAddress', () => {
  it('lowercases the whole address', () => {
    expect(normalizeEmailAddress('Marcus.Bell@Example.COM')).toBe('marcus.bell@example.com');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeEmailAddress('  tasha@example.com  ')).toBe('tasha@example.com');
    expect(normalizeEmailAddress('\tteam@example.com\n')).toBe('team@example.com');
  });

  it('trims AND lowercases together', () => {
    expect(normalizeEmailAddress('  USER@EXAMPLE.COM ')).toBe('user@example.com');
  });

  it('leaves an already-normalized address unchanged', () => {
    expect(normalizeEmailAddress('a@b.co')).toBe('a@b.co');
  });

  it('does not strip interior spaces (only the ends) - validity is a separate check', () => {
    // A stray interior space survives normalize (so isValidEmailAddress can reject it).
    expect(normalizeEmailAddress('  a b@c.com ')).toBe('a b@c.com');
  });
});

describe('isValidEmailAddress', () => {
  it('accepts a plain address', () => {
    expect(isValidEmailAddress('user@example.com')).toBe(true);
  });

  it('accepts an address that only becomes valid after normalize (case/space)', () => {
    expect(isValidEmailAddress('  USER@EXAMPLE.COM ')).toBe(true);
  });

  it('accepts a relay-style plus-tagged address', () => {
    expect(isValidEmailAddress('relay+tok123@mail.example.com')).toBe(true);
  });

  it('accepts a multi-label domain', () => {
    expect(isValidEmailAddress('a.b@sub.domain.co.uk')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidEmailAddress('')).toBe(false);
    expect(isValidEmailAddress('   ')).toBe(false);
  });

  it('rejects a missing @', () => {
    expect(isValidEmailAddress('userexample.com')).toBe(false);
  });

  it('rejects a domain with no dot', () => {
    expect(isValidEmailAddress('user@localhost')).toBe(false);
  });

  it('rejects an empty local part', () => {
    expect(isValidEmailAddress('@example.com')).toBe(false);
  });

  it('rejects a trailing dot with nothing after it', () => {
    expect(isValidEmailAddress('user@example.')).toBe(false);
  });

  it('rejects interior whitespace', () => {
    expect(isValidEmailAddress('a b@c.com')).toBe(false);
    expect(isValidEmailAddress('user@ex ample.com')).toBe(false);
  });

  it('rejects two @ signs', () => {
    expect(isValidEmailAddress('a@@b.com')).toBe(false);
    expect(isValidEmailAddress('a@b@c.com')).toBe(false);
  });
});
