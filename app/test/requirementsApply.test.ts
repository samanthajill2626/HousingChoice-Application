// Unit tests for planUnitApply (spec
// docs/superpowers/specs/2026-10-20-property-requirements-design.md D8, D5,
// D6, D13): the pure per-unit decision of Apply to properties. The S3 route
// does the reads, the conditional write (changed_during_apply) and the audit;
// this suite pins the decision.
import { describe, expect, it } from 'vitest';
import {
  REQUIREMENT_ITEM_IDS,
  landlordItemValue,
  planUnitApply,
  unitItemValue,
  type ItemValue,
  type RequirementItemId,
} from '../src/lib/requirements.js';

const LANDLORD_ID = 'contact-ll-1';

/** The landlord's requirements as stored on the contact (req_ keys). */
const LANDLORD: Record<string, unknown> = {
  contactId: LANDLORD_ID,
  type: 'landlord',
  req_credit_requirements: '600+',
  req_no_pets: true,
  req_pet_fee: '$300',
  req_tour_type: 'landlord_led',
  req_tour_process: 'Text Ana a day ahead',
};

/** A landlord with no requirement recorded at all. */
const BLANK_LANDLORD: Record<string, unknown> = { contactId: LANDLORD_ID, type: 'landlord' };

function valuesOf(
  landlord: Record<string, unknown>,
  ids: readonly RequirementItemId[],
): Partial<Record<RequirementItemId, ItemValue>> {
  const out: Partial<Record<RequirementItemId, ItemValue>> = {};
  for (const id of ids) out[id] = landlordItemValue(landlord, id);
  return out;
}

function unit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { unitId: 'unit-1', landlordId: LANDLORD_ID, status: 'available', ...overrides };
}

/** The unit's own items as the dialog read them (PR-1 `seen`): by default the
 *  unit as given, i.e. nothing changed since the dialog's read. */
function seenOf(
  u: Record<string, unknown> | undefined,
  ownItems: readonly RequirementItemId[],
): Partial<Record<RequirementItemId, ItemValue>> {
  const out: Partial<Record<RequirementItemId, ItemValue>> = {};
  for (const id of ownItems) out[id] = unitItemValue(u ?? {}, id);
  return out;
}

function plan(
  u: Record<string, unknown> | undefined,
  items: readonly RequirementItemId[],
  ownItems: readonly RequirementItemId[] = [],
  landlord: Record<string, unknown> = LANDLORD,
  seen: Partial<Record<RequirementItemId, ItemValue>> = seenOf(u, ownItems),
) {
  return planUnitApply({
    unit: u,
    landlordId: LANDLORD_ID,
    items,
    landlordValues: valuesOf(landlord, items),
    ownItems,
    seen,
  });
}

