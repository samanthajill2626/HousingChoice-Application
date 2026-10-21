import { describe, expect, it } from 'vitest';
import type { Contact, UnitItem } from '../../api/index.js';
import type { RequirementItemId } from '../listing/requirements.js';
import {
  APPLY_BATCH_SIZE,
  APPLY_FAILED_NOTICE,
  REQUIREMENTS_CHANGED_NOTICE,
  applyRequestBody,
  applyRows,
  carryCheckedItems,
  carryHandChoices,
  chunk,
  defaultCheckedItems,
  doneHeadline,
  orderedItems,
  propertyRowLabel,
  rowIsChecked,
  skipReasonCopy,
  stoppedNotice,
  summarizeApply,
  updateButtonLabel,
  type ApplyRow,
} from './applyRequirementsModel.js';

const LANDLORD: Contact = {
  contactId: 'L1',
  type: 'landlord',
  req_no_pets: true,
  req_pet_fee: '$300',
  req_credit_requirements: '600+',
};
// Already matches on credit and pets.
const MATCH: UnitItem = {
  unitId: 'u-match',
  landlordId: 'L1',
  status: 'available',
  address: { line1: '1 Match St' },
  no_pets: true,
  pet_fee: '$300',
  credit_requirements: '600+',
  requirement_sources: { pets: 'copied', credit_requirements: 'copied' },
};
// Out of date: a copied pet fee; an evictions note never touched.
const OLD: UnitItem = {
  unitId: 'u-old',
  landlordId: 'L1',
  status: 'occupied',
  address: { line1: '2 Old St' },
  no_pets: true,
  pet_fee: '$250',
  evictions_notes: 'Case by case',
  requirement_sources: { pets: 'copied' },
};
// Own values: pets details and qualifications, never touched.
const OWN: UnitItem = {
  unitId: 'u-own',
  landlordId: 'L1',
  status: 'setup',
  address: { line1: '3 Own St' },
  pets: 'Cats OK',
  qualifications: 'Two references',
};
const UNITS = [MATCH, OLD, OWN];
const set = (...ids: RequirementItemId[]): Set<RequirementItemId> => new Set(ids);
const rowOf = (rows: ApplyRow[], unitId: string): ApplyRow => rows.find((r) => r.unitId === unitId)!;

describe('defaultCheckedItems + orderedItems', () => {
  it('checks the items with a value, in display order', () => {
    expect(orderedItems(defaultCheckedItems(LANDLORD))).toEqual(['credit_requirements', 'pets']);
    expect(defaultCheckedItems({ contactId: 'L2', type: 'landlord' }).size).toBe(0);
  });
});

describe('applyRows', () => {
  it('lists the checked items that would change, the own values among them, and Already matches', () => {
    const rows = applyRows(UNITS, LANDLORD, set('pets', 'credit_requirements'));
    expect(rowOf(rows, 'u-match')).toEqual({ unitId: 'u-match', changes: [], own: [], alreadyMatches: true });
    expect(rowOf(rows, 'u-old')).toEqual({
      unitId: 'u-old',
      changes: ['credit_requirements', 'pets'],
      own: [],
      alreadyMatches: false,
    });
    expect(rowOf(rows, 'u-own')).toEqual({
      unitId: 'u-own',
      changes: ['credit_requirements', 'pets'],
      own: ['pets'],
      alreadyMatches: false,
    });
  });

  it('a checked BLANK item (Clears) meets existing values as own values (an all-blank landlord)', () => {
    const blank: Contact = { contactId: 'L1', type: 'landlord' };
    const rows = applyRows([OWN, OLD], blank, set('pets', 'evictions'));
    expect(rowOf(rows, 'u-own')).toMatchObject({ changes: ['pets'], own: ['pets'] });
    expect(rowOf(rows, 'u-old')).toMatchObject({ changes: ['evictions', 'pets'], own: ['evictions'] });
  });

  it('nothing checked: every row already matches', () => {
    expect(applyRows(UNITS, LANDLORD, set()).every((r) => r.alreadyMatches)).toBe(true);
  });
});

