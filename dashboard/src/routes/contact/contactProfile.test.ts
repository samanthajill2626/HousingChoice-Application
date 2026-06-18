import { describe, expect, it } from 'vitest';
import { CONTACT_TYPE_LABEL, displayKind } from './contactProfile.js';

describe('displayKind', () => {
  it('returns the role when role is set', () => {
    expect(displayKind({ type: 'tenant', role: 'Case worker' }, (t) => CONTACT_TYPE_LABEL[t])).toBe('Case worker');
  });

  it('returns the type label when role is empty string', () => {
    expect(displayKind({ type: 'pm', role: '' }, (t) => CONTACT_TYPE_LABEL[t])).toBe('Property mgr');
  });

  it('returns the type label when role is undefined', () => {
    expect(displayKind({ type: 'pm', role: undefined }, (t) => CONTACT_TYPE_LABEL[t])).toBe('Property mgr');
  });

  it('trims whitespace-only role and falls back to type label', () => {
    expect(displayKind({ type: 'tenant', role: '   ' }, (t) => CONTACT_TYPE_LABEL[t])).toBe('Tenant');
  });

  it('returns trimmed role when role has surrounding spaces', () => {
    expect(displayKind({ type: 'landlord', role: ' Broker ' }, (t) => CONTACT_TYPE_LABEL[t])).toBe('Broker');
  });
});

describe('CONTACT_TYPE_LABEL', () => {
  it('maps pm to "Property mgr"', () => {
    expect(CONTACT_TYPE_LABEL['pm']).toBe('Property mgr');
  });

  it('maps tenant to "Tenant"', () => {
    expect(CONTACT_TYPE_LABEL['tenant']).toBe('Tenant');
  });

  it('maps landlord to "Landlord"', () => {
    expect(CONTACT_TYPE_LABEL['landlord']).toBe('Landlord');
  });

  it('maps team_member to "Team"', () => {
    expect(CONTACT_TYPE_LABEL['team_member']).toBe('Team');
  });

  it('maps unknown to "Unknown"', () => {
    expect(CONTACT_TYPE_LABEL['unknown']).toBe('Unknown');
  });
});