describe('planUnitApply - skips, in check order (D8)', () => {
  it('not_found when the consistent read found nothing', () => {
    expect(plan(undefined, ['pets'])).toEqual({ kind: 'skip', reason: 'not_found' });
  });

  it('deleted when the unit carries deleted_at - checked before the landlord', () => {
    expect(plan(unit({ deleted_at: '2026-10-19T12:00:00.000Z', landlordId: 'contact-ll-2' }), ['pets'])).toEqual({
      kind: 'skip',
      reason: 'deleted',
    });
    // An empty stamp is not deleted (unitsRepo isDeleted).
    expect(plan(unit({ deleted_at: '' }), ['pets']).kind).toBe('write');
  });

  it('landlord_changed when the landlord of record is not this contact - checked before the values', () => {
    expect(plan(unit({ landlordId: 'contact-ll-2', no_pets: true, pet_fee: '$300' }), ['pets'])).toEqual({
      kind: 'skip',
      reason: 'landlord_changed',
    });
    expect(plan({ unitId: 'unit-1', status: 'available' }, ['pets'])).toEqual({ kind: 'skip', reason: 'landlord_changed' });
  });

  it('already_matches when no listed item changes by interpreted value', () => {
    expect(
      plan(unit({ credit_requirements: ' 600+ ', no_pets: true, pet_fee: '$300' }), ['credit_requirements', 'pets']),
    ).toEqual({ kind: 'skip', reason: 'already_matches' });
  });

  it('a legacy pets boolean that MEANS the landlord value is no change', () => {
    const landlord = { contactId: LANDLORD_ID, req_no_pets: true };
    expect(plan(unit({ pets: false }), ['pets'], [], landlord)).toEqual({ kind: 'skip', reason: 'already_matches' });
  });

  it('changed_since_opened when a changing item is an own value the request did not list', () => {
    // never touched + not blank
    expect(plan(unit({ pets: 'Cats OK' }), ['pets'])).toEqual({ kind: 'skip', reason: 'changed_since_opened' });
    // set_here
    expect(
      plan(unit({ credit_requirements: '550+', requirement_sources: { credit_requirements: 'set_here' } }), ['credit_requirements']),
    ).toEqual({ kind: 'skip', reason: 'changed_since_opened' });
    // listed for another item only
    expect(plan(unit({ pets: 'Cats OK' }), ['pets', 'credit_requirements'], ['credit_requirements'])).toEqual({
      kind: 'skip',
      reason: 'changed_since_opened',
    });
  });

  // Planner ruling PR-1 (code review PA-1): an own value in ownItems is
  // written only while it still equals what the dialog showed (`seen`).
  it('changed_since_opened when an accepted own value is no longer the value the dialog showed', () => {
    const u = unit({ pets: 'Cats and small dogs OK', pet_fee: '$200', requirement_sources: { pets: 'set_here' } });
    const shown = { pets: { no_pets: null, pets: 'Cats OK', pet_fee: null } };
    expect(plan(u, ['pets'], ['pets'], LANDLORD, shown)).toEqual({ kind: 'skip', reason: 'changed_since_opened' });
    // No seen value at all for an accepted own item is no consent either.
    expect(plan(u, ['pets'], ['pets'], LANDLORD, {})).toEqual({ kind: 'skip', reason: 'changed_since_opened' });
  });

  it('an accepted own value that still equals seen (D1 equality) is written; seen never holds back a value that is not own', () => {
    const u = unit({ pets: 'Cats OK', requirement_sources: { pets: 'set_here' } });
    const shown = { pets: { no_pets: null, pets: ' Cats OK ', pet_fee: null } };
    expect(plan(u, ['pets'], ['pets'], LANDLORD, shown).kind).toBe('write');
    // A copied (not own) item is written whatever seen says.
    const copied = unit({ pets: 'Dogs OK', requirement_sources: { pets: 'copied' } });
    expect(plan(copied, ['pets'], [], LANDLORD, {}).kind).toBe('write');
  });

  it('already_matches is decided before changed_since_opened: an EQUAL own value blocks nothing', () => {
    expect(plan(unit({ no_pets: true, pet_fee: '$300', requirement_sources: { pets: 'set_here' } }), ['pets'])).toEqual({
      kind: 'skip',
      reason: 'already_matches',
    });
  });
});