// Worklist OR-17: after an Update that stopped (a later batch's 409 or
// failure) or a first request that failed other than with 409
// requirements_changed, the re-read keeps what staff chose on the left -
// narrowed to what the re-read landlord still holds - instead of resetting it
// to the defaults. It only ever copies LESS than staff chose, never more.
describe('carryCheckedItems - the left column across a re-read after a stop (worklist OR-17)', () => {
  it('an item staff unchecked stays unchecked; an item staff checked stays checked', () => {
    // The landlord still holds both; staff had unchecked Credit score.
    expect(orderedItems(carryCheckedItems(set('pets'), LANDLORD))).toEqual(['pets']);
    expect(orderedItems(carryCheckedItems(set('credit_requirements', 'pets'), LANDLORD))).toEqual([
      'credit_requirements',
      'pets',
    ]);
  });

  it('an item the re-read landlord holds blank comes back unchecked - never a surprise Clears', () => {
    const petsBlanked: Contact = { contactId: 'L1', type: 'landlord', req_credit_requirements: '600+' };
    expect(orderedItems(carryCheckedItems(set('credit_requirements', 'pets'), petsBlanked))).toEqual([
      'credit_requirements',
    ]);
    // A Clears item staff had checked comes back unchecked too: the carry never copies a blank by itself.
    expect(carryCheckedItems(set('evictions', 'pets'), LANDLORD).has('evictions')).toBe(false);
  });

  it('an item the landlord filled in since is not checked by the carry (staff never chose it)', () => {
    const more: Contact = { ...LANDLORD, req_income_requirements: '3x rent' };
    expect(orderedItems(carryCheckedItems(set('pets'), more))).toEqual(['pets']);
    expect(orderedItems(defaultCheckedItems(more))).toEqual(['credit_requirements', 'income_requirements', 'pets']);
  });
});

describe('rowIsChecked', () => {
  const rows = applyRows(UNITS, LANDLORD, set('pets', 'credit_requirements'));
  it('starts checked without own values, unchecked with one, never when Already matches', () => {
    const none = new Map<string, boolean>();
    expect(rowIsChecked(rowOf(rows, 'u-old'), none)).toBe(true);
    expect(rowIsChecked(rowOf(rows, 'u-own'), none)).toBe(false);
    expect(rowIsChecked(rowOf(rows, 'u-match'), new Map([['u-match', true]]))).toBe(false);
  });
  it('a hand choice wins over the starting state', () => {
    expect(rowIsChecked(rowOf(rows, 'u-own'), new Map([['u-own', true]]))).toBe(true);
    expect(rowIsChecked(rowOf(rows, 'u-old'), new Map([['u-old', false]]))).toBe(false);
  });
});

describe('carryHandChoices - the D8 hand rules across a left-column change', () => {
  const before = applyRows(UNITS, LANDLORD, set('pets', 'credit_requirements'));

  it('a hand-checked row resets when the change ADDS an own value to it', () => {
    const after = applyRows(UNITS, LANDLORD, set('pets', 'credit_requirements', 'qualifications'));
    expect(carryHandChoices(new Map([['u-own', true]]), before, after).has('u-own')).toBe(false);
  });

  it('removing items never resets a hand-checked row', () => {
    const after = applyRows(UNITS, LANDLORD, set('pets'));
    expect(carryHandChoices(new Map([['u-own', true]]), before, after).get('u-own')).toBe(true);
  });

  it('adding an item that is NOT an own value keeps a hand-checked row checked', () => {
    // OLD has no deposit, the landlord none: nothing changes there; add income for a non-own change.
    const landlord: Contact = { ...LANDLORD, req_income_requirements: '3x rent' };
    const b = applyRows(UNITS, landlord, set('pets', 'credit_requirements'));
    const a = applyRows(UNITS, landlord, set('pets', 'credit_requirements', 'income_requirements'));
    expect(carryHandChoices(new Map([['u-own', true]]), b, a).get('u-own')).toBe(true);
  });

  it('a hand-unchecked row stays unchecked, until it becomes Already matches', () => {
    const fewer = applyRows(UNITS, LANDLORD, set('credit_requirements'));
    expect(carryHandChoices(new Map([['u-old', false]]), before, fewer).get('u-old')).toBe(false);
    const nothing = applyRows(UNITS, LANDLORD, set());
    expect(carryHandChoices(new Map([['u-old', false]]), fewer, nothing).has('u-old')).toBe(false);
  });
});

