// tourTimeWarning — the confirmable odd-time check both tour datetime dialogs
// share: past and >14-days-out values warn (the dialogs then require a second
// submit); empty (timeless) and unparseable values are not this check's job.
import { describe, expect, it } from 'vitest';
import { FAR_FUTURE_DAYS, tourTimeWarning } from './tourTime.js';

/** A datetime-local value `msFromNow` relative to `now`, in host-local time
 *  (mirrors how the dialogs' values parse back via `new Date(local)`). */
function localDatetime(now: number, msFromNow: number): string {
  const d = new Date(now + msFromNow);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const DAY = 24 * 3_600_000;
// A fixed whole-minute "now" so localDatetime round-trips exactly (datetime-local
// has minute precision; a seconds-bearing now would make "exactly now" drift).
const NOW = new Date('2026-07-09T12:00:00').getTime();

describe('tourTimeWarning', () => {
  it('returns null for an empty value (a timeless tour)', () => {
    expect(tourTimeWarning('', NOW)).toBeNull();
  });

  it('returns null for an unparseable value (native validation owns garbage)', () => {
    expect(tourTimeWarning('not-a-date', NOW)).toBeNull();
  });

  it('warns for a past time', () => {
    expect(tourTimeWarning(localDatetime(NOW, -3_600_000), NOW)).toMatch(/in the past/);
  });

  it('treats exactly-now as past (a tour must be in the future to be unremarkable)', () => {
    expect(tourTimeWarning(localDatetime(NOW, 0), NOW)).toMatch(/in the past/);
  });

  it('returns null inside the ordinary window (1 hour to 14 days out)', () => {
    expect(tourTimeWarning(localDatetime(NOW, 3_600_000), NOW)).toBeNull();
    expect(tourTimeWarning(localDatetime(NOW, 13 * DAY), NOW)).toBeNull();
    expect(tourTimeWarning(localDatetime(NOW, FAR_FUTURE_DAYS * DAY), NOW)).toBeNull();
  });

  it(`warns beyond ${FAR_FUTURE_DAYS} days out`, () => {
    expect(tourTimeWarning(localDatetime(NOW, 15 * DAY), NOW)).toMatch(/more than 14 days/);
  });
});
