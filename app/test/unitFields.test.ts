// Unit tests for the unit-field validation + the merged public flyer projection
// (flyer-full-info 2026-07-16). Covers the writable fields
// (video_url/application_fee/same_day_rta) and the toUnitFlyer allowlist -
// proving it exposes the full public set WITHOUT ever leaking an
// internal/landlord/contact field.
import { describe, expect, it } from 'vitest';
import {
  authoritiesOf,
  toUnitFlyer,
  validateUnitBody,
  type UnitFlyer,
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

describe('validateUnitBody — property notes (internal)', () => {
  // Free-form staff notes ("In-unit washer/dryer", "No dishwasher") — writable
  // like contact notes, but INTERNAL: the flyer projections never carry it
  // (asserted in the allowlist-wall test below).
  it('accepts notes (a string)', () => {
    expect(validateUnitBody({ notes: 'In-unit washer/dryer' }, 'update')).toEqual({
      ok: true,
      fields: { notes: 'In-unit washer/dryer' },
    });
  });

  it('rejects a non-string notes', () => {
    expect(validateUnitBody({ notes: 42 }, 'update')).toEqual({
      ok: false,
      error: 'notes must be a string',
    });
  });
});

describe('validateUnitBody — lease_terms (moved off the landlord contact 2026-07-10)', () => {
  it('accepts lease_terms (a string)', () => {
    expect(
      validateUnitBody({ lease_terms: '12-month minimum, month-to-month after' }, 'update'),
    ).toEqual({
      ok: true,
      fields: { lease_terms: '12-month minimum, month-to-month after' },
    });
  });

  it('rejects a non-string lease_terms', () => {
    expect(validateUnitBody({ lease_terms: 12 }, 'update')).toEqual({
      ok: false,
      error: 'lease_terms must be a string',
    });
  });
});

describe('validateUnitBody - tour_type (structured, clear-to-absent)', () => {
  // A dedicated enum field: a value must be in the TourType union, and clearing
  // it (''/null) maps to a null patch value so the repo REMOVEs the attribute
  // (no stray empty-string enum). Applies to both create and update.
  it('accepts each TourType union member (passes through unchanged)', () => {
    for (const t of ['self_guided', 'landlord_led', 'pm_team']) {
      expect(validateUnitBody({ tour_type: t }, 'update')).toEqual({
        ok: true,
        fields: { tour_type: t },
      });
    }
  });

  it('maps a "" clear to a null patch value (the repo REMOVE signal)', () => {
    const res = validateUnitBody({ tour_type: '' }, 'update');
    expect(res).toEqual({ ok: true, fields: { tour_type: null } });
    // Explicit: it is null (the REMOVE signal), not '' or absent.
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.fields.tour_type).toBeNull();
  });

  it('maps a null clear to a null patch value (the repo REMOVE signal)', () => {
    const res = validateUnitBody({ tour_type: null }, 'update');
    expect(res).toEqual({ ok: true, fields: { tour_type: null } });
    if (res.ok) expect(res.fields.tour_type).toBeNull();
  });

  it('rejects a value outside the union with a 400 error object', () => {
    for (const bad of ['pm', 'landlord', 'SELF_GUIDED', 42, true, {}]) {
      expect(validateUnitBody({ tour_type: bad }, 'update')).toEqual({
        ok: false,
        error: 'tour_type must be one of: self_guided, landlord_led, pm_team',
      });
    }
  });

  it('accepts tour_type on create as well as update', () => {
    expect(
      validateUnitBody({ landlordId: 'contact-ll', tour_type: 'pm_team' }, 'create'),
    ).toEqual({ ok: true, fields: { landlordId: 'contact-ll', tour_type: 'pm_team' } });
  });
});

