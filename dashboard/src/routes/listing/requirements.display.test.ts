// The D6 display rules (property requirements spec 2026-10-20): what the
// property page shows for each requirement item against the landlord's
// CURRENT value, how one item value reads as one line, and the
// no-requirements note. Pure; the mirror-parity cases live in
// requirements.test.ts.
import { describe, expect, it } from 'vitest';
import type { Contact, UnitItem } from '../../api/index.js';
import {
  REQUIREMENT_ITEMS,
  formatItemValue,
  landlordHasNoRequirements,
  requirementDisplay,
  requirementItemsByGroup,
  type RequirementItemId,
} from './requirements.js';

const unit = (over: Record<string, unknown> = {}): UnitItem => ({
  unitId: 'u1',
  landlordId: 'L1',
  status: 'available',
  ...over,
});
const landlord = (over: Record<string, unknown> = {}): Contact => ({
  contactId: 'L1',
  type: 'landlord',
  ...over,
});

const NONE = { tag: null, landlordLine: null };

describe('requirementDisplay - the D6 table', () => {
  it('equal values show no tag and no landlord line, whatever the record says', () => {
    expect(
      requirementDisplay(
        unit({ pet_fee: '$300', requirement_sources: { pets: 'set_here' } }),
        landlord({ req_pet_fee: '$300' }),
        'pets',
      ),
    ).toEqual(NONE);
    // Both blank, recorded as copied: still equal.
    expect(requirementDisplay(unit({ requirement_sources: { pets: 'copied' } }), landlord(), 'pets')).toEqual(NONE);
  });

  it('different + copied: orange "Landlord updated" with "Landlord now: <v>"', () => {
    expect(
      requirementDisplay(
        unit({ no_pets: true, pet_fee: '$250', requirement_sources: { pets: 'copied' } }),
        landlord({ req_no_pets: true, req_pet_fee: '$300' }),
        'pets',
      ),
    ).toEqual({ tag: 'landlord_updated', landlordLine: 'Landlord now: No pets; pet fee $300' });
  });

  it('different + set_here: purple "Set on this property" with "Landlord: <v>"', () => {
    expect(
      requirementDisplay(
        unit({ pets: 'Cats OK', requirement_sources: { pets: 'set_here' } }),
        landlord({ req_no_pets: true }),
        'pets',
      ),
    ).toEqual({ tag: 'set_here', landlordLine: 'Landlord: No pets' });
  });

  it('different + never touched + a property value: counts as set on this property', () => {
    expect(requirementDisplay(unit({ deposit: 1400 }), landlord({ req_deposit_one_month: true }), 'deposit')).toEqual({
      tag: 'set_here',
      landlordLine: "Landlord: One month's rent",
    });
  });

  it('property blank + never touched + a landlord value: the landlord line only, no tag', () => {
    expect(
      requirementDisplay(unit(), landlord({ req_credit_requirements: '600+' }), 'credit_requirements'),
    ).toEqual({ tag: null, landlordLine: 'Landlord: 600+' });
  });

  it('an own value against a BLANK landlord item is purple with "Landlord: blank" (Cameron, O2)', () => {
    expect(requirementDisplay(unit({ deposit: 1400 }), landlord(), 'deposit')).toEqual({
      tag: 'set_here',
      landlordLine: 'Landlord: blank',
    });
    expect(
      requirementDisplay(unit({ application_fee: 25, requirement_sources: { application_fee: 'set_here' } }), landlord(), 'application_fee'),
    ).toEqual({ tag: 'set_here', landlordLine: 'Landlord: blank' });
  });

  it('a copied BLANK the landlord later fills is orange (the copy is out of date)', () => {
    expect(
      requirementDisplay(
        unit({ requirement_sources: { qualifications: 'copied' } }),
        landlord({ req_qualifications: 'Two references' }),
        'qualifications',
      ),
    ).toEqual({ tag: 'landlord_updated', landlordLine: 'Landlord now: Two references' });
  });

  it('a pre-filled item cleared on the property (set_here, blank) is purple', () => {
    expect(
      requirementDisplay(
        unit({ requirement_sources: { touring: 'set_here' } }),
        landlord({ req_tour_type: 'self_guided', req_tour_process: 'Lockbox code by text' }),
        'touring',
      ),
    ).toEqual({ tag: 'set_here', landlordLine: 'Landlord: Self-guided; Lockbox code by text' });
  });

  it('a multi-field item carries ONE tag and ONE line giving the landlord whole item value', () => {
    // Pets differs only in the fee; the line still gives every field.
    expect(
      requirementDisplay(unit({ no_pets: true, pet_fee: '$200' }), landlord({ req_no_pets: true, req_pet_fee: '$300' }), 'pets'),
    ).toEqual({ tag: 'set_here', landlordLine: 'Landlord: No pets; pet fee $300' });
    // Deposit differs only in "flexible".
    expect(
      requirementDisplay(
        unit({ deposit: 1400, requirement_sources: { deposit: 'copied' } }),
        landlord({ req_deposit: 1400, req_deposit_flexible: true }),
        'deposit',
      ),
    ).toEqual({ tag: 'landlord_updated', landlordLine: 'Landlord now: $1,400; flexible' });
  });

  it('a legacy pets boolean compares by its interpretation (D1)', () => {
    expect(requirementDisplay(unit({ pets: false }), landlord({ req_no_pets: true }), 'pets')).toEqual(NONE);
    expect(requirementDisplay(unit({ pets: true }), landlord({ req_pets: 'Allowed' }), 'pets')).toEqual(NONE);
  });

  it('no landlord (or a landlord that failed to load): no tags and no lines on any item', () => {
    const full = unit({
      no_evictions_on_program: true,
      credit_requirements: '600+',
      income_requirements: '3x rent',
      qualifications: 'References',
      pets: 'Cats OK',
      deposit: 1400,
      application_fee: 25,
      tour_type: 'self_guided',
      requirement_sources: { pets: 'copied', deposit: 'set_here' },
    });
    for (const item of REQUIREMENT_ITEMS) {
      expect(requirementDisplay(full, undefined, item.id)).toEqual(NONE);
    }
  });

  it('a malformed stored map reads as never touched', () => {
    expect(requirementDisplay(unit({ deposit: 1400, requirement_sources: 'copied' }), landlord({ req_deposit: 900 }), 'deposit')).toEqual({
      tag: 'set_here',
      landlordLine: 'Landlord: $900',
    });
  });
});

