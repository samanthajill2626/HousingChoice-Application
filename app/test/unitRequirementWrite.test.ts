// property requirements (spec 2026-10-20 D1, D5, D13): the pure write planner
// behind POST /api/units and PATCH /api/units/:unitId
// (lib/unitRequirementWrite.ts) - the create-body snapshot split, the legacy
// pets partner, deposit_conflict against the stored record, the
// classification (a landlord change resets first), the map written whole and
// only when it changes, and the audit field list.
import { describe, expect, it } from 'vitest';
import { REQUIREMENT_ITEM_IDS, REQUIREMENT_UNIT_KEYS, type RequirementsSnapshot } from '../src/lib/requirements.js';
import {
  applyUnitPatch,
  changedKeys,
  depositConflictAfter,
  planRequirementWrite,
  splitRequirementsSnapshot,
  touchesRequirements,
  type RequirementWritePlan,
} from '../src/lib/unitRequirementWrite.js';

const landlord = (requirements: Record<string, unknown> = {}): Record<string, unknown> => ({
  contactId: 'c-ll',
  type: 'landlord',
  ...requirements,
});

const ALL_COPIED = Object.fromEntries(REQUIREMENT_ITEM_IDS.map((id) => [id, 'copied'] as const));

/** A snapshot naming every item with no key set (all blank), then `items` over the top. */
function snapshot(items: RequirementsSnapshot['items'] = {}): RequirementsSnapshot {
  const blank = Object.fromEntries(REQUIREMENT_ITEM_IDS.map((id) => [id, {}] as const)) as RequirementsSnapshot['items'];
  return { landlordId: 'c-ll', items: { ...blank, ...items } };
}

function written(plan: RequirementWritePlan): Extract<RequirementWritePlan, { ok: true }> {
  if (!plan.ok) throw new Error(`expected a write, got ${plan.error}`);
  return plan;
}

describe('touchesRequirements', () => {
  it('is true for every requirement unit key, a REMOVE (null) included', () => {
    for (const key of REQUIREMENT_UNIT_KEYS) expect(touchesRequirements({ [key]: null }), key).toBe(true);
  });

  it('is false for a body without one', () => {
    expect(
      touchesRequirements({ landlordId: 'c-ll', beds: 2, notes: 'x', subzone: 'E8', application_process: 'Online' }),
    ).toBe(false);
  });
});

describe('applyUnitPatch', () => {
  it('SETs values, REMOVEs nulls, skips undefined, and mutates neither input', () => {
    const record = { unitId: 'u-1', pets: 'Cats OK', beds: 2 };
    const patch = { pets: null, no_pets: true, beds: undefined };
    expect(applyUnitPatch(record, patch)).toEqual({ unitId: 'u-1', no_pets: true, beds: 2 });
    expect(record).toEqual({ unitId: 'u-1', pets: 'Cats OK', beds: 2 });
    expect(patch).toEqual({ pets: null, no_pets: true, beds: undefined });
  });
});

describe('changedKeys (D13, plan review PR1-10)', () => {
  it('lists a SET to a new value and a SET of a key the read lacked; not a key re-sent with its stored value', () => {
    expect(
      changedKeys(
        { beds: 2, income_requirements: '2x rent', address: { line1: '1 Main' } },
        { beds: 2, income_requirements: '3x rent', address: { line1: '1 Main' }, pet_fee: '$50' },
      ),
    ).toEqual(['income_requirements', 'pet_fee']);
  });

  it('lists a REMOVE of a key the read held; not a REMOVE of a key it lacked', () => {
    expect(changedKeys({ deposit: 1200 }, { deposit: null, no_pets: null })).toEqual(['deposit']);
  });

  it('never lists requirement_sources, and skips undefined', () => {
    expect(changedKeys({}, { requirement_sources: { pets: 'copied' }, beds: undefined, no_pets: true })).toEqual([
      'no_pets',
    ]);
  });
});

describe('depositConflictAfter (D1)', () => {
  it('a one-month deposit over a STORED fixed amount conflicts', () => {
    expect(depositConflictAfter({ deposit: 1200 }, { deposit_one_month: true })).toBe(true);
  });

  it('sending the amount as null in the same write does not', () => {
    expect(depositConflictAfter({ deposit: 1200 }, { deposit_one_month: true, deposit: null })).toBe(false);
  });

  it('a body carrying no Deposit key is never checked', () => {
    expect(depositConflictAfter({ deposit_one_month: true, deposit: 5 }, { beds: 2 })).toBe(false);
  });

  it('on create (no stored record) the body alone decides', () => {
    expect(depositConflictAfter(undefined, { deposit_one_month: true, deposit: 1200 })).toBe(true);
    expect(depositConflictAfter(undefined, { deposit_flexible: true, deposit: 1200 })).toBe(false);
  });
});

