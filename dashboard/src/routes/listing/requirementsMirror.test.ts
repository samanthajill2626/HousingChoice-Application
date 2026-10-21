// Cross-workspace requirements-registry MIRROR DRIFT GUARD (spec 2026-10-20
// D1, D10a; plan 2.1, 2.6).
//
// routes/listing/requirements.ts HAND-COPIES the read side of
// app/src/lib/requirements.ts (the dashboard is a separate package and cannot
// import app code at runtime). Two unpinned copies drift silently: a property
// the server classifies one way and the dashboard tags another is exactly the
// confusion the tags exist to remove; and the D10a table is what the forms tag
// every field from, while the app test proves the app table against the real
// flyer projection.
//
// MECHANISM: the caseworkerRoleMirror.test.ts one - import both copies and
// compare RESOLVED answers over one table. The app module is a LEAF (plan 2.1:
// pure, no I/O), so the dashboard typecheck compiles it alone. Import nothing
// else from app/ here. When this fails, the APP module is the source of
// truth: change the mirror, never the app.
import { describe, expect, it } from 'vitest';
import * as app from '../../../../app/src/lib/requirements.js';
import * as mirror from './requirements.js';

const UNIT_RECORDS: Record<string, unknown>[] = [
  {},
  { no_evictions_on_program: true, evictions_notes: '  none in 5 years  ' },
  { no_evictions_on_program: false, evictions_notes: '' },
  { credit_requirements: '600+', income_requirements: '3x rent', qualifications: 'No felonies\nwithin 7 years' },
  { pets: false },
  { pets: true },
  { pets: false, no_pets: true, pet_fee: '$300' },
  { pets: true, pet_fee: '  ' },
  { no_pets: true, pets: 'Service animals only', pet_fee: '$300' },
  { pets: 'No pets' },
  { pets: 42 },
  { deposit_one_month: true, deposit_flexible: true, deposit_notes: 'Plan over 3 months' },
  { deposit: 1200 },
  { deposit: 0 },
  { deposit: -5 },
  { deposit: '1200' },
  { deposit: Number.NaN },
  { application_fee: 0 },
  { application_fee: 40 },
  { tour_type: 'landlord_led', tour_process: 'Call first.' },
  { tour_type: '', tour_process: '   ' },
  // Outside the enum: blank on BOTH sides (the app reads tour_type through
  // isTourType, the mirror through TOUR_TYPE_LABELS' keys - exact, untrimmed).
  { tour_type: 'bogus' },
  { tour_type: ' pm_team ' },
  { tour_type: 7 },
];

const LANDLORD_RECORDS: Record<string, unknown>[] = [
  {},
  { req_no_evictions_on_program: true, req_evictions_notes: ' none ' },
  { req_no_pets: true, req_pets: 'Service animals only', req_pet_fee: '$300' },
  { req_pets: true },
  { req_pets: false },
  { req_deposit_one_month: true, req_deposit_flexible: true },
  { req_deposit: 500, req_deposit_notes: 'Half up front' },
  { req_application_fee: 0 },
  { req_tour_type: 'pm_team', req_tour_process: 'Text the PM.' },
  { req_tour_type: 'bogus' },
  { req_tour_type: ' landlord_led' },
  { pets: 'Cats OK', evictions: 'One in 2019', no_pets: true },
];

const RAW_SOURCES: unknown[] = [
  undefined,
  null,
  'copied',
  [],
  {},
  { pets: 'copied' },
  { pets: 'set_here', deposit: 'copied' },
  { pets: 'other', bogus: 'copied' },
  { touring: 'set_here', evictions: true },
];

const label = (v: unknown): string => JSON.stringify(v) ?? String(v);

