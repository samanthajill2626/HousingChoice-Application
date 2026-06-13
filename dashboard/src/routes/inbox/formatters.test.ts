import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '../../api/index.js';
import { displayName, formatPhone, formatRelativeTime, needsReview } from './formatters.js';

function summary(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    conversationId: 'c1',
    type: 'tenant_1to1',
    participant_phone: '+14155550142',
    participants: [{ contactId: 'k1', phone: '+14155550142' }],
    preview: 'hi',
    last_activity_at: '2026-06-13T00:00:00.000Z',
    unread_count: 0,
    assignment: null,
    sms_opt_out: false,
    participant_display_name: null,
    ...over,
  };
}

describe('formatPhone', () => {
  it('formats a NANP +1 number as (NXX) NXX-XXXX, dropping +1', () => {
    expect(formatPhone('+14155550142')).toBe('(415) 555-0142');
  });

  it('formats a bare 10-digit number', () => {
    expect(formatPhone('4155550142')).toBe('(415) 555-0142');
  });

  it('returns a non-NANP number unchanged (never fabricated)', () => {
    expect(formatPhone('+442071838750')).toBe('+442071838750');
  });

  it('handles empty/nullish input', () => {
    expect(formatPhone('')).toBe('Unknown number');
    expect(formatPhone(null)).toBe('Unknown number');
    expect(formatPhone(undefined)).toBe('Unknown number');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-06-13T12:00:00.000Z');

  it('renders "now" for a few seconds ago', () => {
    expect(formatRelativeTime('2026-06-13T11:59:40.000Z', now)).toBe('now');
  });

  it('renders minutes', () => {
    expect(formatRelativeTime('2026-06-13T11:58:00.000Z', now)).toBe('2m');
  });

  it('renders hours', () => {
    expect(formatRelativeTime('2026-06-13T09:00:00.000Z', now)).toBe('3h');
  });

  it('renders "yesterday" for ~1 day ago', () => {
    expect(formatRelativeTime('2026-06-12T11:00:00.000Z', now)).toBe('yesterday');
  });

  it('renders day count under a week', () => {
    expect(formatRelativeTime('2026-06-09T12:00:00.000Z', now)).toBe('4d');
  });

  it('returns empty string for invalid/empty input', () => {
    expect(formatRelativeTime('', now)).toBe('');
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });
});

describe('displayName / needsReview', () => {
  it('falls back to the formatted participant phone when no resolved name', () => {
    expect(displayName(summary())).toBe('(415) 555-0142');
  });

  it('prefers the denormalized participant_display_name when present', () => {
    expect(displayName(summary({ participant_display_name: 'Keisha Jones' }))).toBe('Keisha Jones');
  });

  it('never fabricates a name — an empty resolved name falls back to the phone', () => {
    expect(displayName(summary({ participant_display_name: '' }))).toBe('(415) 555-0142');
  });

  it('flags unknown_1to1 conversations as needing review', () => {
    expect(needsReview(summary({ type: 'unknown_1to1' }))).toBe(true);
    expect(needsReview(summary({ type: 'tenant_1to1' }))).toBe(false);
  });
});
