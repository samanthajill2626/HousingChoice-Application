// The D10a parity walk (spec
// docs/superpowers/specs/2026-10-20-property-requirements-design.md D10,
// D10a): every field on the New / Edit property forms carries an "On flyer"
// or "Staff only" tag from PROPERTY_FORM_FIELDS, and this suite FAILS when a
// tag disagrees with what the public flyer projection (toUnitFlyer)
// publishes. The dashboard mirror (slice S5) carries the same table and cases.
//
// Per field and per base unit, the walk compares the base with the field's
// keys CLEARED against the same unit with them set to a SAMPLE value - never
// the base against the field cleared: on a base whose recorded voucher sizes
// equal its beds, clearing the sizes falls back to the same sizes, which would
// make "Voucher sizes accepted" look Staff only (pinned below).
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  PROPERTY_FORM_FIELDS,
  REQUIREMENT_ITEMS,
  type FlyerVisibility,
  type FormFieldVisibility,
} from '../src/lib/requirements.js';
import { acceptedVoucherSizes, toUnitFlyer, validateUnitBody } from '../src/lib/unitFields.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';

/**
 * A valid, non-blank value per unit key. The walk sets it on a unit whose
 * field was CLEARED, so it only has to differ from blank and from what a
 * cleared field falls back to (no base has 7 beds or sizes 9 / 11).
 */
const SAMPLE: Readonly<Record<string, unknown>> = {
  // plan AR1: the Owning landlord row. Staff only - two units differing only in
  // their landlord of record give identical toUnitFlyer output.
  landlordId: 'contact-ll-parity',
  accepted_authorities: ['Parity Housing Authority'],
  beds: 7,
  baths: 4.5,
  voucher_size_accepted: [9, 11],
  rent_min: 2222,
  rent_max: 3333,
  payment_standard: 4444,
  address: { line1: '1 Parity Way', city: 'Decatur', state: 'GA', zip: '30030' },
  subzone: 'SE11',
  washer_dryer: 'none',
  utilities: 'Parity utilities',
  accessibility: 'Parity accessibility',
  lease_terms: 'Parity lease terms',
  listing_link: 'https://example.com/parity',
  video_url: 'https://v.example/parity',
  same_day_rta: false,
  no_evictions_on_program: true,
  evictions_notes: 'Parity evictions details',
  credit_requirements: 'Parity credit',
  income_requirements: 'Parity income',
  qualifications: 'Parity qualifications',
  no_pets: true,
  pets: 'Parity pets details',
  pet_fee: 'Parity pet fee',
  deposit_one_month: true,
  deposit: 777,
  deposit_flexible: true,
  deposit_notes: 'Parity deposit notes',
  application_fee: 99,
  tour_type: 'pm_team',
  tour_process: 'Parity tour process',
  application_process: 'Parity application process',
  notes: 'Parity notes',
};

function sampleFor(key: string): unknown {
  if (!Object.hasOwn(SAMPLE, key)) throw new Error(`no parity sample for ${key} - add one`);
  return SAMPLE[key];
}

interface Base {
  name: string;
  unit: UnitItem;
}

const SIZES_EQUAL_BEDS = 'a unit whose recorded voucher sizes equal its beds';

const BASES: readonly Base[] = [
  { name: 'a bare unit', unit: { unitId: 'u-bare', landlordId: 'contact-ll-1', status: 'available' } },
  {
    name: 'a fully filled unit',
    unit: {
      unitId: 'u-full',
      landlordId: 'contact-ll-1',
      status: 'available',
      accepted_authorities: ['DCA'],
      beds: 2,
      baths: 1,
      voucher_size_accepted: [2, 3],
      rent_min: 1400,
      rent_max: 1600,
      payment_standard: 1700,
      address: { line1: '123 Base St', city: 'Atlanta', state: 'GA', zip: '30303' },
      area: 'Westside',
      subzone: 'E8',
      washer_dryer: 'hookups',
      utilities: 'Tenant pays electric',
      accessibility: 'Ground floor',
      lease_terms: '12-month minimum',
      listing_link: 'https://example.com/base',
      video_url: 'https://v.example/base',
      same_day_rta: true,
      no_evictions_on_program: true,
      evictions_notes: 'None in 5 years',
      credit_requirements: '600+',
      income_requirements: '2.5x rent',
      qualifications: 'Background check',
      pets: 'Cats OK',
      pet_fee: '$300',
      deposit: 1400,
      deposit_notes: 'Split in two',
      application_fee: 50,
      tour_type: 'self_guided',
      tour_process: 'Lockbox',
      application_process: 'Online portal',
      notes: 'Back gate sticks',
      requirement_sources: { pets: 'set_here' },
    },
  },
  {
    name: SIZES_EQUAL_BEDS,
    unit: {
      unitId: 'u-eq',
      landlordId: 'contact-ll-1',
      status: 'available',
      beds: 2,
      voucher_size_accepted: [2],
      no_pets: true,
      pets: 'Service animals only',
      deposit_one_month: true,
      deposit_flexible: true,
      application_fee: 0,
      washer_dryer: 'included',
      same_day_rta: false,
      tour_type: 'pm_team',
    },
  },
];

