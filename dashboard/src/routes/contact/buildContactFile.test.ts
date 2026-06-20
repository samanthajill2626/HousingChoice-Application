import { describe, expect, it } from 'vitest';
import { landlordPlacements, landlordUnits, tenantPlacements, tenantTours } from './buildContactFile.js';
import type { PlacementItem, UnitItem } from '../../api/index.js';

function placementOf(p: Partial<PlacementItem> & Pick<PlacementItem, 'placementId'>): PlacementItem {
  return { tenantId: 't', unitId: 'u', stage: 'schedule_inspection', ...p };
}
function unitOf(p: Partial<UnitItem> & Pick<UnitItem, 'unitId'>): UnitItem {
  return { landlordId: 'l', status: 'available', ...p };
}

describe('tenantPlacements', () => {
  it('keeps only the placements for this tenant', () => {
    const placements = [
      placementOf({ placementId: 'a', tenantId: 'k1' }),
      placementOf({ placementId: 'b', tenantId: 'other' }),
      placementOf({ placementId: 'c', tenantId: 'k1' }),
    ];
    expect(tenantPlacements(placements, 'k1').map((c) => c.placementId)).toEqual(['a', 'c']);
  });
});

describe('tenantTours', () => {
  it('aggregates tours across the tenant placements, newest first, with the unit', () => {
    const placements = [
      placementOf({
        placementId: 'a',
        tenantId: 'k1',
        unitId: 'u1',
        tours: [
          { date: '2026-06-05', outcome: 'No-show' },
          { date: '2026-06-13', outcome: 'Toured' },
        ],
      }),
      placementOf({ placementId: 'b', tenantId: 'other', unitId: 'u9', tours: [{ date: '2026-06-20' }] }),
    ];
    const tours = tenantTours(placements, 'k1');
    expect(tours.map((t) => t.date)).toEqual(['2026-06-13', '2026-06-05']);
    expect(tours[0]?.unitId).toBe('u1');
    expect(tours[0]?.outcome).toBe('Toured');
  });

  it('tolerates placements without tours', () => {
    expect(tenantTours([placementOf({ placementId: 'a', tenantId: 'k1' })], 'k1')).toEqual([]);
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

describe('landlordPlacements', () => {
  it('keeps the placements on any of the landlord units', () => {
    const units = [unitOf({ unitId: 'u1', landlordId: 'k1' }), unitOf({ unitId: 'u2', landlordId: 'k1' })];
    const placements = [
      placementOf({ placementId: 'a', unitId: 'u1' }),
      placementOf({ placementId: 'b', unitId: 'u9' }),
      placementOf({ placementId: 'c', unitId: 'u2' }),
    ];
    expect(landlordPlacements(placements, units, 'k1').map((c) => c.placementId)).toEqual(['a', 'c']);
  });
});
