// The property forms' Requirements plumbing (spec 2026-10-20 D1, D4, D5, D7, D10a).
import { describe, expect, it } from 'vitest';
import {
  NO_APPLICATION_FEE_FLAG,
  buildRequirementCreateFields,
  buildRequirementPatch,
  emptyRequirementFormValues,
  fillBlankRequirementItems,
  formFieldVisibility,
  isNoApplicationFee,
  noApplicationFeeChecked,
  requirementFormValuesFromLandlord,
  requirementFormValuesFromUnit,
  requirementsSnapshotOf,
  splitVoucherSizes,
  toLandlordPatch,
  voucherSizesPatchValue,
  type RequirementFormValues,
} from './requirementForm.js';
import { REQUIREMENT_UNIT_KEYS } from './requirements.js';

describe('requirement form values', () => {
  it('empty: every one of the 15 unit keys - checkboxes false, the rest blank', () => {
    const v = emptyRequirementFormValues();
    expect(Object.keys(v)).toEqual([...REQUIREMENT_UNIT_KEYS]);
    expect(v['no_pets']).toBe(false);
    expect(v['deposit_one_month']).toBe(false);
    expect(v['pets']).toBe('');
    expect(v['deposit']).toBe('');
    expect(v['tour_type']).toBe('');
  });

  it('from a unit: through the D1 interpretation, an amount as the text its box shows', () => {
    expect(
      requirementFormValuesFromUnit({
        no_pets: true,
        pets: ' Service animals only ',
        deposit: 1200,
        application_fee: 0,
        tour_type: 'pm_team',
      }),
    ).toMatchObject({
      no_pets: true,
      pets: 'Service animals only',
      pet_fee: '',
      deposit_one_month: false,
      deposit: '1200',
      application_fee: '0',
      tour_type: 'pm_team',
      tour_process: '',
    });
  });

  it('from a unit holding a legacy pets boolean (D1)', () => {
    expect(requirementFormValuesFromUnit({ pets: false })).toMatchObject({ no_pets: true, pets: '' });
    expect(requirementFormValuesFromUnit({ pets: true })).toMatchObject({ no_pets: false, pets: 'Allowed' });
  });

  it('from a landlord: the req_ keys - never a boolean req_pets, never the tenant keys', () => {
    expect(
      requirementFormValuesFromLandlord({ req_no_pets: true, req_pet_fee: '$300', req_deposit: 500, pets: 'Cats OK' }),
    ).toMatchObject({ no_pets: true, pets: '', pet_fee: '$300', deposit: '500' });
    expect(requirementFormValuesFromLandlord({ req_pets: true })).toMatchObject({ no_pets: false, pets: '' });
  });

  it('isNoApplicationFee: a recorded 0, never a blank or another amount', () => {
    const v = emptyRequirementFormValues();
    expect(isNoApplicationFee({ ...v, application_fee: '0' })).toBe(true);
    expect(isNoApplicationFee({ ...v, application_fee: '0.00' })).toBe(true);
    expect(isNoApplicationFee({ ...v, application_fee: '' })).toBe(false);
    expect(isNoApplicationFee({ ...v, application_fee: '25' })).toBe(false);
  });

  // Code review R2D-5: "No application fee" is its own form flag. Until the
  // checkbox (or an edit of the amount) sets it, it reads the stored /
  // prefilled value - checked for a recorded 0; once set, only the checkbox
  // changes it, so a typed 0 is an amount of 0.
  it('noApplicationFeeChecked: the stored / prefilled 0 until the flag is set; then only the flag', () => {
    expect(noApplicationFeeChecked(requirementFormValuesFromUnit({ application_fee: 0 }))).toBe(true);
    expect(noApplicationFeeChecked(requirementFormValuesFromLandlord({ req_application_fee: 0 }))).toBe(true);
    expect(noApplicationFeeChecked(requirementFormValuesFromUnit({ application_fee: 40 }))).toBe(false);
    expect(noApplicationFeeChecked(emptyRequirementFormValues())).toBe(false);
    const v = emptyRequirementFormValues();
    expect(noApplicationFeeChecked({ ...v, application_fee: '0', [NO_APPLICATION_FEE_FLAG]: false })).toBe(false);
    expect(noApplicationFeeChecked({ ...v, application_fee: '', [NO_APPLICATION_FEE_FLAG]: true })).toBe(true);
  });

  it('the flag is not a unit key: the starting values never carry it', () => {
    expect(NO_APPLICATION_FEE_FLAG in emptyRequirementFormValues()).toBe(false);
    expect(NO_APPLICATION_FEE_FLAG in requirementFormValuesFromUnit({ application_fee: 0 })).toBe(false);
    expect(REQUIREMENT_UNIT_KEYS as readonly string[]).not.toContain(NO_APPLICATION_FEE_FLAG);
  });
});

