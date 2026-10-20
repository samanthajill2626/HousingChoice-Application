// Unit tests for where each requirement value came from (spec
// docs/superpowers/specs/2026-10-20-property-requirements-design.md D5, D6):
// the stored requirement_sources map read, the OWN VALUE definition, the
// create snapshot parser and nextRequirementSources - the ONE classification
// rule create and PATCH share. Pure. The routes that call these (S2) assert
// the same rules over HTTP; the dashboard mirror (S5) carries these cases.
import { describe, expect, it } from 'vitest';
import {
  REQUIREMENT_ITEM_IDS,
  isOwnValue,
  landlordItemValue,
  nextRequirementSources,
  parseRequirementsSnapshot,
  readRequirementSources,
  unitItemValue,
  type RequirementItemId,
  type RequirementSources,
  type RequirementsSnapshot,
} from '../src/lib/requirements.js';

/** The landlord the New form pre-filled from (req_ keys, as stored on the contact). */
const LANDLORD: Record<string, unknown> = {
  contactId: 'contact-ll-1',
  type: 'landlord',
  req_no_pets: true,
  req_pet_fee: '$300',
  req_deposit_one_month: true,
  req_deposit_flexible: true,
  req_application_fee: 50,
  req_tour_type: 'self_guided',
  req_tour_process: 'Lockbox on the porch',
};

/** What the New form sends as requirements_snapshot, parsed (every item it names). */
function snapshotOf(
  landlord: Record<string, unknown>,
  ids: readonly RequirementItemId[] = REQUIREMENT_ITEM_IDS,
): RequirementsSnapshot {
  const items: RequirementsSnapshot['items'] = {};
  for (const id of ids) items[id] = landlordItemValue(landlord, id);
  return { landlordId: 'contact-ll-1', items };
}

/** The create body after the form pre-filled LANDLORD and staff changed nothing. */
const PREFILLED: Record<string, unknown> = {
  landlordId: 'contact-ll-1',
  beds: 2,
  no_pets: true,
  pet_fee: '$300',
  deposit_one_month: true,
  deposit_flexible: true,
  application_fee: 50,
  tour_type: 'self_guided',
  tour_process: 'Lockbox on the porch',
};

const ALL_COPIED: RequirementSources = Object.fromEntries(REQUIREMENT_ITEM_IDS.map((id) => [id, 'copied']));

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

describe('parseRequirementsSnapshot - the create snapshot (D5, plan 2.4)', () => {
  it('refuses a snapshot that is not an object with a non-empty string landlordId', () => {
    for (const bad of [undefined, null, 'contact-ll-1', 42, [], {}, { landlordId: 7 }, { landlordId: '' }]) {
      expect(parseRequirementsSnapshot(bad), JSON.stringify(bad) ?? 'undefined').toEqual({
        ok: false,
        error: 'requirements_snapshot must be an object with a landlordId',
      });
    }
  });

  it('refuses an item value that is not a plain object', () => {
    for (const bad of [null, 'No pets', [], 42, true]) {
      expect(parseRequirementsSnapshot({ landlordId: 'contact-ll-1', pets: bad })).toEqual({
        ok: false,
        error: 'requirements_snapshot.pets must be an object',
      });
    }
  });

  it('reads the named items through their kinds: a missing or failing key is blank; unknown ids and keys are ignored', () => {
    expect(
      parseRequirementsSnapshot({
        landlordId: 'contact-ll-1',
        pets: { no_pets: true, pet_fee: ' $300 ', extra: 'ignored' },
        deposit: { deposit: 'abc', deposit_flexible: true },
        touring: { tour_type: 'concierge', tour_process: 'Call' },
        bogus_item: { anything: 1 },
      }),
    ).toEqual({
      ok: true,
      snapshot: {
        landlordId: 'contact-ll-1',
        items: {
          pets: { no_pets: true, pets: null, pet_fee: '$300' },
          deposit: { deposit_one_month: null, deposit: null, deposit_flexible: true, deposit_notes: null },
          touring: { tour_type: null, tour_process: 'Call' },
        },
      },
    });
  });

  it('a boolean pets in a snapshot is blank (the landlord side never holds one)', () => {
    const res = parseRequirementsSnapshot({ landlordId: 'contact-ll-1', pets: { pets: false } });
    expect(res.ok && res.snapshot.items.pets).toEqual({ no_pets: null, pets: null, pet_fee: null });
  });

  it('an all-blank landlord snapshot parses to eight all-blank items', () => {
    const wire: Record<string, unknown> = { landlordId: 'contact-ll-1' };
    for (const id of REQUIREMENT_ITEM_IDS) wire[id] = {};
    const res = parseRequirementsSnapshot(wire);
    expect(res.ok && Object.keys(res.snapshot.items)).toEqual([...REQUIREMENT_ITEM_IDS]);
    expect(res.ok && Object.values(res.snapshot.items).every((v) => Object.values(v).every((x) => x === null))).toBe(true);
  });

  it('a snapshot naming no item has no items', () => {
    expect(parseRequirementsSnapshot({ landlordId: 'contact-ll-1' })).toEqual({
      ok: true,
      snapshot: { landlordId: 'contact-ll-1', items: {} },
    });
  });
});

