// Unit tests for the requirement registry (spec
// docs/superpowers/specs/2026-10-20-property-requirements-design.md D1, D2):
// the eight items, their keys and kinds, the D1 read interpretation (incl. the
// legacy pets boolean), item equality, the deposit conflict and the landlord
// PATCH parser. Pure - no I/O. The dashboard mirror's suite
// (dashboard/src/routes/listing/requirements.test.ts, slice S5) carries the
// SAME cases - keep them in step.
import { describe, expect, it } from 'vitest';
import {
  REQUIREMENT_ITEMS,
  REQUIREMENT_ITEM_IDS,
  REQUIREMENT_LANDLORD_KEYS,
  REQUIREMENT_UNIT_KEYS,
  VOUCHER_SIZE_MAX,
  WASHER_DRYER_VALUES,
  hasDepositConflict,
  isItemBlank,
  isRequirementItemId,
  itemOfUnitKey,
  itemValuesEqual,
  landlordItemValue,
  normalizeRequirementValue,
  parseLandlordRequirementPatch,
  unitItemValue,
  type ItemValue,
  type RequirementField,
} from '../src/lib/requirements.js';

/** The registry field behind a unit key (throws on a typo, so no case passes vacuously). */
function fieldOf(key: string): RequirementField {
  const field = itemOfUnitKey(key)?.fields.find((f) => f.key === key);
  if (field === undefined) throw new Error(`no requirement field ${key}`);
  return field;
}

/** A hand-built item value holding what ItemValue's type forbids (false, '', untrimmed text). */
function raw(value: Record<string, unknown>): ItemValue {
  return value as ItemValue;
}

const UNIT_KEYS = [
  'no_evictions_on_program',
  'evictions_notes',
  'credit_requirements',
  'income_requirements',
  'qualifications',
  'no_pets',
  'pets',
  'pet_fee',
  'deposit_one_month',
  'deposit',
  'deposit_flexible',
  'deposit_notes',
  'application_fee',
  'tour_type',
  'tour_process',
];

