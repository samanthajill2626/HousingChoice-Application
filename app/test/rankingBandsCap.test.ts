// WP1 B2a spec D9 (charter 7.4, 8): the bands from a score and the Weak cap.
// One cap function serves the read, the run's cappedAtRun and the
// counterfactual check (plan WI13, PR7) - these cases are its contract.
import { describe, expect, it } from 'vitest';
import { BAND_FLOORS, BAND_ORDER, bandOf } from '../src/services/ranking/bands.js';
import {
  CAP_ELIGIBLE_KEYS,
  CAP_REASON,
  baseField,
  capOf,
  flagFieldsOfKind,
} from '../src/services/ranking/cap.js';
import { LANDLORD_FIELD_PREFIX, requirementItemOfField } from '../src/services/ranking/cardFields.js';

describe('bandOf (spec D9: Strong 80-100, Good 60-79, Possible 40-59, Weak 0-39)', () => {
  it.each([
    [100, 'strong'],
    [80, 'strong'],
    [79, 'good'],
    [60, 'good'],
    [59, 'possible'],
    [40, 'possible'],
    [39, 'weak'],
    [0, 'weak'],
  ] as const)('%i reads %s', (score, band) => {
    expect(bandOf(score)).toBe(band);
  });

  it('exports the floors and the order the read sorts by', () => {
    expect(BAND_FLOORS).toEqual({ strong: 80, good: 60, possible: 40 });
    expect(BAND_ORDER).toEqual(['strong', 'good', 'possible', 'weak']);
  });
});