describe('validateUnitBody - accepted_authorities consolidation (spec section 8)', () => {
  // ONE list field replaces BOTH the single `jurisdiction` string and the
  // dissolved `accepted_programs` concept. The two retired keys are ACCEPT-AND-
  // IGNORE tombstones rather than a hard removal: the parser 400s an unknown key,
  // and a stale cached dashboard bundle must not fail its save.
  it('accepts accepted_authorities and DISCARDS the tombstoned legacy keys', () => {
    const res = validateUnitBody(
      {
        accepted_authorities: ['Atlanta (AHA)', 'DCA'],
        jurisdiction: 'x',
        accepted_programs: ['HCV'],
      },
      'update',
    );
    expect(res).toEqual({ ok: true, fields: { accepted_authorities: ['Atlanta (AHA)', 'DCA'] } });
  });

  it('rejects an accepted_authorities that is not an array of strings', () => {
    expect(validateUnitBody({ accepted_authorities: [1, 2] }, 'update')).toEqual({
      ok: false,
      error: 'accepted_authorities must be an array of strings',
    });
    expect(validateUnitBody({ accepted_authorities: 'DCA' }, 'update')).toEqual({
      ok: false,
      error: 'accepted_authorities must be an array of strings',
    });
  });

  it('accepts accepted_authorities on create as well as update', () => {
    expect(
      validateUnitBody({ landlordId: 'contact-ll', accepted_authorities: ['DCA'] }, 'create'),
    ).toEqual({ ok: true, fields: { landlordId: 'contact-ll', accepted_authorities: ['DCA'] } });
  });

  it('a save supplying ONLY tombstoned keys validates ok with an EMPTY field set', () => {
    // A retired key COUNTS as supplied, so this is NOT the no-updatable-fields
    // 400 - the route turns the empty set into a 200 no-op instead.
    expect(validateUnitBody({ jurisdiction: 'x' }, 'update')).toEqual({ ok: true, fields: {} });
    expect(validateUnitBody({ accepted_programs: ['HCV'] }, 'update')).toEqual({
      ok: true,
      fields: {},
    });
  });

  it('still rejects a TRULY empty update body', () => {
    expect(validateUnitBody({}, 'update')).toEqual({
      ok: false,
      error: 'no updatable fields supplied',
    });
  });

  it('authoritiesOf: the new list wins, a legacy jurisdiction synthesizes, else []', () => {
    expect(authoritiesOf({ accepted_authorities: ['DCA'], jurisdiction: 'old' })).toEqual(['DCA']);
    expect(authoritiesOf({ jurisdiction: 'atlanta_housing' })).toEqual(['atlanta_housing']);
    expect(authoritiesOf({})).toEqual([]);
    // A STORED empty list means "cleared" and still wins - otherwise clearing the
    // authorities on a legacy unit would resurrect its old jurisdiction value.
    expect(authoritiesOf({ accepted_authorities: [], jurisdiction: 'legacy' })).toEqual([]);
    // A malformed stored value falls back to the legacy string instead of
    // shipping garbage; an empty legacy string is not a value at all.
    expect(authoritiesOf({ accepted_authorities: 'not-a-list', jurisdiction: 'j' })).toEqual(['j']);
    expect(authoritiesOf({ jurisdiction: '' })).toEqual([]);
  });

  it('toUnitFlyer projects the SYNTHESIZED list and carries no accepted_programs key', () => {
    const flyer = toUnitFlyer({
      unitId: 'u1',
      landlordId: 'l1',
      status: 'available',
      jurisdiction: 'Atlanta (AHA)',
    });
    expect(flyer.accepted_authorities).toEqual(['Atlanta (AHA)']);
    expect('accepted_programs' in flyer).toBe(false);
    // Stored accepted_programs data stays on the document and simply stops
    // rendering (spec section 8) - it never migrates into the new field.
    const stale = toUnitFlyer({
      unitId: 'u2',
      landlordId: 'l1',
      status: 'available',
      accepted_programs: ['HCV'],
    });
    expect(stale.accepted_authorities).toEqual([]);
  });
});

