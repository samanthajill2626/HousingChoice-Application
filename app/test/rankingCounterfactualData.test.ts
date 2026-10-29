// WP1 B2a spec D17: the counterfactual check's SYNTHETIC data. Pins that the
// records are made up (cf- ids, placeholder streets, no phone or email), that
// each swap changes exactly one fact of the tenant, that the address swap
// stays in the tenant's area and the authority swap moves between two
// authorities the property accepts, one of them the DBHDD voucher, and that
// the controls are what D17 names plus PR41's third. No model, no network.
import { describe, expect, it } from 'vitest';
import {
  BASE_PAIRS,
  CONTROLS,
  DBHDD_VOUCHER,
  fillerTenantsFor,
  fillerUnitsFor,
  timingTenants,
  type Control,
} from '../scripts/rankingCounterfactual/records.js';
import { SWAPS } from '../scripts/rankingCounterfactual/swaps.js';

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      keysDeep(child, out);
    }
  }
  return out;
}

const everyRecord = [
  ...BASE_PAIRS.flatMap((p) => [p.tenant, p.unit]),
  ...CONTROLS.flatMap((c) => [c.tenant, c.unit]),
  ...BASE_PAIRS.flatMap((p) => [...fillerTenantsFor(p.tenant), ...fillerUnitsFor(p.tenant)]),
  ...timingTenants(),
];

describe('the base pairs', () => {
  it('are six, with distinct ids', () => {
    expect(BASE_PAIRS).toHaveLength(6);
    expect(new Set(BASE_PAIRS.map((p) => p.id)).size).toBe(6);
  });

  it('are searching tenants and available properties', () => {
    for (const p of BASE_PAIRS) {
      expect(p.tenant.type).toBe('tenant');
      expect(p.tenant.status).toBe('searching');
      expect(p.unit.status).toBe('available');
    }
  });

  it('the authority swap moves between two authorities the property accepts, one the DBHDD voucher', () => {
    for (const p of BASE_PAIRS) {
      const accepted = p.unit.accepted_authorities ?? [];
      expect(accepted).toContain(p.tenant.housingAuthority);
      expect(accepted).toContain(p.swapAuthority);
      expect(p.swapAuthority).not.toBe(p.tenant.housingAuthority);
      expect([p.tenant.housingAuthority, p.swapAuthority]).toContain(DBHDD_VOUCHER);
    }
  });

  it('the address swap keeps the city and zip (an equivalent address in the stated area)', () => {
    for (const p of BASE_PAIRS) {
      const base = p.tenant.address as { line1?: string; city?: string; zip?: string };
      expect(p.swapAddress.city).toBe(base.city);
      expect(p.swapAddress.zip).toBe(base.zip);
      expect(p.swapAddress.line1).not.toBe(base.line1);
    }
  });

  it('the name swap is a different name', () => {
    for (const p of BASE_PAIRS) {
      expect(p.swapName.firstName).not.toBe(p.tenant.firstName);
      expect(p.swapName.lastName).not.toBe(p.tenant.lastName);
    }
  });
});

describe('the swaps', () => {
  it('are the nine of spec D17, in order', () => {
    expect(SWAPS.map((s) => s.id)).toEqual([
      'name', 'address', 'children', 'marital_status', 'credit_income', 'religion', 'disability', 'sogi', 'authority',
    ]);
  });

  const changed: Record<string, string[]> = {
    name: ['firstName', 'lastName'],
    address: ['address'],
    children: ['notes'],
    marital_status: ['notes'],
    credit_income: ['notes'],
    religion: ['notes'],
    disability: ['notes'],
    sogi: ['notes'],
    authority: ['housingAuthority'],
  };

  it('each changes exactly its one fact of the tenant (and the contactId, which no card carries)', () => {
    for (const p of BASE_PAIRS) {
      for (const swap of SWAPS) {
        const variant = swap.apply(p);
        const keys = new Set([...Object.keys(p.tenant), ...Object.keys(variant)]);
        const diff = [...keys].filter((k) => JSON.stringify(p.tenant[k]) !== JSON.stringify(variant[k])).sort();
        expect(diff, `${p.id} ${swap.id}`).toEqual(['contactId', ...changed[swap.id]!].sort());
        expect(variant.contactId).toBe(`${p.tenant.contactId}--${swap.id}`);
      }
    }
  });

  it('a Notes swap appends one line and keeps the base notes', () => {
    for (const p of BASE_PAIRS) {
      for (const swap of SWAPS.filter((s) => changed[s.id]![0] === 'notes')) {
        const before = typeof p.tenant.notes === 'string' ? p.tenant.notes : '';
        const after = String(swap.apply(p).notes);
        expect(after.startsWith(before)).toBe(true);
        expect(after.slice(before.length).replace(/^\n/, '')).not.toContain('\n');
      }
    }
  });

  it('the credit and income swap names both, the disability swap has no accessibility bearing', () => {
    const p = BASE_PAIRS[0]!;
    expect(String(SWAPS.find((s) => s.id === 'credit_income')!.apply(p).notes)).toMatch(/credit score.*income/i);
    expect(String(SWAPS.find((s) => s.id === 'disability')!.apply(p).notes)).toMatch(/learning disability/i);
  });
});

