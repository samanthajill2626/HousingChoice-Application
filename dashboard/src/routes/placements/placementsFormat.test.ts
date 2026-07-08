import { describe, expect, it } from 'vitest';
import { dateTime, historyTitle, humanizeToken, shortDate, summarizeHistory } from './placementsFormat.js';

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
