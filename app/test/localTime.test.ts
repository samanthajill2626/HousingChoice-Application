import { describe, expect, it } from 'vitest';
import { formatLocalDate, formatLocalTime, toAscii } from '../src/lib/localTime.js';

const NY = 'America/New_York';

describe('toAscii (the normalizer itself, pinned directly)', () => {
  // While the host ICU emits plain ASCII spaces, the output tests below pass
  // whether or not the normalizer works - a no-op toAscii is invisible to them.
  // This pins the mechanism so a future Node/ICU bump lands on a PROVEN
  // normalizer instead of silently shipping U+202F into SMS bodies.
  // String.fromCharCode keeps this file free of non-ASCII AND of \u escapes.
  it('replaces U+202F NARROW NO-BREAK SPACE with a plain space', () => {
    expect(toAscii('3:00' + String.fromCharCode(0x202f) + 'PM')).toBe('3:00 PM');
  });

  it('replaces U+00A0 NO-BREAK SPACE with a plain space', () => {
    expect(toAscii('3:00' + String.fromCharCode(0x00a0) + 'PM')).toBe('3:00 PM');
  });

  it('leaves plain ASCII untouched', () => {
    expect(toAscii('Thu, Jul 23 at 3:00 PM')).toBe('Thu, Jul 23 at 3:00 PM');
  });
});

describe('formatLocalDate', () => {
  it('renders weekday, month and day in the given zone', () => {
    // 2026-07-23T19:00Z == Jul 23 15:00 EDT
    expect(formatLocalDate('2026-07-23T19:00:00.000Z', NY)).toBe('Thu, Jul 23');
  });

  it('uses the LOCAL day, not the UTC day', () => {
    // 2026-07-23T01:00Z == Jul 22 21:00 EDT - the local date is the 22nd.
    expect(formatLocalDate('2026-07-23T01:00:00.000Z', NY)).toBe('Wed, Jul 22');
  });

  it('honors a non-US zone', () => {
    expect(formatLocalDate('2026-07-23T19:00:00.000Z', 'Asia/Tokyo')).toBe('Fri, Jul 24');
  });
});

describe('formatLocalTime', () => {
  it('renders 12-hour time with a meridiem', () => {
    expect(formatLocalTime('2026-07-23T19:00:00.000Z', NY)).toBe('3:00 PM');
  });

  it('renders local midnight as 12:00 AM, not 0:00 or 24:00', () => {
    // 2026-07-23T04:00Z == Jul 23 00:00 EDT
    expect(formatLocalTime('2026-07-23T04:00:00.000Z', NY)).toBe('12:00 AM');
  });

  it('renders local noon as 12:00 PM', () => {
    expect(formatLocalTime('2026-07-23T16:00:00.000Z', NY)).toBe('12:00 PM');
  });

  it('is correct on both sides of a DST boundary', () => {
    // EST (UTC-5) in January, EDT (UTC-4) in July - same UTC clock time.
    expect(formatLocalTime('2026-01-15T17:00:00.000Z', NY)).toBe('12:00 PM');
    expect(formatLocalTime('2026-07-15T17:00:00.000Z', NY)).toBe('1:00 PM');
  });
});

describe('output is always ASCII (the SMS budget depends on it)', () => {
  // ICU 72 shipped U+202F NARROW NO-BREAK SPACE before AM/PM. One of those flips
  // a whole reminder to UCS-2 and halves its budget, so the formatters normalize
  // it and this test is the tripwire for a future Node/ICU bump.
  const NON_ASCII = /[^\x20-\x7e]/;
  const instants = [
    '2026-01-15T17:00:00.000Z', '2026-07-15T17:00:00.000Z',
    '2026-07-23T04:00:00.000Z', '2026-07-23T16:00:00.000Z',
  ];
  for (const iso of instants) {
    it(`no non-ASCII in either formatter at ${iso}`, () => {
      expect(formatLocalDate(iso, NY)).not.toMatch(NON_ASCII);
      expect(formatLocalTime(iso, NY)).not.toMatch(NON_ASCII);
    });
  }
});