describe('toUnitFlyer - the merged public allowlist', () => {
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
      rent_min: 1400,
      rent_max: 1600,
      media: ['s3://photo1.jpg'],
      listing_link: 'https://example.com/listing/9',
      utilities: 'Tenant-paid',
      video_url: 'https://v.example/tour9',
      application_fee: 50,
      same_day_rta: true,
      // newly PUBLIC (flyer-full-info 2026-07-16) - real values, asserted below
      deposit: 1400,
      accessibility: 'Ground floor, no stairs',
      lease_terms: '12-month minimum',
      pets: 'Cats only',
      // still INTERNAL - SECRET markers prove they never serialize
      payment_standard: 1700,
      lif: 500,
      notes: 'SECRET in-unit washer note',
      priority: 'SECRET high',
      tour_process: 'SECRET lockbox 9999',
      // E3 pin: set on the fixture but NOT listed in the exact-shape expected
      // object below, so the flyer test FAILS loudly if tour_type ever leaks.
      tour_type: 'self_guided',
      application_process: 'SECRET portal',
      primary_contact: 'contact-ll-agent',
      status_source: 'manual',
      propertyId: 'SECRET-parent',
      ...overrides,
    };
  }

  it('exposes the merged public field set (teaser + reveal + tenant-useful)', () => {
    const flyer = toUnitFlyer(fullUnit());
    expect(flyer).toEqual<UnitFlyer>({
      unitId: 'unit-9',
      media: ['s3://photo1.jpg'],
      beds: 2,
      baths: 1,
      area: 'Westside',
      subzone: 'Zone 4',
      voucher_size: 2,
      // SYNTHESIZED from the fixture's legacy `jurisdiction: 'DCA'` (spec section
      // 8): the fixture no longer sets accepted_programs at all, since that field
      // is retired and never folded into the new one.
      accepted_authorities: ['DCA'],
      listing_link: 'https://example.com/listing/9',
      rent_min: 1400,
      rent_max: 1600,
      address: { line1: '123 Private St', city: 'Atlanta', state: 'GA', zip: '30303' },
      utilities: 'Tenant-paid',
      video_url: 'https://v.example/tour9',
      application_fee: 50,
      same_day_rta: true,
      pets: 'Cats only',
      accessibility: 'Ground floor, no stairs',
      deposit: 1400,
      lease_terms: '12-month minimum',
    });
  });

  it('NEVER leaks an internal/landlord/contact field (allowlist wall)', () => {
    const flyer = toUnitFlyer(fullUnit());
    const keys = Object.keys(flyer);
    // CONSCIOUS narrowing (spec section 8): `jurisdiction` stays a forbidden KEY,
    // but its VALUE is no longer walled off - on a legacy unit it is the single
    // synthesized entry of the public `accepted_authorities` list (asserted in the
    // exact-shape test above). That is the deliberate, defended consequence of the
    // consolidation, not a leak; this wall is about keys and SECRET-marked
    // internal values.
    for (const forbidden of [
      'landlordId', 'primary_contact', 'tour_process', 'tour_type',
      'application_process', 'status', 'status_source', 'notes',
      'payment_standard', 'lif', 'propertyId', 'jurisdiction', 'priority',
      'final_rent', 'voucher_size_accepted',
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    // And no SECRET value (carried on internal fields) reaches the serialization.
    expect(JSON.stringify(flyer)).not.toContain('SECRET');
    expect(JSON.stringify(flyer)).not.toContain('contact-ll-secret');
  });

  it('falls each absent field to null (not undefined) and address to {}', () => {
    const flyer = toUnitFlyer({
      unitId: 'bare',
      landlordId: 'll',
      status: 'available',
    });
    expect(flyer.address).toEqual({});
    expect(flyer.utilities).toBeNull();
    expect(flyer.video_url).toBeNull();
    expect(flyer.application_fee).toBeNull();
    expect(flyer.same_day_rta).toBeNull();
    expect(flyer.pets).toBeNull();
    expect(flyer.accessibility).toBeNull();
    expect(flyer.deposit).toBeNull();
    expect(flyer.lease_terms).toBeNull();
  });

  it('passes pets through as string or boolean; null when absent', () => {
    expect(toUnitFlyer(fullUnit({ pets: true })).pets).toBe(true);
    expect(toUnitFlyer(fullUnit({ pets: false })).pets).toBe(false);
    expect(toUnitFlyer(fullUnit({ pets: 'Cats only' })).pets).toBe('Cats only');
    expect(toUnitFlyer({ unitId: 'x', landlordId: 'll', status: 'available' }).pets).toBeNull();
  });

  it('drops a legacy plain-string address (only structured sub-fields survive)', () => {
    const flyer = toUnitFlyer({
      unitId: 'legacy',
      landlordId: 'll',
      status: 'available',
      // A legacy dev unit may hold a plain string here - it must NOT pass through
      // as a raw blob; the projection re-validates to the structured allowlist.
      address: '123 Legacy St' as unknown as UnitItem['address'],
    });
    expect(flyer.address).toEqual({});
  });
});
