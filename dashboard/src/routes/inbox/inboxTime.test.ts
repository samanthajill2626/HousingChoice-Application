import { describe, expect, it } from 'vitest';
import { formatInboxTime, formatInboxTimeFull } from './inboxTime.js';

// Every instant is built with the LOCAL-time constructor so the tier logic is
// exercised in whatever zone the runner has (spec 5.3: local calendar days).
const now = new Date(2026, 8, 25, 15, 30); // Sep 25 2026 15:30 local
const iso = (d: Date): string => d.toISOString();

describe('formatInboxTime', () => {
  it('same local day -> clock time with a plain space before AM/PM', () => {
    expect(formatInboxTime(iso(new Date(2026, 8, 25, 14, 14)), now)).toBe('2:14 PM');
    expect(formatInboxTime(iso(new Date(2026, 8, 25, 0, 5)), now)).toBe('12:05 AM');
  });

  it('a minute after local midnight is today; a minute before is Yesterday', () => {
    expect(formatInboxTime(iso(new Date(2026, 8, 25, 0, 1)), now)).toBe('12:01 AM');
    expect(formatInboxTime(iso(new Date(2026, 8, 24, 23, 59)), now)).toBe('Yesterday');
  });

  it('the previous local day -> Yesterday regardless of hour', () => {
    expect(formatInboxTime(iso(new Date(2026, 8, 24, 9, 0)), now)).toBe('Yesterday');
  });

  it('earlier this local year -> month and day', () => {
    expect(formatInboxTime(iso(new Date(2026, 8, 12, 9, 0)), now)).toBe('Sep 12');
    expect(formatInboxTime(iso(new Date(2026, 0, 1, 0, 0)), now)).toBe('Jan 1');
  });

  it('another year -> month, day and year', () => {
    expect(formatInboxTime(iso(new Date(2025, 11, 31, 23, 59)), now)).toBe('Dec 31, 2025');
    expect(formatInboxTime(iso(new Date(2025, 8, 12, 9, 0)), now)).toBe('Sep 12, 2025');
  });

  it('two days ago is a date, never a weekday', () => {
    expect(formatInboxTime(iso(new Date(2026, 8, 23, 9, 0)), now)).toBe('Sep 23');
  });

  it('a future instant today is a clock time; a future day is a date', () => {
    expect(formatInboxTime(iso(new Date(2026, 8, 25, 23, 0)), now)).toBe('11:00 PM');
    expect(formatInboxTime(iso(new Date(2026, 8, 26, 1, 0)), now)).toBe('Sep 26');
  });

  // Review Focus 1: the local day, not the UTC day, decides the tier. Only
  // meaningful off UTC; skipped with a reason on a UTC runner.
  it('an instant whose UTC date differs from its local date follows the local date', (ctx) => {
    if (new Date(2026, 8, 25).getTimezoneOffset() === 0) {
      ctx.skip();
      return;
    }
    const lateLocal = new Date(2026, 8, 25, 23, 30);
    expect(formatInboxTime(iso(lateLocal), now)).toBe('11:30 PM');
  });

  it('accepts a #-suffixed sort key by normalizing it', () => {
    expect(formatInboxTime(`${iso(new Date(2026, 8, 25, 14, 14))}#abc`, now)).toBe('2:14 PM');
  });

  it('returns an empty string for an unparseable instant', () => {
    expect(formatInboxTime('not-a-date', now)).toBe('');
    expect(formatInboxTime('', now)).toBe('');
  });
});

describe('formatInboxTimeFull', () => {
  it('renders month, day, year and clock time', () => {
    expect(formatInboxTimeFull(iso(new Date(2026, 8, 12, 14, 14)))).toBe('Sep 12, 2026, 2:14 PM');
  });
  it('returns an empty string for an unparseable instant', () => {
    expect(formatInboxTimeFull('nope')).toBe('');
  });
});
