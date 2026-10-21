// The dashboard requirements registry mirror (spec 2026-10-20 D1, D5, D6,
// D10a; plan 2.1, 2.6). The SAME cases as the app suite for the mirrored
// functions (app/src/lib/requirements.ts is the source of truth);
// requirementsMirror.test.ts compares the two copies' answers directly.
import { describe, expect, it } from 'vitest';
import {
  PROPERTY_FORM_FIELDS,
  REQUIREMENT_ITEMS,
  REQUIREMENT_ITEM_IDS,
  REQUIREMENT_LANDLORD_KEYS,
  REQUIREMENT_UNIT_KEYS,
  VOUCHER_SIZE_MAX,
  WASHER_DRYER_LABELS,
  WASHER_DRYER_VALUES,
  isItemBlank,
  isOwnValue,
  isRequirementItemId,
  itemOfUnitKey,
  itemValuesEqual,
  landlordItemValue,
  readRequirementSources,
  unitItemValue,
  type ItemValue,
} from './requirements.js';

describe('the requirement items (D1)', () => {
  it('lists the eight items in display order with their labels and groups', () => {
    expect(REQUIREMENT_ITEMS.map((i) => [i.id, i.label, i.group])).toEqual([
      ['evictions', 'Evictions', 'Screening'],
      ['credit_requirements', 'Credit score', 'Screening'],
      ['income_requirements', 'Income requirements', 'Screening'],
      ['qualifications', 'Qualifications', 'Screening'],
      ['pets', 'Pets', 'Pets'],
      ['deposit', 'Deposit', 'Move-in costs'],
      ['application_fee', 'Application fee', 'Move-in costs'],
      ['touring', 'Touring', 'Touring'],
    ]);
    expect(REQUIREMENT_ITEM_IDS).toEqual(REQUIREMENT_ITEMS.map((i) => i.id));
  });

  it('gives every field its unit key, landlord key, label, kind and flyer visibility (plan 1.0)', () => {
    expect(REQUIREMENT_ITEMS.flatMap((i) => i.fields.map((f) => [f.key, f.landlordKey, f.label, f.kind, f.flyer]))).toEqual([
      ['no_evictions_on_program', 'req_no_evictions_on_program', 'No evictions while on the program', 'checkbox', 'staff_only'],
      ['evictions_notes', 'req_evictions_notes', 'Evictions (details)', 'text', 'staff_only'],
      ['credit_requirements', 'req_credit_requirements', 'Credit score', 'text', 'staff_only'],
      ['income_requirements', 'req_income_requirements', 'Income requirements', 'text', 'staff_only'],
      ['qualifications', 'req_qualifications', 'Qualifications', 'long_text', 'staff_only'],
      ['no_pets', 'req_no_pets', 'No pets', 'checkbox', 'on_flyer'],
      ['pets', 'req_pets', 'Pets (details)', 'text', 'on_flyer'],
      ['pet_fee', 'req_pet_fee', 'Pet fee', 'text', 'on_flyer'],
      ['deposit_one_month', 'req_deposit_one_month', "One month's rent", 'checkbox', 'on_flyer'],
      ['deposit', 'req_deposit', 'Fixed amount', 'money', 'on_flyer'],
      ['deposit_flexible', 'req_deposit_flexible', 'Flexible / payment terms available', 'checkbox', 'on_flyer'],
      ['deposit_notes', 'req_deposit_notes', 'Deposit notes', 'text', 'staff_only'],
      ['application_fee', 'req_application_fee', 'Application fee', 'money', 'on_flyer'],
      ['tour_type', 'req_tour_type', 'Tour type', 'tour_type', 'staff_only'],
      ['tour_process', 'req_tour_process', 'Tour process', 'text', 'staff_only'],
    ]);
    expect(REQUIREMENT_UNIT_KEYS).toHaveLength(15);
    expect(REQUIREMENT_LANDLORD_KEYS).toEqual(REQUIREMENT_UNIT_KEYS.map((k) => `req_${k}`));
  });

  it('isRequirementItemId accepts the eight ids only', () => {
    for (const id of REQUIREMENT_ITEM_IDS) expect(isRequirementItemId(id)).toBe(true);
    for (const v of ['Pets', 'pets_x', '', 'req_pets', 3, null, undefined]) expect(isRequirementItemId(v)).toBe(false);
  });

  it('itemOfUnitKey finds the item a unit key belongs to', () => {
    expect(itemOfUnitKey('pets')?.id).toBe('pets');
    expect(itemOfUnitKey('pet_fee')?.id).toBe('pets');
    expect(itemOfUnitKey('deposit_notes')?.id).toBe('deposit');
    expect(itemOfUnitKey('tour_type')?.id).toBe('touring');
    expect(itemOfUnitKey('notes')).toBeUndefined();
    expect(itemOfUnitKey('req_pets')).toBeUndefined();
  });

  it('is frozen - no caller can edit the registry (the app suite case)', () => {
    expect(Object.isFrozen(REQUIREMENT_ITEMS)).toBe(true);
    expect(Object.isFrozen(REQUIREMENT_ITEMS[0])).toBe(true);
    expect(Object.isFrozen(REQUIREMENT_ITEMS[0]?.fields)).toBe(true);
    expect(Object.isFrozen(REQUIREMENT_ITEMS[0]?.fields[0])).toBe(true);
    expect(Object.isFrozen(REQUIREMENT_UNIT_KEYS)).toBe(true);
    expect(Object.isFrozen(REQUIREMENT_ITEM_IDS)).toBe(true);
    expect(Object.isFrozen(REQUIREMENT_LANDLORD_KEYS)).toBe(true);
    expect(Object.isFrozen(WASHER_DRYER_VALUES)).toBe(true);
  });
});