describe('REQUIREMENT_ITEMS - the eight items (D1)', () => {
  it('lists the eight items in display order, with their labels and groups', () => {
    expect(REQUIREMENT_ITEMS.map((item) => [item.id, item.label, item.group])).toEqual([
      ['evictions', 'Evictions', 'Screening'],
      ['credit_requirements', 'Credit score', 'Screening'],
      ['income_requirements', 'Income requirements', 'Screening'],
      ['qualifications', 'Qualifications', 'Screening'],
      ['pets', 'Pets', 'Pets'],
      ['deposit', 'Deposit', 'Move-in costs'],
      ['application_fee', 'Application fee', 'Move-in costs'],
      ['touring', 'Touring', 'Touring'],
    ]);
    expect(REQUIREMENT_ITEM_IDS).toEqual(REQUIREMENT_ITEMS.map((item) => item.id));
  });

  it('gives every field its unit key, landlord key, label, kind and flyer visibility', () => {
    expect(
      REQUIREMENT_ITEMS.flatMap((item) =>
        item.fields.map((f) => [item.id, f.key, f.landlordKey, f.label, f.kind, f.flyer]),
      ),
    ).toEqual([
      ['evictions', 'no_evictions_on_program', 'req_no_evictions_on_program', 'No evictions while on the program', 'checkbox', 'staff_only'],
      ['evictions', 'evictions_notes', 'req_evictions_notes', 'Evictions (details)', 'text', 'staff_only'],
      ['credit_requirements', 'credit_requirements', 'req_credit_requirements', 'Credit score', 'text', 'staff_only'],
      ['income_requirements', 'income_requirements', 'req_income_requirements', 'Income requirements', 'text', 'staff_only'],
      ['qualifications', 'qualifications', 'req_qualifications', 'Qualifications', 'long_text', 'staff_only'],
      ['pets', 'no_pets', 'req_no_pets', 'No pets', 'checkbox', 'on_flyer'],
      ['pets', 'pets', 'req_pets', 'Pets (details)', 'text', 'on_flyer'],
      ['pets', 'pet_fee', 'req_pet_fee', 'Pet fee', 'text', 'on_flyer'],
      ['deposit', 'deposit_one_month', 'req_deposit_one_month', "One month's rent", 'checkbox', 'on_flyer'],
      ['deposit', 'deposit', 'req_deposit', 'Fixed amount', 'money', 'on_flyer'],
      ['deposit', 'deposit_flexible', 'req_deposit_flexible', 'Flexible / payment terms available', 'checkbox', 'on_flyer'],
      ['deposit', 'deposit_notes', 'req_deposit_notes', 'Deposit notes', 'text', 'staff_only'],
      ['application_fee', 'application_fee', 'req_application_fee', 'Application fee', 'money', 'on_flyer'],
      ['touring', 'tour_type', 'req_tour_type', 'Tour type', 'tour_type', 'staff_only'],
      ['touring', 'tour_process', 'req_tour_process', 'Tour process', 'text', 'staff_only'],
    ]);
  });

  it('flattens the 15 unit keys and the 15 req_ keys in item, then field, order', () => {
    expect(REQUIREMENT_UNIT_KEYS).toEqual(UNIT_KEYS);
    expect(REQUIREMENT_LANDLORD_KEYS).toEqual(UNIT_KEYS.map((key) => `req_${key}`));
  });

  it('isRequirementItemId accepts the eight ids only', () => {
    for (const id of REQUIREMENT_ITEM_IDS) expect(isRequirementItemId(id), id).toBe(true);
    for (const bad of ['Pets', 'tour_type', 'req_pets', 'no_pets', '', 'toString', 'constructor', 42, null, undefined, {}]) {
      expect(isRequirementItemId(bad), String(bad)).toBe(false);
    }
  });

  it('itemOfUnitKey maps a unit key to its item; anything else is undefined', () => {
    expect(itemOfUnitKey('pet_fee')?.id).toBe('pets');
    expect(itemOfUnitKey('pets')?.id).toBe('pets');
    expect(itemOfUnitKey('tour_type')?.id).toBe('touring');
    expect(itemOfUnitKey('deposit')?.id).toBe('deposit');
    expect(itemOfUnitKey('application_fee')?.id).toBe('application_fee');
    for (const other of ['req_pet_fee', 'notes', 'subzone', 'same_day_rta', 'touring', 'toString']) {
      expect(itemOfUnitKey(other), other).toBeUndefined();
    }
  });

  it('is frozen - no caller can edit the registry', () => {
    expect(Object.isFrozen(REQUIREMENT_ITEMS)).toBe(true);
    expect(Object.isFrozen(REQUIREMENT_ITEMS[0])).toBe(true);
    expect(Object.isFrozen(REQUIREMENT_ITEMS[0]?.fields)).toBe(true);
    expect(Object.isFrozen(REQUIREMENT_ITEMS[0]?.fields[0])).toBe(true);
    expect(Object.isFrozen(REQUIREMENT_UNIT_KEYS)).toBe(true);
  });

  it('exports the washer / dryer values (D3) and the largest voucher size (D4)', () => {
    expect(WASHER_DRYER_VALUES).toEqual(['hookups', 'included', 'none']);
    expect(VOUCHER_SIZE_MAX).toBe(12);
  });
});

