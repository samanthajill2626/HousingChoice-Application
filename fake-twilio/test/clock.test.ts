// fake-twilio/test/clock.test.ts
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/engine/clock.js';

describe('ManualClock', () => {
  it('returns a fixed ISO time and advances deterministically', () => {
    const clock = new ManualClock('2026-06-15T00:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-06-15T00:00:00.000Z');
    clock.advance(1500);
    expect(clock.nowIso()).toBe('2026-06-15T00:00:01.500Z');
  });

  it('runs scheduled callbacks in order when flushed', () => {
    const clock = new ManualClock('2026-06-15T00:00:00.000Z');
    const order: string[] = [];
    clock.schedule(200, () => order.push('b'));
    clock.schedule(100, () => order.push('a'));
    clock.flush();
    expect(order).toEqual(['a', 'b']);
  });
});