describe('buildRequirementPatch (the Edit form, D1)', () => {
  const base = requirementFormValuesFromUnit({ pets: 'Cats only', deposit: 1200, application_fee: 25, tour_type: 'pm_team' });
  function patchOf(change: RequirementFormValues): Record<string, unknown> {
    const r = buildRequirementPatch(base, { ...base, ...change });
    if (!r.ok) throw new Error(r.error);
    return r.patch;
  }

  it('an untouched section sends nothing', () => {
    expect(patchOf({})).toEqual({});
  });

  it('sends only the changed keys: text as typed, a checkbox as true, an amount as a number', () => {
    expect(patchOf({ pets: 'Dogs only' })).toEqual({ pets: 'Dogs only' });
    expect(patchOf({ no_evictions_on_program: true })).toEqual({ no_evictions_on_program: true });
    expect(patchOf({ application_fee: '40' })).toEqual({ application_fee: 40 });
    expect(patchOf({ tour_type: 'self_guided' })).toEqual({ tour_type: 'self_guided' });
  });

  it('cleared: text sends an empty string, an amount and an unticked box send null (all REMOVE)', () => {
    expect(patchOf({ pets: '' })).toEqual({ pets: '' });
    expect(patchOf({ deposit: '' })).toEqual({ deposit: null });
    expect(patchOf({ tour_type: '' })).toEqual({ tour_type: '' });
    const ticked = requirementFormValuesFromUnit({ no_pets: true });
    expect(buildRequirementPatch(ticked, { ...ticked, no_pets: false })).toEqual({ ok: true, patch: { no_pets: null } });
  });

  it("the save that CHECKS One month's rent also sends the amount as null - even when it looked unchanged", () => {
    expect(patchOf({ deposit_one_month: true, deposit: '' })).toEqual({ deposit_one_month: true, deposit: null });
    const noAmount = requirementFormValuesFromUnit({});
    expect(buildRequirementPatch(noAmount, { ...noAmount, deposit_one_month: true })).toEqual({
      ok: true,
      patch: { deposit_one_month: true, deposit: null },
    });
  });

  it("a save that leaves One month's rent as it was never sends the amount", () => {
    const oneMonth = requirementFormValuesFromUnit({ deposit_one_month: true });
    expect(buildRequirementPatch(oneMonth, { ...oneMonth, deposit_flexible: true })).toEqual({
      ok: true,
      patch: { deposit_flexible: true },
    });
    expect(buildRequirementPatch(oneMonth, { ...oneMonth, deposit_one_month: false })).toEqual({
      ok: true,
      patch: { deposit_one_month: null },
    });
  });

  it('refuses an amount that is not a number 0 or greater, naming the field', () => {
    expect(buildRequirementPatch(base, { ...base, deposit: '-5' })).toEqual({
      ok: false,
      error: 'Fixed amount must be a number 0 or greater.',
    });
    expect(buildRequirementPatch(base, { ...base, application_fee: 'abc' })).toEqual({
      ok: false,
      error: 'Application fee must be a number 0 or greater.',
    });
  });

  // Code review R2D-5: checked records 0, unchecked the typed amount (blank =
  // none); the flag itself is never a key.
  describe('the No application fee flag (code review R2D-5)', () => {
    const NO = NO_APPLICATION_FEE_FLAG;
    const forty = requirementFormValuesFromUnit({ application_fee: 40 });
    const zero = requirementFormValuesFromUnit({ application_fee: 0 });

    it('a typed 0 (the 4 of 40 deleted) is an amount of 0; a typed 0.50 is 0.5', () => {
      expect(buildRequirementPatch(forty, { ...forty, application_fee: '0', [NO]: false })).toEqual({
        ok: true,
        patch: { application_fee: 0 },
      });
      expect(buildRequirementPatch(forty, { ...forty, application_fee: '0.50', [NO]: false })).toEqual({
        ok: true,
        patch: { application_fee: 0.5 },
      });
    });

    it('checked records 0 whatever the amount box holds; unchecked a stored 0 sends null', () => {
      expect(buildRequirementPatch(forty, { ...forty, application_fee: '40', [NO]: true })).toEqual({
        ok: true,
        patch: { application_fee: 0 },
      });
      expect(buildRequirementPatch(zero, { ...zero, application_fee: '', [NO]: false })).toEqual({
        ok: true,
        patch: { application_fee: null },
      });
    });

    it('a stored 0 ticked again, or retyped as 0, sends nothing - only what changed is sent', () => {
      expect(buildRequirementPatch(zero, { ...zero, application_fee: '0', [NO]: true })).toEqual({ ok: true, patch: {} });
      expect(buildRequirementPatch(zero, { ...zero, application_fee: '0', [NO]: false })).toEqual({ ok: true, patch: {} });
      expect(buildRequirementPatch(forty, { ...forty, [NO]: false })).toEqual({ ok: true, patch: {} });
    });

    it('the New form: checked sends 0, unchecked the typed amount, blank nothing; the flag is never a key', () => {
      const v = emptyRequirementFormValues();
      expect(buildRequirementCreateFields({ ...v, application_fee: '', [NO]: true })).toEqual({
        ok: true,
        fields: { application_fee: 0 },
      });
      expect(buildRequirementCreateFields({ ...v, application_fee: '0.50', [NO]: false })).toEqual({
        ok: true,
        fields: { application_fee: 0.5 },
      });
      expect(buildRequirementCreateFields({ ...v, application_fee: '', [NO]: false })).toEqual({ ok: true, fields: {} });
    });

    it('the landlord patch carries req_application_fee and never the flag', () => {
      const r = buildRequirementPatch(forty, { ...forty, application_fee: '0', [NO]: false });
      if (!r.ok) throw new Error(r.error);
      expect(toLandlordPatch(r.patch)).toEqual({ req_application_fee: 0 });
    });
  });
});

