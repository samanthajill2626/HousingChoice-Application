// fake-twilio/test/registry.test.ts
import { describe, expect, it } from 'vitest';
import { PersonaRegistry, SEEDED_PERSONAS, APP_NUMBER } from '../src/engine/registry.js';

describe('PersonaRegistry', () => {
  it('loads the seeded roster with the known seed phone numbers', () => {
    const reg = new PersonaRegistry();
    expect(reg.byNumber('+15550100001')?.role).toBe('tenant');
    expect(reg.byNumber('+15550100002')?.role).toBe('landlord');
    expect(reg.list().length).toBe(SEEDED_PERSONAS.length);
  });

  it('knows the app number is not a party', () => {
    const reg = new PersonaRegistry();
    expect(reg.isAppNumber(APP_NUMBER)).toBe(true);
    expect(reg.byNumber(APP_NUMBER)).toBeUndefined();
  });

  it('mints a deterministic ad-hoc number when none is given', () => {
    const reg = new PersonaRegistry();
    const a = reg.addAdHoc({ label: 'Unknown Caller', role: 'tenant' });
    const b = reg.addAdHoc({ label: 'Another', role: 'landlord' });
    expect(a.number).toBe('+15550199001');
    expect(b.number).toBe('+15550199002');
    expect(a.adHoc).toBe(true);
    expect(reg.byNumber(a.number)?.label).toBe('Unknown Caller');
  });

  it('rejects an ad-hoc number that collides with an existing persona', () => {
    const reg = new PersonaRegistry();
    expect(() => reg.addAdHoc({ label: 'x', role: 'tenant', number: '+15550100001' })).toThrow(/exists/i);
  });
});
