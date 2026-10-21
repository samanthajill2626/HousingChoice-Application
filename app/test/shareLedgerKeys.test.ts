// flyer-leads plan 2.1 (AR1): the pure share-ledger keys leaf - the key
// literals, the flyer attempt key, and the ONE "latest counted entry" rule
// that summarize (services/shareLedger.ts) and deriveListingSendOutcome
// (lib/listingSendOutcome.ts) both read. Pure - no I/O.
import { describe, expect, it } from 'vitest';
import { attemptKeyTimestampMs, compareAttemptKeys } from '../src/lib/shareAttemptOrder.js';
import { FLYER_SHARE_KEY, INDIVIDUAL_SHARE_KEY, flyerAttemptKey, latestCountedShareKey } from '../src/lib/shareLedgerKeys.js';

const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';
const T3 = '2026-10-03T00:00:00.000Z';

describe('shareLedgerKeys - the key literals and the flyer attempt key', () => {
  it('the stored key literals', () => {
    expect(INDIVIDUAL_SHARE_KEY).toBe('individual');
    expect(FLYER_SHARE_KEY).toBe('flyer');
  });

  it("flyerAttemptKey is `<iso>#flyer`: it carries the sign-up instant like every attempt key, and a later sign-up is a NEWER attempt", () => {
    const iso = '2026-10-21T15:04:05.678Z';
    expect(flyerAttemptKey(iso)).toBe('2026-10-21T15:04:05.678Z#flyer');
    expect(attemptKeyTimestampMs(flyerAttemptKey(iso))).toBe(Date.parse(iso));
    expect(compareAttemptKeys(flyerAttemptKey(T2), flyerAttemptKey(T1))).toBe(1);
  });
});

describe('latestCountedShareKey - the ONE latest-counted-entry rule', () => {
  it('undefined for no shares, an empty map, nothing counted, or a counted entry without an instant', () => {
    expect(latestCountedShareKey(undefined)).toBeUndefined();
    expect(latestCountedShareKey({})).toBeUndefined();
    expect(latestCountedShareKey({ b1: { state: 'failed' }, b2: { state: 'pending' }, b3: { state: 'unconfirmed' } })).toBeUndefined();
    expect(latestCountedShareKey({ b1: { state: 'counted' } })).toBeUndefined(); // no instant: counts nowhere
  });

  it('the greatest countedAt among COUNTED entries wins; an uncounted entry never does, however late', () => {
    expect(
      latestCountedShareKey({
        b1: { state: 'counted', countedAt: T1 },
        flyer: { state: 'counted', countedAt: T2 },
        b2: { state: 'failed', countedAt: T3 },
      }),
    ).toBe('flyer');
    expect(latestCountedShareKey({ flyer: { state: 'counted', countedAt: T1 }, b1: { state: 'counted', countedAt: T2 } })).toBe('b1');
    expect(latestCountedShareKey({ individual: { state: 'counted', countedAt: T1 } })).toBe('individual');
  });

  it("a tie keeps the FIRST entry in insertion order (summarize's strict >) - keys are never sorted", () => {
    expect(latestCountedShareKey({ zeta: { state: 'counted', countedAt: T1 }, alpha: { state: 'counted', countedAt: T1 } })).toBe('zeta');
    expect(latestCountedShareKey({ alpha: { state: 'counted', countedAt: T1 }, zeta: { state: 'counted', countedAt: T1 } })).toBe('alpha');
  });
});