describe('buildRequirementCreateFields (the New form, D5)', () => {
  it('a blank section sends nothing', () => {
    expect(buildRequirementCreateFields(emptyRequirementFormValues())).toEqual({ ok: true, fields: {} });
  });

  it('sends only non-blank fields: text trimmed, ticked boxes as true, amounts as numbers (0 included)', () => {
    const v: RequirementFormValues = {
      ...emptyRequirementFormValues(),
      no_pets: true,
      pets: '  Service animals only ',
      pet_fee: '   ',
      deposit: '1200',
      application_fee: '0',
      tour_type: 'landlord_led',
    };
    expect(buildRequirementCreateFields(v)).toEqual({
      ok: true,
      fields: { no_pets: true, pets: 'Service animals only', deposit: 1200, application_fee: 0, tour_type: 'landlord_led' },
    });
  });

  it("with One month's rent ticked, never an amount", () => {
    const v: RequirementFormValues = { ...emptyRequirementFormValues(), deposit_one_month: true, deposit: '1200' };
    expect(buildRequirementCreateFields(v)).toEqual({ ok: true, fields: { deposit_one_month: true } });
  });

  it('refuses a bad amount', () => {
    const v: RequirementFormValues = { ...emptyRequirementFormValues(), application_fee: '-1' };
    expect(buildRequirementCreateFields(v)).toEqual({ ok: false, error: 'Application fee must be a number 0 or greater.' });
  });
});

// Code review R2D-7 (spec D7): Try again after a failed read of the locked
// landlord fills in only what staff left blank - D7 replaces typed values only
// for a DIFFERENT landlord pick. An item is filled only when every field of it
// is blank (D1: an item is copied whole, so a filled checkbox never
// contradicts a typed detail or amount).
describe('fillBlankRequirementItems (the New form Try again, R2D-7)', () => {
  const landlord = requirementFormValuesFromLandlord({
    req_credit_requirements: '600+',
    req_income_requirements: '3x rent',
    req_no_pets: true,
    req_pets: 'Service animals only',
    req_deposit_one_month: true,
    req_application_fee: 0,
    req_tour_type: 'landlord_led',
  });
  const blank = emptyRequirementFormValues();

  it('an all-blank section takes every landlord value', () => {
    const filled = fillBlankRequirementItems(blank, landlord);
    expect(filled).toMatchObject(landlord);
    expect(noApplicationFeeChecked(filled)).toBe(true);
  });

  it('keeps every item staff typed into; fills the blank ones', () => {
    const typed = { ...blank, credit_requirements: '650 minimum', tour_process: 'Call first' };
    const filled = fillBlankRequirementItems(typed, landlord);
    expect(filled['credit_requirements']).toBe('650 minimum');
    // Touring was typed into (the process), so its tour type is not filled either.
    expect(filled['tour_process']).toBe('Call first');
    expect(filled['tour_type']).toBe('');
    // Blank items are filled.
    expect(filled['income_requirements']).toBe('3x rent');
    expect(filled).toMatchObject({ no_pets: true, pets: 'Service animals only' });
  });

  it('never fills part of an item: a typed fixed amount keeps One month\'s rent unticked (no deposit conflict)', () => {
    const filled = fillBlankRequirementItems({ ...blank, deposit: '1400' }, landlord);
    expect(filled).toMatchObject({ deposit: '1400', deposit_one_month: false });
  });

  it('a ticked box or a ticked No application fee counts as typed; whitespace alone is blank', () => {
    const filled = fillBlankRequirementItems(
      { ...blank, no_pets: true, credit_requirements: '   ', application_fee: '', [NO_APPLICATION_FEE_FLAG]: true },
      { ...landlord, application_fee: '35' },
    );
    expect(filled).toMatchObject({ no_pets: true, pets: '' });
    expect(filled['credit_requirements']).toBe('600+');
    expect(noApplicationFeeChecked(filled)).toBe(true);
    expect(filled['application_fee']).toBe('');
  });

  it('a blank fee takes the landlord fee and its No application fee state', () => {
    const typedThenCleared = { ...blank, application_fee: '', [NO_APPLICATION_FEE_FLAG]: false };
    expect(noApplicationFeeChecked(fillBlankRequirementItems(typedThenCleared, landlord))).toBe(true);
    const thirtyFive = fillBlankRequirementItems(typedThenCleared, { ...landlord, application_fee: '35' });
    expect(thirtyFive['application_fee']).toBe('35');
    expect(noApplicationFeeChecked(thirtyFive)).toBe(false);
  });
});

