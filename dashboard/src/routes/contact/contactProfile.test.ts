import { describe, expect, it } from 'vitest';
import { CONTACT_TYPE_LABEL, displayKind, normalizeRelationships, normalizeCustomFields } from './contactProfile.js';

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

describe('normalizeRelationships', () => {
  it('drops a row where role is non-empty but name is empty', () => {
    const result = normalizeRelationships([{ role: 'Spouse', name: '' }]);
    expect(result).toEqual([]);
  });

  it('drops a row where name is non-empty but role is empty', () => {
    const result = normalizeRelationships([{ role: '', name: 'Jane Doe' }]);
    expect(result).toEqual([]);
  });

  it('keeps a row where both role and name are non-empty', () => {
    const result = normalizeRelationships([{ role: 'Spouse', name: 'Jane Doe' }]);
    expect(result).toEqual([{ role: 'Spouse', name: 'Jane Doe' }]);
  });

  it('omits contactId when absent/empty', () => {
    const result = normalizeRelationships([{ role: 'Spouse', name: 'Jane Doe', contactId: '' }]);
    expect(result).toEqual([{ role: 'Spouse', name: 'Jane Doe' }]);
  });

  it('keeps contactId when present and non-empty', () => {
    const result = normalizeRelationships([{ role: 'Spouse', name: 'Jane Doe', contactId: 'c-123' }]);
    expect(result).toEqual([{ role: 'Spouse', name: 'Jane Doe', contactId: 'c-123' }]);
  });

  it('trims whitespace from role and name before checking', () => {
    const result = normalizeRelationships([{ role: '  ', name: '  Jane  ' }]);
    expect(result).toEqual([]);
  });
});

describe('normalizeCustomFields', () => {
  it('drops a row where label is empty after trim', () => {
    const result = normalizeCustomFields([{ label: '', value: 'some value' }]);
    expect(result).toEqual([]);
  });

  it('drops a row where label is whitespace-only', () => {
    const result = normalizeCustomFields([{ label: '   ', value: 'some value' }]);
    expect(result).toEqual([]);
  });

  it('keeps a row where label is non-empty', () => {
    const result = normalizeCustomFields([{ label: 'Notes', value: 'Prefers calls' }]);
    expect(result).toEqual([{ label: 'Notes', value: 'Prefers calls' }]);
  });

  it('keeps value as-is (no trimming)', () => {
    const result = normalizeCustomFields([{ label: 'Notes', value: '  with spaces  ' }]);
    expect(result).toEqual([{ label: 'Notes', value: '  with spaces  ' }]);
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
