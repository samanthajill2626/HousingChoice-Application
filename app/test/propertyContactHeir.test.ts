// Unit tests for the heir function and applyPrimary (primary-contact-integrity
// spec 4.3 / 4.7, plan contract 2.1 / C4). PURE - no I/O, no DynamoDB. The
// real units repo AND the API-test fake both call these two functions (slice
// S2), so pinning them here pins both.
import { describe, expect, it } from 'vitest';
import { applyPrimary, chooseHeir, type RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitContact } from '../src/repos/unitsRepo.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';
const contact = (o: Record<string, unknown>): ContactItem => o as unknown as ContactItem;
const row = (contactId: string, role: UnitContact['role'], primaryContact = false): UnitContact => ({
  contactId,
  role,
  primaryContact,
});
/** A COMPLETE liveness read holding exactly these records. */
const readOf = (...contacts: ContactItem[]): RosterContactsRead => ({
  ok: true,
  byId: new Map(contacts.map((c): [string, ContactItem] => [c.contactId, c])),
});
const deleted = (c: ContactItem): ContactItem => ({ ...c, deleted_at: DELETED_AT });

const LL = contact({ contactId: 'c-ll', type: 'landlord' });
const PM = contact({ contactId: 'c-pm', type: 'landlord' });
const OWNER = contact({ contactId: 'c-owner', type: 'landlord' });
const TENANT_TYPED = contact({ contactId: 'c-tenant-typed', type: 'tenant' });
const CASEWORKER = contact({ contactId: 'c-cw', type: 'partner', role: 'Caseworker' });
const POINTER = contact({ contactId: 'c-ptr', type: 'landlord', phone_ref: true });

describe('chooseHeir (spec 4.3)', () => {
  it('liveness UNKNOWN answers unknown - whatever the roster holds', () => {
    expect(
      chooseHeir({
        roster: [row('c-ll', 'landlord', true), row('c-pm', 'pm')],
        landlordId: 'c-ll',
        read: { ok: false },
      }),
    ).toEqual({ kind: 'unknown' });
  });

  it('1. the live landlord of record wins, ahead of an earlier eligible row', () => {
    expect(
      chooseHeir({ roster: [row('c-pm', 'pm'), row('c-ll', 'landlord')], landlordId: 'c-ll', read: readOf(PM, LL) }),
    ).toEqual({ kind: 'heir', contactId: 'c-ll', addLandlordRow: false });
  });

  it('1. the landlord of record is NOT type-tested (the owner by definition)', () => {
    const partnerLandlord = contact({ contactId: 'c-ll', type: 'partner' });
    expect(
      chooseHeir({
        roster: [row('c-ll', 'landlord'), row('c-pm', 'pm')],
        landlordId: 'c-ll',
        read: readOf(partnerLandlord, PM),
      }),
    ).toEqual({ kind: 'heir', contactId: 'c-ll', addLandlordRow: false });
  });

  it('1. an OFF-roster landlord of record is the heir, and the write must ADD its row', () => {
    expect(chooseHeir({ roster: [row('c-pm', 'pm')], landlordId: 'c-ll', read: readOf(PM, LL) })).toEqual({
      kind: 'heir',
      contactId: 'c-ll',
      addLandlordRow: true,
    });
  });

  it('2. a deleted, missing or EXCLUDED landlord falls to the earliest-added eligible row', () => {
    const roster = [row('c-ll', 'landlord', true), row('c-pm', 'pm'), row('c-owner', 'owner')];
    expect(chooseHeir({ roster, landlordId: 'c-ll', read: readOf(deleted(LL), PM, OWNER) })).toEqual({
      kind: 'heir',
      contactId: 'c-pm',
      addLandlordRow: false,
    });
    expect(chooseHeir({ roster, landlordId: 'c-ll', read: readOf(PM, OWNER) })).toEqual({
      kind: 'heir',
      contactId: 'c-pm',
      addLandlordRow: false,
    });
    // The read says the landlord is LIVE - the exclusion still wins (a delete
    // fan-out's eventually consistent read can return the contact it just
    // deleted).
    expect(chooseHeir({ roster, landlordId: 'c-ll', exclude: 'c-ll', read: readOf(LL, PM, OWNER) })).toEqual({
      kind: 'heir',
      contactId: 'c-pm',
      addLandlordRow: false,
    });
  });

  it('2. never picks a tenant-typed, caseworker or routing-pointer row: the first ELIGIBLE row in add order', () => {
    const roster = [
      row('c-tenant-typed', 'other'),
      row('c-cw', 'other'),
      row('c-ptr', 'other'),
      row('c-owner', 'owner'),
      row('c-pm', 'pm'),
    ];
    expect(
      chooseHeir({ roster, landlordId: undefined, read: readOf(TENANT_TYPED, CASEWORKER, POINTER, OWNER, PM) }),
    ).toEqual({ kind: 'heir', contactId: 'c-owner', addLandlordRow: false });
  });

  it('2. skips a deleted row, a row with no record, and the excluded row', () => {
    const roster = [row('c-pm', 'pm', true), row('c-gone', 'pm'), row('c-owner', 'owner')];
    expect(chooseHeir({ roster, landlordId: undefined, read: readOf(deleted(PM), OWNER) })).toEqual({
      kind: 'heir',
      contactId: 'c-owner',
      addLandlordRow: false,
    });
    expect(chooseHeir({ roster, landlordId: undefined, exclude: 'c-pm', read: readOf(PM, OWNER) })).toEqual({
      kind: 'heir',
      contactId: 'c-owner',
      addLandlordRow: false,
    });
  });

  it('the heir if a landlord PRIMARY were removed never names the landlord (excluded = not live)', () => {
    expect(
      chooseHeir({
        roster: [row('c-ll', 'landlord', true), row('c-pm', 'pm')],
        landlordId: 'c-ll',
        exclude: 'c-ll',
        read: readOf(LL, PM),
      }),
    ).toEqual({ kind: 'heir', contactId: 'c-pm', addLandlordRow: false });
    expect(
      chooseHeir({ roster: [row('c-ll', 'landlord', true)], landlordId: 'c-ll', exclude: 'c-ll', read: readOf(LL) }),
    ).toEqual({ kind: 'none', why: 'no_live_candidate' });
  });

  it('3. none - no_live_candidate when no live, non-excluded roster contact exists', () => {
    expect(chooseHeir({ roster: [], landlordId: undefined, read: readOf() })).toEqual({
      kind: 'none',
      why: 'no_live_candidate',
    });
    expect(
      chooseHeir({
        roster: [row('c-pm', 'pm', true), row('c-gone', 'other')],
        landlordId: '',
        read: readOf(deleted(PM)),
      }),
    ).toEqual({ kind: 'none', why: 'no_live_candidate' });
    expect(
      chooseHeir({ roster: [row('c-pm', 'pm', true)], landlordId: undefined, exclude: 'c-pm', read: readOf(PM) }),
    ).toEqual({ kind: 'none', why: 'no_live_candidate' });
  });

  it('3. none - no_eligible_candidate when live rows exist but none may be promoted automatically', () => {
    expect(
      chooseHeir({
        roster: [row('c-tenant-typed', 'other'), row('c-cw', 'other')],
        landlordId: undefined,
        read: readOf(TENANT_TYPED, CASEWORKER),
      }),
    ).toEqual({ kind: 'none', why: 'no_eligible_candidate' });
  });
});