describe('unitItemValue (the D1 read interpretation)', () => {
  it('reads checkboxes as true or blank, text trimmed, blank as null - every key of the item present', () => {
    expect(unitItemValue({ no_evictions_on_program: true, evictions_notes: '  none in 5 years ' }, 'evictions')).toEqual({
      no_evictions_on_program: true,
      evictions_notes: 'none in 5 years',
    });
    expect(unitItemValue({ no_evictions_on_program: false, evictions_notes: '   ' }, 'evictions')).toEqual({
      no_evictions_on_program: null,
      evictions_notes: null,
    });
    expect(unitItemValue({}, 'qualifications')).toEqual({ qualifications: null });
  });

  it('reads money as a finite number of 0 or more (0 is a value, not blank)', () => {
    expect(unitItemValue({ application_fee: 0 }, 'application_fee')).toEqual({ application_fee: 0 });
    expect(unitItemValue({ deposit: 1200, deposit_flexible: true }, 'deposit')).toEqual({
      deposit_one_month: null,
      deposit: 1200,
      deposit_flexible: true,
      deposit_notes: null,
    });
    expect(unitItemValue({ deposit: '1200' }, 'deposit')['deposit']).toBeNull();
    expect(unitItemValue({ deposit: Number.NaN }, 'deposit')['deposit']).toBeNull();
  });

  it('a legacy pets false reads as No pets with blank details; true as details "Allowed"', () => {
    expect(unitItemValue({ pets: false }, 'pets')).toEqual({ no_pets: true, pets: null, pet_fee: null });
    expect(unitItemValue({ pets: true, pet_fee: '$300' }, 'pets')).toEqual({ no_pets: null, pets: 'Allowed', pet_fee: '$300' });
  });

  it('never parses free text: "No pets" stays details text', () => {
    expect(unitItemValue({ pets: 'No pets' }, 'pets')).toEqual({ no_pets: null, pets: 'No pets', pet_fee: null });
  });

  it('reads the touring item', () => {
    expect(unitItemValue({ tour_type: 'landlord_led', tour_process: ' Call first. ' }, 'touring')).toEqual({
      tour_type: 'landlord_led',
      tour_process: 'Call first.',
    });
    expect(unitItemValue({ tour_type: '' }, 'touring')).toEqual({ tour_type: null, tour_process: null });
  });

  it('a tour type outside the three known ones reads as blank, exactly as the app (isTourType)', () => {
    expect(unitItemValue({ tour_type: 'bogus' }, 'touring')).toEqual({ tour_type: null, tour_process: null });
    // Exact match, never trimmed - the app's isTourType does not trim either.
    expect(unitItemValue({ tour_type: ' pm_team ' }, 'touring')['tour_type']).toBeNull();
    expect(unitItemValue({ tour_type: 7 }, 'touring')['tour_type']).toBeNull();
    expect(landlordItemValue({ req_tour_type: 'bogus' }, 'touring')['tour_type']).toBeNull();
    expect(landlordItemValue({ req_tour_type: 'pm_team' }, 'touring')['tour_type']).toBe('pm_team');
  });
});