describe('capOf (charter 7.4)', () => {
  const recorded = ['no_pets', 'qualifications', 'deposit'];

  it('pins the five cap-eligible keys and the reason text', () => {
    expect(CAP_ELIGIBLE_KEYS).toEqual(['no_evictions_on_program', 'evictions_notes', 'qualifications', 'no_pets', 'pets']);
    // PR45 keys on the qualifications ITEM id: S3 must keep it 'qualifications'.
    expect(requirementItemOfField('qualifications')).toBe('qualifications');
    expect(CAP_REASON).toBe('requirement not met');
    expect(LANDLORD_FIELD_PREFIX).toBe('landlord:');
  });

  it('caps a failed cap-eligible key the property records', () => {
    expect(capOf({ failedRequirements: ['no_pets'], accommodationFields: [], recordedRequirementKeys: recorded, openUnlawfulFields: [] }))
      .toEqual({ capped: true, capReason: 'requirement not met' });
  });

  it('does not cap a failed key the property does not record', () => {
    expect(capOf({ failedRequirements: ['evictions_notes'], accommodationFields: [], recordedRequirementKeys: recorded, openUnlawfulFields: [] }))
      .toEqual({ capped: false, capReason: null });
  });

  it('does not cap a failed key that is not cap-eligible (move-in costs, touring)', () => {
    expect(capOf({ failedRequirements: ['deposit', 'tour_type'], accommodationFields: [], recordedRequirementKeys: [...recorded, 'tour_type'], openUnlawfulFields: [] }).capped)
      .toBe(false);
  });

  it('never caps on credit or income keys, even when recorded', () => {
    expect(capOf({
      failedRequirements: ['credit_requirements', 'income_requirements'],
      accommodationFields: [],
      recordedRequirementKeys: ['credit_requirements', 'income_requirements'],
      openUnlawfulFields: [],
    }).capped).toBe(false);
  });

  it('an accommodation flag on the key suppresses the cap for this pair', () => {
    expect(capOf({ failedRequirements: ['no_pets'], accommodationFields: ['no_pets'], recordedRequirementKeys: recorded, openUnlawfulFields: [] }).capped)
      .toBe(false);
  });

  it('an open unlawful flag on the field suppresses the cap', () => {
    expect(capOf({ failedRequirements: ['qualifications'], accommodationFields: [], recordedRequirementKeys: recorded, openUnlawfulFields: ['qualifications'] }).capped)
      .toBe(false);
  });

  it('a landlord:<key> flag counts as a flag on <key> (spec D2.1)', () => {
    expect(capOf({ failedRequirements: ['no_pets'], accommodationFields: ['landlord:no_pets'], recordedRequirementKeys: recorded, openUnlawfulFields: [] }).capped)
      .toBe(false);
    expect(capOf({ failedRequirements: ['qualifications'], accommodationFields: [], recordedRequirementKeys: recorded, openUnlawfulFields: ['landlord:qualifications'] }).capped)
      .toBe(false);
  });

  it('a suppressed key does not hide another failed cap-eligible key of ANOTHER item (Pets vs Evictions)', () => {
    expect(capOf({
      failedRequirements: ['no_pets', 'no_evictions_on_program'],
      accommodationFields: ['no_pets'],
      recordedRequirementKeys: ['no_pets', 'no_evictions_on_program'],
      openUnlawfulFields: [],
    }).capped).toBe(true);
  });

  // PR29 as amended by PR40 and PR45: an ACCOMMODATION suppresses by
  // requirement ITEM (no_pets / pets / pet_fee are the one Pets item;
  // no_evictions_on_program / evictions_notes the one Evictions item), so an
  // accommodation on any key of the item covers a failure on any other; and
  // for accommodation only, qualifications joins every cap-eligible item
  // (PR45: No pets checked AND repeated in qualifications is one rule stated
  // twice). An open UNLAWFUL flag suppresses only a failed requirement on its
  // OWN field (landlord:<key> = <key>), as spec D9 / D10 say: an unlawful
  // pets text never lifts the lawful No pets checkbox.
  describe('accommodation suppression is by item, qualifications joining each; unlawful suppression is by field (PR29, PR40, PR45)', () => {
    const petsRecorded = ['no_pets', 'pets', 'pet_fee', 'no_evictions_on_program', 'evictions_notes', 'qualifications'];
    const cap = (failed: string[], accommodation: string[], unlawful: string[]) =>
      capOf({ failedRequirements: failed, accommodationFields: accommodation, recordedRequirementKeys: petsRecorded, openUnlawfulFields: unlawful }).capped;

    it.each([
      ['an accommodation on no_pets covers a failed pets', ['pets'], ['no_pets'], []],
      ['an accommodation on pets covers a failed no_pets', ['no_pets'], ['pets'], []],
      ['an accommodation on pet_fee covers a failed no_pets', ['no_pets'], ['pet_fee'], []],
      ['an accommodation on landlord:pets covers a failed no_pets', ['no_pets'], ['landlord:pets'], []],
      ['an accommodation on evictions_notes covers a failed no_evictions_on_program', ['no_evictions_on_program'], ['evictions_notes'], []],
      ['an accommodation on no_evictions_on_program covers a failed evictions_notes', ['evictions_notes'], ['no_evictions_on_program'], []],
      ['an accommodation on qualifications covers a failed qualifications', ['qualifications'], ['qualifications'], []],
      ['PR45 both places: an accommodation on no_pets covers a failed no_pets AND a failed qualifications', ['no_pets', 'qualifications'], ['no_pets'], []],
      ['PR45 both places, reversed: an accommodation on qualifications covers a failed qualifications AND a failed no_pets', ['qualifications', 'no_pets'], ['qualifications'], []],
      ['PR45: an accommodation on pets covers a failed qualifications', ['qualifications'], ['pets'], []],
      ['PR45: an accommodation on landlord:pet_fee covers a failed qualifications', ['qualifications'], ['landlord:pet_fee'], []],
      ['PR45: an accommodation on evictions_notes covers a failed qualifications', ['qualifications'], ['evictions_notes'], []],
      ['PR45: an accommodation on qualifications covers a failed no_evictions_on_program', ['no_evictions_on_program'], ['qualifications'], []],
      ['PR45: an accommodation on landlord:qualifications covers a failed pets', ['pets'], ['landlord:qualifications'], []],
      ['an open unlawful flag on pets covers a failed pets (its own field)', ['pets'], [], ['pets']],
      ['an open unlawful flag on landlord:pets covers a failed pets', ['pets'], [], ['landlord:pets']],
      ['an open unlawful flag on evictions_notes covers a failed evictions_notes', ['evictions_notes'], [], ['evictions_notes']],
    ] as const)('suppressed: %s', (_label, failed, accommodation, unlawful) => {
      expect(cap([...failed], [...accommodation], [...unlawful])).toBe(false);
    });

    it.each([
      ['an open unlawful flag on pets text does NOT lift a failed no_pets checkbox', ['no_pets'], [], ['pets']],
      ['an open unlawful flag on pet_fee does NOT lift a failed pets', ['pets'], [], ['pet_fee']],
      ['an open unlawful flag on landlord:pet_fee does NOT lift a failed no_pets', ['no_pets'], [], ['landlord:pet_fee']],
      ['an open unlawful flag on evictions_notes does NOT lift a failed no_evictions_on_program', ['no_evictions_on_program'], [], ['evictions_notes']],
      ['an accommodation on another item suppresses nothing', ['no_pets'], ['evictions_notes'], []],
      ['PR45 is accommodation only: an unlawful flag on no_pets does NOT lift a failed qualifications', ['qualifications'], [], ['no_pets']],
      ['PR45 is accommodation only: an unlawful flag on qualifications does NOT lift a failed no_pets', ['no_pets'], [], ['qualifications']],
      ['PR45 joins qualifications only: an accommodation on no_pets does not cover a failed evictions_notes', ['evictions_notes'], ['no_pets'], []],
      ['an accommodation on a field of no item (notes) does not cover a failed qualifications', ['qualifications'], ['notes'], []],
      ['an unlawful flag on a field of no item (notes) suppresses nothing', ['qualifications'], [], ['notes']],
    ] as const)('still capped: %s', (_label, failed, accommodation, unlawful) => {
      expect(cap([...failed], [...accommodation], [...unlawful])).toBe(true);
    });
  });

  it('nothing failed is never capped', () => {
    expect(capOf({ failedRequirements: [], accommodationFields: [], recordedRequirementKeys: recorded, openUnlawfulFields: [] }))
      .toEqual({ capped: false, capReason: null });
  });
});

describe('field helpers', () => {
  it('baseField strips only a leading landlord: prefix', () => {
    expect(baseField('landlord:no_pets')).toBe('no_pets');
    expect(baseField('no_pets')).toBe('no_pets');
    expect(baseField('notes')).toBe('notes');
  });

  it('flagFieldsOfKind picks one kind, in order', () => {
    const flags = [
      { kind: 'unlawful', field: 'qualifications' },
      { kind: 'accommodation', field: 'no_pets' },
      { kind: 'unlawful', field: 'notes' },
    ];
    expect(flagFieldsOfKind(flags, 'unlawful')).toEqual(['qualifications', 'notes']);
    expect(flagFieldsOfKind(flags, 'accommodation')).toEqual(['no_pets']);
  });
});
