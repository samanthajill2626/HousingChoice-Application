import { describe, expect, it } from 'vitest';

import { planMmsBatches, type BatchLimits } from '../src/lib/mmsBatching.js';
import {
  OUTBOUND_MMS_MAX_MEDIA_PER_MESSAGE,
  OUTBOUND_MMS_MAX_TOTAL_BYTES,
} from '../src/lib/outboundMediaLimits.js';

const LIMITS: BatchLimits = { maxBytes: 1_000_000, maxCount: 4 };

/** Named so a failure message says WHICH attachment, not just an index. */
const att = (name: string, sizeBytes: number): { name: string; sizeBytes: number } => ({
  name,
  sizeBytes,
});

const names = (batches: { name: string }[][]): string[][] => batches.map((b) => b.map((a) => a.name));

describe('planMmsBatches', () => {
  it('keeps a send that already fits as ONE message', () => {
    const items = [att('a', 200_000), att('b', 200_000), att('c', 200_000)];
    const { batches, oversized } = planMmsBatches(items, LIMITS);
    expect(names(batches)).toEqual([['a', 'b', 'c']]);
    expect(oversized).toEqual([]);
  });

  it('a text-only send (no attachments) plans NO batches, never one empty message', () => {
    expect(planMmsBatches([], LIMITS).batches).toEqual([]);
  });

  it('splits on the BYTE budget', () => {
    // 3 x 400KB = 1.2MB, over the 1MB budget: 2 + 1.
    const items = [att('a', 400_000), att('b', 400_000), att('c', 400_000)];
    expect(names(planMmsBatches(items, LIMITS).batches)).toEqual([['a', 'b'], ['c']]);
  });

  it('splits on the COUNT budget even when the bytes would fit', () => {
    const items = [att('a', 1), att('b', 1), att('c', 1), att('d', 1), att('e', 1)];
    expect(names(planMmsBatches(items, LIMITS).batches)).toEqual([['a', 'b', 'c', 'd'], ['e']]);
  });

  it('every planned batch is within BOTH limits', () => {
    const items = Array.from({ length: 9 }, (_, i) => att(`p${i}`, 260_000));
    const { batches } = planMmsBatches(items, LIMITS);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(LIMITS.maxCount);
      expect(batch.reduce((n, a) => n + a.sizeBytes, 0)).toBeLessThanOrEqual(LIMITS.maxBytes);
    }
    // Nothing invented, nothing dropped, order intact.
    expect(batches.flat().map((a) => a.name)).toEqual(items.map((a) => a.name));
  });

  it('PRESERVES the sender-chosen order rather than packing tighter', () => {
    // A bin-packing optimum would pair the two 100KBs with the 800KB. We do not:
    // the recipient sees the photos in the order they were picked.
    const items = [att('big', 800_000), att('s1', 100_000), att('s2', 100_000), att('s3', 100_000)];
    const { batches } = planMmsBatches(items, LIMITS);
    expect(names(batches)).toEqual([['big', 's1', 's2'], ['s3']]);
  });

  it('gives an item larger than the whole budget its own batch, and REPORTS it', () => {
    const items = [att('a', 100_000), att('huge', 3_000_000), att('b', 100_000)];
    const { batches, oversized } = planMmsBatches(items, LIMITS);
    expect(names(batches)).toEqual([['a'], ['huge'], ['b']]);
    // Never silently dropped - the caller decides what to do about it.
    expect(oversized.map((a) => a.name)).toEqual(['huge']);
  });

  it('does not wedge when EVERY item is oversized', () => {
    const items = [att('x', 9_000_000), att('y', 9_000_000)];
    const { batches, oversized } = planMmsBatches(items, LIMITS);
    expect(names(batches)).toEqual([['x'], ['y']]);
    expect(oversized).toHaveLength(2);
  });

  it('treats a missing/absurd size as 0 rather than throwing (HeadObject gave us nothing)', () => {
    const items = [att('a', Number.NaN), att('b', -5), att('c', 200_000)];
    const { batches, oversized } = planMmsBatches(items, LIMITS);
    expect(names(batches)).toEqual([['a', 'b', 'c']]);
    expect(oversized).toEqual([]);
  });

  it('defaults to the shipped carrier limits', () => {
    // The prod message that got dropped: 7 attachments, 2.93MB, 3 of them ~920KB.
    const dropped = [
      att('p1', 58_101),
      att('p2', 929_757),
      att('p3', 76_934),
      att('p4', 918_527),
      att('p5', 923_368),
      att('p6', 73_092),
      att('p7', 89_528),
    ];
    const { batches } = planMmsBatches(dropped);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.reduce((n, a) => n + a.sizeBytes, 0)).toBeLessThanOrEqual(
        OUTBOUND_MMS_MAX_TOTAL_BYTES,
      );
      expect(batch.length).toBeLessThanOrEqual(OUTBOUND_MMS_MAX_MEDIA_PER_MESSAGE);
    }
  });
});
