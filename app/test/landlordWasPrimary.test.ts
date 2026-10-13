// primary-contact-integrity (plan review R2/R3; spec 3 / 4.6 / 4.7): does a
// restore that removes the landlord's row need a primary hand-off? ONE pure
// rule shared by the real restoreWithLandlord, the restore route's heir pick
// and the API-test fake: yes when the landlord's row is the FLAGGED primary,
// or when NO row is flagged (the property has no primary; the heir function
// picks who). It takes no scalar - a stale primary_contact can decide
// nothing.
import { describe, expect, it } from 'vitest';
import { landlordWasPrimary, type UnitContact } from '../src/repos/unitsRepo.js';

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