describe('applyRequestBody + chunk', () => {
  it('sends each row with its own values, the items in order, and the landlord values with null for blank', () => {
    const rows = applyRows(UNITS, LANDLORD, set('pets', 'credit_requirements'));
    const checked = [rowOf(rows, 'u-old'), rowOf(rows, 'u-own')];
    expect(applyRequestBody(checked, ['credit_requirements', 'pets'], LANDLORD)).toEqual({
      units: [
        { unitId: 'u-old', ownItems: [] },
        { unitId: 'u-own', ownItems: ['pets'] },
      ],
      items: ['credit_requirements', 'pets'],
      expected: {
        credit_requirements: { credit_requirements: '600+' },
        pets: { no_pets: true, pets: null, pet_fee: '$300' },
      },
    });
  });

  it('batches at the server cap of 100', () => {
    expect(APPLY_BATCH_SIZE).toBe(100);
    expect(chunk(Array.from({ length: 250 }, (_, i) => i), APPLY_BATCH_SIZE).map((b) => b.length)).toEqual([100, 100, 50]);
    expect(chunk([], APPLY_BATCH_SIZE)).toEqual([]);
  });
});

describe('summary + copy', () => {
  it('merges the responses and names each skipped property with a plain reason', () => {
    expect(
      summarizeApply(
        [
          { updated: ['u-old'], skipped: [{ unitId: 'u-own', reason: 'changed_since_opened' }] },
          { updated: [], skipped: [{ unitId: 'u-gone', reason: 'not_found' }] },
        ],
        UNITS,
      ),
    ).toEqual({
      updated: 1,
      skipped: [
        { unitId: 'u-own', address: '3 Own St', reason: 'changed since you opened this - review it again' },
        { unitId: 'u-gone', address: 'u-gone', reason: 'no longer exists' },
      ],
    });
  });

  it('labels a property as the landlord Properties card does: "address - NBR", else the address, else the id', () => {
    expect(propertyRowLabel({ ...OLD, beds: 2 })).toBe('2 Old St - 2BR');
    expect(propertyRowLabel(OLD)).toBe('2 Old St');
    expect(propertyRowLabel({ unitId: 'u-bare', landlordId: 'L1', status: 'setup' })).toBe('u-bare');
  });

  it('words every skip reason per plan 1.1', () => {
    expect(skipReasonCopy('changed_since_opened')).toBe('changed since you opened this - review it again');
    expect(skipReasonCopy('changed_during_apply')).toBe('changed since you opened this - review it again');
    expect(skipReasonCopy('already_matches')).toBe('already matches');
    expect(skipReasonCopy('landlord_changed')).toBe('has a different landlord now');
    expect(skipReasonCopy('deleted')).toBe('was deleted');
    expect(skipReasonCopy('not_found')).toBe('no longer exists');
  });

  it('counts properties in the singular for one', () => {
    expect(updateButtonLabel(1)).toBe('Update 1 property');
    expect(updateButtonLabel(0)).toBe('Update 0 properties');
    expect(updateButtonLabel(12)).toBe('Update 12 properties');
    expect(doneHeadline(1)).toBe('Updated 1 property');
    expect(doneHeadline(3)).toBe('Updated 3 properties');
    expect(stoppedNotice(100)).toBe('Updated 100 properties before this stopped. Review the rest and press Update again.');
    expect(stoppedNotice(1)).toBe('Updated 1 property before this stopped. Review the rest and press Update again.');
    expect(REQUIREMENTS_CHANGED_NOTICE).toBe(
      "This landlord's requirements changed. Review the updated list and press Update again.",
    );
    expect(APPLY_FAILED_NOTICE).toBe("Couldn't update the properties. Review the list and press Update again.");
  });
});