describe('formatItemValue - one item value as one line', () => {
  it('prints "blank" when every field of the item is blank', () => {
    const blankOf: Record<RequirementItemId, Record<string, null>> = {
      evictions: { no_evictions_on_program: null, evictions_notes: null },
      credit_requirements: { credit_requirements: null },
      income_requirements: { income_requirements: null },
      qualifications: { qualifications: null },
      pets: { no_pets: null, pets: null, pet_fee: null },
      deposit: { deposit_one_month: null, deposit: null, deposit_flexible: null, deposit_notes: null },
      application_fee: { application_fee: null },
      touring: { tour_type: null, tour_process: null },
    };
    for (const item of REQUIREMENT_ITEMS) expect(formatItemValue(item.id, blankOf[item.id])).toBe('blank');
  });

  it('joins the parts of each item in field order with "; "', () => {
    expect(formatItemValue('evictions', { no_evictions_on_program: true, evictions_notes: 'None in 5 years' })).toBe(
      'No evictions while on the program; None in 5 years',
    );
    expect(formatItemValue('credit_requirements', { credit_requirements: '600+' })).toBe('600+');
    expect(formatItemValue('income_requirements', { income_requirements: '3x rent' })).toBe('3x rent');
    expect(formatItemValue('qualifications', { qualifications: 'Two references\nNo smoking' })).toBe(
      'Two references\nNo smoking',
    );
    expect(formatItemValue('pets', { no_pets: true, pets: 'Service animals only', pet_fee: '$300' })).toBe(
      'No pets; Service animals only; pet fee $300',
    );
    expect(formatItemValue('pets', { no_pets: null, pets: null, pet_fee: '$300' })).toBe('pet fee $300');
    expect(
      formatItemValue('deposit', { deposit_one_month: true, deposit: null, deposit_flexible: true, deposit_notes: 'Half at signing' }),
    ).toBe("One month's rent; flexible; Half at signing");
    expect(formatItemValue('deposit', { deposit_one_month: null, deposit: 1400, deposit_flexible: null, deposit_notes: null })).toBe(
      '$1,400',
    );
    expect(formatItemValue('application_fee', { application_fee: 0 })).toBe('No application fee');
    expect(formatItemValue('application_fee', { application_fee: 40 })).toBe('$40');
    expect(formatItemValue('touring', { tour_type: 'landlord_led', tour_process: 'Call the owner' })).toBe(
      'Landlord-led; Call the owner',
    );
    expect(formatItemValue('touring', { tour_type: 'pm_team', tour_process: null })).toBe('PM team');
  });

  // Code review RD-1 (worklist OR-31): the two deposit forms are alternatives
  // (D1), but a record holding both (only a direct data edit can, OR-30) shows
  // both, so the landlord card and the Apply dialog show what the server
  // refuses (409 deposit_conflict).
  it('a deposit holding BOTH forms shows both, then flexible and the notes', () => {
    expect(formatItemValue('deposit', { deposit_one_month: true, deposit: 1400, deposit_flexible: null, deposit_notes: null })).toBe(
      "One month's rent; $1,400",
    );
    expect(
      formatItemValue('deposit', { deposit_one_month: true, deposit: 1400, deposit_flexible: true, deposit_notes: 'Half at signing' }),
    ).toBe("One month's rent; $1,400; flexible; Half at signing");
  });
});

describe('landlordHasNoRequirements', () => {
  it('is true only when every item is blank on the landlord', () => {
    expect(landlordHasNoRequirements(landlord())).toBe(true);
    // An unchecked checkbox is "not a rule" (D1): still nothing recorded.
    expect(landlordHasNoRequirements(landlord({ req_no_pets: false }))).toBe(true);
    expect(landlordHasNoRequirements(landlord({ req_qualifications: 'References' }))).toBe(false);
    // 0 is a value: "No application fee".
    expect(landlordHasNoRequirements(landlord({ req_application_fee: 0 }))).toBe(false);
  });

  it('never reads the TENANT pets / evictions answers that share the contacts table', () => {
    expect(landlordHasNoRequirements(landlord({ pets: 'two cats', evictions: 'none' }))).toBe(true);
  });
});

describe('requirementItemsByGroup', () => {
  it('groups the eight items in display order', () => {
    expect(requirementItemsByGroup().map((g) => [g.group, g.items.map((i) => i.id)])).toEqual([
      ['Screening', ['evictions', 'credit_requirements', 'income_requirements', 'qualifications']],
      ['Pets', ['pets']],
      ['Move-in costs', ['deposit', 'application_fee']],
      ['Touring', ['touring']],
    ]);
  });
});
