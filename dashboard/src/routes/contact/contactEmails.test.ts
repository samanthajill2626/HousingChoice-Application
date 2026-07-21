import { describe, expect, it } from 'vitest';
import {
  contactEmails,
  defaultEmail,
  defaultEmailLabel,
  isValidEmail,
  normalizeEmail,
} from './contactEmails.js';
import type { Contact } from '../../api/index.js';

function contactOf(partial: Partial<Contact>): Contact {
  return { contactId: 'k1', type: 'landlord', ...partial };
}

describe('contactEmails', () => {
  it('uses roster emails[] when present', () => {
    const emails = [
      { email: 'a@x.com', primary: false },
      { email: 'b@x.com', primary: true },
    ];
    expect(contactEmails(contactOf({ emails }))).toEqual(emails);
  });

  it('synthesizes a single primary from the legacy email', () => {
    expect(contactEmails(contactOf({ email: 'a@x.com' }))).toEqual([
      { email: 'a@x.com', primary: true },
    ]);
  });

  it('returns [] when there is no address', () => {
    expect(contactEmails(contactOf({}))).toEqual([]);
  });
});

describe('defaultEmail', () => {
  it('prefers the primary', () => {
    const emails = [
      { email: 'a@x.com', primary: false, lastSeenAt: '2026-06-10T00:00:00Z' },
      { email: 'b@x.com', primary: true },
    ];
    expect(defaultEmail(emails)?.email).toBe('b@x.com');
  });

  it('falls back to most-recent lastSeenAt when no primary', () => {
    const emails = [
      { email: 'a@x.com', primary: false, lastSeenAt: '2026-06-08T00:00:00Z' },
      { email: 'b@x.com', primary: false, lastSeenAt: '2026-06-10T00:00:00Z' },
    ];
    expect(defaultEmail(emails)?.email).toBe('b@x.com');
  });

  it('falls back to the first when nothing else distinguishes', () => {
    const emails = [
      { email: 'a@x.com', primary: false },
      { email: 'b@x.com', primary: false },
    ];
    expect(defaultEmail(emails)?.email).toBe('a@x.com');
    expect(defaultEmail([])).toBeUndefined();
  });
});

describe('defaultEmailLabel', () => {
  it('labels primary vs most recent vs none', () => {
    expect(defaultEmailLabel([{ email: 'b@x.com', primary: true }])).toBe('primary');
    expect(defaultEmailLabel([{ email: 'b@x.com', primary: false, lastSeenAt: 'x' }])).toBe(
      'most recent',
    );
    expect(defaultEmailLabel([{ email: 'b@x.com', primary: false }])).toBe('');
    expect(defaultEmailLabel([])).toBe('');
  });
});

describe('isValidEmail', () => {
  it('accepts a normal address (case/space-insensitive)', () => {
    expect(isValidEmail('a@x.com')).toBe(true);
    expect(isValidEmail('  Marcus@Example.COM ')).toBe(true);
  });

  it('rejects the obvious garbage', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false); // dotless domain
    expect(isValidEmail('a b@x.com')).toBe(false); // interior space
    expect(isValidEmail('a@@x.com')).toBe(false); // two @
  });
});

describe('normalizeEmail', () => {
  it('trims + lowercases', () => {
    expect(normalizeEmail('  Marcus@Example.COM ')).toBe('marcus@example.com');
  });
});