function baseNamed(name: string): UnitItem {
  const base = BASES.find((b) => b.name === name);
  if (base === undefined) throw new Error(`no base ${name}`);
  return base.unit;
}

/** Every disagreement between the table and toUnitFlyer, as "<label> | <base>: <why>". */
function flyerTagMismatches(fields: readonly FormFieldVisibility[], bases: readonly Base[]): string[] {
  const mismatches: string[] = [];
  for (const field of fields) {
    for (const base of bases) {
      const cleared: Record<string, unknown> = structuredClone(base.unit);
      for (const key of field.keys) delete cleared[key];
      const sampled: Record<string, unknown> = structuredClone(cleared);
      for (const key of field.keys) sampled[key] = sampleFor(key);
      const flyerSampled = toUnitFlyer(sampled as UnitItem);
      const changesFlyer = !isDeepStrictEqual(toUnitFlyer(cleared as UnitItem), flyerSampled);
      if (field.flyer === 'on_flyer' && !changesFlyer) {
        mismatches.push(`${field.label} | ${base.name}: tagged On flyer, but the flyer does not change`);
      }
      if (
        field.flyer === 'staff_only' &&
        (changesFlyer || !isDeepStrictEqual(toUnitFlyer(base.unit), flyerSampled))
      ) {
        mismatches.push(`${field.label} | ${base.name}: tagged Staff only, but the flyer changes`);
      }
    }
  }
  return mismatches;
}

describe('PROPERTY_FORM_FIELDS - the D10a tag table', () => {
  it('lists every property-form field in form order with its tag (D10, D10a, plan AR1) - 35 rows', () => {
    expect(PROPERTY_FORM_FIELDS).toHaveLength(35);
    expect(PROPERTY_FORM_FIELDS.map((f) => [f.label, [...f.keys], f.flyer])).toEqual([
      // New form only (plan AR1): the landlord picker; landlordId never reaches the flyer.
      ['Owning landlord', ['landlordId'], 'staff_only'],
      ['Housing authorities', ['accepted_authorities'], 'on_flyer'],
      ['Beds', ['beds'], 'on_flyer'],
      ['Baths', ['baths'], 'on_flyer'],
      ['Voucher sizes accepted', ['voucher_size_accepted'], 'on_flyer'],
      // flyer-leads D2 (spec 2026-10-21): rent, accessibility, lease terms and
      // every Pets / Deposit field are Staff only; Application fee stays On flyer.
      ['Rent min', ['rent_min'], 'staff_only'],
      ['Rent max', ['rent_max'], 'staff_only'],
      ['Payment standard', ['payment_standard'], 'staff_only'],
      ['Address', ['address'], 'on_flyer'],
      ['Subzone', ['subzone'], 'staff_only'],
      ['Washer / dryer', ['washer_dryer'], 'on_flyer'],
      ['Tenant-paid utilities', ['utilities'], 'on_flyer'],
      ['Accessibility', ['accessibility'], 'staff_only'],
      ['Lease terms', ['lease_terms'], 'staff_only'],
      ['Public listing link', ['listing_link'], 'on_flyer'],
      ['Video URL', ['video_url'], 'on_flyer'],
      ['Same-day RTA', ['same_day_rta'], 'on_flyer'],
      ['No evictions while on the program', ['no_evictions_on_program'], 'staff_only'],
      ['Evictions (details)', ['evictions_notes'], 'staff_only'],
      ['Credit score', ['credit_requirements'], 'staff_only'],
      ['Income requirements', ['income_requirements'], 'staff_only'],
      ['Qualifications', ['qualifications'], 'staff_only'],
      ['No pets', ['no_pets'], 'staff_only'],
      ['Pets (details)', ['pets'], 'staff_only'],
      ['Pet fee', ['pet_fee'], 'staff_only'],
      ["One month's rent", ['deposit_one_month'], 'staff_only'],
      ['Fixed amount', ['deposit'], 'staff_only'],
      ['Flexible / payment terms available', ['deposit_flexible'], 'staff_only'],
      ['Deposit notes', ['deposit_notes'], 'staff_only'],
      ['No application fee', ['application_fee'], 'on_flyer'],
      ['Application fee', ['application_fee'], 'on_flyer'],
      ['Tour type', ['tour_type'], 'staff_only'],
      ['Tour process', ['tour_process'], 'staff_only'],
      ['Application process', ['application_process'], 'staff_only'],
      ['Notes', ['notes'], 'staff_only'],
    ]);
  });

  it('tags each requirement field exactly as the registry does (D1)', () => {
    const byLabel = new Map(PROPERTY_FORM_FIELDS.map((f) => [f.label, f]));
    for (const item of REQUIREMENT_ITEMS) {
      for (const field of item.fields) {
        const row = byLabel.get(field.label);
        expect(row?.keys, field.label).toEqual([field.key]);
        expect(row?.flyer, field.label).toBe(field.flyer);
      }
    }
  });

  it('names only writable unit keys (each sample passes validateUnitBody)', () => {
    for (const field of PROPERTY_FORM_FIELDS) {
      for (const key of field.keys) {
        const res = validateUnitBody({ [key]: sampleFor(key) }, 'update');
        expect(res.ok && key in res.fields, `${field.label}: ${key}`).toBe(true);
      }
    }
  });

  it('names landlordId on the Owning landlord row only, tagged Staff only (plan AR1)', () => {
    const rows = PROPERTY_FORM_FIELDS.filter((f) => f.keys.includes('landlordId'));
    expect(rows.map((f) => [f.label, f.flyer])).toEqual([['Owning landlord', 'staff_only']]);
    expect(PROPERTY_FORM_FIELDS[0]?.label).toBe('Owning landlord');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PROPERTY_FORM_FIELDS)).toBe(true);
    expect(Object.isFrozen(PROPERTY_FORM_FIELDS[0])).toBe(true);
    expect(Object.isFrozen(PROPERTY_FORM_FIELDS[0]?.keys)).toBe(true);
  });
});