describe('planUnitApply - writes (D8, D5, D13)', () => {
  it('writes every key of each changing item (SET or REMOVE) and marks it copied', () => {
    const u = unit({
      credit_requirements: '550+',
      pets: 'Cats OK',
      pet_fee: '$250',
      requirement_sources: { credit_requirements: 'copied', pets: 'copied' },
    });
    expect(plan(u, ['credit_requirements', 'pets'])).toEqual({
      kind: 'write',
      patch: {
        credit_requirements: '600+',
        no_pets: true,
        pets: null,
        pet_fee: '$300',
        requirement_sources: { credit_requirements: 'copied', pets: 'copied' },
      },
      changedKeys: ['credit_requirements', 'no_pets', 'pets', 'pet_fee'],
      changedItems: ['credit_requirements', 'pets'],
    });
  });

  it('a blank landlord item ("Clears") REMOVEs the item on the unit', () => {
    const u = unit({
      no_evictions_on_program: true,
      evictions_notes: 'None in 5 years',
      requirement_sources: { evictions: 'copied' },
    });
    expect(plan(u, ['evictions'])).toEqual({
      kind: 'write',
      patch: { no_evictions_on_program: null, evictions_notes: null, requirement_sources: { evictions: 'copied' } },
      changedKeys: ['no_evictions_on_program', 'evictions_notes'],
      changedItems: ['evictions'],
    });
  });

  it('normalizes the pets pair over a legacy boolean', () => {
    expect(plan(unit({ pets: true, requirement_sources: { pets: 'copied' } }), ['pets'])).toEqual({
      kind: 'write',
      patch: { no_pets: true, pets: null, pet_fee: '$300', requirement_sources: { pets: 'copied' } },
      changedKeys: ['no_pets', 'pets', 'pet_fee'],
      changedItems: ['pets'],
    });
  });

  it('writes an own value when the request listed it in ownItems', () => {
    const res = plan(unit({ pets: 'Cats OK' }), ['pets'], ['pets']);
    expect(res).toEqual({
      kind: 'write',
      patch: { no_pets: true, pets: null, pet_fee: '$300', requirement_sources: { pets: 'copied' } },
      changedKeys: ['no_pets', 'pets', 'pet_fee'],
      changedItems: ['pets'],
    });
  });

  it('a listed item that already equaled the landlord keeps its record and is not written', () => {
    const u = unit({
      no_pets: true,
      pet_fee: '$300',
      credit_requirements: '550+',
      requirement_sources: { pets: 'set_here' },
    });
    const res = plan(u, ['pets', 'credit_requirements'], ['credit_requirements']);
    expect(res).toEqual({
      kind: 'write',
      patch: { credit_requirements: '600+', requirement_sources: { pets: 'set_here', credit_requirements: 'copied' } },
      changedKeys: ['credit_requirements'],
      changedItems: ['credit_requirements'],
    });
  });

  it('keeps the other items records and drops junk from the stored map', () => {
    const u = unit({
      credit_requirements: '550+',
      requirement_sources: { touring: 'set_here', credit_requirements: 'copied', bogus: 'copied', evictions: 'manual' },
    });
    const res = plan(u, ['credit_requirements']);
    expect(res.kind === 'write' && res.patch['requirement_sources']).toEqual({
      touring: 'set_here',
      credit_requirements: 'copied',
    });
  });

  it('an all-blank landlord: its Clears items meet existing values, which are own values', () => {
    // The lean seed's unit A shape (app/src/lib/seed/lean.ts:224-226): never touched values.
    const u = unit({ pets: 'No pets', deposit: 1650, tour_process: 'Text landlord; lockbox tours weekdays 9-5.' });
    expect(plan(u, REQUIREMENT_ITEM_IDS, [], BLANK_LANDLORD)).toEqual({ kind: 'skip', reason: 'changed_since_opened' });
    expect(plan(u, REQUIREMENT_ITEM_IDS, ['pets', 'deposit', 'touring'], BLANK_LANDLORD)).toEqual({
      kind: 'write',
      patch: {
        no_pets: null,
        pets: null,
        pet_fee: null,
        deposit_one_month: null,
        deposit: null,
        deposit_flexible: null,
        deposit_notes: null,
        tour_type: null,
        tour_process: null,
        requirement_sources: { pets: 'copied', deposit: 'copied', touring: 'copied' },
      },
      changedKeys: ['pets', 'deposit', 'tour_process'],
      changedItems: ['pets', 'deposit', 'touring'],
    });
  });

  it('changedKeys lists only stored values the write changes - never requirement_sources', () => {
    const res = plan(unit({ no_pets: true, pet_fee: '$250', requirement_sources: { pets: 'copied' } }), ['pets']);
    expect(res.kind === 'write' && res.changedKeys).toEqual(['pet_fee']);
    expect(res.kind === 'write' && res.patch).toEqual({
      no_pets: true,
      pets: null,
      pet_fee: '$300',
      requirement_sources: { pets: 'copied' },
    });
  });

  it('rewriting untrimmed stored text in a changing item is a stored-value change', () => {
    const res = plan(unit({ pet_fee: ' $300 ', requirement_sources: { pets: 'copied' } }), ['pets']);
    expect(res.kind === 'write' && res.changedKeys).toEqual(['no_pets', 'pet_fee']);
  });

  it('decides items in registry order whatever order the request lists them', () => {
    const res = plan(unit({ requirement_sources: {} }), ['pets', 'credit_requirements']);
    expect(res.kind === 'write' && res.changedItems).toEqual(['credit_requirements', 'pets']);
  });

  it('never mutates the unit it was given', () => {
    const u = unit({ pets: true, requirement_sources: { pets: 'copied' } });
    const before = JSON.stringify(u);
    plan(u, ['pets']);
    expect(JSON.stringify(u)).toBe(before);
  });

  it('throws when a listed item has no landlord value (a route bug, never a silent clear)', () => {
    expect(() =>
      planUnitApply({ unit: unit(), landlordId: LANDLORD_ID, items: ['pets'], landlordValues: {}, ownItems: [], seen: {} }),
    ).toThrow('planUnitApply: no landlord value for item pets');
  });
});