describe('dashboard requirements registry mirrors app/src/lib/requirements.ts', () => {
  it('the items, ids and key lists are identical', () => {
    expect(mirror.REQUIREMENT_ITEMS).toEqual(app.REQUIREMENT_ITEMS);
    expect(mirror.REQUIREMENT_ITEM_IDS).toEqual(app.REQUIREMENT_ITEM_IDS);
    expect(mirror.REQUIREMENT_UNIT_KEYS).toEqual(app.REQUIREMENT_UNIT_KEYS);
    expect(mirror.REQUIREMENT_LANDLORD_KEYS).toEqual(app.REQUIREMENT_LANDLORD_KEYS);
  });

  it('the D10a property-form table is identical (D10a: the mirror carries the same table)', () => {
    expect(mirror.PROPERTY_FORM_FIELDS).toEqual(app.PROPERTY_FORM_FIELDS);
  });

  it('the washer / dryer values and the voucher size cap are identical', () => {
    expect(mirror.WASHER_DRYER_VALUES).toEqual(app.WASHER_DRYER_VALUES);
    expect(mirror.VOUCHER_SIZE_MAX).toBe(app.VOUCHER_SIZE_MAX);
  });

  it('both copies are frozen alike (the app suite\'s "is frozen" cases hold for the mirror)', () => {
    const frozen = (m: typeof mirror | typeof app): boolean[] => [
      Object.isFrozen(m.REQUIREMENT_ITEMS),
      Object.isFrozen(m.REQUIREMENT_ITEMS[0]),
      Object.isFrozen(m.REQUIREMENT_ITEMS[0]?.fields),
      Object.isFrozen(m.REQUIREMENT_ITEMS[0]?.fields[0]),
      Object.isFrozen(m.REQUIREMENT_UNIT_KEYS),
      Object.isFrozen(m.PROPERTY_FORM_FIELDS),
      Object.isFrozen(m.PROPERTY_FORM_FIELDS[0]),
      Object.isFrozen(m.PROPERTY_FORM_FIELDS[0]?.keys),
    ];
    expect(frozen(mirror)).toEqual(frozen(app));
    expect(frozen(mirror).every(Boolean)).toBe(true);
  });

  it('isRequirementItemId and itemOfUnitKey agree', () => {
    for (const v of [...mirror.REQUIREMENT_ITEM_IDS, 'Pets', '', 'req_pets', 3, null, undefined]) {
      expect(mirror.isRequirementItemId(v), label(v)).toBe(app.isRequirementItemId(v));
    }
    for (const key of [...mirror.REQUIREMENT_UNIT_KEYS, 'notes', 'req_pets', '']) {
      expect(mirror.itemOfUnitKey(key)?.id, key).toBe(app.itemOfUnitKey(key)?.id);
    }
  });

  it('unitItemValue agrees on every item of every unit record', () => {
    for (const rec of UNIT_RECORDS) {
      for (const id of mirror.REQUIREMENT_ITEM_IDS) {
        expect(mirror.unitItemValue(rec, id), `${label(rec)} ${id}`).toEqual(app.unitItemValue(rec, id));
      }
    }
  });

  it('landlordItemValue agrees on every item of every landlord record', () => {
    for (const rec of LANDLORD_RECORDS) {
      for (const id of mirror.REQUIREMENT_ITEM_IDS) {
        expect(mirror.landlordItemValue(rec, id), `${label(rec)} ${id}`).toEqual(app.landlordItemValue(rec, id));
      }
    }
  });

  it('itemValuesEqual and isItemBlank agree over every unit value against every landlord value', () => {
    for (const id of mirror.REQUIREMENT_ITEM_IDS) {
      const unitValues = UNIT_RECORDS.map((rec) => app.unitItemValue(rec, id));
      const landlordValues = LANDLORD_RECORDS.map((rec) => app.landlordItemValue(rec, id));
      for (const a of unitValues) {
        expect(mirror.isItemBlank(a), `${id} ${label(a)}`).toBe(app.isItemBlank(a));
        for (const b of landlordValues) {
          expect(mirror.itemValuesEqual(a, b), `${id} ${label(a)} vs ${label(b)}`).toBe(app.itemValuesEqual(a, b));
        }
      }
    }
  });

  it('readRequirementSources and isOwnValue agree', () => {
    for (const raw of RAW_SOURCES) {
      const sources = app.readRequirementSources(raw);
      expect(mirror.readRequirementSources(raw), label(raw)).toEqual(sources);
      for (const rec of UNIT_RECORDS) {
        for (const id of mirror.REQUIREMENT_ITEM_IDS) {
          const value = app.unitItemValue(rec, id);
          expect(mirror.isOwnValue(sources, id, value), `${label(raw)} ${id} ${label(rec)}`).toBe(
            app.isOwnValue(sources, id, value),
          );
        }
      }
    }
  });

  it('does not compare constant answers', () => {
    // The floor that stops the agreement above passing VACUOUSLY: the tables
    // produce both blank and non-blank values, equal and unequal pairs, and
    // own values both ways.
    const petsValues = UNIT_RECORDS.map((rec) => mirror.unitItemValue(rec, 'pets'));
    expect(petsValues.some((v) => mirror.isItemBlank(v))).toBe(true);
    expect(petsValues.some((v) => !mirror.isItemBlank(v))).toBe(true);
    const noPets = mirror.landlordItemValue({ req_no_pets: true }, 'pets');
    expect(petsValues.some((v) => mirror.itemValuesEqual(v, noPets))).toBe(true);
    expect(petsValues.some((v) => !mirror.itemValuesEqual(v, noPets))).toBe(true);
    expect(mirror.isOwnValue({}, 'pets', mirror.unitItemValue({ pets: 'Cats OK' }, 'pets'))).toBe(true);
    expect(mirror.isOwnValue({ pets: 'copied' }, 'pets', mirror.unitItemValue({ pets: 'Cats OK' }, 'pets'))).toBe(false);
    expect(mirror.PROPERTY_FORM_FIELDS.length).toBeGreaterThan(30);
  });
});