describe('landlordItemValue', () => {
  it('reads the req_ keys and answers with UNIT keys, so the two sides compare directly', () => {
    expect(landlordItemValue({ req_no_pets: true, req_pet_fee: '$300' }, 'pets')).toEqual({
      no_pets: true,
      pets: null,
      pet_fee: '$300',
    });
    expect(landlordItemValue({ req_deposit: 500, req_deposit_notes: ' Half up front ' }, 'deposit')).toEqual({
      deposit_one_month: null,
      deposit: 500,
      deposit_flexible: null,
      deposit_notes: 'Half up front',
    });
  });

  it('never reads a boolean req_pets, nor the tenant pets / evictions keys', () => {
    expect(landlordItemValue({ req_pets: false }, 'pets')).toEqual({ no_pets: null, pets: null, pet_fee: null });
    expect(landlordItemValue({ req_pets: true }, 'pets')).toEqual({ no_pets: null, pets: null, pet_fee: null });
    expect(landlordItemValue({ pets: 'Cats OK', no_pets: true }, 'pets')).toEqual({ no_pets: null, pets: null, pet_fee: null });
    expect(landlordItemValue({ evictions: 'One in 2019' }, 'evictions')).toEqual({
      no_evictions_on_program: null,
      evictions_notes: null,
    });
  });
});

describe('itemValuesEqual / isItemBlank (D1 item equality)', () => {
  it('absent, null, empty and false are all blank', () => {
    expect(itemValuesEqual({ no_pets: null, pets: '' }, {})).toBe(true);
    expect(isItemBlank({ no_pets: null, pets: null, pet_fee: null })).toBe(true);
    expect(isItemBlank({})).toBe(true);
    expect(isItemBlank({ application_fee: 0 })).toBe(false);
  });

  it('compares text trimmed and case-sensitive, numbers exactly', () => {
    expect(itemValuesEqual({ pets: 'Cats' }, { pets: '  Cats ' })).toBe(true);
    expect(itemValuesEqual({ pets: 'Cats' }, { pets: 'cats' })).toBe(false);
    expect(itemValuesEqual({ deposit: 1200 }, { deposit: 1200.5 })).toBe(false);
    expect(itemValuesEqual({ application_fee: 0 }, { application_fee: null })).toBe(false);
  });

  it('a multi-field item is equal only when every key is', () => {
    const landlord = { no_pets: true as const, pets: null, pet_fee: '$300' };
    expect(itemValuesEqual(landlord, { no_pets: true, pets: null, pet_fee: '$300' })).toBe(true);
    expect(itemValuesEqual(landlord, { no_pets: true, pets: 'Cats OK', pet_fee: '$300' })).toBe(false);
    expect(itemValuesEqual(landlord, { no_pets: true, pets: null, pet_fee: null })).toBe(false);
  });

  it('the Deposit item and a legacy pets boolean compare after interpretation', () => {
    expect(
      itemValuesEqual(unitItemValue({ deposit_one_month: true }, 'deposit'), landlordItemValue({ req_deposit_one_month: true }, 'deposit')),
    ).toBe(true);
    expect(
      itemValuesEqual(unitItemValue({ deposit_one_month: true }, 'deposit'), landlordItemValue({ req_deposit: 1200 }, 'deposit')),
    ).toBe(false);
    expect(itemValuesEqual(unitItemValue({ pets: false }, 'pets'), landlordItemValue({ req_no_pets: true }, 'pets'))).toBe(true);
    expect(itemValuesEqual(unitItemValue({ pets: true }, 'pets'), landlordItemValue({ req_pets: 'Allowed' }, 'pets'))).toBe(true);
  });
});

