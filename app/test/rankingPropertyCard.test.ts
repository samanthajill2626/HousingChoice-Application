// WP1 B2a S3.6 (spec D2.1, D2.2; charter 6.1-6.2; plan PR7, WI12): the
// property card. Only `include` attributes, in registry order, trimmed, empty
// values left off; requirement items read through unitItemValue (a legacy
// boolean pets is the No pets checkbox it means); derived voucher sizes and
// authorities; credit, income, lif, priority, ids, contacts, media and every
// unclassified attribute never on it. The landlord switch adds the landlord's
// defaults only for items the property records nothing for. Pure.
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { landlordDefaults, propertyCard, propertyFacts, type PropertyCardCtx } from '../src/services/ranking/cards.js';
import { ATLANTA } from './helpers/orgFixtures.js';
import { ORG_ENTRIES, unit } from './helpers/rankingFixtures.js';

const OFF: PropertyCardCtx = { orgEntries: ORG_ENTRIES, landlordCard: false };

const FULL_UNIT: UnitItem = {
  unitId: 'u1',
  landlordId: 'contact-landlord-1',
  propertyId: 'prop-1',
  status: 'available',
  address: { line1: ' 12 Oak St ', line2: '', city: 'Decatur', state: 'GA', zip: '30030' },
  beds: 3,
  baths: 1.5,
  area: 'Oakhurst',
  subzone: 'E8',
  rent_min: 1500,
  rent_max: 1650,
  final_rent: 1600,
  payment_standard: 1700,
  deposit: 500,
  deposit_flexible: true,
  deposit_notes: ' Half up front ',
  application_fee: 50,
  same_day_rta: true,
  utilities: 'Electric',
  accessibility: 'Ground floor',
  notes: 'Fenced yard',
  lease_terms: '12 months',
  pets: 'Cats only',
  pet_fee: '$200',
  no_evictions_on_program: true,
  evictions_notes: 'None in 5 years',
  qualifications: 'Background check',
  tour_type: 'landlord_led',
  tour_process: 'Call first',
  application_process: 'Online',
  washer_dryer: 'hookups',
  created_at: '2026-09-01T10:00:00.000Z',
  voucher_size_accepted: [3, 2],
  accepted_authorities: [ATLANTA.name, 'Nowhere Board'],
  // Never on a card:
  priority: true,
  credit_requirements: '600+',
  income_requirements: '3x rent',
  lif: 500,
  contacts: [],
  primary_contact: 'contact-x',
  media: ['a.jpg'],
  listing_link: 'https://example.com/listing',
  video_url: 'https://example.com/video',
  requirement_sources: { pets: 'set_here' },
  status_source: 'manual',
  jurisdiction: 'Old jurisdiction',
  accepted_programs: ['HCV'],
  updated_at: '2026-10-01T00:00:00.000Z',
  bedrooms: 3,
  bathrooms: 1,
  imported_from: 'quo-airtable-import',
  imported_at: '2026-08-01T00:00:00.000Z',
  imported_landlord_name: 'Pat Example',
  zz_unclassified: 'never read',
};

const FULL_CARD = {
  address: { line1: '12 Oak St', city: 'Decatur', state: 'GA', zip: '30030' },
  status: 'available',
  beds: 3,
  baths: 1.5,
  area: 'Oakhurst',
  subzone: 'E8',
  rent_min: 1500,
  rent_max: 1650,
  final_rent: 1600,
  payment_standard: 1700,
  utilities: 'Electric',
  accessibility: 'Ground floor',
  washer_dryer: 'hookups',
  same_day_rta: true,
  application_fee: 50,
  deposit: 500,
  deposit_flexible: true,
  deposit_notes: 'Half up front',
  pets: 'Cats only',
  pet_fee: '$200',
  no_evictions_on_program: true,
  evictions_notes: 'None in 5 years',
  qualifications: 'Background check',
  lease_terms: '12 months',
  tour_type: 'landlord_led',
  tour_process: 'Call first',
  application_process: 'Online',
  notes: 'Fenced yard',
  created_at: '2026-09-01',
  voucherSizes: [2, 3],
  voucherSizesInferredFromBeds: false,
  authorities: { mapped: [ATLANTA.name], unmapped: ['Nowhere Board'] },
};

const LANDLORD: ContactItem = {
  contactId: 'contact-landlord-1',
  type: 'landlord',
  notes: ' Prefers long leases ',
  req_no_pets: true,
  req_pet_fee: '$300',
  req_credit_requirements: '650+',
  req_income_requirements: '3x',
  req_qualifications: 'No smoking',
  req_deposit: 900,
  req_tour_type: 'self_guided',
};

