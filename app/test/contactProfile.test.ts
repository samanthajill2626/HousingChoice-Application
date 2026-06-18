// app/test/contactProfile.test.ts
import { describe, it, expect } from 'vitest';
import { parseRole, parseRelationships, parseCustomFields } from '../src/lib/contactProfile.js';

describe('parseRole', () => {
  it('trims a valid role', () => expect(parseRole('  Case worker ')).toBe('Case worker'));
  it('rejects a non-string', () => expect(parseRole(5)).toEqual({ error: 'role must be a string' }));
});

describe('parseRelationships', () => {
  it('accepts linked + text rows', () => {
    expect(
      parseRelationships([
        { role: 'Client', name: 'Tasha', contactId: 'c1' },
        { role: ' Spouse ', name: ' Bob ' },
      ]),
    ).toEqual([
      { role: 'Client', name: 'Tasha', contactId: 'c1' },
      { role: 'Spouse', name: 'Bob' },
    ]);
  });
  it('rejects a non-array', () => expect(parseRelationships({})).toEqual({ error: 'relationships must be an array' }));
  it('rejects a row missing role/name', () => {
    expect(parseRelationships([{ role: '', name: 'x' }])).toEqual({ error: 'each relationship needs a role and a name' });
    expect(parseRelationships([{ role: 'r', name: '  ' }])).toEqual({ error: 'each relationship needs a role and a name' });
  });
  it('rejects a non-string contactId', () => expect(parseRelationships([{ role: 'r', name: 'n', contactId: 5 }])).toEqual({ error: 'relationship contactId must be a string' }));
});

describe('parseCustomFields', () => {
  it('keeps labelled rows, drops empty-label rows', () => {
    expect(parseCustomFields([{ label: ' Agency ', value: 'AH' }, { label: '  ', value: 'x' }])).toEqual([{ label: 'Agency', value: 'AH' }]);
  });
  it('rejects a non-array', () => expect(parseCustomFields('x')).toEqual({ error: 'customFields must be an array' }));
  it('rejects a non-string value', () => expect(parseCustomFields([{ label: 'a', value: 5 }])).toEqual({ error: 'custom field value must be a string' }));
});
