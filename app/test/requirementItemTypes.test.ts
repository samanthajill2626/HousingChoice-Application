// Type pins for the requirement keys on the stored items (spec
// docs/superpowers/specs/2026-10-20-property-requirements-design.md D2-D5).
// The real check is `npm run typecheck` (app/tsconfig.test.json covers
// app/test): every requirement key must be a DECLARED property of UnitItem /
// ContactItem - not just the `[key: string]: unknown` index signature - with
// its stored kind. The runtime assertions keep the declared lists complete
// against the registry.
import { describe, expect, it } from 'vitest';
import { REQUIREMENT_LANDLORD_KEYS, REQUIREMENT_UNIT_KEYS } from '../src/lib/requirements.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';

/** The DECLARED keys of T (drops the index signature's string / number keys). */
type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

const UNIT_REQUIREMENT_KEYS: readonly DeclaredKeys<UnitItem>[] = [
  'no_evictions_on_program',
  'evictions_notes',
  'credit_requirements',
  'income_requirements',
  'qualifications',
  'no_pets',
  'pets',
  'pet_fee',
  'deposit_one_month',
  'deposit',
  'deposit_flexible',
  'deposit_notes',
  'application_fee',
  'tour_type',
  'tour_process',
];

const CONTACT_REQUIREMENT_KEYS: readonly DeclaredKeys<ContactItem>[] = [
  'req_no_evictions_on_program',
  'req_evictions_notes',
  'req_credit_requirements',
  'req_income_requirements',
  'req_qualifications',
  'req_no_pets',
  'req_pets',
  'req_pet_fee',
  'req_deposit_one_month',
  'req_deposit',
  'req_deposit_flexible',
  'req_deposit_notes',
  'req_application_fee',
  'req_tour_type',
  'req_tour_process',
];

describe('UnitItem and ContactItem declare the requirement keys (spec 2026-10-20 D2-D5)', () => {
  it('UnitItem declares every registry unit key', () => {
    expect([...UNIT_REQUIREMENT_KEYS]).toEqual([...REQUIREMENT_UNIT_KEYS]);
  });

  it('ContactItem declares every registry req_ key', () => {
    expect([...CONTACT_REQUIREMENT_KEYS]).toEqual([...REQUIREMENT_LANDLORD_KEYS]);
  });

  it('UnitItem declares washer_dryer, the voucher size LIST and the sources map', () => {
    const unit: UnitItem = {
      unitId: 'unit-1',
      landlordId: 'contact-ll-1',
      status: 'available',
      voucher_size_accepted: [2, 3],
      washer_dryer: 'included',
      requirement_sources: { pets: 'copied', deposit: 'set_here' },
    };
    const declared: readonly DeclaredKeys<UnitItem>[] = ['washer_dryer', 'voucher_size_accepted', 'requirement_sources'];
    expect(declared.every((key) => key in unit)).toBe(true);
  });

  it('a wrong stored kind is a compile error', () => {
    const washer: Partial<UnitItem> = {
      // @ts-expect-error - washer_dryer is hookups | included | none
      washer_dryer: 'stacked',
    };
    const checkbox: Partial<UnitItem> = {
      // @ts-expect-error - a requirement checkbox is stored only as true
      no_pets: false,
    };
    const source: Partial<UnitItem> = {
      // @ts-expect-error - a source is copied or set_here
      requirement_sources: { pets: 'manual' },
    };
    const tourType: Partial<ContactItem> = {
      // @ts-expect-error - req_tour_type is a TourType
      req_tour_type: 'concierge',
    };
    const amount: Partial<ContactItem> = {
      // @ts-expect-error - req_deposit is dollars (a number)
      req_deposit: '1400',
    };
    const boolPets: Partial<ContactItem> = {
      // @ts-expect-error - the landlord side never holds a boolean req_pets
      req_pets: false,
    };
    expect([washer, checkbox, source, tourType, amount, boolPets]).toHaveLength(6);
  });
});
