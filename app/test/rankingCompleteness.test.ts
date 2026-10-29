// WP1 B2a S3.8 (spec D3; charter 7.3; plan PR6): the completeness pass. Each
// gap is a stable key with a staff label. Property: rent, payment standard,
// voucher sizes (a size inferred from beds counts as missing), recorded
// authorities that do not map, pets, accessibility. Tenant: voucher size,
// housing authority, and each matching input the list marks for completeness.
// mergeMissing is the match's missing[]: the code flags first, then the
// model's unknowns not equal to a flag (case and spacing folded). Pure.
import { describe, expect, it } from 'vitest';
import { TENANT_MATCHING_INPUTS } from '../src/lib/tenantMatchingInputs.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  PROPERTY_MISSING_LABELS,
  TENANT_MISSING_LABELS,
  mergeMissing,
  propertyMissing,
  tenantMissing,
} from '../src/services/ranking/completeness.js';
import type { PropertyCardCtx } from '../src/services/ranking/cards.js';
import { ATLANTA } from './helpers/orgFixtures.js';
import { ORG_ENTRIES, unit } from './helpers/rankingFixtures.js';

const OFF: PropertyCardCtx = { orgEntries: ORG_ENTRIES, landlordCard: false };

const keysOf = (flags: { key: string }[]): string[] => flags.map((flag) => flag.key);

describe('propertyMissing (spec D3)', () => {
  it('marks every gap with its key and label, in the fixed order', () => {
    const bare = unit('u1', {
      rent_min: undefined,
      rent_max: undefined,
      beds: undefined,
      accepted_authorities: ['Nowhere Board'],
    });
    expect(propertyMissing(bare, OFF)).toEqual([
      { key: 'rent', label: PROPERTY_MISSING_LABELS.rent },
      { key: 'payment_standard', label: PROPERTY_MISSING_LABELS.payment_standard },
      { key: 'voucher_sizes', label: PROPERTY_MISSING_LABELS.voucher_sizes },
      { key: 'authorities_unmapped', label: PROPERTY_MISSING_LABELS.authorities_unmapped },
      { key: 'pets', label: PROPERTY_MISSING_LABELS.pets },
      { key: 'accessibility', label: PROPERTY_MISSING_LABELS.accessibility },
    ]);
  });

  it('a size inferred from beds counts as missing; a recorded one does not', () => {
    expect(keysOf(propertyMissing(unit('u2', { beds: 3 }), OFF))).toContain('voucher_sizes');
    expect(keysOf(propertyMissing(unit('u3', { voucher_size_accepted: [2] }), OFF))).not.toContain('voucher_sizes');
    expect(keysOf(propertyMissing(unit('u3b', { voucher_size_accepted: [2.5] }), OFF))).toContain('voucher_sizes');
  });

  it('any one of the rent fields is rent; a final rent alone is enough', () => {
    expect(keysOf(propertyMissing(unit('u4', { rent_min: undefined, rent_max: undefined, final_rent: 1500 }), OFF))).not.toContain('rent');
  });

  it('only an unmapped recorded authority is a gap; all mapped or none recorded is not', () => {
    expect(keysOf(propertyMissing(unit('u5', { accepted_authorities: [ATLANTA.name] }), OFF))).not.toContain('authorities_unmapped');
    expect(keysOf(propertyMissing(unit('u6', { accepted_authorities: [] }), OFF))).not.toContain('authorities_unmapped');
    expect(keysOf(propertyMissing(unit('u7', { accepted_authorities: ['AHA'] }), OFF))).toContain('authorities_unmapped');
  });

  it('pets: any of No pets, the details or the fee, a legacy boolean included; a landlord default counts with the switch on (C7)', () => {
    expect(keysOf(propertyMissing(unit('u8', { pet_fee: '$100' }), OFF))).not.toContain('pets');
    expect(keysOf(propertyMissing(unit('u9', { pets: false }), OFF))).not.toContain('pets');
    const landlord: ContactItem = { contactId: 'contact-landlord-1', type: 'landlord', req_no_pets: true };
    expect(keysOf(propertyMissing(unit('u10'), { ...OFF, landlord }))).toContain('pets');
    expect(keysOf(propertyMissing(unit('u10'), { orgEntries: ORG_ENTRIES, landlordCard: true, landlord }))).not.toContain('pets');
  });

  it('a whitespace-only accessibility is still missing', () => {
    expect(keysOf(propertyMissing(unit('u11', { accessibility: '  ' }), OFF))).toContain('accessibility');
  });
});

describe('tenantMissing (spec D3, PR6)', () => {
  const marked = TENANT_MATCHING_INPUTS.filter((input) => input.completeness);

  it('the list marks the area preference and the maximum tenant portion (PR6)', () => {
    expect(marked.map((input) => input.key)).toEqual(['area_preference', 'max_tenant_portion']);
  });

  it('marks voucher size, housing authority and each marked input, by the list', () => {
    expect(tenantMissing({ contactId: 't1', type: 'tenant' })).toEqual([
      { key: 'voucher_size', label: TENANT_MISSING_LABELS.voucher_size },
      { key: 'housing_authority', label: TENANT_MISSING_LABELS.housing_authority },
      ...marked.map((input) => ({ key: input.key, label: input.label })),
    ]);
  });

  it('a recorded value closes each gap; a portion of 0 is a value', () => {
    expect(
      tenantMissing({
        contactId: 't1',
        type: 'tenant',
        voucherSize: 0,
        housingAuthority: ATLANTA.name,
        area_preference: 'Decatur',
        max_tenant_portion: 0,
      }),
    ).toEqual([]);
  });

  it('reads only inputs whose source is `field`, as the card does (R2F10)', () => {
    const list = [
      { key: 'a_field', label: 'A field', kind: 'text', source: 'field', completeness: true },
      { key: 'a_note', label: 'A note', kind: 'text', source: 'notes', completeness: true },
      { key: 'a_skip', label: 'A skip', kind: 'dollars', source: 'field', completeness: false },
    ] as const;
    expect(tenantMissing({ contactId: 't1', type: 'tenant', voucherSize: 2, housingAuthority: ATLANTA.name }, list)).toEqual([
      { key: 'a_field', label: 'A field' },
    ]);
  });

  it('blank text and a non-whole size are gaps', () => {
    expect(keysOf(tenantMissing({ contactId: 't1', type: 'tenant', voucherSize: 2.5, housingAuthority: '  ', area_preference: ' ' }))).toEqual([
      'voucher_size',
      'housing_authority',
      'area_preference',
      'max_tenant_portion',
    ]);
  });
});

describe('mergeMissing - the match missing[] (spec D3, D8)', () => {
  it('code flags first with their keys, then each new unknown once; case and spacing folded', () => {
    expect(
      mergeMissing(
        [
          { key: 'rent', label: 'Rent' },
          { key: 'voucher_size', label: 'Voucher size' },
        ],
        ['rent ', ' Commute time ', 'commute  TIME', '', 'VOUCHER SIZE', 'Parking'],
      ),
    ).toEqual([
      { key: 'rent', text: 'Rent' },
      { key: 'voucher_size', text: 'Voucher size' },
      { text: 'Commute time' },
      { text: 'Parking' },
    ]);
  });

  it('no flags and no unknowns is an empty list', () => {
    expect(mergeMissing([], [])).toEqual([]);
  });
});
