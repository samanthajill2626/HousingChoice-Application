// Unit tests for the unit-field validation + flyer projections (public-pages
// §3). Covers the 3 new writable fields (video_url/application_fee/same_day_rta)
// and the toUnitFlyerDetails reveal allowlist — proving it exposes the richer
// set WITHOUT ever leaking an internal/landlord/contact field.
import { describe, expect, it } from 'vitest';
import {
  toUnitFlyerDetails,
  validateUnitBody,
  type UnitFlyerDetails,
} from '../src/lib/unitFields.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';

describe('validateUnitBody — new public-flyer fields', () => {
  it('accepts video_url (string), application_fee (number >= 0), same_day_rta (boolean)', () => {
    const res = validateUnitBody(
      { video_url: 'https://v.example/tour', application_fee: 50, same_day_rta: true },
      'update',
    );
    expect(res).toEqual({
      ok: true,
      fields: { video_url: 'https://v.example/tour', application_fee: 50, same_day_rta: true },
    });
  });

  it('accepts same_day_rta: false (a boolean, not just true)', () => {
    const res = validateUnitBody({ same_day_rta: false }, 'update');
    expect(res).toEqual({ ok: true, fields: { same_day_rta: false } });
  });

  it('rejects a non-boolean same_day_rta', () => {
    for (const bad of ['yes', 1, 0, null, {}]) {
      const res = validateUnitBody({ same_day_rta: bad }, 'update');
      expect(res).toEqual({ ok: false, error: 'same_day_rta must be a boolean' });
    }
  });

  it('rejects a non-number / negative application_fee', () => {
    expect(validateUnitBody({ application_fee: 'free' }, 'update')).toEqual({
      ok: false,
      error: 'application_fee must be a number',
    });
    expect(validateUnitBody({ application_fee: -1 }, 'update')).toEqual({
      ok: false,
      error: 'application_fee must be >= 0',
    });
    // 0 is allowed (a fee-free unit).
    expect(validateUnitBody({ application_fee: 0 }, 'update')).toEqual({
      ok: true,
      fields: { application_fee: 0 },
    });
  });

  it('rejects a non-string video_url', () => {
    expect(validateUnitBody({ video_url: 123 }, 'update')).toEqual({
      ok: false,
      error: 'video_url must be a string',
    });
  });
});

describe('validateUnitBody — voucher_size_accepted (landlord-onboarding)', () => {
  // A writable, STORED voucher size the unit accepts — DISTINCT from the derived
  // read-only voucher_size (which projects from beds). A 3bd unit may accept a
  // 2BR voucher, so this is its own number field feeding matching.
  it('accepts voucher_size_accepted (a number >= 0)', () => {
    expect(validateUnitBody({ voucher_size_accepted: 2 }, 'update')).toEqual({
      ok: true,
      fields: { voucher_size_accepted: 2 },
    });
    // 0 is allowed (an efficiency/SRO voucher).
    expect(validateUnitBody({ voucher_size_accepted: 0 }, 'update')).toEqual({
      ok: true,
      fields: { voucher_size_accepted: 0 },
    });
  });

  it('rejects a non-number voucher_size_accepted', () => {
    expect(validateUnitBody({ voucher_size_accepted: 'two' }, 'update')).toEqual({
      ok: false,
      error: 'voucher_size_accepted must be a number',
    });
  });

  it('rejects a negative voucher_size_accepted', () => {
    expect(validateUnitBody({ voucher_size_accepted: -1 }, 'update')).toEqual({
      ok: false,
      error: 'voucher_size_accepted must be >= 0',
    });
  });
});

describe('toUnitFlyerDetails — the reveal allowlist', () => {
  // A unit loaded with EVERY internal/landlord/contact field set, to prove none
  // leak through the projection.
  function fullUnit(overrides: Partial<UnitItem> = {}): UnitItem {
    return {
      unitId: 'unit-9',
      landlordId: 'contact-ll-secret',
      status: 'available',
      jurisdiction: 'DCA',
      address: { line1: '123 Private St', city: 'Atlanta', state: 'GA', zip: '30303' },
      beds: 2,
      baths: 1,
      area: 'Westside',
      subzone: 'Zone 4',
      accepted_programs: ['GHV'],
      rent_min: 1400,
      rent_max: 1600,
      payment_standard: 1700,
      deposit: 1400,
      lif: 500,
      media: ['s3://photo1.jpg'],
      listing_link: 'https://example.com/listing/9',
      utilities: 'Tenant-paid',
      video_url: 'https://v.example/tour9',
      application_fee: 50,
      same_day_rta: true,
      accessibility: 'SECRET ground floor',
      pets: 'SECRET cats only',
      priority: 'SECRET high',
      tour_process: 'SECRET lockbox 9999',
      application_process: 'SECRET portal',
      primary_voice_contact: 'contact-ll-agent',
      status_source: 'manual',
      propertyId: 'SECRET-parent',
      ...overrides,
    };
  }

  it('exposes the teaser fields PLUS the 5 reveal fields', () => {
    const details = toUnitFlyerDetails(fullUnit());
    expect(details).toEqual<UnitFlyerDetails>({
      // teaser
      unitId: 'unit-9',
      media: ['s3://photo1.jpg'],
      beds: 2,
      baths: 1,
      area: 'Westside',
      subzone: 'Zone 4',
      voucher_size: 2,
      accepted_programs: ['GHV'],
      listing_link: 'https://example.com/listing/9',
      rent_min: 1400,
      rent_max: 1600,
      // reveal
      address: { line1: '123 Private St', city: 'Atlanta', state: 'GA', zip: '30303' },
      utilities: 'Tenant-paid',
      video_url: 'https://v.example/tour9',
      application_fee: 50,
      same_day_rta: true,
    });
  });

  it('NEVER leaks an internal/landlord/contact field (allowlist wall)', () => {
    const details = toUnitFlyerDetails(fullUnit());
    const keys = Object.keys(details);
    for (const forbidden of [
      'landlordId',
      'primary_voice_contact',
      'tour_process',
      'application_process',
      'status',
      'status_source',
      'notes',
      'payment_standard',
      'deposit',
      'lif',
      'propertyId',
      'jurisdiction',
      'priority',
      'accessibility',
      'pets',
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    // And no SECRET value (carried on internal fields) reaches the serialization.
    expect(JSON.stringify(details)).not.toContain('SECRET');
    expect(JSON.stringify(details)).not.toContain('contact-ll-secret');
  });

  it('falls each absent reveal field to null (not undefined) and address to {}', () => {
    const details = toUnitFlyerDetails({
      unitId: 'bare',
      landlordId: 'll',
      status: 'available',
    });
    expect(details.address).toEqual({});
    expect(details.utilities).toBeNull();
    expect(details.video_url).toBeNull();
    expect(details.application_fee).toBeNull();
    expect(details.same_day_rta).toBeNull();
  });

  it('drops a legacy plain-string address (only structured sub-fields survive)', () => {
    const details = toUnitFlyerDetails({
      unitId: 'legacy',
      landlordId: 'll',
      status: 'available',
      // A legacy dev unit may hold a plain string here — it must NOT pass through
      // as a raw blob; the projection re-validates to the structured allowlist.
      address: '123 Legacy St' as unknown as UnitItem['address'],
    });
    expect(details.address).toEqual({});
  });
});