describe('applyPrimary (spec 4.7 - the flag and the scalar move together)', () => {
  it('flags exactly the heir, demotes every other row, and returns the scalar', () => {
    expect(
      applyPrimary([row('c-ll', 'landlord', true), row('c-pm', 'pm')], { contactId: 'c-pm', addLandlordRow: false }),
    ).toEqual({
      contacts: [row('c-ll', 'landlord', false), row('c-pm', 'pm', true)],
      primaryContactScalar: 'c-pm',
    });
  });

  it('APPENDS the off-roster landlord row as the primary when addLandlordRow', () => {
    expect(applyPrimary([row('c-pm', 'pm', true)], { contactId: 'c-ll', addLandlordRow: true })).toEqual({
      contacts: [row('c-pm', 'pm', false), { contactId: 'c-ll', role: 'landlord', primaryContact: true }],
      primaryContactScalar: 'c-ll',
    });
  });

  it('never duplicates a row that is already there, even when addLandlordRow', () => {
    expect(
      applyPrimary([row('c-ll', 'landlord'), row('c-pm', 'pm', true)], { contactId: 'c-ll', addLandlordRow: true })
        .contacts,
    ).toEqual([row('c-ll', 'landlord', true), row('c-pm', 'pm', false)]);
  });

  it('null clears EVERY flag and the scalar (null = REMOVE)', () => {
    expect(applyPrimary([row('c-ll', 'landlord'), row('c-pm', 'pm', true)], null)).toEqual({
      contacts: [row('c-ll', 'landlord', false), row('c-pm', 'pm', false)],
      primaryContactScalar: null,
    });
  });

  it('keeps each row\'s denormalized name and company, and never mutates its input', () => {
    const input = Object.freeze([
      Object.freeze({
        contactId: 'c-ll',
        role: 'landlord' as const,
        primaryContact: true,
        name: 'Lee Park',
        company: 'Park Homes',
      }),
      Object.freeze(row('c-pm', 'pm')),
    ]);
    const result = applyPrimary(input, { contactId: 'c-pm', addLandlordRow: false });
    expect(result.contacts).toEqual([
      { contactId: 'c-ll', role: 'landlord', primaryContact: false, name: 'Lee Park', company: 'Park Homes' },
      row('c-pm', 'pm', true),
    ]);
    expect(input[0]?.primaryContact).toBe(true);
    expect(result.contacts).not.toBe(input);
  });

  it('THROWS for an heir with no row and addLandlordRow false (a scalar no row agrees with)', () => {
    expect(() => applyPrimary([row('c-pm', 'pm', true)], { contactId: 'c-x', addLandlordRow: false })).toThrow(
      'applyPrimary: heir c-x has no roster row and addLandlordRow is false',
    );
  });

  it('composes with chooseHeir: no landlord of record and ONE live typed-landlord contact -> it becomes primary', () => {
    const roster = [row('c-sole', 'pm')];
    const sole = contact({ contactId: 'c-sole', type: 'landlord' });
    const heir = chooseHeir({ roster, landlordId: undefined, read: readOf(sole) });
    expect(heir).toEqual({ kind: 'heir', contactId: 'c-sole', addLandlordRow: false });
    if (heir.kind !== 'heir') throw new Error('unreachable: asserted above');
    expect(applyPrimary(roster, heir)).toEqual({
      contacts: [row('c-sole', 'pm', true)],
      primaryContactScalar: 'c-sole',
    });
  });
});
