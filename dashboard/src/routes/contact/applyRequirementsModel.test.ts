import { describe, expect, it } from 'vitest';
import type { Contact, UnitItem } from '../../api/index.js';
import type { RequirementItemId } from '../listing/requirements.js';
import {
  APPLY_BATCH_SIZE,
  APPLY_FAILED_NOTICE,
  DEPOSIT_CONFLICT_NOTICE,
  REQUIREMENTS_CHANGED_NOTICE,
  applyRequestBody,
  applyRows,
  carryCheckedItems,
  carryHandChoices,
  carryHandUnchecks,
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

// Worklist OR-17, amended by OR-34 and OR-35 (code review R3-1, R3-3): after
// an Update that stopped or failed - a first-request 409 requirements_changed
// included - the re-read keeps what staff chose on the left instead of
// resetting it to the defaults. carryCheckedItems(previous, landlord, seen):
// each item staff CHECKED (`previous`) stays checked while the re-read
// `landlord` holds a value, or holds the same value as `seen` (the landlord
// the dialog showed when staff pressed Update - so a deliberate Clears of an
// unchanged blank survives); it comes back unchecked only when it turned
// blank since. An item staff UNCHECKED stays unchecked, and the carry never
// adds an item staff did not check.
describe('carryCheckedItems - the left column across a re-read (worklist OR-17, OR-35)', () => {
  it('an item staff unchecked stays unchecked, blank or not', () => {
    // The landlord still holds Credit score; staff had unchecked it.
    expect(orderedItems(carryCheckedItems(set('pets'), LANDLORD, LANDLORD))).toEqual(['pets']);
    // Evictions is blank ("Clears") and unchanged; staff never checked it.
    expect(carryCheckedItems(set('pets'), LANDLORD, LANDLORD).has('evictions')).toBe(false);
  });

  it('a checked item the re-read landlord holds a value for stays checked, a changed value included', () => {
    expect(orderedItems(carryCheckedItems(set('credit_requirements', 'pets'), LANDLORD, LANDLORD))).toEqual([
      'credit_requirements',
      'pets',
    ]);
    // A new pet fee: still checked (the re-read shows the new value).
    const newFee: Contact = { ...LANDLORD, req_pet_fee: '$350' };
    expect(orderedItems(carryCheckedItems(set('credit_requirements', 'pets'), newFee, LANDLORD))).toEqual([
      'credit_requirements',
      'pets',
    ]);
    // A Clears staff checked that the landlord has filled in since: a value now, still checked.
    const touringNow: Contact = { ...LANDLORD, req_tour_type: 'self_guided' };
    expect(carryCheckedItems(set('touring'), touringNow, LANDLORD).has('touring')).toBe(true);
  });

  it('a checked item that turned blank since comes back unchecked - never a surprise Clears', () => {
    const petsBlanked: Contact = { contactId: 'L1', type: 'landlord', req_credit_requirements: '600+' };
    expect(orderedItems(carryCheckedItems(set('credit_requirements', 'pets'), petsBlanked, LANDLORD))).toEqual([
      'credit_requirements',
    ]);
  });

  // Code review R3-3: the carry once kept only the items the re-read landlord
  // held, so a Clears staff chose was dropped by every re-read - after a
  // mid-run stop, 100 properties cleared and 50 not.
  it('a Clears item staff checked on purpose stays checked while the landlord still holds the blank staff saw (code review R3-3)', () => {
    expect(orderedItems(carryCheckedItems(set('evictions', 'pets', 'touring'), LANDLORD, LANDLORD))).toEqual([
      'evictions',
      'pets',
      'touring',
    ]);
    // Something else changed (the pet fee), the blank did not: still checked.
    expect(carryCheckedItems(set('touring'), { ...LANDLORD, req_pet_fee: '$350' }, LANDLORD).has('touring')).toBe(true);
  });

  it('an item the landlord filled in since is not checked by the carry (staff never chose it)', () => {
    const more: Contact = { ...LANDLORD, req_income_requirements: '3x rent' };
    expect(orderedItems(carryCheckedItems(set('pets'), more, LANDLORD))).toEqual(['pets']);
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

// Worklist OR-32 (code review R2D-1, amends OR-17): the same preserving
// re-read that keeps the left column (carryCheckedItems) keeps the rows staff
// UNCHECKED by hand; the rows staff CHECKED by hand go back to their starting
// state (staff confirm a check again). So no re-read ever writes more than
// staff chose - rows and items alike.
describe('carryHandUnchecks - the row choices across a preserving re-read (worklist OR-32)', () => {
  const rows = applyRows(UNITS, LANDLORD, set('pets', 'credit_requirements'));

  it('a row staff unchecked stays unchecked while it is listed and not Already matches', () => {
    const carried = carryHandUnchecks(new Map([['u-old', false]]), rows);
    expect(carried).toEqual(new Map([['u-old', false]]));
    expect(rowIsChecked(rowOf(rows, 'u-old'), carried)).toBe(false);
  });

  it('a row staff checked by hand goes back to its starting state - staff confirm it again', () => {
    const carried = carryHandUnchecks(new Map([['u-own', true], ['u-old', false]]), rows);
    expect(carried.has('u-own')).toBe(false);
    expect(rowIsChecked(rowOf(rows, 'u-own'), carried)).toBe(false); // an own value: starts unchecked
    expect(carried.get('u-old')).toBe(false);
  });

  it('an uncheck is dropped for a row the re-read no longer lists, or that already matches now', () => {
    // u-old left this landlord (or was deleted) since.
    expect(carryHandUnchecks(new Map([['u-old', false]]), applyRows([MATCH, OWN], LANDLORD, set('pets'))).size).toBe(0);
    // u-old was brought in line since: Already matches, so the uncheck is released.
    const inLine: UnitItem = { ...OLD, pet_fee: '$300', credit_requirements: '600+' };
    const reread = applyRows([MATCH, inLine, OWN], LANDLORD, set('pets', 'credit_requirements'));
    expect(rowOf(reread, 'u-old').alreadyMatches).toBe(true);
    expect(carryHandUnchecks(new Map([['u-old', false]]), reread).size).toBe(0);
  });

  it('nothing chosen by hand carries nothing', () => {
    expect(carryHandUnchecks(new Map(), rows).size).toBe(0);
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
    // Code review R2D-13 (amends OR-31): the fix is behind the dialog.
    expect(DEPOSIT_CONFLICT_NOTICE).toBe(
      "This landlord's deposit is set to both one month's rent and a fixed amount. Close this, fix it with Edit requirements, then open Apply to properties again.",
    );
  });
});