describe('propertyCard (spec D2.1, D2.2)', () => {
  it('copies the included attributes in registry order, trimmed, then the derived fields; nothing else', () => {
    const card = propertyCard(FULL_UNIT, OFF);
    expect(card).toEqual(FULL_CARD);
    expect(Object.keys(card)).toEqual(Object.keys(FULL_CARD));
  });

  it('serializes the same record to the same bytes whatever its stored key order', () => {
    const reversed = Object.fromEntries(Object.entries(FULL_UNIT).reverse()) as UnitItem;
    expect(JSON.stringify(propertyCard(reversed, OFF))).toBe(JSON.stringify(propertyCard(FULL_UNIT, OFF)));
  });

  it('reads a legacy boolean pets as the No pets checkbox it means', () => {
    const noPets = propertyCard(unit('u2', { pets: false }), OFF);
    expect(noPets['no_pets']).toBe(true);
    expect(noPets).not.toHaveProperty('pets');
    const allowed = propertyCard(unit('u3', { pets: true }), OFF);
    expect(allowed['pets']).toBe('Allowed');
    expect(allowed).not.toHaveProperty('no_pets');
  });

  it('marks voucher sizes inferred from beds, and none when there are neither', () => {
    expect(propertyCard(unit('u4', { beds: 3 }), OFF)).toMatchObject({ voucherSizes: [3], voucherSizesInferredFromBeds: true });
    expect(propertyCard(unit('u5', { beds: undefined }), OFF)).toMatchObject({ voucherSizes: [], voucherSizesInferredFromBeds: false });
  });

  it('normalizes voucher sizes exactly as the pool does: whole sizes, 4 means 4 or more (FB20)', () => {
    expect(propertyCard(unit('u12', { beds: 5 }), OFF)).toMatchObject({ voucherSizes: [4], voucherSizesInferredFromBeds: true });
    expect(propertyCard(unit('u13', { voucher_size_accepted: [6, 2, 2] }), OFF)).toMatchObject({
      voucherSizes: [2, 4],
      voucherSizesInferredFromBeds: false,
    });
    expect(propertyCard(unit('u14', { voucher_size_accepted: [2.5], beds: undefined }), OFF)).toMatchObject({
      voucherSizes: [],
      voucherSizesInferredFromBeds: false,
    });
  });

  it('leaves off an empty value and an absent one', () => {
    const card = propertyCard(unit('u6', { notes: '   ', area: '' }), OFF);
    expect(card).not.toHaveProperty('notes');
    expect(card).not.toHaveProperty('area');
  });
});

describe('the landlord card switch (spec D2.1)', () => {
  it('off: nothing of the landlord is read, even when one is passed', () => {
    expect(propertyCard(unit('u7'), { ...OFF, landlord: LANDLORD })).not.toHaveProperty('landlordDefaults');
    expect(landlordDefaults(unit('u7'), { ...OFF, landlord: LANDLORD })).toBeUndefined();
  });

  it("on: the landlord's defaults for every item the property records nothing for, credit and income left out, the notes added", () => {
    const own = unit('u8', { pets: 'Dogs ok' });
    const on: PropertyCardCtx = { orgEntries: ORG_ENTRIES, landlordCard: true, landlord: LANDLORD };
    expect(landlordDefaults(own, on)).toEqual({
      qualifications: 'No smoking',
      deposit: 900,
      tour_type: 'self_guided',
      notes: 'Prefers long leases',
    });
    expect(propertyCard(own, on)['landlordDefaults']).toEqual(landlordDefaults(own, on));
  });

  it('on with no landlord on file: no defaults', () => {
    expect(propertyCard(unit('u9'), { orgEntries: ORG_ENTRIES, landlordCard: true, landlord: null })).not.toHaveProperty('landlordDefaults');
  });
});

describe('propertyFacts - what the cap and the flag check read (spec D2.1, D5, D9, D10)', () => {
  it('the recorded requirement keys and the free-text fields, never credit or income', () => {
    expect(propertyFacts(FULL_UNIT, OFF)).toEqual({
      recordedRequirementKeys: [
        'no_evictions_on_program',
        'evictions_notes',
        'qualifications',
        'pets',
        'pet_fee',
        'deposit',
        'deposit_flexible',
        'deposit_notes',
        'application_fee',
        'tour_type',
        'tour_process',
      ],
      freeTextByField: {
        notes: 'Fenced yard',
        lease_terms: '12 months',
        application_process: 'Online',
        qualifications: 'Background check',
        evictions_notes: 'None in 5 years',
        pets: 'Cats only',
        pet_fee: '$200',
        deposit_notes: 'Half up front',
        tour_process: 'Call first',
        utilities: 'Electric',
        accessibility: 'Ground floor',
      },
    });
  });

  it('a legacy boolean pets records No pets and no pets text', () => {
    expect(propertyFacts(unit('u2', { pets: false }), OFF)).toEqual({ recordedRequirementKeys: ['no_pets'], freeTextByField: {} });
  });

  it('switch on: a landlord default counts as recorded and its text is the landlord: twin', () => {
    const own = unit('u8', { pets: 'Dogs ok' });
    expect(propertyFacts(own, { orgEntries: ORG_ENTRIES, landlordCard: true, landlord: LANDLORD })).toEqual({
      recordedRequirementKeys: ['qualifications', 'pets', 'deposit', 'tour_type'],
      freeTextByField: { pets: 'Dogs ok', 'landlord:qualifications': 'No smoking', 'landlord:notes': 'Prefers long leases' },
    });
  });
});
