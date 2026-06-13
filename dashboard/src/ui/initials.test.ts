import { describe, expect, it } from 'vitest';
import { initialsFrom } from './initials.js';

describe('initialsFrom', () => {
  it('derives two initials from a full name', () => {
    expect(initialsFrom('Keisha Jones')).toBe('KJ');
    expect(initialsFrom('  ada   lovelace ')).toBe('AL');
  });

  it('takes the first two letters of a single name', () => {
    expect(initialsFrom('Keisha')).toBe('KE');
  });

  it('uses first + last for 3+ word names', () => {
    expect(initialsFrom('Mary Jane Watson')).toBe('MW');
  });

  it('returns the honest unknown marker for absent/empty names', () => {
    expect(initialsFrom(undefined)).toBe('?');
    expect(initialsFrom('')).toBe('?');
    expect(initialsFrom('   ')).toBe('?');
  });
});
