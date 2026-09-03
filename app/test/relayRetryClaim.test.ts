// Identity for the relay 30003 retry ladder (spec D3, D5, D6). Pure helpers -
// no repo, no adapter, no DynamoDB - so the webhook that CLAIMS a rung and the
// job that SENDS it cannot disagree about which rung they are on.
import { describe, expect, it } from 'vitest';
import {
  MAX_RELAY_RETRY_ATTEMPTS,
  relayRetryBackoffMs,
  relayRetryDigest,
  relayRetryProviderSid,
  type RelayRetryClaimOutcome,
} from '../src/lib/relayRetryClaim.js';

describe('relayRetryClaim identity', () => {
  it('is deterministic for the same root, destination and attempt', () => {
    const d = relayRetryDigest('2026-09-02T10:00:00.000Z#SM123', '+15558675309');
    expect(relayRetryDigest('2026-09-02T10:00:00.000Z#SM123', '+15558675309')).toBe(d);
    expect(relayRetryProviderSid(d, 1)).toBe(relayRetryProviderSid(d, 1));
  });

  it('separates ladders by destination and by attempt', () => {
    const root = '2026-09-02T10:00:00.000Z#SM123';
    const a = relayRetryDigest(root, '+15558675309');
    const b = relayRetryDigest(root, '+15558675310');
    expect(a).not.toBe(b);
    expect(relayRetryProviderSid(a, 1)).not.toBe(relayRetryProviderSid(a, 2));
  });

  // D3: the SID becomes the second half of a sort key that splits on the FIRST
  // '#', and a phone in a sort key is a PII leak. Both are structural.
  it('emits no "#" and no phone digits from the destination', () => {
    const sid = relayRetryProviderSid(
      relayRetryDigest('2026-09-02T10:00:00.000Z#SM123', '+15558675309'),
      2,
    );
    expect(sid).not.toContain('#');
    expect(sid).not.toContain('5558675309');
    expect(sid).toMatch(/^relayretry-[0-9a-f]{16}-[1-3]$/);
  });

  it('matches the 1:1 ladder policy', () => {
    expect(MAX_RELAY_RETRY_ATTEMPTS).toBe(3);
    expect([1, 2, 3].map((n) => relayRetryBackoffMs(n))).toEqual([60_000, 120_000, 240_000]);
  });
});

describe('RelayRetryClaimOutcome', () => {
  // D23 + adjudication S2a: the union is the SHARED vocabulary of the webhook's
  // retryClaim log field and the job's own close paths. A Record keyed by the
  // union is exhaustive in BOTH directions - a missing member and an extra key
  // are each a compile error - so this list cannot drift from the type.
  it('enumerates exactly the twelve claim outcomes', () => {
    const outcomes: Record<RelayRetryClaimOutcome, true> = {
      claimed: true,
      already_claimed: true,
      cap_exhausted: true,
      gate_refused: true,
      fenced_announcement: true,
      to_missing: true,
      to_malformed: true,
      source_unreadable: true,
      slot_ineligible: true,
      code_not_retryable: true,
      enqueue_failed: true,
      // Code review R1, F2: an internal fault WHILE claiming - the helper threw.
      claim_failed: true,
    };
    expect(Object.keys(outcomes).sort()).toEqual(
      [
        'already_claimed',
        'cap_exhausted',
        'claim_failed',
        'claimed',
        'code_not_retryable',
        'enqueue_failed',
        'fenced_announcement',
        'gate_refused',
        'slot_ineligible',
        'source_unreadable',
        'to_malformed',
        'to_missing',
      ].sort(),
    );
  });
});
