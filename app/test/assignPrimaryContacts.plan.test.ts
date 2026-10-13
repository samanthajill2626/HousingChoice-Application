// assign-primary-contacts (spec 2026-10-12 primary-contact-integrity, section
// 8; plan C12, task S5.2): the PURE per-unit planner. WHO takes over always
// comes from the shared heir function (lib/propertyContact.ts chooseHeir and
// applyPrimary) - these tests pin that the script asks it the right question
// and maps its answer to the right outcome, never a rule of its own.
import { describe, expect, it } from 'vitest';
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitContact, UnitItem } from '../src/repos/unitsRepo.js';
import { planUnitPrimary, type UnitPrimaryPlan } from '../scripts/assign-primary-contacts.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';

const landlord = (contactId: string, extra: Partial<ContactItem> = {}): ContactItem => ({
  contactId,
  type: 'landlord',
  status: 'active',
  ...extra,
});
const tenant = (contactId: string): ContactItem => ({ contactId, type: 'tenant', status: 'searching' });
const caseworker = (contactId: string): ContactItem => ({
  contactId,
  type: 'partner',
  status: 'active',
  role: 'Caseworker',
});
const row = (contactId: string, role: UnitContact['role'], primaryContact = false): UnitContact => ({
  contactId,
  role,
  primaryContact,
});
const unitOf = (fields: Partial<UnitItem>): UnitItem => ({ unitId: 'u-1', status: 'available', ...fields }) as UnitItem;
const readOf = (...contacts: ContactItem[]): RosterContactsRead => ({
  ok: true,
  byId: new Map(contacts.map((c) => [c.contactId, c])),
});

function asTarget(plan: UnitPrimaryPlan): Extract<UnitPrimaryPlan, { kind: 'target' }> {
  if (plan.kind !== 'target') throw new Error(`expected a target, got ${plan.kind}`);
  return plan;
}
const flaggedIds = (contacts: UnitContact[]): string[] =>
  contacts.filter((c) => c.primaryContact).map((c) => c.contactId);

describe('planUnitPrimary - targets (spec section 8)', () => {
  it('470 Bolton: no primary, no landlord of record, one live landlord-typed contact -> that contact', () => {
    const plan = asTarget(planUnitPrimary(unitOf({ contacts: [row('c-mark', 'pm')] }), readOf(landlord('c-mark'))));
    expect(plan.heirId).toBe('c-mark');
    expect(plan.from).toBeUndefined();
    expect(plan.write).toEqual({ contacts: [row('c-mark', 'pm', true)], primaryContact: 'c-mark' });
  });

  it('a DELETED flagged primary next to a live landlord of record -> the landlord; from names the deleted contact', () => {
    const unit = unitOf({
      landlordId: 'c-owner',
      contacts: [row('c-owner', 'landlord'), row('c-gone', 'pm', true)],
      primary_contact: 'c-gone',
    });
    const plan = asTarget(
      planUnitPrimary(unit, readOf(landlord('c-owner'), landlord('c-gone', { deleted_at: DELETED_AT }))),
    );
    expect(plan.heirId).toBe('c-owner');
    expect(plan.from).toBe('c-gone');
    expect(plan.write).toEqual({
      contacts: [row('c-owner', 'landlord', true), row('c-gone', 'pm')],
      primaryContact: 'c-owner',
    });
  });

  it('a MISSING flagged primary (hard-deleted by an import retraction) counts as not live', () => {
    const unit = unitOf({ contacts: [row('c-retracted', 'pm', true), row('c-pm', 'owner')] });
    const plan = asTarget(planUnitPrimary(unit, readOf(landlord('c-pm'))));
    expect(plan.heirId).toBe('c-pm');
    expect(plan.from).toBe('c-retracted');
    expect(flaggedIds(plan.write.contacts)).toEqual(['c-pm']);
  });

  it('no landlord: the EARLIEST-added eligible contact - a deleted one, a tenant and a caseworker before it are skipped', () => {
    const unit = unitOf({
      contacts: [
        row('c-gone', 'pm', true),
        row('c-ten', 'other'),
        row('c-cw', 'other'),
        row('c-first', 'owner'),
        row('c-second', 'pm'),
      ],
    });
    const plan = asTarget(
      planUnitPrimary(
        unit,
        readOf(
          landlord('c-gone', { deleted_at: DELETED_AT }),
          tenant('c-ten'),
          caseworker('c-cw'),
          landlord('c-first'),
          landlord('c-second'),
        ),
      ),
    );
    expect(plan.heirId).toBe('c-first');
    expect(plan.from).toBe('c-gone');
    expect(plan.write.contacts.map((c) => c.contactId)).toEqual(['c-gone', 'c-ten', 'c-cw', 'c-first', 'c-second']);
    expect(flaggedIds(plan.write.contacts)).toEqual(['c-first']);
  });

  it('an OFF-ROSTER landlord of record and no flagged row -> the landlord, who gains a landlord row', () => {
    const unit = unitOf({ landlordId: 'c-owner', contacts: [row('c-pm', 'pm')] });
    const plan = asTarget(planUnitPrimary(unit, readOf(landlord('c-owner'), landlord('c-pm'))));
    expect(plan.heirId).toBe('c-owner');
    expect(plan.write.primaryContact).toBe('c-owner');
    expect(plan.write.contacts).toHaveLength(2);
    expect(plan.write.contacts).toContainEqual(
      expect.objectContaining({ contactId: 'c-owner', role: 'landlord', primaryContact: true }),
    );
    expect(plan.write.contacts).toContainEqual(row('c-pm', 'pm'));
    expect(flaggedIds(plan.write.contacts)).toEqual(['c-owner']);
  });

  it('a soft-deleted UNIT is planned like a live one (the script reads them all)', () => {
    const unit = unitOf({ contacts: [row('c-mark', 'pm')], deleted_at: DELETED_AT });
    expect(asTarget(planUnitPrimary(unit, readOf(landlord('c-mark')))).heirId).toBe('c-mark');
  });
});