describe('the D10a parity walk - the tags agree with toUnitFlyer', () => {
  it('(PIN) walks more than one base, one of them recording voucher sizes equal to its beds', () => {
    expect(BASES.length).toBeGreaterThan(1);
    const eq = baseNamed(SIZES_EQUAL_BEDS);
    expect(acceptedVoucherSizes(eq)).toEqual([eq.beds]);
  });

  it('every On flyer field changes the flyer and every Staff only field never does, on every base', () => {
    expect(flyerTagMismatches(PROPERTY_FORM_FIELDS, BASES)).toEqual([]);
  });

  it('catches a wrong tag - the walk is not vacuous', () => {
    const flip = (v: FlyerVisibility): FlyerVisibility => (v === 'on_flyer' ? 'staff_only' : 'on_flyer');
    // Both directions: three Staff only rows flipped On flyer, and one On flyer
    // row (Application fee) flipped Staff only.
    const flipped = new Set(['Subzone', 'Pets (details)', 'Deposit notes', 'Application fee']);
    const wrong = PROPERTY_FORM_FIELDS.map((f) => (flipped.has(f.label) ? { ...f, flyer: flip(f.flyer) } : f));
    const mismatches = flyerTagMismatches(wrong, BASES);
    expect(mismatches).toHaveLength(flipped.size * BASES.length);
    expect(new Set(mismatches.map((m) => m.split(' | ')[0]))).toEqual(flipped);
  });

  it('flyer-leads D2: a re-tagged field tagged On flyer again fails the walk on every base', () => {
    const retagged = new Set([
      'Rent min',
      'Rent max',
      'Accessibility',
      'Lease terms',
      'No pets',
      'Pets (details)',
      'Pet fee',
      "One month's rent",
      'Fixed amount',
      'Flexible / payment terms available',
    ]);
    const wrong = PROPERTY_FORM_FIELDS.map((f) =>
      retagged.has(f.label) ? { ...f, flyer: 'on_flyer' as FlyerVisibility } : f,
    );
    const mismatches = flyerTagMismatches(wrong, BASES);
    expect(mismatches).toHaveLength(retagged.size * BASES.length);
    expect(new Set(mismatches.map((m) => m.split(' | ')[0]))).toEqual(retagged);
    expect(mismatches.every((m) => m.endsWith('tagged On flyer, but the flyer does not change'))).toBe(true);
  });

  it('(PIN) pins the trap: on the sizes-equal-beds base, clearing the sizes alone changes nothing', () => {
    const eq = baseNamed(SIZES_EQUAL_BEDS);
    const cleared: Record<string, unknown> = structuredClone(eq);
    delete cleared['voucher_size_accepted'];
    expect(toUnitFlyer(cleared as UnitItem)).toEqual(toUnitFlyer(eq));
  });
});
