// The attempt order key (spec D2): attempts order by the message id, which is
// `<provider ISO>#<SID>` (messagesRepo.buildTsMsgId); a row-less attempt (the
// reconcile's unresolved close of a retry never appended) sorts right after the
// row it retried; a seeded legacy ledger entry sorts before every real attempt.
import { describe, expect, it } from 'vitest';
import {
  LEGACY_ATTEMPT_KEY, attemptKeyTimestampMs, compareAttemptKeys, isRowlessAttemptKey,
  retriedOfRowless, rowlessAttemptKey,
} from '../src/lib/shareAttemptOrder.js';

const ROOT = '2026-09-28T10:00:00.000Z#SM00000000000000000000000000000001';
const RETRY = '2026-09-28T10:01:00.000Z#SM00000000000000000000000000000002';

describe('shareAttemptOrder', () => {
  it('a later provider timestamp is the newer attempt', () => {
    expect(compareAttemptKeys(RETRY, ROOT)).toBe(1);
    expect(compareAttemptKeys(ROOT, RETRY)).toBe(-1);
    expect(compareAttemptKeys(ROOT, ROOT)).toBe(0);
  });
  it('a row-less attempt sorts after the row it retried and before any later row', () => {
    const marker = rowlessAttemptKey(ROOT);
    expect(isRowlessAttemptKey(marker)).toBe(true);
    expect(retriedOfRowless(marker)).toBe(ROOT);
    expect(compareAttemptKeys(marker, ROOT)).toBe(1);
    expect(compareAttemptKeys(RETRY, marker)).toBe(1);
  });
  it('a same-second SID that sorts lower still loses to the marker (the suffix outranks any SID character)', () => {
    const sameSecondLowerSid = '2026-09-28T10:00:00.000Z#SM00000000000000000000000000000000';
    expect(compareAttemptKeys(rowlessAttemptKey(ROOT), sameSecondLowerSid)).toBe(1);
  });
  it('the legacy key sorts before every real attempt and has no timestamp', () => {
    expect(compareAttemptKeys(LEGACY_ATTEMPT_KEY, ROOT)).toBe(-1);
    expect(attemptKeyTimestampMs(LEGACY_ATTEMPT_KEY)).toBeUndefined();
  });
  it('attemptKeyTimestampMs reads the ISO prefix of a real key and of a row-less marker', () => {
    expect(attemptKeyTimestampMs(ROOT)).toBe(Date.parse('2026-09-28T10:00:00.000Z'));
    expect(attemptKeyTimestampMs(rowlessAttemptKey(ROOT))).toBe(Date.parse('2026-09-28T10:00:00.000Z'));
    expect(attemptKeyTimestampMs('garbage')).toBeUndefined();
  });
});