describe('readRequirementSources / isOwnValue (D5, D6)', () => {
  it('reads a stored map defensively: unknown ids and values are dropped', () => {
    expect(readRequirementSources(undefined)).toEqual({});
    expect(readRequirementSources(null)).toEqual({});
    expect(readRequirementSources('copied')).toEqual({});
    expect(readRequirementSources(['pets'])).toEqual({});
    expect(readRequirementSources({ pets: 'set_here', deposit: 'copied' })).toEqual({ pets: 'set_here', deposit: 'copied' });
    expect(readRequirementSources({ pets: 'other', bogus: 'copied', touring: true })).toEqual({});
  });

  it('an own value is set_here, or never touched with a non-blank property value - whatever the landlord holds', () => {
    const blank = { no_pets: null, pets: null, pet_fee: null };
    const cats = { no_pets: null, pets: 'Cats OK', pet_fee: null };
    expect(isOwnValue({ pets: 'set_here' }, 'pets', blank)).toBe(true);
    expect(isOwnValue({ pets: 'set_here' }, 'pets', cats)).toBe(true);
    expect(isOwnValue({ pets: 'copied' }, 'pets', cats)).toBe(false);
    expect(isOwnValue({}, 'pets', cats)).toBe(true);
    expect(isOwnValue({}, 'pets', blank)).toBe(false);
    expect(isOwnValue({ deposit: 'set_here' }, 'pets', blank)).toBe(false);
  });
});