describe('splitRequirementsSnapshot (D5 create)', () => {
  it('passes a body without the key through untouched', () => {
    const body = { landlordId: 'c-ll', beds: 2 };
    const split = splitRequirementsSnapshot(body);
    expect(split).toEqual({ ok: true, body });
    if (split.ok) {
      expect(split.body).toBe(body);
      expect(split.snapshot).toBeUndefined();
    }
  });

  it('takes the snapshot OFF the body and parses it', () => {
    const split = splitRequirementsSnapshot({
      landlordId: 'c-ll',
      beds: 2,
      requirements_snapshot: { landlordId: 'c-ll', pets: { no_pets: true } },
    });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.body).toEqual({ landlordId: 'c-ll', beds: 2 });
    expect(split.snapshot?.landlordId).toBe('c-ll');
    expect(split.snapshot?.items.pets?.['no_pets']).toBe(true);
  });

  it('answers the parse error for a malformed snapshot', () => {
    expect(splitRequirementsSnapshot({ landlordId: 'c-ll', requirements_snapshot: 'x' })).toEqual({
      ok: false,
      error: 'requirements_snapshot must be an object with a landlordId',
    });
  });

  it('passes a body that is not an object through, for the validator to refuse', () => {
    expect(splitRequirementsSnapshot('nope')).toEqual({ ok: true, body: 'nope' });
  });
});

describe('planRequirementWrite - create (D5)', () => {
  it('without a snapshot: only the items written non-blank are classified, against the landlord', () => {
    const plan = written(
      planRequirementWrite({
        stored: undefined,
        fields: { landlordId: 'c-ll', no_pets: true, income_requirements: '3x rent' },
        landlord: landlord({ req_no_pets: true, req_credit_requirements: 'Score 600+' }),
        landlordChanged: false,
      }),
    );
    expect(plan.patch['requirement_sources']).toEqual({ pets: 'copied', income_requirements: 'set_here' });
    expect(plan.auditFields).toEqual(['landlordId', 'no_pets', 'income_requirements']);
  });

  it('without a snapshot and no requirement field: no requirement_sources key at all', () => {
    const plan = written(
      planRequirementWrite({ stored: undefined, fields: { landlordId: 'c-ll', beds: 2 }, landlord: landlord(), landlordChanged: false }),
    );
    expect(plan.patch).toEqual({ landlordId: 'c-ll', beds: 2 });
  });

  it('an all-blank snapshot, a blank landlord and a blank form: all eight copied', () => {
    const plan = written(
      planRequirementWrite({
        stored: undefined,
        fields: { landlordId: 'c-ll' },
        landlord: landlord(),
        landlordChanged: false,
        snapshot: snapshot(),
      }),
    );
    expect(plan.patch['requirement_sources']).toEqual(ALL_COPIED);
  });

  it('with a snapshot: a field left as pre-filled is copied even when the landlord changed since', () => {
    const plan = written(
      planRequirementWrite({
        stored: undefined,
        fields: { landlordId: 'c-ll', no_pets: true, pet_fee: '$300' },
        landlord: landlord({ req_no_pets: true, req_pet_fee: '$350' }),
        landlordChanged: false,
        snapshot: snapshot({ pets: { no_pets: true, pet_fee: '$300' } }),
      }),
    );
    expect(plan.patch['requirement_sources']).toEqual(ALL_COPIED);
  });

  it('deposit_conflict: a new record holding a one-month deposit and a fixed amount', () => {
    expect(
      planRequirementWrite({
        stored: undefined,
        fields: { landlordId: 'c-ll', deposit_one_month: true, deposit: 1200 },
        landlord: landlord(),
        landlordChanged: false,
      }),
    ).toEqual({ ok: false, error: 'deposit_conflict' });
  });
});