describe('normalizeRequirementValue - the D1 write kinds', () => {
  it('checkbox: true stores true; false and null REMOVE (null); anything else is an error', () => {
    const f = fieldOf('no_pets');
    expect(normalizeRequirementValue(f, true, 'no_pets')).toEqual({ ok: true, value: true });
    expect(normalizeRequirementValue(f, false, 'no_pets')).toEqual({ ok: true, value: null });
    expect(normalizeRequirementValue(f, null, 'no_pets')).toEqual({ ok: true, value: null });
    for (const bad of ['true', 1, 0, '', {}]) {
      expect(normalizeRequirementValue(f, bad, 'no_pets')).toEqual({
        ok: false,
        error: 'no_pets must be true, false or null',
      });
    }
  });

  it('text: trimmed and case kept; blank and null REMOVE; a non-string is an error', () => {
    const f = fieldOf('pet_fee');
    expect(normalizeRequirementValue(f, '  $300 one-time  ', 'pet_fee')).toEqual({ ok: true, value: '$300 one-time' });
    expect(normalizeRequirementValue(f, 'Cats OK', 'pet_fee')).toEqual({ ok: true, value: 'Cats OK' });
    expect(normalizeRequirementValue(f, '', 'pet_fee')).toEqual({ ok: true, value: null });
    expect(normalizeRequirementValue(f, '   ', 'pet_fee')).toEqual({ ok: true, value: null });
    expect(normalizeRequirementValue(f, null, 'pet_fee')).toEqual({ ok: true, value: null });
    for (const bad of [300, true, false, [], {}]) {
      expect(normalizeRequirementValue(f, bad, 'pet_fee')).toEqual({
        ok: false,
        error: 'pet_fee must be a string or null',
      });
    }
  });

  it('long_text follows the text rules and keeps inner newlines', () => {
    const f = fieldOf('qualifications');
    expect(normalizeRequirementValue(f, '\nBackground check\nNo prior landlord debt\n', 'qualifications')).toEqual({
      ok: true,
      value: 'Background check\nNo prior landlord debt',
    });
  });

  it('money: a finite number >= 0 stores (0 included); null REMOVEs; else an error', () => {
    const f = fieldOf('deposit');
    expect(normalizeRequirementValue(f, 1400, 'deposit')).toEqual({ ok: true, value: 1400 });
    expect(normalizeRequirementValue(f, 0, 'deposit')).toEqual({ ok: true, value: 0 });
    expect(normalizeRequirementValue(f, 1400.5, 'deposit')).toEqual({ ok: true, value: 1400.5 });
    expect(normalizeRequirementValue(f, null, 'deposit')).toEqual({ ok: true, value: null });
    expect(normalizeRequirementValue(f, -1, 'deposit')).toEqual({ ok: false, error: 'deposit must be >= 0' });
    for (const bad of ['1400', '', Number.NaN, Number.POSITIVE_INFINITY, true, {}]) {
      expect(normalizeRequirementValue(f, bad, 'deposit')).toEqual({ ok: false, error: 'deposit must be a number' });
    }
  });

  it('tour_type: a TourType stores; "" and null REMOVE; anything else is an error', () => {
    const f = fieldOf('tour_type');
    for (const t of ['self_guided', 'landlord_led', 'pm_team']) {
      expect(normalizeRequirementValue(f, t, 'tour_type')).toEqual({ ok: true, value: t });
    }
    expect(normalizeRequirementValue(f, '', 'tour_type')).toEqual({ ok: true, value: null });
    expect(normalizeRequirementValue(f, null, 'tour_type')).toEqual({ ok: true, value: null });
    for (const bad of ['concierge', 'SELF_GUIDED', ' pm_team', 42, true, {}]) {
      expect(normalizeRequirementValue(f, bad, 'tour_type')).toEqual({
        ok: false,
        error: 'tour_type must be one of: self_guided, landlord_led, pm_team',
      });
    }
  });

  it('names keyForError in the message (the landlord side passes the req_ key)', () => {
    expect(normalizeRequirementValue(fieldOf('deposit'), 'x', 'req_deposit')).toEqual({
      ok: false,
      error: 'req_deposit must be a number',
    });
  });
});

describe('unitItemValue / landlordItemValue - the D1 read', () => {
  it('returns every key of the item: blank as null, text trimmed', () => {
    expect(unitItemValue({}, 'deposit')).toEqual({
      deposit_one_month: null,
      deposit: null,
      deposit_flexible: null,
      deposit_notes: null,
    });
    expect(
      unitItemValue({ deposit_one_month: true, deposit_flexible: false, deposit_notes: '  split in two  ' }, 'deposit'),
    ).toEqual({ deposit_one_month: true, deposit: null, deposit_flexible: null, deposit_notes: 'split in two' });
    expect(unitItemValue({ tour_type: 'pm_team', tour_process: '' }, 'touring')).toEqual({
      tour_type: 'pm_team',
      tour_process: null,
    });
  });

  it('reads a stored value that fails its kind as blank', () => {
    expect(unitItemValue({ tour_type: 'concierge' }, 'touring')['tour_type']).toBeNull();
    expect(unitItemValue({ deposit: '1400' }, 'deposit')['deposit']).toBeNull();
    expect(unitItemValue({ deposit: -5 }, 'deposit')['deposit']).toBeNull();
    expect(unitItemValue({ no_evictions_on_program: 'yes' }, 'evictions')['no_evictions_on_program']).toBeNull();
    expect(unitItemValue({ credit_requirements: 650 }, 'credit_requirements')['credit_requirements']).toBeNull();
  });

  it('a legacy pets false = No pets checked, details blank (the fee reads as stored)', () => {
    expect(unitItemValue({ pets: false, pet_fee: '$300' }, 'pets')).toEqual({ no_pets: true, pets: null, pet_fee: '$300' });
  });

  it('a legacy pets true = No pets unchecked, details "Allowed"', () => {
    expect(unitItemValue({ pets: true }, 'pets')).toEqual({ no_pets: null, pets: 'Allowed', pet_fee: null });
  });

  it('the legacy boolean decides BOTH keys, even beside a stray stored no_pets', () => {
    expect(unitItemValue({ pets: true, no_pets: true }, 'pets')).toEqual({ no_pets: null, pets: 'Allowed', pet_fee: null });
  });

  it('free text is never parsed: "No pets" stays details text', () => {
    expect(unitItemValue({ pets: 'No pets' }, 'pets')).toEqual({ no_pets: null, pets: 'No pets', pet_fee: null });
  });

  it('landlordItemValue reads the req_ keys and returns UNIT keys (the tenant pets / no_pets are ignored)', () => {
    expect(landlordItemValue({ req_no_pets: true, req_pet_fee: '$300', pets: 'tenant answer', no_pets: true }, 'pets')).toEqual({
      no_pets: true,
      pets: null,
      pet_fee: '$300',
    });
  });

  it('landlordItemValue never interprets a boolean req_pets (the landlord side has none)', () => {
    expect(landlordItemValue({ req_pets: false }, 'pets')).toEqual({ no_pets: null, pets: null, pet_fee: null });
    expect(landlordItemValue({ req_pets: true }, 'pets')).toEqual({ no_pets: null, pets: null, pet_fee: null });
  });
});

