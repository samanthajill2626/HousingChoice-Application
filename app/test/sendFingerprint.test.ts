// app/test/sendFingerprint.test.ts
// Spec D12/D13: the facts a reconcile matches on - a LOSSY body fingerprint
// (the Messaging Service's Smart Encoding rewrites curly quotes, dashes and
// ellipses), an owner-independent recipient digest, and phone-free keys.
// Unicode inputs are written as escapes (the repo's ASCII-only rule).
import { describe, expect, it } from 'vitest';
import {
  bodyFingerprint,
  hashRecipientKey,
  normalizeBodyForMatch,
  recipientDigest,
  safeRecipientKey,
} from '../src/lib/sendFingerprint.js';

describe('normalizeBodyForMatch (spec D13, Smart Encoding)', () => {
  const submitted = 'HC spike B \u2019quote\u2019 dash\u2014dash more\u2026 ignore';
  const stored = "HC spike B 'quote' dash-dash more... ignore"; // the 2026-09-24 spike's stored body

  it('makes the submitted and the Smart-Encoded stored body equal', () => {
    expect(normalizeBodyForMatch(submitted)).toBe(normalizeBodyForMatch(stored));
    expect(bodyFingerprint(submitted).hash).toBe(bodyFingerprint(stored).hash);
  });

  it('keeps letters and digits only, NFKC first', () => {
    expect(normalizeBodyForMatch('\uff28\uff23 42!')).toBe('HC42');
    expect(normalizeBodyForMatch(undefined)).toBe('');
  });

  it('flags a body under three normalized characters as short', () => {
    expect(bodyFingerprint('\u{1f44d}').short).toBe(true);
    expect(bodyFingerprint('ok').short).toBe(true);
    expect(bodyFingerprint('yes').short).toBe(false);
  });

  it('a STOP auto-reply never matches a share body', () => {
    expect(bodyFingerprint('You have successfully been unsubscribed. Reply START to resubscribe.').hash).not.toBe(
      bodyFingerprint('Hey Cameron, looking for a 1BR? 12 Main St is available.').hash,
    );
  });
});

describe('recipientDigest / hashRecipientKey / safeRecipientKey', () => {
  it('is keyed on the sender and owner-independent, 32 hex chars', () => {
    const a = recipientDigest('+15550009999', '+16175550100');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(recipientDigest('+15550009999', '+16175550100')).toBe(a);
    expect(recipientDigest('+15550001111', '+16175550100')).not.toBe(a);
    expect(recipientDigest(undefined, '+16175550100')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashes a phone-bearing key, leaves a contact id alone, is stable', () => {
    expect(hashRecipientKey('contact-1')).toBe('contact-1');
    expect(hashRecipientKey('phone#+16175550100')).toMatch(/^phonehash#[0-9a-f]{32}$/);
    expect(hashRecipientKey('phone#+16175550100')).toBe(hashRecipientKey('phone#+16175550100'));
  });

  it('redacts a phone-bearing key for logs', () => {
    expect(safeRecipientKey('phone#+16175550100')).toBe('phone#redacted');
    expect(safeRecipientKey('contact-1')).toBe('contact-1');
  });
});