describe('planUnitPrimary - a live primary stays; only the scalar may be aligned', () => {
  it('a live flagged primary whose scalar is absent or names someone else -> align, the contact list unchanged', () => {
    for (const scalar of [undefined, 'c-old']) {
      const contacts = [row('c-owner', 'landlord'), row('c-pm', 'pm', true)];
      const unit = unitOf({
        landlordId: 'c-owner',
        contacts,
        ...(scalar !== undefined && { primary_contact: scalar }),
      });
      expect(planUnitPrimary(unit, readOf(landlord('c-owner'), landlord('c-pm')))).toEqual({
        kind: 'align',
        write: { contacts, primaryContact: 'c-pm' },
      });
    }
  });

  it('a live flagged primary whose scalar agrees -> unchanged', () => {
    const unit = unitOf({ contacts: [row('c-pm', 'pm', true)], primary_contact: 'c-pm' });
    expect(planUnitPrimary(unit, readOf(landlord('c-pm')))).toEqual({ kind: 'unchanged' });
  });

  it('a landlord-only unit (no stored contact list: the DERIVED landlord row is primary) is left alone, whatever its scalar', () => {
    const unit = unitOf({ landlordId: 'c-owner', primary_contact: 'c-someone' });
    expect(planUnitPrimary(unit, readOf(landlord('c-owner')))).toEqual({ kind: 'unchanged' });
  });

  it('a live flagged primary that is NOT eligible (a tenant made primary by hand) is not replaced', () => {
    const unit = unitOf({ contacts: [row('c-ten', 'other', true), row('c-pm', 'pm')], primary_contact: 'c-ten' });
    expect(planUnitPrimary(unit, readOf(tenant('c-ten'), landlord('c-pm')))).toEqual({ kind: 'unchanged' });
  });
});

describe('planUnitPrimary - counted, never written', () => {
  it('noHeir: no live contact and no live landlord of record', () => {
    const gone = landlord('c-gone', { deleted_at: DELETED_AT });
    // A deleted sole primary...
    expect(
      planUnitPrimary(unitOf({ contacts: [row('c-gone', 'pm', true)], primary_contact: 'c-gone' }), readOf(gone)),
    ).toEqual({ kind: 'noHeir' });
    // ...a landlord-only unit whose landlord of record is deleted...
    expect(planUnitPrimary(unitOf({ landlordId: 'c-gone' }), readOf(gone))).toEqual({ kind: 'noHeir' });
    // ...and an ownerless unit with no contacts at all.
    expect(planUnitPrimary(unitOf({}), readOf())).toEqual({ kind: 'noHeir' });
  });

  it('noEligible: live contacts exist, but only a tenant and a caseworker', () => {
    const unit = unitOf({ contacts: [row('c-ten', 'other'), row('c-cw', 'other')] });
    expect(planUnitPrimary(unit, readOf(tenant('c-ten'), caseworker('c-cw')))).toEqual({ kind: 'noEligible' });
  });

  it('unknown: the contact read failed - even for a unit that would otherwise be fine', () => {
    expect(planUnitPrimary(unitOf({ contacts: [row('c-mark', 'pm')] }), { ok: false })).toEqual({ kind: 'unknown' });
    expect(planUnitPrimary(unitOf({ landlordId: 'c-owner' }), { ok: false })).toEqual({ kind: 'unknown' });
  });
});