describe('planRequirementWrite - PATCH (D5, D1, D13)', () => {
  it('a classified item overwrites its entry; untouched entries are kept; the map is never an audit field', () => {
    const stored = {
      unitId: 'u-1',
      landlordId: 'c-ll',
      credit_requirements: 'Score 650',
      requirement_sources: { credit_requirements: 'set_here' },
    };
    const plan = written(
      planRequirementWrite({
        stored,
        fields: { income_requirements: '3x rent' },
        landlord: landlord({ req_income_requirements: '3x rent' }),
        landlordChanged: false,
      }),
    );
    expect(plan.patch).toEqual({
      income_requirements: '3x rent',
      requirement_sources: { credit_requirements: 'set_here', income_requirements: 'copied' },
    });
    expect(plan.auditFields).toEqual(['income_requirements']);
    expect(stored.requirement_sources).toEqual({ credit_requirements: 'set_here' });
  });

  it('a write that changes no interpreted value leaves the map out of the patch', () => {
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll', income_requirements: '3x rent', requirement_sources: { income_requirements: 'copied' } },
        fields: { income_requirements: '3x rent' },
        landlord: landlord({ req_income_requirements: '2x rent' }),
        landlordChanged: false,
      }),
    );
    expect(plan.patch).toEqual({ income_requirements: '3x rent' });
    expect(plan.sources).toEqual({ income_requirements: 'copied' });
    // D13 (PR1-10): a key re-sent with its stored value is not an audit field.
    expect(plan.auditFields).toEqual([]);
  });

  it('audit fields: a re-sent unchanged key is left out, the changed one listed', () => {
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll', beds: 2, income_requirements: '2x rent' },
        fields: { beds: 2, income_requirements: '3x rent' },
        landlord: landlord({ req_income_requirements: '3x rent' }),
        landlordChanged: false,
      }),
    );
    expect(plan.auditFields).toEqual(['income_requirements']);
  });

  it('audit fields: clearing an amount the unit never held is not listed', () => {
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll' },
        fields: { deposit_one_month: true, deposit: null },
        landlord: landlord(),
        landlordChanged: false,
      }),
    );
    expect(plan.auditFields).toEqual(['deposit_one_month']);
  });

  it('a landlord change with no item REMOVEs the map', () => {
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll', pets: 'Cats OK', requirement_sources: { pets: 'set_here' } },
        fields: { landlordId: 'c-2' },
        landlord: { contactId: 'c-2', type: 'landlord' },
        landlordChanged: true,
      }),
    );
    expect(plan.patch).toEqual({ landlordId: 'c-2', requirement_sources: null });
    expect(plan.auditFields).toEqual(['landlordId']);
  });

  it('a landlord change on a unit with no map and no item writes no map key', () => {
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll' },
        fields: { landlordId: 'c-2' },
        landlord: { contactId: 'c-2', type: 'landlord' },
        landlordChanged: true,
      }),
    );
    expect(plan.patch).toEqual({ landlordId: 'c-2' });
  });

  it('a landlord change AND a touched item: reset first, then classified against the NEW landlord', () => {
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll', pets: 'Cats OK', requirement_sources: { pets: 'set_here' } },
        fields: { landlordId: 'c-2', income_requirements: '3x rent' },
        landlord: { contactId: 'c-2', type: 'landlord', req_income_requirements: '3x rent' },
        landlordChanged: true,
      }),
    );
    expect(plan.patch['requirement_sources']).toEqual({ income_requirements: 'copied' });
  });

  it('legacy pets:false met by a pet_fee write: No pets and blank details are written in the new shape', () => {
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll', pets: false },
        fields: { pet_fee: '$300' },
        landlord: landlord({ req_no_pets: true, req_pet_fee: '$300' }),
        landlordChanged: false,
      }),
    );
    expect(plan.patch).toEqual({ pet_fee: '$300', no_pets: true, pets: null, requirement_sources: { pets: 'copied' } });
    expect(plan.auditFields).toEqual(['pet_fee', 'no_pets', 'pets']);
  });

  it('legacy pets:true met by a pet_fee write: the details read Allowed; an absent no_pets is not listed', () => {
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll', pets: true },
        fields: { pet_fee: '$50' },
        landlord: landlord({ req_pets: 'Allowed', req_pet_fee: '$50' }),
        landlordChanged: false,
      }),
    );
    expect(plan.patch).toEqual({ pet_fee: '$50', pets: 'Allowed', requirement_sources: { pets: 'copied' } });
    expect(plan.auditFields).toEqual(['pet_fee', 'pets']);
  });

  it('legacy pets:true met by a no_pets write keeps the details as they read', () => {
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll', pets: true },
        fields: { no_pets: true },
        landlord: landlord(),
        landlordChanged: false,
      }),
    );
    expect(plan.patch).toEqual({ no_pets: true, pets: 'Allowed', requirement_sources: { pets: 'set_here' } });
  });

  it('a legacy boolean is left alone by a write that touches no Pets key', () => {
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll', pets: false },
        fields: { beds: 3 },
        landlord: landlord(),
        landlordChanged: false,
      }),
    );
    expect(plan.patch).toEqual({ beds: 3 });
  });

  it('a text pets value gets no partner', () => {
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll', pets: 'Cats OK' },
        fields: { pet_fee: '$25' },
        landlord: landlord(),
        landlordChanged: false,
      }),
    );
    expect(Object.keys(plan.patch).sort()).toEqual(['pet_fee', 'requirement_sources']);
  });

  it('a legacy pets key rewritten with the same meaning is not a change: no map write; no_pets (never held) not an audit field', () => {
    // { no_pets: null, pets: 'Allowed' } is what S1's validator makes of a raw `pets: true`.
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll', pets: true },
        fields: { no_pets: null, pets: 'Allowed' },
        landlord: landlord({ req_no_pets: true }),
        landlordChanged: false,
      }),
    );
    expect(plan.patch).toEqual({ no_pets: null, pets: 'Allowed' });
    expect(plan.auditFields).toEqual(['pets']);
  });

  it('deposit_conflict against the stored record', () => {
    expect(
      planRequirementWrite({
        stored: { unitId: 'u-1', landlordId: 'c-ll', deposit: 1200 },
        fields: { deposit_one_month: true },
        landlord: landlord(),
        landlordChanged: false,
      }),
    ).toEqual({ ok: false, error: 'deposit_conflict' });
  });

  it('no landlord: every touched item is set here', () => {
    const plan = written(
      planRequirementWrite({
        stored: { unitId: 'u-1', status: 'available' },
        fields: { credit_requirements: 'Score 600+' },
        landlord: undefined,
        landlordChanged: false,
      }),
    );
    expect(plan.patch['requirement_sources']).toEqual({ credit_requirements: 'set_here' });
  });
});
