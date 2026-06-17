import { describe, expect, it } from 'vitest';
import {
  contactDisplayName,
  dayKey,
  formatAddress,
  formatDuration,
  formatPhone,
  formatTime,
} from './format.js';

describe('formatPhone', () => {
  it('formats a US E.164 number', () => {
    expect(formatPhone('+14040100007')).toBe('(404) 010-0007');
  });
  it('returns non-US / unparseable numbers as-is', () => {
    expect(formatPhone('+447911123456')).toBe('+447911123456');
    expect(formatPhone(undefined)).toBe('');
  });
});

describe('formatTime', () => {
  it('formats morning and afternoon with a/p meridiem', () => {
    expect(formatTime('2026-06-08T09:14:00')).toBe('9:14a');
    expect(formatTime('2026-06-08T13:02:00')).toBe('1:02p');
    expect(formatTime('2026-06-08T00:05:00')).toBe('12:05a');
  });
  it('returns empty for an invalid instant', () => {
    expect(formatTime('not-a-date')).toBe('');
  });
});

describe('dayKey', () => {
  it('groups by local calendar day', () => {
    expect(dayKey('2026-06-08T23:59:00')).toBe('2026-06-08');
  });
});

describe('formatDuration', () => {
  it('formats minutes + seconds and bare seconds', () => {
    expect(formatDuration(252)).toBe('4m 12s');
    expect(formatDuration(48)).toBe('48s');
    expect(formatDuration(undefined)).toBe('');
  });
});

describe('formatAddress', () => {
  it('joins a structured address', () => {
    expect(formatAddress({ line1: '123 Main St', city: 'Atlanta', state: 'GA', zip: '30303' })).toBe(
      '123 Main St, Atlanta, GA, 30303',
    );
  });
  it('passes a plain string through', () => {
    expect(formatAddress('123 Main St, Atlanta GA')).toBe('123 Main St, Atlanta GA');
  });
});

describe('contactDisplayName', () => {
  it('prefers the name, falls back to phone then a placeholder', () => {
    expect(contactDisplayName('Tasha', 'Williams', '+14040100007')).toBe('Tasha Williams');
    expect(contactDisplayName(undefined, undefined, '+14040100007')).toBe('(404) 010-0007');
    expect(contactDisplayName(undefined, undefined, undefined)).toBe('Unknown contact');
  });
});
