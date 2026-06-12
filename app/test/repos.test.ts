// M1.1 unit tests: repo pure logic — messages SK construction, the
// delivery-status machine's allowed transitions, preview truncation, and the
// breaker's minute bucketing. (Conditional-write/idempotency behavior against
// real DynamoDB lives in messaging.integration.test.ts.)
import { describe, expect, it } from 'vitest';
import { minuteBucket, toPreview } from '../src/repos/conversationsRepo.js';
import { allowedPriorStatuses, buildTsMsgId } from '../src/repos/messagesRepo.js';

describe('messages SK construction (`<ISO ts>#<msgId>`)', () => {
  it('uses the PROVIDER timestamp + provider SID — deterministic across redeliveries', () => {
    const a = buildTsMsgId('2026-06-12T10:00:00.000Z', 'SM123');
    const b = buildTsMsgId('2026-06-12T10:00:00.000Z', 'SM123');
    expect(a).toBe('2026-06-12T10:00:00.000Z#SM123');
    expect(b).toBe(a); // same provider message -> same key, every delivery
  });

  it('sorts chronologically as a plain string (ISO 8601 prefix)', () => {
    const earlier = buildTsMsgId('2026-06-12T09:59:59.999Z', 'SM999');
    const later = buildTsMsgId('2026-06-12T10:00:00.000Z', 'SM000');
    expect(earlier < later).toBe(true);
  });
});

describe('delivery-status machine (queued → sent → delivered | undelivered | failed)', () => {
  it('moves forward only', () => {
    expect(allowedPriorStatuses('sent')).toEqual(['queued']);
    expect(allowedPriorStatuses('delivered')).toEqual(['queued', 'sent']);
    expect(allowedPriorStatuses('undelivered')).toEqual(['queued', 'sent']);
    expect(allowedPriorStatuses('failed')).toEqual(['queued', 'sent']);
  });

  it('nothing transitions INTO queued, and delivered can never be overwritten', () => {
    expect(allowedPriorStatuses('queued')).toEqual([]);
    for (const next of ['sent', 'delivered', 'undelivered', 'failed'] as const) {
      expect(allowedPriorStatuses(next)).not.toContain('delivered');
    }
  });
});

describe('conversation preview truncation', () => {
  it('passes short bodies through and leaves undefined alone', () => {
    expect(toPreview('hello')).toBe('hello');
    expect(toPreview(undefined)).toBeUndefined();
  });

  it('truncates long bodies to 120 chars with an ellipsis', () => {
    const preview = toPreview('x'.repeat(500))!;
    expect(preview).toHaveLength(120);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('breaker minute bucketing', () => {
  it('buckets to the UTC minute', () => {
    expect(minuteBucket(new Date('2026-06-12T15:04:59.999Z'))).toBe('2026-06-12T15:04');
    expect(minuteBucket(new Date('2026-06-12T15:05:00.000Z'))).toBe('2026-06-12T15:05');
  });
});
