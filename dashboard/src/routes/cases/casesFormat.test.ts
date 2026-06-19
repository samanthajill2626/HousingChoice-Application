import { describe, expect, it } from 'vitest';
import { historyTitle, humanizeToken, summarizeHistory } from './casesFormat.js';

describe('summarizeHistory (M6 — human labels, never raw snake_case)', () => {
  it('labels a case_stage_changed from→to via STAGE_LABELS', () => {
    const summary = summarizeHistory('case_stage_changed', {
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
    expect(summarizeHistory('case_reopened', undefined)).toBe('Case reopened');
  });
});

describe('historyTitle (readable event title)', () => {
  it('maps known event types to readable titles', () => {
    expect(historyTitle('case_stage_changed')).toBe('Stage changed');
    expect(historyTitle('tenant_status_changed')).toBe('Tenant status changed');
    expect(historyTitle('listing_status_changed')).toBe('Listing status changed');
  });

  it('humanizes an unknown event type', () => {
    expect(historyTitle('case_note_added')).toBe('Case note added');
  });
});

describe('humanizeToken', () => {
  it('sentence-cases a snake_case token', () => {
    expect(humanizeToken('case_stage_changed')).toBe('Case stage changed');
    expect(humanizeToken('')).toBe('');
  });
});