describe('nextRequirementSources - create (D5)', () => {
  it('with a snapshot and the values left as pre-filled: all eight items copied', () => {
    expect(
      nextRequirementSources({ before: {}, after: PREFILLED, current: {}, landlord: LANDLORD, snapshot: snapshotOf(LANDLORD) }),
    ).toEqual(ALL_COPIED);
  });

  it('still all copied when the landlord changed after the snapshot (the target is the snapshot)', () => {
    const changed = { ...LANDLORD, req_pet_fee: '$500', req_application_fee: 75, req_credit_requirements: '650+' };
    expect(
      nextRequirementSources({ before: {}, after: PREFILLED, current: {}, landlord: changed, snapshot: snapshotOf(LANDLORD) }),
    ).toEqual(ALL_COPIED);
  });

  it('a pre-filled value staff cleared is set_here', () => {
    const { pet_fee: _cleared, ...after } = PREFILLED;
    expect(
      nextRequirementSources({ before: {}, after, current: {}, landlord: LANDLORD, snapshot: snapshotOf(LANDLORD) }),
    ).toEqual({ ...ALL_COPIED, pets: 'set_here' });
  });

  it('a pre-filled value staff changed is set_here', () => {
    expect(
      nextRequirementSources({
        before: {},
        after: { ...PREFILLED, application_fee: 0 },
        current: {},
        landlord: LANDLORD,
        snapshot: snapshotOf(LANDLORD),
      }),
    ).toEqual({ ...ALL_COPIED, application_fee: 'set_here' });
  });

  it('an item the snapshot does not name is classified as if there were no snapshot', () => {
    const named = REQUIREMENT_ITEM_IDS.filter(
      (id) => id !== 'qualifications' && id !== 'credit_requirements' && id !== 'touring',
    );
    expect(
      nextRequirementSources({
        before: {},
        after: { ...PREFILLED, qualifications: 'Background check' },
        current: {},
        landlord: LANDLORD,
        snapshot: snapshotOf(LANDLORD, named),
      }),
    ).toEqual({
      evictions: 'copied',
      income_requirements: 'copied',
      pets: 'copied',
      deposit: 'copied',
      application_fee: 'copied',
      // written, and the landlord has none -> set_here
      qualifications: 'set_here',
      // written, equal to the landlord's CURRENT value -> copied
      touring: 'copied',
      // credit_requirements: neither named nor written -> never touched (absent)
    });
  });

  it('without a snapshot: only items written non-blank, against the CURRENT landlord', () => {
    expect(
      nextRequirementSources({
        before: {},
        after: { landlordId: 'contact-ll-1', beds: 2, no_pets: true, pet_fee: '$300', application_fee: 0, tour_process: 'Call me' },
        current: {},
        landlord: LANDLORD,
      }),
    ).toEqual({ pets: 'copied', application_fee: 'set_here', touring: 'set_here' });
  });

  it('with no landlord: every classified item is set_here', () => {
    expect(nextRequirementSources({ before: {}, after: { no_pets: true }, current: {}, landlord: undefined })).toEqual({
      pets: 'set_here',
    });
  });
});

