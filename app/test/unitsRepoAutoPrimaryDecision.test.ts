// primary-contact-integrity (spec 2026-10-12 section 4.4, P2): the PURE
// auto-primary decision that unitsRepo.addContact and the API-test fake
// (test/helpers/twilioWebhookHarness.ts) share - which ids a roster write for
// contact X must read for liveness, and what that read decides - plus the two
// new roster errors. No DynamoDB.
import { describe, expect, it } from 'vitest';
import type { RosterContactsRead } from '../src/lib/propertyContact.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  autoPrimaryLivenessIds,
  decideAutoPrimary,
  PrimaryContactDeletedError,
  RosterReadFailedError,
  type AutoPrimaryArgs,
  type UnitContact,
} from '../src/repos/unitsRepo.js';

const GONE = '2026-10-01T09:00:00.000Z';

/** A contact record, typed landlord unless overridden. */
function person(contactId: string, fields: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', ...fields } as ContactItem;
}

/** A COMPLETE liveness read that found exactly `known` (any other id is missing). */
function readOf(...known: ContactItem[]): RosterContactsRead {
  return { ok: true, byId: new Map(known.map((c) => [c.contactId, c] as const)) };
}

function row(contactId: string, primaryContact: boolean, role: UnitContact['role'] = 'pm'): UnitContact {
  return { contactId, role, primaryContact };
}

/** A write for X = c-x: eligible, the request not asking for primary, unless overridden. */
function args(overrides: Partial<AutoPrimaryArgs> = {}): AutoPrimaryArgs {
  return { roster: [], landlordId: undefined, contactId: 'c-x', eligible: true, requested: false, ...overrides };
}

/** The writes no liveness read can change: the request's flag stands. */
const NO_READ_CASES: Array<[string, Partial<AutoPrimaryArgs>]> = [
  ['X is not eligible for automatic routing', { eligible: false }],
  ['the request already asks for primary', { requested: true }],
  ['X is itself the flagged primary', { roster: [row('c-x', true)] }],
  ['X is the landlord of record', { landlordId: 'c-x', roster: [row('c-x', false, 'landlord')] }],
];

describe('autoPrimaryLivenessIds (spec 4.4)', () => {
  it('no flagged row and no landlord of record: nothing to read', () => {
    expect(autoPrimaryLivenessIds(args({ roster: [row('c-other', false)] }))).toEqual([]);
  });

  it('reads the flagged primary and the landlord of record - each once', () => {
    expect(
      autoPrimaryLivenessIds(
        args({ roster: [row('c-ll', false, 'landlord'), row('c-dead', true)], landlordId: 'c-ll' }),
      ),
    ).toEqual(['c-dead', 'c-ll']);
    // A landlord-only unit: the derived landlord row IS the flagged primary.
    expect(autoPrimaryLivenessIds(args({ roster: [row('c-ll', true, 'landlord')], landlordId: 'c-ll' }))).toEqual([
      'c-ll',
    ]);
  });

  it.each(NO_READ_CASES)('%s: null - no read can change the answer', (_case, overrides) => {
    expect(autoPrimaryLivenessIds(args(overrides))).toBeNull();
  });
});

describe('decideAutoPrimary (spec 4.4)', () => {
  it('no flagged row and no landlord of record: promote, with no read at all', () => {
    expect(decideAutoPrimary({ ...args(), read: undefined })).toBe('promote');
  });

  it('a soft-deleted flagged primary counts as absent: promote', () => {
    const a = args({ roster: [row('c-dead', true)] });
    expect(decideAutoPrimary({ ...a, read: readOf(person('c-dead', { deleted_at: GONE })) })).toBe('promote');
  });

  it('a MISSING flagged primary (no record) counts as absent: promote', () => {
    expect(decideAutoPrimary({ ...args({ roster: [row('c-gone', true)] }), read: readOf() })).toBe('promote');
  });

  it('a soft-deleted landlord of record counts as absent: promote', () => {
    const a = args({ roster: [row('c-ll', false, 'landlord')], landlordId: 'c-ll' });
    expect(decideAutoPrimary({ ...a, read: readOf(person('c-ll', { deleted_at: GONE })) })).toBe('promote');
  });

  it('a LIVE flagged primary: keep the request flag', () => {
    const a = args({ roster: [row('c-first', true)] });
    expect(decideAutoPrimary({ ...a, read: readOf(person('c-first')) })).toBe('keep');
  });

  it('a LIVE landlord of record: keep, even beside a soft-deleted flagged primary', () => {
    const a = args({ roster: [row('c-ll', false, 'landlord'), row('c-dead', true)], landlordId: 'c-ll' });
    expect(
      decideAutoPrimary({ ...a, read: readOf(person('c-ll'), person('c-dead', { deleted_at: GONE })) }),
    ).toBe('keep');
  });

  it('a liveness read that failed, or that was not supplied, is unknown - never a promotion', () => {
    const a = args({ roster: [row('c-dead', true)] });
    expect(decideAutoPrimary({ ...a, read: { ok: false } })).toBe('unknown');
    expect(decideAutoPrimary({ ...a, read: undefined })).toBe('unknown');
  });

  it.each(NO_READ_CASES)('%s: keep, whatever the read says', (_case, overrides) => {
    expect(decideAutoPrimary({ ...args(overrides), read: { ok: false } })).toBe('keep');
    expect(decideAutoPrimary({ ...args(overrides), read: readOf() })).toBe('keep');
  });
});

describe('the new roster errors (spec 4.4, 4.6)', () => {
  it('RosterReadFailedError and PrimaryContactDeletedError are named Errors', () => {
    expect(new RosterReadFailedError()).toBeInstanceOf(Error);
    expect(new RosterReadFailedError()).toMatchObject({ name: 'RosterReadFailedError' });
    expect(new PrimaryContactDeletedError()).toBeInstanceOf(Error);
    expect(new PrimaryContactDeletedError()).toMatchObject({ name: 'PrimaryContactDeletedError' });
  });
});