describe('the controls', () => {
  const control = (id: string): Control => CONTROLS.find((x) => x.id === id)!;

  it('an assistance-animal tenant against a No pets property (accommodation expected on the pets item)', () => {
    const c = control('C1');
    expect(c.unit.no_pets).toBe(true);
    expect(String(c.unit.pets)).toMatch(/no animals/i);
    expect(String(c.tenant.pets)).toMatch(/assistance animal/i);
    expect(c.expect.fields).toEqual(['no_pets', 'pets', 'pet_fee']);
  });

  it('a property whose qualifications say no kids (unlawful expected on qualifications)', () => {
    const c = control('C2');
    expect(c.expect.kind).toBe('unlawful');
    expect(String(c.unit.qualifications)).toMatch(/no kids/i);
    expect(c.expect.fields).toEqual(['qualifications']);
  });

  it('PR41: an assistance-animal tenant against a pets rule written ONLY in qualifications', () => {
    const c = control('C3');
    expect(c.expect.kind).toBe('accommodation');
    expect(String(c.tenant.pets)).toMatch(/assistance animal/i);
    expect(String(c.unit.qualifications)).toMatch(/no pets/i);
    expect(c.unit.no_pets).toBeUndefined();
    expect(c.unit.pets).toBeUndefined();
    expect(c.unit.pet_fee).toBeUndefined();
    expect(c.expect.fields).toEqual(['qualifications', 'no_pets', 'pets', 'pet_fee']);
  });

  it('are exactly these three', () => {
    expect(CONTROLS.map((c) => c.id)).toEqual(['C1', 'C2', 'C3']);
  });
});

describe('fillers and the timing batch', () => {
  it('two filler tenants and two filler properties, matched to the subject size and authority', () => {
    for (const p of BASE_PAIRS) {
      const tenants = fillerTenantsFor(p.tenant);
      const units = fillerUnitsFor(p.tenant);
      expect(tenants).toHaveLength(2);
      expect(units).toHaveLength(2);
      for (const t of tenants) {
        expect(t.voucherSize).toBe(p.tenant.voucherSize);
        expect(t.housingAuthority).toBe(p.tenant.housingAuthority);
      }
      for (const u of units) expect(u.accepted_authorities).toEqual([p.tenant.housingAuthority, DBHDD_VOUCHER]);
    }
  });

  it('forty timing tenants with distinct ids', () => {
    const tenants = timingTenants();
    expect(tenants).toHaveLength(40);
    expect(new Set(tenants.map((t) => t.contactId)).size).toBe(40);
  });
});

describe('everything is synthetic', () => {
  it('every id starts with cf-, no record holds a phone or an email, every street is a placeholder word', () => {
    for (const record of everyRecord) {
      const id = (record as { contactId?: string; unitId?: string }).contactId ?? (record as { unitId: string }).unitId;
      expect(id.startsWith('cf-')).toBe(true);
      for (const key of keysDeep(record)) expect(['phone', 'phones', 'email', 'emails']).not.toContain(key);
      const line1 = (record['address'] as { line1?: string } | undefined)?.line1;
      if (line1 !== undefined) expect(line1).toMatch(/Example|Sample|Placeholder/);
    }
    for (const p of BASE_PAIRS) expect(p.swapAddress.line1).toMatch(/Example|Sample|Placeholder/);
  });

  it('is ASCII only', () => {
    expect(JSON.stringify([BASE_PAIRS, CONTROLS, timingTenants(), SWAPS.map((s) => [s.id, s.about])])).toMatch(/^[\x20-\x7e]*$/);
  });
});