describe('itemValuesEqual / isItemBlank - D1 equality', () => {
  it('absent, null, "" and false are all blank', () => {
    expect(itemValuesEqual(raw({ pets: null }), raw({}))).toBe(true);
    expect(itemValuesEqual(raw({ pets: '' }), raw({ pets: null }))).toBe(true);
    expect(itemValuesEqual(raw({ no_pets: false }), raw({}))).toBe(true);
    expect(itemValuesEqual(raw({ pets: '   ' }), raw({ pets: null }))).toBe(true);
  });

  it('text compares after trimming, case-sensitive', () => {
    expect(itemValuesEqual(raw({ pets: ' Cats OK ' }), raw({ pets: 'Cats OK' }))).toBe(true);
    expect(itemValuesEqual(raw({ pets: 'cats ok' }), raw({ pets: 'Cats OK' }))).toBe(false);
  });

  it('numbers compare exactly; 0 is a value, never blank; a number never equals its text', () => {
    expect(itemValuesEqual(raw({ deposit: 1400 }), raw({ deposit: 1400 }))).toBe(true);
    expect(itemValuesEqual(raw({ deposit: 1400 }), raw({ deposit: 1400.01 }))).toBe(false);
    expect(itemValuesEqual(raw({ application_fee: 0 }), raw({ application_fee: null }))).toBe(false);
    expect(itemValuesEqual(raw({ pet_fee: 300 }), raw({ pet_fee: '300' }))).toBe(false);
  });

  it('a multi-field item (Deposit) is equal only when every key is equal', () => {
    const unit = unitItemValue({ deposit_one_month: true }, 'deposit');
    expect(itemValuesEqual(unit, landlordItemValue({ req_deposit_one_month: true }, 'deposit'))).toBe(true);
    expect(
      itemValuesEqual(unit, landlordItemValue({ req_deposit_one_month: true, req_deposit_flexible: true }, 'deposit')),
    ).toBe(false);
    expect(
      itemValuesEqual(
        unitItemValue({ deposit_one_month: true, deposit_notes: 'Half up front' }, 'deposit'),
        landlordItemValue({ req_deposit_one_month: true }, 'deposit'),
      ),
    ).toBe(false);
  });

  it('legacy pets compare by meaning; free text "No pets" is NOT the No pets checkbox', () => {
    expect(itemValuesEqual(unitItemValue({ pets: false }, 'pets'), landlordItemValue({ req_no_pets: true }, 'pets'))).toBe(true);
    expect(itemValuesEqual(unitItemValue({ pets: true }, 'pets'), landlordItemValue({ req_pets: 'Allowed' }, 'pets'))).toBe(true);
    expect(itemValuesEqual(unitItemValue({ pets: 'No pets' }, 'pets'), landlordItemValue({ req_no_pets: true }, 'pets'))).toBe(false);
  });

  it('unit and landlord values compare directly (same keys)', () => {
    expect(
      itemValuesEqual(
        unitItemValue({ tour_type: 'self_guided', tour_process: 'Lockbox' }, 'touring'),
        landlordItemValue({ req_tour_type: 'self_guided', req_tour_process: ' Lockbox ' }, 'touring'),
      ),
    ).toBe(true);
  });

  it('isItemBlank: every key blank', () => {
    expect(isItemBlank(unitItemValue({}, 'pets'))).toBe(true);
    expect(isItemBlank(unitItemValue({ tour_process: '   ' }, 'touring'))).toBe(true);
    expect(isItemBlank(unitItemValue({ application_fee: 0 }, 'application_fee'))).toBe(false);
    // A legacy false MEANS No pets checked - not blank.
    expect(isItemBlank(unitItemValue({ pets: false }, 'pets'))).toBe(false);
    expect(isItemBlank(raw({ no_pets: false, pets: '' }))).toBe(true);
  });
});

