// pageModel - pure ledger helpers for the placements page. No React, no I/O.
import { describe, expect, it } from 'vitest';
import type { Contact, PlacementItem, UnitItem } from '../../api/index.js';
import {
  PHASE_SLUG,
  buildLedger,
  filterSearch,
  ledgerCounts,
  parseFilter,
} from './pageModel.js';

function mk(over: Partial<PlacementItem> & Pick<PlacementItem, 'placementId' | 'stage'>): PlacementItem {
  return { tenantId: 't1', unitId: 'u1', ...over } as PlacementItem;
}

const contacts = new Map<string, Contact>([
  ['t1', { contactId: 't1', type: 'tenant', firstName: 'Tasha', lastName: 'Nguyen', status: 'placing' } as Contact],
  ['t2', { contactId: 't2', type: 'tenant', firstName: 'Omar', lastName: 'Reyes', porting: true } as Contact],
]);
const units = new Map<string, UnitItem>([
  ['u1', { unitId: 'u1', landlordId: 'l1', status: 'available', address: { line1: '12 Oak St' } } as UnitItem],
]);

describe('parseFilter / filterSearch', () => {
  it('round-trips all, each phase slug, and closed', () => {
    expect(parseFilter(new URLSearchParams(''))).toEqual({ kind: 'all' });
    expect(parseFilter(new URLSearchParams('?phase=rent-determination'))).toEqual({
      kind: 'phase',
      phase: 'Rent Determination',
    });
    expect(parseFilter(new URLSearchParams('?view=closed'))).toEqual({ kind: 'closed' });
    expect(filterSearch({ kind: 'all' })).toBe('');
    expect(filterSearch({ kind: 'phase', phase: 'RTA' })).toBe('?phase=rta');
    expect(filterSearch({ kind: 'closed' })).toBe('?view=closed');
  });

  it('unknown phase slug falls back to all', () => {
    expect(parseFilter(new URLSearchParams('?phase=bogus'))).toEqual({ kind: 'all' });
  });

  it('every phase has a unique slug', () => {
    const slugs = Object.values(PHASE_SLUG);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('ledgerCounts', () => {
  it('counts actives per phase; terminals and legacy stages count as closed', () => {
    const counts = ledgerCounts([
      mk({ placementId: 'a', stage: 'collect_rta' }),
      mk({ placementId: 'b', stage: 'review_rta' }),
      mk({ placementId: 'c', stage: 'awaiting_inspection' }),
      mk({ placementId: 'd', stage: 'moved_in' }),
      mk({ placementId: 'e', stage: 'lost' }),
      mk({ placementId: 'f', stage: 'zombie_stage' as PlacementItem['stage'] }),
    ]);
    expect(counts.all).toBe(3);
    expect(counts.byPhase['RTA']).toBe(2);
    expect(counts.byPhase['Inspection']).toBe(1);
    expect(counts.byPhase['Contract']).toBe(0);
    expect(counts.closed).toBe(3);
  });
});

describe('buildLedger', () => {
  const placements = [
    mk({ placementId: 'a', stage: 'send_application' }),
    mk({ placementId: 'b', stage: 'collect_rta', tenantId: 't2' }),
    mk({ placementId: 'c', stage: 'lost' }),
  ];

  it('all: groups by phase in canonical order, omits empty phases, excludes closed', () => {
    const groups = buildLedger(placements, contacts, units, { kind: 'all' }, '');
    expect(groups.map((g) => g.phase)).toEqual(['Application', 'RTA']);
    expect(groups[0]!.rows.map((r) => r.placement.placementId)).toEqual(['a']);
    expect(groups[0]!.rows[0]!.tenant).toBe('Tasha Nguyen');
    expect(groups[0]!.rows[0]!.listing).toBe('12 Oak St');
    expect(groups[1]!.rows[0]!.porting).toBe(true);
  });

  it('phase: one flat group (phase null) with only that slice', () => {
    const groups = buildLedger(placements, contacts, units, { kind: 'phase', phase: 'RTA' }, '');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.phase).toBeNull();
    expect(groups[0]!.rows.map((r) => r.placement.placementId)).toEqual(['b']);
  });

  it('closed: one flat group with terminal rows', () => {
    const groups = buildLedger(placements, contacts, units, { kind: 'closed' }, '');
    expect(groups[0]!.rows.map((r) => r.placement.placementId)).toEqual(['c']);
  });

  it('search matches tenant OR address case-insensitively and drops emptied groups', () => {
    const byName = buildLedger(placements, contacts, units, { kind: 'all' }, 'omar');
    expect(byName.map((g) => g.phase)).toEqual(['RTA']);
    const byAddr = buildLedger(placements, contacts, units, { kind: 'all' }, 'oak st');
    // Both actives resolve unit u1 (12 Oak St), so both groups survive.
    expect(byAddr.map((g) => g.phase)).toEqual(['Application', 'RTA']);
    expect(buildLedger(placements, contacts, units, { kind: 'all' }, 'zzz')).toEqual([]);
  });
});
