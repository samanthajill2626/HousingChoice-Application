import { describe, expect, it } from 'vitest';
import type { CaseItem, Contact, UnitItem } from '../../api/index.js';
import { casesOnUnit, listingRoster, relatedByLandlord } from './buildListingFile.js';

const unit = (over: Partial<UnitItem> = {}): UnitItem => ({
  unitId: 'u1',
  landlordId: 'll1',
  status: 'available',
  ...over,
});

describe('listingRoster', () => {
  it('uses the unit contacts[] roster when present (C3), ordered primaryVoice first', () => {
    const u = unit({
      contacts: [
        { contactId: 'pm1', role: 'pm', primaryVoice: false, name: 'Maria Gomez', company: 'Porter' },
        { contactId: 'll1', role: 'landlord', primaryVoice: true, name: 'James Porter', company: 'Porter' },
      ],
    });
    const rows = listingRoster(u, null);
    expect(rows.map((r) => r.contactId)).toEqual(['ll1', 'pm1']);
    expect(rows[0]).toMatchObject({
      name: 'James Porter',
      roleLabel: 'Landlord',
      company: 'Porter',
      primaryVoice: true,
      fallback: false,
    });
    expect(rows[1]).toMatchObject({ roleLabel: 'Property manager', primaryVoice: false });
  });

  it('falls back to a single landlord row from the resolved contact when contacts[] is absent', () => {
    const u = unit({ landlordId: 'll1' });
    const landlord: Contact = {
      contactId: 'll1',
      type: 'landlord',
      firstName: 'James',
      lastName: 'Porter',
      company: 'Porter Properties',
    } as Contact;
    const rows = listingRoster(u, landlord);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      contactId: 'll1',
      name: 'James Porter',
      roleLabel: 'Landlord',
      company: 'Porter Properties',
      primaryVoice: true,
      fallback: true,
    });
  });

  it('falls back with no resolved contact (id-only row, name undefined)', () => {
    const rows = listingRoster(unit({ landlordId: 'll9' }), null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contactId: 'll9', primaryVoice: true, fallback: true });
    expect(rows[0]?.name).toBeUndefined();
  });

  it('returns an empty roster when there is no landlordId and no contacts[]', () => {
    const u = { unitId: 'u1', status: 'available' } as UnitItem;
    expect(listingRoster(u, null)).toEqual([]);
  });
});

describe('casesOnUnit', () => {
  const cases: CaseItem[] = [
    { caseId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'awaiting_approval' },
    { caseId: 'c2', tenantId: 't2', unitId: 'u2', stage: 'schedule_inspection' },
    { caseId: 'c3', tenantId: 't3', unitId: 'u1', stage: 'awaiting_hap_contract' },
  ];

  it('keeps only cases on this unit', () => {
    expect(casesOnUnit(cases, 'u1').map((c) => c.caseId)).toEqual(['c1', 'c3']);
  });

  it('returns [] when none match', () => {
    expect(casesOnUnit(cases, 'zzz')).toEqual([]);
  });
});

describe('relatedByLandlord', () => {
  const units: UnitItem[] = [
    unit({ unitId: 'u1', landlordId: 'll1' }),
    unit({ unitId: 'u2', landlordId: 'll1', status: 'occupied' }),
    unit({ unitId: 'u3', landlordId: 'll1', status: 'off_market' }),
    unit({ unitId: 'u4', landlordId: 'llX' }),
  ];

  it('returns same-landlord units excluding self, labelled "Same landlord"', () => {
    const rows = relatedByLandlord(units, unit({ unitId: 'u1', landlordId: 'll1' }));
    expect(rows.map((r) => r.unitId)).toEqual(['u2', 'u3']);
    expect(rows.every((r) => r.relation === 'same_landlord')).toBe(true);
    expect(rows[0]?.label).toBe('Same landlord');
    expect(rows[0]?.status).toBe('occupied');
  });

  it('returns [] when the unit has no landlordId', () => {
    const u = { unitId: 'u1', status: 'available' } as UnitItem;
    expect(relatedByLandlord(units, u)).toEqual([]);
  });

  it('returns [] when the landlord owns only this unit', () => {
    expect(relatedByLandlord(units, unit({ unitId: 'u4', landlordId: 'llX' }))).toEqual([]);
  });
});