describe('requirementsSnapshotOf (D5, D7)', () => {
  it('names the landlord and holds every item with every key, null for blank', () => {
    expect(
      requirementsSnapshotOf({
        contactId: 'll1',
        type: 'landlord',
        req_no_pets: true,
        req_pet_fee: '$300',
        req_application_fee: 0,
        req_tour_type: 'pm_team',
      }),
    ).toEqual({
      landlordId: 'll1',
      evictions: { no_evictions_on_program: null, evictions_notes: null },
      credit_requirements: { credit_requirements: null },
      income_requirements: { income_requirements: null },
      qualifications: { qualifications: null },
      pets: { no_pets: true, pets: null, pet_fee: '$300' },
      deposit: { deposit_one_month: null, deposit: null, deposit_flexible: null, deposit_notes: null },
      application_fee: { application_fee: 0 },
      touring: { tour_type: 'pm_team', tour_process: null },
    });
  });
});

describe('toLandlordPatch (the landlord form, D9)', () => {
  it("prefixes every unit key with req_ and keeps the values", () => {
    expect(toLandlordPatch({ no_pets: true, deposit: null, pets: '' })).toEqual({ req_no_pets: true, req_deposit: null, req_pets: '' });
  });
});

describe('formFieldVisibility (D10a lookup by label)', () => {
  it('answers the tag of a property-form field', () => {
    expect(formFieldVisibility('Owning landlord')).toBe('staff_only');
    expect(formFieldVisibility('Beds')).toBe('on_flyer');
    expect(formFieldVisibility('Subzone')).toBe('staff_only');
    expect(formFieldVisibility('No application fee')).toBe('on_flyer');
  });

  it('throws for a label the table does not hold - a form field without a D10a row is a bug', () => {
    expect(() => formFieldVisibility('Square footage')).toThrow(/PROPERTY_FORM_FIELDS/);
  });
});

describe('splitVoucherSizes / voucherSizesPatchValue (D4)', () => {
  it('splits a stored value into chip sizes (ascending, de-duplicated) and values with no chip', () => {
    expect(splitVoucherSizes(undefined)).toEqual({ sizes: [], invalid: [] });
    expect(splitVoucherSizes(null)).toEqual({ sizes: [], invalid: [] });
    expect(splitVoucherSizes([])).toEqual({ sizes: [], invalid: [] });
    expect(splitVoucherSizes(2)).toEqual({ sizes: [2], invalid: [] });
    expect(splitVoucherSizes([3, 2, 2])).toEqual({ sizes: [2, 3], invalid: [] });
    expect(splitVoucherSizes([0, 12])).toEqual({ sizes: [0, 12], invalid: [] });
    expect(splitVoucherSizes([2, 2.5, 13, -1, 'x'])).toEqual({ sizes: [2], invalid: [2.5, 13, -1, 'x'] });
    expect(splitVoucherSizes(2.5)).toEqual({ sizes: [], invalid: [2.5] });
  });

  it('sends nothing when the list is unchanged and held no off-chip value', () => {
    expect(voucherSizesPatchValue(undefined, [])).toBeUndefined();
    expect(voucherSizesPatchValue(2, [2])).toBeUndefined();
    expect(voucherSizesPatchValue([3, 2], [2, 3])).toBeUndefined();
  });

  it('sends the list when it changed, ascending; an emptied picker sends null', () => {
    expect(voucherSizesPatchValue([2], [3, 2])).toEqual([2, 3]);
    expect(voucherSizesPatchValue(undefined, [4])).toEqual([4]);
    expect(voucherSizesPatchValue(2, [])).toBeNull();
  });

  it('a stored off-chip value is dropped by the save: the list goes without it (null when nothing is left)', () => {
    expect(voucherSizesPatchValue([2, 2.5], [2])).toEqual([2]);
    expect(voucherSizesPatchValue(13, [])).toBeNull();
  });
});
