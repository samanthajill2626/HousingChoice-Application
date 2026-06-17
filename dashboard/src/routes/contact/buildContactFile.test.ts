import { describe, expect, it } from 'vitest';
import { landlordCases, landlordUnits, tenantCases, tenantTours } from './buildContactFile.js';
import type { CaseItem, UnitItem } from '../../api/index.js';

function caseOf(p: Partial<CaseItem> & Pick<CaseItem, 'caseId'>): CaseItem {
  return { tenantId: 't', unitId: 'u', stage: 'touring', ...p };
}
function unitOf(p: Partial<UnitItem> & Pick<UnitItem, 'unitId'>): UnitItem {
  return { landlordId: 'l', status: 'available', ...p };
}

describe('tenantCases', () => {
  it('keeps only the cases for this tenant', () => {
    const cases = [
      caseOf({ caseId: 'a', tenantId: 'k1' }),
      caseOf({ caseId: 'b', tenantId: 'other' }),
      caseOf({ caseId: 'c', tenantId: 'k1' }),
    ];
    expect(tenantCases(cases, 'k1').map((c) => c.caseId)).toEqual(['a', 'c']);
  });
});

describe('tenantTours', () => {
  it('aggregates tours across the tenant cases, newest first, with the unit', () => {
    const cases = [
      caseOf({
        caseId: 'a',
        tenantId: 'k1',
        unitId: 'u1',
        tours: [
          { date: '2026-06-05', outcome: 'No-show' },
          { date: '2026-06-13', outcome: 'Toured' },
        ],
      }),
      caseOf({ caseId: 'b', tenantId: 'other', unitId: 'u9', tours: [{ date: '2026-06-20' }] }),
    ];
    const tours = tenantTours(cases, 'k1');
    expect(tours.map((t) => t.date)).toEqual(['2026-06-13', '2026-06-05']);
    expect(tours[0]?.unitId).toBe('u1');
    expect(tours[0]?.outcome).toBe('Toured');
  });

  it('tolerates cases without tours', () => {
    expect(tenantTours([caseOf({ caseId: 'a', tenantId: 'k1' })], 'k1')).toEqual([]);
  });
});

describe('landlordUnits', () => {
  it('keeps only the units this landlord owns', () => {
    const units = [
      unitOf({ unitId: 'u1', landlordId: 'k1' }),
      unitOf({ unitId: 'u2', landlordId: 'other' }),
    ];
    expect(landlordUnits(units, 'k1').map((u) => u.unitId)).toEqual(['u1']);
  });
});

describe('landlordCases', () => {
  it('keeps the cases on any of the landlord units', () => {
    const units = [unitOf({ unitId: 'u1', landlordId: 'k1' }), unitOf({ unitId: 'u2', landlordId: 'k1' })];
    const cases = [
      caseOf({ caseId: 'a', unitId: 'u1' }),
      caseOf({ caseId: 'b', unitId: 'u9' }),
      caseOf({ caseId: 'c', unitId: 'u2' }),
    ];
    expect(landlordCases(cases, units, 'k1').map((c) => c.caseId)).toEqual(['a', 'c']);
  });
});