describe('hasDepositConflict - "One month\'s rent" and a fixed amount are alternatives (D1)', () => {
  it('unit side: true only when the record holds BOTH', () => {
    expect(hasDepositConflict({ deposit_one_month: true, deposit: 1400 }, 'unit')).toBe(true);
    // A fixed amount of 0 is still an amount.
    expect(hasDepositConflict({ deposit_one_month: true, deposit: 0 }, 'unit')).toBe(true);
    expect(hasDepositConflict({ deposit_one_month: true }, 'unit')).toBe(false);
    expect(hasDepositConflict({ deposit: 1400 }, 'unit')).toBe(false);
    expect(hasDepositConflict({ deposit_one_month: false, deposit: 1400 }, 'unit')).toBe(false);
    // A merged patch's null (REMOVE) counts as absent, so a caller may merge
    // the validated fields over the stored record directly.
    expect(hasDepositConflict({ deposit_one_month: true, deposit: null }, 'unit')).toBe(false);
    expect(hasDepositConflict({ deposit_one_month: null, deposit: 1400 }, 'unit')).toBe(false);
  });

  it('landlord side reads the req_ keys only', () => {
    expect(hasDepositConflict({ req_deposit_one_month: true, req_deposit: 1400 }, 'landlord')).toBe(true);
    expect(hasDepositConflict({ deposit_one_month: true, deposit: 1400 }, 'landlord')).toBe(false);
    expect(hasDepositConflict({ req_deposit_one_month: true, req_deposit: 1400 }, 'unit')).toBe(false);
  });
});

describe('parseLandlordRequirementPatch - the req_ keys of a contacts PATCH body (D2)', () => {
  it('picks out and normalizes the req_ keys, leaving every other key alone', () => {
    expect(
      parseLandlordRequirementPatch({
        firstName: 'Ann',
        pets: 'tenant answer',
        req_no_pets: true,
        req_pet_fee: '  $300 ',
        req_deposit: 1400,
        req_deposit_flexible: false,
        req_tour_type: '',
      }),
    ).toEqual({
      ok: true,
      fields: { req_no_pets: true, req_pet_fee: '$300', req_deposit: 1400, req_deposit_flexible: null, req_tour_type: null },
    });
  });

  it('accepts all 15 req_ keys', () => {
    const body: Record<string, unknown> = {
      req_no_evictions_on_program: true,
      req_evictions_notes: 'None in 5 years',
      req_credit_requirements: '600+',
      req_income_requirements: '2.5x the tenant portion',
      req_qualifications: 'Background check',
      req_no_pets: true,
      req_pets: 'Service animals only',
      req_pet_fee: '$300',
      req_deposit_one_month: true,
      req_deposit: null,
      req_deposit_flexible: true,
      req_deposit_notes: 'Can split it',
      req_application_fee: 0,
      req_tour_type: 'landlord_led',
      req_tour_process: 'Text Ana',
    };
    const res = parseLandlordRequirementPatch(body);
    expect(res.ok && Object.keys(res.fields)).toEqual(REQUIREMENT_LANDLORD_KEYS);
  });

  it('ignores unknown req_ keys, like any unknown contact key', () => {
    expect(parseLandlordRequirementPatch({ req_unknown: 'x', req_pet_policy: 'y' })).toEqual({ ok: true, fields: {} });
  });

  it('skips an undefined value (not a REMOVE)', () => {
    expect(parseLandlordRequirementPatch({ req_pets: undefined })).toEqual({ ok: true, fields: {} });
  });

  it('never accepts a boolean req_pets', () => {
    for (const bad of [true, false]) {
      expect(parseLandlordRequirementPatch({ req_pets: bad })).toEqual({
        ok: false,
        error: 'req_pets must be a string or null',
      });
    }
  });

  it('names the req_ key in every error', () => {
    expect(parseLandlordRequirementPatch({ req_application_fee: -5 })).toEqual({
      ok: false,
      error: 'req_application_fee must be >= 0',
    });
    expect(parseLandlordRequirementPatch({ req_tour_type: 'concierge' })).toEqual({
      ok: false,
      error: 'req_tour_type must be one of: self_guided, landlord_led, pm_team',
    });
    expect(parseLandlordRequirementPatch({ req_no_pets: 'yes' })).toEqual({
      ok: false,
      error: 'req_no_pets must be true, false or null',
    });
  });
});