describe('PROPERTY_FORM_FIELDS (the D10a tag table)', () => {
  it('lists every New / Edit property-form field in form order with its tag', () => {
    expect(PROPERTY_FORM_FIELDS.map((f) => [f.label, f.flyer])).toEqual([
      ['Owning landlord', 'staff_only'],
      ['Housing authorities', 'on_flyer'],
      ['Beds', 'on_flyer'],
      ['Baths', 'on_flyer'],
      ['Voucher sizes accepted', 'on_flyer'],
      ['Rent min', 'on_flyer'],
      ['Rent max', 'on_flyer'],
      ['Payment standard', 'staff_only'],
      ['Address', 'on_flyer'],
      ['Subzone', 'staff_only'],
      ['Washer / dryer', 'on_flyer'],
      ['Tenant-paid utilities', 'on_flyer'],
      ['Accessibility', 'on_flyer'],
      ['Lease terms', 'on_flyer'],
      ['Public listing link', 'on_flyer'],
      ['Video URL', 'on_flyer'],
      ['Same-day RTA', 'on_flyer'],
      ['No evictions while on the program', 'staff_only'],
      ['Evictions (details)', 'staff_only'],
      ['Credit score', 'staff_only'],
      ['Income requirements', 'staff_only'],
      ['Qualifications', 'staff_only'],
      ['No pets', 'on_flyer'],
      ['Pets (details)', 'on_flyer'],
      ['Pet fee', 'on_flyer'],
      ["One month's rent", 'on_flyer'],
      ['Fixed amount', 'on_flyer'],
      ['Flexible / payment terms available', 'on_flyer'],
      ['Deposit notes', 'staff_only'],
      ['No application fee', 'on_flyer'],
      ['Application fee', 'on_flyer'],
      ['Tour type', 'staff_only'],
      ['Tour process', 'staff_only'],
      ['Application process', 'staff_only'],
      ['Notes', 'staff_only'],
    ]);
  });

  it('names the unit keys each field writes', () => {
    const keysOf = (label: string): readonly string[] | undefined => PROPERTY_FORM_FIELDS.find((f) => f.label === label)?.keys;
    // The New form's owner (planner ruling 2026-10-20): Staff only - toUnitFlyer publishes no landlord.
    expect(keysOf('Owning landlord')).toEqual(['landlordId']);
    expect(keysOf('Housing authorities')).toEqual(['accepted_authorities']);
    expect(keysOf('Address')).toEqual(['address']);
    expect(keysOf('Voucher sizes accepted')).toEqual(['voucher_size_accepted']);
    expect(keysOf('Tenant-paid utilities')).toEqual(['utilities']);
    expect(keysOf('Public listing link')).toEqual(['listing_link']);
    expect(keysOf('No application fee')).toEqual(['application_fee']);
    expect(keysOf('Application fee')).toEqual(['application_fee']);
  });

  it('agrees with the registry for every requirement field', () => {
    for (const item of REQUIREMENT_ITEMS) {
      for (const f of item.fields) {
        const row = PROPERTY_FORM_FIELDS.find((r) => r.label === f.label);
        expect(row?.keys, f.label).toEqual([f.key]);
        expect(row?.flyer, f.label).toBe(f.flyer);
      }
    }
  });

  it('is frozen (the app suite case)', () => {
    expect(Object.isFrozen(PROPERTY_FORM_FIELDS)).toBe(true);
    expect(Object.isFrozen(PROPERTY_FORM_FIELDS[0])).toBe(true);
    expect(Object.isFrozen(PROPERTY_FORM_FIELDS[0]?.keys)).toBe(true);
  });

  it('has one row per label (the forms look tags up by label)', () => {
    const labels = PROPERTY_FORM_FIELDS.map((f) => f.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('constants', () => {
  it('washer / dryer values and labels (D3); the voucher size cap (D4)', () => {
    expect(WASHER_DRYER_VALUES).toEqual(['hookups', 'included', 'none']);
    expect(WASHER_DRYER_LABELS).toEqual({ hookups: 'Hookups', included: 'Washer and dryer included', none: 'No hookups' });
    expect(VOUCHER_SIZE_MAX).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// The app suites' cases for the mirrored functions, copied VERBATIM (same `it`
// names, inputs and expected values - worklist OR-12): every case of
// app/test/requirements.test.ts, app/test/requirementSources.test.ts and
// app/test/propertyFormFlyerParity.test.ts that exercises a function or table
// this mirror exports. Not copied: their server-only cases
// (normalizeRequirementValue, hasDepositConflict,
// parseLandlordRequirementPatch, parseRequirementsSnapshot,
// nextRequirementSources, validateUnitBody and the toUnitFlyer parity walk -
// plan AR27). When an app case changes, copy the change here.
// ---------------------------------------------------------------------------

// From app/test/requirements.test.ts.
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

  it('a key missing on either side is blank, so equality is symmetric', () => {
    expect(itemValuesEqual(raw({}), raw({ pets: 'Cats OK' }))).toBe(false);
    expect(itemValuesEqual(raw({ pets: 'Cats OK' }), raw({}))).toBe(false);
    expect(itemValuesEqual(raw({ no_pets: true }), raw({ no_pets: true, pet_fee: '$300' }))).toBe(false);
    expect(itemValuesEqual(raw({ no_pets: true, pet_fee: '$300' }), raw({ no_pets: true }))).toBe(false);
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

// From app/test/requirementSources.test.ts.
describe('readRequirementSources - defensive read of the stored map (D5)', () => {
  it('reads a non-object as the empty map', () => {
    for (const bad of [undefined, null, 'copied', 42, true, [], ['pets']]) {
      expect(readRequirementSources(bad), String(bad)).toEqual({});
    }
  });

  it('keeps known item ids with known values; drops unknown ids and values', () => {
    expect(
      readRequirementSources({
        pets: 'copied',
        deposit: 'set_here',
        touring: 'manual',
        evictions: true,
        bogus: 'copied',
        no_pets: 'set_here',
      }),
    ).toEqual({ pets: 'copied', deposit: 'set_here' });
  });

  it('never reads an inherited property', () => {
    expect(readRequirementSources(Object.create({ pets: 'copied' }))).toEqual({});
  });
});

describe('isOwnValue - the D6 OWN VALUE definition', () => {
  const catsOk = unitItemValue({ pets: 'Cats OK' }, 'pets');
  const blank = unitItemValue({}, 'pets');

  it('set_here is an own value, even when the property value is blank', () => {
    expect(isOwnValue({ pets: 'set_here' }, 'pets', catsOk)).toBe(true);
    expect(isOwnValue({ pets: 'set_here' }, 'pets', blank)).toBe(true);
  });

  it('copied is never an own value', () => {
    expect(isOwnValue({ pets: 'copied' }, 'pets', catsOk)).toBe(false);
  });

  it('never touched: an own value exactly when the property value is not blank', () => {
    expect(isOwnValue({}, 'pets', catsOk)).toBe(true);
    expect(isOwnValue({}, 'pets', blank)).toBe(false);
    // A legacy false MEANS No pets - not blank, so an own value.
    expect(isOwnValue({}, 'pets', unitItemValue({ pets: false }, 'pets'))).toBe(true);
    // Another item's record does not count.
    expect(isOwnValue({ deposit: 'copied' }, 'pets', catsOk)).toBe(true);
  });
});

// From app/test/propertyFormFlyerParity.test.ts (its "names only writable unit
// keys" case runs the app's validateUnitBody, server-only, so it is not here).
describe('PROPERTY_FORM_FIELDS - the D10a tag table', () => {
  it('lists every property-form field in form order with its tag (D10, D10a, plan AR1) - 35 rows', () => {
    expect(PROPERTY_FORM_FIELDS).toHaveLength(35);
    expect(PROPERTY_FORM_FIELDS.map((f) => [f.label, [...f.keys], f.flyer])).toEqual([
      // New form only (plan AR1): the landlord picker; landlordId never reaches the flyer.
      ['Owning landlord', ['landlordId'], 'staff_only'],
      ['Housing authorities', ['accepted_authorities'], 'on_flyer'],
      ['Beds', ['beds'], 'on_flyer'],
      ['Baths', ['baths'], 'on_flyer'],
      ['Voucher sizes accepted', ['voucher_size_accepted'], 'on_flyer'],
      ['Rent min', ['rent_min'], 'on_flyer'],
      ['Rent max', ['rent_max'], 'on_flyer'],
      ['Payment standard', ['payment_standard'], 'staff_only'],
      ['Address', ['address'], 'on_flyer'],
      ['Subzone', ['subzone'], 'staff_only'],
      ['Washer / dryer', ['washer_dryer'], 'on_flyer'],
      ['Tenant-paid utilities', ['utilities'], 'on_flyer'],
      ['Accessibility', ['accessibility'], 'on_flyer'],
      ['Lease terms', ['lease_terms'], 'on_flyer'],
      ['Public listing link', ['listing_link'], 'on_flyer'],
      ['Video URL', ['video_url'], 'on_flyer'],
      ['Same-day RTA', ['same_day_rta'], 'on_flyer'],
      ['No evictions while on the program', ['no_evictions_on_program'], 'staff_only'],
      ['Evictions (details)', ['evictions_notes'], 'staff_only'],
      ['Credit score', ['credit_requirements'], 'staff_only'],
      ['Income requirements', ['income_requirements'], 'staff_only'],
      ['Qualifications', ['qualifications'], 'staff_only'],
      ['No pets', ['no_pets'], 'on_flyer'],
      ['Pets (details)', ['pets'], 'on_flyer'],
      ['Pet fee', ['pet_fee'], 'on_flyer'],
      ["One month's rent", ['deposit_one_month'], 'on_flyer'],
      ['Fixed amount', ['deposit'], 'on_flyer'],
      ['Flexible / payment terms available', ['deposit_flexible'], 'on_flyer'],
      ['Deposit notes', ['deposit_notes'], 'staff_only'],
      ['No application fee', ['application_fee'], 'on_flyer'],
      ['Application fee', ['application_fee'], 'on_flyer'],
      ['Tour type', ['tour_type'], 'staff_only'],
      ['Tour process', ['tour_process'], 'staff_only'],
      ['Application process', ['application_process'], 'staff_only'],
      ['Notes', ['notes'], 'staff_only'],
    ]);
  });

  it('tags each requirement field exactly as the registry does (D1)', () => {
    const byLabel = new Map(PROPERTY_FORM_FIELDS.map((f) => [f.label, f]));
    for (const item of REQUIREMENT_ITEMS) {
      for (const field of item.fields) {
        const row = byLabel.get(field.label);
        expect(row?.keys, field.label).toEqual([field.key]);
        expect(row?.flyer, field.label).toBe(field.flyer);
      }
    }
  });

  it('names landlordId on the Owning landlord row only, tagged Staff only (plan AR1)', () => {
    const rows = PROPERTY_FORM_FIELDS.filter((f) => f.keys.includes('landlordId'));
    expect(rows.map((f) => [f.label, f.flyer])).toEqual([['Owning landlord', 'staff_only']]);
    expect(PROPERTY_FORM_FIELDS[0]?.label).toBe('Owning landlord');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PROPERTY_FORM_FIELDS)).toBe(true);
    expect(Object.isFrozen(PROPERTY_FORM_FIELDS[0])).toBe(true);
    expect(Object.isFrozen(PROPERTY_FORM_FIELDS[0]?.keys)).toBe(true);
  });
});