describe('nextRequirementSources - PATCH (D5)', () => {
  const stored: Record<string, unknown> = {
    unitId: 'unit-1',
    landlordId: 'contact-ll-1',
    status: 'available',
    no_pets: true,
    pet_fee: '$300',
    requirement_sources: { pets: 'copied' },
  };

  it('an edit that makes a value differ makes it set_here; editing it back makes it copied again', () => {
    const differ = nextRequirementSources({
      before: stored,
      after: { ...stored, pet_fee: '$450' },
      current: readRequirementSources(stored['requirement_sources']),
      landlord: LANDLORD,
    });
    expect(differ).toEqual({ pets: 'set_here' });
    const edited = { ...stored, pet_fee: '$450', requirement_sources: differ };
    expect(
      nextRequirementSources({ before: edited, after: { ...edited, pet_fee: '$300' }, current: differ, landlord: LANDLORD }),
    ).toEqual({ pets: 'copied' });
  });

  it('a PATCH of one Deposit key classifies the whole Deposit item', () => {
    const before = { ...stored, deposit_one_month: true };
    expect(
      nextRequirementSources({ before, after: { ...before, deposit_flexible: true }, current: {}, landlord: LANDLORD }),
    ).toEqual({ deposit: 'copied' });
    const whole = { ...stored, deposit_one_month: true, deposit_flexible: true };
    expect(
      nextRequirementSources({ before: whole, after: { ...whole, deposit_notes: 'Half up front' }, current: {}, landlord: LANDLORD }),
    ).toEqual({ deposit: 'set_here' });
  });

  it('a cleared deposit amount counts as a change', () => {
    const before = { ...stored, deposit: 1400 };
    const after = { ...before, deposit: null, deposit_one_month: true };
    expect(nextRequirementSources({ before, after, current: {}, landlord: LANDLORD })).toEqual({ deposit: 'set_here' });
    expect(
      nextRequirementSources({ before, after, current: {}, landlord: { contactId: 'contact-ll-1', req_deposit_one_month: true } }),
    ).toEqual({ deposit: 'copied' });
  });

  it('items the write does not change keep their records', () => {
    expect(
      nextRequirementSources({
        before: stored,
        after: { ...stored, pet_fee: '$450' },
        current: { touring: 'set_here', evictions: 'copied', pets: 'copied' },
        landlord: LANDLORD,
      }),
    ).toEqual({ touring: 'set_here', evictions: 'copied', pets: 'set_here' });
  });

  it('text that is equal after trimming is no change', () => {
    expect(
      nextRequirementSources({ before: stored, after: { ...stored, pet_fee: ' $300 ' }, current: { pets: 'set_here' }, landlord: LANDLORD }),
    ).toEqual({ pets: 'set_here' });
  });

  it('rewriting a legacy pets boolean into the new shape with the same meaning classifies nothing', () => {
    const legacy = { ...stored, no_pets: undefined, pet_fee: undefined, pets: false, requirement_sources: { pets: 'set_here' } };
    const rewritten = { ...legacy, no_pets: true, pets: null };
    expect(nextRequirementSources({ before: legacy, after: rewritten, current: { pets: 'set_here' }, landlord: LANDLORD })).toEqual({
      pets: 'set_here',
    });
    expect(nextRequirementSources({ before: legacy, after: rewritten, current: {}, landlord: LANDLORD })).toEqual({});
  });

  it('a raw boolean pets write (stored by the validator as the new shape) classifies the Pets item', () => {
    const before = { landlordId: 'contact-ll-1', pets: 'Cats OK' };
    const after = { ...before, no_pets: true, pets: null };
    expect(nextRequirementSources({ before, after, current: {}, landlord: LANDLORD })).toEqual({ pets: 'set_here' });
    expect(
      nextRequirementSources({ before, after, current: {}, landlord: { contactId: 'contact-ll-1', req_no_pets: true } }),
    ).toEqual({ pets: 'copied' });
  });

  it('a PATCH of pet_fee alone on a legacy boolean property keeps No pets as it read', () => {
    const before = { landlordId: 'contact-ll-1', pets: false };
    // The S2 route adds the partner keys in their interpreted shape.
    const after = { ...before, pet_fee: '$300', no_pets: true, pets: null };
    expect(unitItemValue(after, 'pets')).toEqual({ no_pets: true, pets: null, pet_fee: '$300' });
    expect(nextRequirementSources({ before, after, current: {}, landlord: LANDLORD })).toEqual({ pets: 'copied' });
  });

  it('a landlord change: the caller resets current to {} and classifies the touched items against the NEW landlord', () => {
    const newLandlord = { contactId: 'contact-ll-2', type: 'landlord', req_no_pets: true, req_pet_fee: '$450' };
    expect(
      nextRequirementSources({
        before: { ...stored, requirement_sources: { pets: 'copied', touring: 'set_here' } },
        after: { ...stored, landlordId: 'contact-ll-2', pet_fee: '$450' },
        current: {},
        landlord: newLandlord,
      }),
    ).toEqual({ pets: 'copied' });
  });

  it('no landlord: a touched item is set_here, even when the write cleared it', () => {
    expect(
      nextRequirementSources({ before: { pet_fee: '$300' }, after: {}, current: {}, landlord: undefined }),
    ).toEqual({ pets: 'set_here' });
  });

  it('returns a new map and never mutates current', () => {
    const current = Object.freeze({ touring: 'set_here' as const });
    const next = nextRequirementSources({ before: stored, after: { ...stored, pet_fee: '$1' }, current, landlord: LANDLORD });
    expect(next).not.toBe(current);
    expect(current).toEqual({ touring: 'set_here' });
  });
});
