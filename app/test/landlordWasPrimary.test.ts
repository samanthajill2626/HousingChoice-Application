// primary-contact-integrity (plan review R2/R3; spec 3 / 4.6 / 4.7): does a
// restore that removes the landlord's row need a primary hand-off? ONE pure
// rule shared by the real restoreWithLandlord, the restore route's heir pick
// and the API-test fake: yes when the landlord's row is the FLAGGED primary,
// or when NO row is flagged (the property has no primary; the heir function
// picks who). It takes no scalar - a stale primary_contact can decide
// nothing.
//
// Planner fix wave F2 (Cameron 2026-10-13): the contact-DELETE hand-off asks
// the same question of the landlord of record - contactIsPrimaryToHandOff,
// ONE pure rule for the delete fan-out's Scan, handOffPrimaryFrom's re-check
// and the API-test fake. The landlord of record is the primary when
// landlordWasPrimary says so; anyone else only when THEIR row is flagged.
import { describe, expect, it } from 'vitest';
import {
  contactIsPrimaryToHandOff,
  landlordWasPrimary,
  type UnitContact,
  type UnitItem,
} from '../src/repos/unitsRepo.js';

function row(contactId: string, primaryContact: boolean): UnitContact {
  return { contactId, role: contactId === 'c-old' ? 'landlord' : 'pm', primaryContact };
}

describe('landlordWasPrimary', () => {
  it('the landlord row is flagged -> true', () => {
    expect(landlordWasPrimary([row('c-old', true), row('c-pm', false)], 'c-old')).toBe(true);
  });

  it('ANOTHER row is flagged -> false (a live flagged primary is never displaced)', () => {
    expect(landlordWasPrimary([row('c-old', false), row('c-pm', true)], 'c-old')).toBe(false);
  });

  it('NO row is flagged -> true (the hand-off is how the property gets a primary)', () => {
    expect(landlordWasPrimary([row('c-old', false), row('c-pm', false)], 'c-old')).toBe(true);
    expect(landlordWasPrimary([], 'c-old')).toBe(true);
  });

  it('the landlord-only DERIVED row (unitContacts) counts as flagged', () => {
    expect(landlordWasPrimary([{ contactId: 'c-old', role: 'landlord', primaryContact: true }], 'c-old')).toBe(
      true,
    );
  });
});

describe('contactIsPrimaryToHandOff (planner fix wave F2)', () => {
  const entry = (contactId: string, role: UnitContact['role'], primaryContact: boolean): UnitContact => ({
    contactId,
    role,
    primaryContact,
  });
  /** A unit as the Scan reads it: `landlordId` and `contacts` only when given. */
  const unit = (
    landlordId: string | undefined,
    contacts: UnitContact[] | undefined,
  ): Pick<UnitItem, 'contacts' | 'landlordId'> =>
    ({
      ...(landlordId !== undefined && { landlordId }),
      ...(contacts !== undefined && { contacts }),
    }) as Pick<UnitItem, 'contacts' | 'landlordId'>;

  it('NO row flagged: the landlord of record is the primary to hand off - on the list or off it', () => {
    expect(
      contactIsPrimaryToHandOff(unit('c-ll', [entry('c-ll', 'landlord', false), entry('c-pm', 'pm', false)]), 'c-ll'),
    ).toBe(true);
    expect(contactIsPrimaryToHandOff(unit('c-ll', [entry('c-pm', 'pm', false)]), 'c-ll')).toBe(true);
  });

  it('NO row flagged: anyone who is NOT the landlord of record is not - one delete never targets every no-flag unit', () => {
    expect(
      contactIsPrimaryToHandOff(unit('c-other', [entry('c-other', 'landlord', false), entry('c-d', 'pm', false)]), 'c-d'),
    ).toBe(false);
    // Ownerless (no landlordId, or an empty one): nobody is the landlord of record.
    expect(contactIsPrimaryToHandOff(unit(undefined, [entry('c-d', 'pm', false)]), 'c-d')).toBe(false);
    expect(contactIsPrimaryToHandOff(unit('', [entry('c-d', 'pm', false)]), 'c-d')).toBe(false);
  });

  it('a FLAGGED row elsewhere wins: the landlord of record is then not the primary', () => {
    expect(
      contactIsPrimaryToHandOff(unit('c-ll', [entry('c-ll', 'landlord', false), entry('c-pm', 'pm', true)]), 'c-ll'),
    ).toBe(false);
  });

  it('the flagged row is the contact: true, landlord of record or not', () => {
    expect(contactIsPrimaryToHandOff(unit(undefined, [entry('c-d', 'pm', true), entry('c-p', 'pm', false)]), 'c-d')).toBe(
      true,
    );
    expect(
      contactIsPrimaryToHandOff(unit('c-ll', [entry('c-ll', 'landlord', false), entry('c-d', 'pm', true)]), 'c-d'),
    ).toBe(true);
    expect(
      contactIsPrimaryToHandOff(unit('c-ll', [entry('c-ll', 'landlord', true), entry('c-pm', 'pm', false)]), 'c-ll'),
    ).toBe(true);
  });

  it('a landlord-only unit (no stored list): its DERIVED landlord row counts as flagged - its landlord only, as before', () => {
    expect(contactIsPrimaryToHandOff(unit('c-ll', undefined), 'c-ll')).toBe(true);
    expect(contactIsPrimaryToHandOff(unit('c-ll', []), 'c-ll')).toBe(true);
    expect(contactIsPrimaryToHandOff(unit('c-ll', undefined), 'c-x')).toBe(false);
  });
});
