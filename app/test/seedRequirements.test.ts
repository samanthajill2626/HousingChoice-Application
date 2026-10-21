// property-requirements (spec section 7 "Seeds", D5, D6): the FULL demo world
// gives ONE landlord requirements - the PM-managed property's owner of record
// (cast persona 10) - and her property holds one item in each display state:
// copied and still equal (no tag), set on this property (purple), and copied
// before the landlord changed it (orange "Landlord updated"). Seeds bypass the
// API, so the seed writes requirement_sources itself. The LEAN e2e world is
// untouched: no contact holds a req_ key and no property holds the map.
import { describe, expect, it } from 'vitest';
import { SEED } from '../src/lib/seed/lean.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import { buildLiveStaticItems } from '../src/lib/seed/live.js';
import {
  hasDepositConflict,
  itemValuesEqual,
  landlordItemValue,
  normalizeRequirementValue,
  parseLandlordRequirementPatch,
  readRequirementSources,
  REQUIREMENT_ITEMS,
  unitItemValue,
} from '../src/lib/requirements.js';

type Row = Record<string, unknown>;
type Tables = Readonly<Record<string, readonly Row[]>>;

// matrix and live are now-relative; a fixed instant makes them deterministic.
const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');
const OWNER = 'contact-cast-pm-managed-property-owner';
const PM_UNIT = 'unit-cast-pm-managed-property';

const CAST = castItems();
const FULL: readonly Tables[] = [SEED, CAST, matrixItems(FIXED_NOW), buildLiveStaticItems(FIXED_NOW)];

function rowsOf(layers: readonly Tables[], table: string): Row[] {
  return layers.flatMap((tables) => [...(tables[table] ?? [])]);
}

function reqKeysOf(row: Row | undefined): Row {
  return Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => key.startsWith('req_')));
}

const owner = rowsOf([CAST], 'contacts').find((c) => c['contactId'] === OWNER);
const pmUnit = rowsOf([CAST], 'units').find((u) => u['unitId'] === PM_UNIT);

describe('full profile: one demo landlord with requirements', () => {
  it('exactly one contact in the full world holds requirements: the PM-managed property owner', () => {
    const holders = rowsOf(FULL, 'contacts')
      .filter((c) => Object.keys(reqKeysOf(c)).length > 0)
      .map((c) => c['contactId']);
    expect(holders).toEqual([OWNER]);
    expect(owner?.['type']).toBe('landlord');
  });

  it('her requirements are stored exactly as the contacts PATCH would store them', () => {
    const held = reqKeysOf(owner);
    expect(Object.keys(held).sort()).toEqual([
      'req_application_fee',
      'req_credit_requirements',
      'req_deposit_flexible',
      'req_deposit_one_month',
      'req_income_requirements',
      'req_no_evictions_on_program',
      'req_no_pets',
      'req_pets',
      'req_qualifications',
      'req_tour_process',
      'req_tour_type',
    ]);
    expect(parseLandlordRequirementPatch(held)).toEqual({ ok: true, fields: held });
    expect(hasDepositConflict(owner ?? {}, 'landlord')).toBe(false);
  });

  it('her property keeps its two voucher sizes and holds one requirement item in each state', () => {
    expect(pmUnit?.['landlordId']).toBe(OWNER);
    expect(pmUnit?.['voucher_size_accepted']).toEqual([2, 3]);
    const sources = readRequirementSources(pmUnit?.['requirement_sources']);
    // A valid map: the defensive reader drops nothing from it.
    expect(sources).toEqual(pmUnit?.['requirement_sources']);
    expect(sources).toEqual({ credit_requirements: 'copied', pets: 'set_here', income_requirements: 'copied' });
    const equalsLandlord = (id: 'credit_requirements' | 'pets' | 'income_requirements'): boolean =>
      itemValuesEqual(unitItemValue(pmUnit ?? {}, id), landlordItemValue(owner ?? {}, id));
    expect(equalsLandlord('credit_requirements')).toBe(true); // copied, equal: no tag
    expect(equalsLandlord('pets')).toBe(false); // set here: purple "Set on this property"
    expect(equalsLandlord('income_requirements')).toBe(false); // copied, landlord changed: orange
  });

  it("the property's requirement values are what the unit validator would store", () => {
    for (const item of REQUIREMENT_ITEMS) {
      for (const field of item.fields) {
        if (pmUnit === undefined || !(field.key in pmUnit)) continue;
        const value = pmUnit[field.key];
        expect(normalizeRequirementValue(field, value, field.key), field.key).toEqual({ ok: true, value });
      }
    }
  });

  it('no other seeded property holds requirement_sources', () => {
    const holders = rowsOf(FULL, 'units')
      .filter((u) => 'requirement_sources' in u)
      .map((u) => u['unitId']);
    expect(holders).toEqual([PM_UNIT]);
  });
});

describe('lean profile: byte-stable, untouched', () => {
  it('(PIN) no lean contact holds a req_ key and no lean property holds requirement_sources', () => {
    for (const contact of SEED['contacts'] ?? []) expect(reqKeysOf(contact)).toEqual({});
    for (const unit of SEED['units'] ?? []) expect('requirement_sources' in unit).toBe(false);
  });
});
