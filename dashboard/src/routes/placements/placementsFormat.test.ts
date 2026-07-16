import { describe, expect, it } from 'vitest';
import {
  closesAt,
  dateTime,
  expiresOn,
  historyTitle,
  humanizeToken,
  scheduledFor,
  shortDate,
  sinceWhen,
  summarizeHistory,
  wasDue,
} from './placementsFormat.js';

describe('dateTime / shortDate normalise the audit sort-key suffix (never render it raw)', () => {
  const CLEAN = '2026-06-01T14:05:45.000Z';
  // Audit/timeline SORT KEYS are `<ISO>#<collision suffix>` — new Date() can't parse
  // them, so the raw key used to leak into the History panel.
  const SORTKEY = `${CLEAN}#33937ff7`;

  it('dateTime formats a <ISO>#<suffix> sort key identically to the clean ISO', () => {
    expect(dateTime(SORTKEY)).toBe(dateTime(CLEAN));
    expect(dateTime(SORTKEY)).not.toContain('#');
  });

  it('shortDate formats a <ISO>#<suffix> sort key identically to the clean ISO', () => {
    expect(shortDate(SORTKEY)).toBe(shortDate(CLEAN));
    expect(shortDate(SORTKEY)).not.toContain('#');
  });

  it('shortDate treats a date-only string (tour_date / inspection_date) as a LOCAL calendar date, not UTC midnight', () => {
    // new Date('2026-07-16') parses as UTC midnight, which renders as "Jul 15" in
    // negative-offset US timezones — a real off-by-one on every tour/inspection date.
    expect(shortDate('2026-07-16')).toBe('Jul 16');
  });

  it('shortDate still formats a full ISO instant correctly (mid-day UTC, TZ-stable for US timezones)', () => {
    expect(shortDate('2026-07-16T12:00:00.000Z')).toBe('Jul 16');
  });
});

describe('summarizeHistory (M6 — human labels, never raw snake_case)', () => {
  it('labels a placement_stage_changed from→to via STAGE_LABELS', () => {
    const summary = summarizeHistory('placement_stage_changed', {
      from: 'awaiting_inspection',
      to: 'determine_rent',
      source: 'manual',
    });
    expect(summary).toBe('Awaiting inspection → Determine rent (manual)');
    // Never the raw snake_case.
    expect(summary).not.toMatch(/awaiting_inspection|determine_rent/);
  });

  it('labels a tenant_status_changed via TENANT_STATUS_LABELS', () => {
    expect(summarizeHistory('tenant_status_changed', { from: 'searching', to: 'placing' })).toBe(
      'Searching → Placing',
    );
  });

  it('labels a listing_status_changed via LISTING_STATUS_LABELS', () => {
    expect(summarizeHistory('listing_status_changed', { from: 'available', to: 'under_application' })).toBe(
      'Available → Under application',
    );
  });

  it('humanizes from/to for any other event_type (never raw snake_case)', () => {
    expect(summarizeHistory('something_else', { to: 'some_value' })).toBe('→ Some value');
  });

  it('falls back to a humanized event_type when there is no from/to', () => {
    expect(summarizeHistory('placement_reopened', undefined)).toBe('Placement reopened');
  });
});

describe('historyTitle (readable event title)', () => {
  it('maps known event types to readable titles', () => {
    expect(historyTitle('placement_stage_changed')).toBe('Stage changed');
    expect(historyTitle('tenant_status_changed')).toBe('Tenant status changed');
    expect(historyTitle('listing_status_changed')).toBe('Property status changed');
  });

  it('humanizes an unknown event type', () => {
    expect(historyTitle('placement_note_added')).toBe('Placement note added');
  });
});

