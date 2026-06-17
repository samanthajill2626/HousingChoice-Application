import { describe, expect, it } from 'vitest';
import { contactPhones, defaultPhone, defaultPhoneLabel } from './contactPhones.js';
import type { Contact } from '../../api/index.js';

function contactOf(partial: Partial<Contact>): Contact {
  return { contactId: 'k1', type: 'tenant', ...partial };
}

describe('contactPhones', () => {
  it('uses C1 phones[] when present', () => {
    const phones = [
      { phone: '+14040100007', primary: false },
      { phone: '+14705550148', primary: true },
    ];
    expect(contactPhones(contactOf({ phones }))).toEqual(phones);
  });

  it('synthesizes a single primary from the legacy phone', () => {
    expect(contactPhones(contactOf({ phone: '+14040100007' }))).toEqual([
      { phone: '+14040100007', primary: true },
    ]);
  });

  it('returns [] when there is no number', () => {
    expect(contactPhones(contactOf({}))).toEqual([]);
  });
});

describe('defaultPhone', () => {
  it('prefers the primary', () => {
    const phones = [
      { phone: '+1a', primary: false, lastSeenAt: '2026-06-10T00:00:00Z' },
      { phone: '+1b', primary: true },
    ];
    expect(defaultPhone(phones)?.phone).toBe('+1b');
  });

  it('falls back to most-recent lastSeenAt when no primary', () => {
    const phones = [
      { phone: '+1a', primary: false, lastSeenAt: '2026-06-08T00:00:00Z' },
      { phone: '+1b', primary: false, lastSeenAt: '2026-06-10T00:00:00Z' },
    ];
    expect(defaultPhone(phones)?.phone).toBe('+1b');
  });

  it('falls back to the first when nothing else distinguishes', () => {
    const phones = [
      { phone: '+1a', primary: false },
      { phone: '+1b', primary: false },
    ];
    expect(defaultPhone(phones)?.phone).toBe('+1a');
    expect(defaultPhone([])).toBeUndefined();
  });
});

describe('defaultPhoneLabel', () => {
  it('labels primary vs most recent vs none', () => {
    expect(defaultPhoneLabel([{ phone: '+1b', primary: true }])).toBe('primary');
    expect(defaultPhoneLabel([{ phone: '+1b', primary: false, lastSeenAt: 'x' }])).toBe(
      'most recent',
    );
    expect(defaultPhoneLabel([{ phone: '+1b', primary: false }])).toBe('');
    expect(defaultPhoneLabel([])).toBe('');
  });
});