describe('humanizeToken', () => {
  it('sentence-placements a snake_case token', () => {
    expect(humanizeToken('placement_stage_changed')).toBe('Placement stage changed');
    expect(humanizeToken('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Date-vocabulary formatters (spec section 6): a date never stands alone; it
// always rides a verb phrase, with the shared coarse relative span (Nm/Nh/Nd)
// in parens. `now` is injected as the trailing arg (the file's idiom). Instants
// are noon-UTC (day- and weekday-stable across US timezones, like the existing
// shortDate tests); the DATE label is reconstructed with the same Intl options
// so the assertion is TZ-robust, while the meaningful verb + relative span are
// literal. Sub-day cases exercise the h/m buckets; multi-day the d bucket.
// ---------------------------------------------------------------------------
describe('date-vocabulary formatters', () => {
  const NOW = Date.parse('2026-07-15T12:00:00.000Z'); // a Wednesday
  const sd = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // Weekday + shortDate, no comma -> "Fri Jul 17" (matches weekdayDate's composition).
  const wd = (iso: string) => `${new Date(iso).toLocaleDateString('en-US', { weekday: 'short' })} ${sd(iso)}`;

  describe('scheduledFor (future appointment)', () => {
    it('multi-day future adds the "(in Nd)" relative span with a weekday label', () => {
      const iso = '2026-07-17T12:00:00.000Z'; // +2 days
      expect(scheduledFor(iso, NOW)).toBe(`scheduled for ${wd(iso)} (in 2d)`);
    });
    it('under a day reads in hours', () => {
      const iso = '2026-07-15T18:00:00.000Z'; // +6h
      expect(scheduledFor(iso, NOW)).toBe(`scheduled for ${wd(iso)} (in 6h)`);
    });
    it('under an hour reads in minutes', () => {
      const iso = '2026-07-15T12:30:00.000Z'; // +30m
      expect(scheduledFor(iso, NOW)).toBe(`scheduled for ${wd(iso)} (in 30m)`);
    });
    it('a past appointment drops the relative parens', () => {
      const iso = '2026-07-13T12:00:00.000Z'; // -2 days
      expect(scheduledFor(iso, NOW)).toBe(`scheduled for ${wd(iso)}`);
    });
    it('renders a date-only inspection date as a LOCAL weekday label (never a day off)', () => {
      // Jul 17 2026 is a Friday; date-only is parsed as local calendar parts.
      expect(scheduledFor('2026-07-17', NOW)).toMatch(/^scheduled for Fri Jul 17 \(in \d+[mhd]\)$/);
    });
    it('returns "" for an empty/unparseable value', () => {
      expect(scheduledFor('', NOW)).toBe('');
    });
  });

  describe('expiresOn (deadline)', () => {
    it('future deadline reads "expires X (in Nd)"', () => {
      const iso = '2026-08-02T12:00:00.000Z'; // +18 days
      expect(expiresOn(iso, NOW)).toBe(`expires ${sd(iso)} (in 18d)`);
    });
    it('under a day reads in hours', () => {
      const iso = '2026-07-15T18:00:00.000Z'; // +6h
      expect(expiresOn(iso, NOW)).toBe(`expires ${sd(iso)} (in 6h)`);
    });
    it('a past deadline flips to "expired X (N ago)"', () => {
      const iso = '2026-07-13T12:00:00.000Z'; // -2 days
      expect(expiresOn(iso, NOW)).toBe(`expired ${sd(iso)} (2d ago)`);
    });
    it('returns "" for an empty value', () => {
      expect(expiresOn('', NOW)).toBe('');
    });
  });

  describe('closesAt (RTA-window deadline)', () => {
    it('future close reads "closes at X (in Nh)"', () => {
      const iso = '2026-07-16T09:00:00.000Z'; // +21h
      expect(closesAt(iso, NOW)).toBe(`closes at ${sd(iso)} (in 21h)`);
    });
    it('multi-day future reads in days', () => {
      const iso = '2026-07-18T12:00:00.000Z'; // +3 days
      expect(closesAt(iso, NOW)).toBe(`closes at ${sd(iso)} (in 3d)`);
    });
    it('a past close flips to "closed at X (N ago)"', () => {
      const iso = '2026-07-13T12:00:00.000Z'; // -2 days
      expect(closesAt(iso, NOW)).toBe(`closed at ${sd(iso)} (2d ago)`);
    });
  });

  describe('sinceWhen (elapsed / stuck)', () => {
    it('reads "since X (N ago)" for a multi-day-elapsed instant', () => {
      const iso = '2026-07-12T12:00:00.000Z'; // -3 days
      expect(sinceWhen(iso, NOW)).toBe(`since ${sd(iso)} (3d ago)`);
    });
    it('under a day reads in hours', () => {
      const iso = '2026-07-15T06:00:00.000Z'; // -6h
      expect(sinceWhen(iso, NOW)).toBe(`since ${sd(iso)} (6h ago)`);
    });
    it('under an hour reads in minutes', () => {
      const iso = '2026-07-15T11:30:00.000Z'; // -30m
      expect(sinceWhen(iso, NOW)).toBe(`since ${sd(iso)} (30m ago)`);
    });
  });

  describe('wasDue (overdue)', () => {
    it('reads "was due X (N overdue)" with a weekday label', () => {
      const iso = '2026-07-13T12:00:00.000Z'; // -2 days (a Monday)
      expect(wasDue(iso, NOW)).toBe(`was due ${wd(iso)} (2d overdue)`);
    });
    it('under a day overdue reads in hours', () => {
      const iso = '2026-07-15T06:00:00.000Z'; // -6h
      expect(wasDue(iso, NOW)).toBe(`was due ${wd(iso)} (6h overdue)`);
    });
    it('a not-yet-due instant reads "due X (in N)"', () => {
      const iso = '2026-07-16T12:00:00.000Z'; // +24h
      expect(wasDue(iso, NOW)).toBe(`due ${wd(iso)} (in 24h)`);
    });
  });
});
