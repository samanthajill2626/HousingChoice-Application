// Unit tests for the unit-field validation + the merged public flyer projection
// (flyer-full-info 2026-07-16). Covers the writable fields
// (video_url/application_fee/same_day_rta) and the toUnitFlyer allowlist -
// proving it exposes the full public set WITHOUT ever leaking an
// internal/landlord/contact field.
import { describe, expect, it } from 'vitest';
import {
  acceptedVoucherSizes,
  authoritiesOf,
  toUnitFlyer,
  validateUnitBody,
  type UnitFlyer,
} from '../src/lib/unitFields.js';
import { REQUIREMENT_UNIT_KEYS } from '../src/lib/requirements.js';
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
  // A writable, STORED LIST of the voucher sizes the unit accepts (spec
  // 2026-10-20 D4) - DISTINCT from beds. A 3bd unit may accept only a 2BR
  // voucher; readers go through acceptedVoucherSizes (below), which falls
  // back to beds.
  it('a bare integer 0..12 is stored as a one-item list (a raw caller or an older bundle)', () => {
    expect(validateUnitBody({ voucher_size_accepted: 2 }, 'update')).toEqual({
      ok: true,
      fields: { voucher_size_accepted: [2] },
    });
    // 0 is allowed (an efficiency/SRO voucher), and so is the largest size.
    expect(validateUnitBody({ voucher_size_accepted: 0 }, 'update')).toEqual({
      ok: true,
      fields: { voucher_size_accepted: [0] },
    });
    expect(validateUnitBody({ voucher_size_accepted: 12 }, 'update')).toEqual({
      ok: true,
      fields: { voucher_size_accepted: [12] },
    });
  });

  it('a list is stored de-duplicated and ascending', () => {
    expect(validateUnitBody({ voucher_size_accepted: [3, 2, 3] }, 'update')).toEqual({
      ok: true,
      fields: { voucher_size_accepted: [2, 3] },
    });
    expect(validateUnitBody({ voucher_size_accepted: [12, 0, 5] }, 'update')).toEqual({
      ok: true,
      fields: { voucher_size_accepted: [0, 5, 12] },
    });
  });

  it('null and [] CLEAR it (a null patch value -> REMOVE), so beds decide again', () => {
    expect(validateUnitBody({ voucher_size_accepted: null }, 'update')).toEqual({
      ok: true,
      fields: { voucher_size_accepted: null },
    });
    expect(validateUnitBody({ voucher_size_accepted: [] }, 'update')).toEqual({
      ok: true,
      fields: { voucher_size_accepted: null },
    });
  });

  it('rejects 13, -1, 2.5, strings, mixed and nested lists - anything but integers 0..12', () => {
    for (const bad of [13, -1, 2.5, Number.NaN, '2', 'two', '', true, {}, [2, '3'], [2, 13], [2.5], [-1], [[2]], [null]]) {
      expect(validateUnitBody({ voucher_size_accepted: bad }, 'update'), JSON.stringify(bad)).toEqual({
        ok: false,
        error: 'voucher_size_accepted must be an integer 0..12 or a list of them',
      });
    }
  });

  it('accepts the list on create as well as update', () => {
    expect(validateUnitBody({ landlordId: 'contact-ll', voucher_size_accepted: [3, 2] }, 'create')).toEqual({
      ok: true,
      fields: { landlordId: 'contact-ll', voucher_size_accepted: [2, 3] },
    });
  });

  it('(PIN) beds still rejects null (only the voucher sizes and the requirement money fields clear)', () => {
    expect(validateUnitBody({ beds: null }, 'update')).toEqual({
      ok: false,
      error: 'beds must be a number',
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

describe('validateUnitBody - primary_contact is not writable (primary-contact-integrity spec 4.5)', () => {
  // P2b: only the roster writes set the primary_contact scalar, so a body
  // carrying it is refused like any other non-writable key, on create and on
  // update alike.
  it('refuses primary_contact on create', () => {
    expect(validateUnitBody({ landlordId: 'c-ll', primary_contact: 'c-pm' }, 'create')).toEqual({
      ok: false,
      error: 'unknown field: primary_contact',
    });
  });

  it('refuses primary_contact on update, even beside a writable field', () => {
    expect(validateUnitBody({ notes: 'x', primary_contact: 'c-pm' }, 'update')).toEqual({
      ok: false,
      error: 'unknown field: primary_contact',
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

describe('validateUnitBody - the requirement keys (spec 2026-10-20 D1, D2)', () => {
  it('accepts every requirement key with its kind', () => {
    expect(
      validateUnitBody(
        {
          no_evictions_on_program: true,
          evictions_notes: 'None in the last 5 years',
          credit_requirements: '600+',
          income_requirements: '2.5x the tenant portion',
          qualifications: 'Background check\nNo prior landlord debt',
          no_pets: true,
          pets: 'Service animals only',
          pet_fee: '$300 one-time',
          deposit_one_month: true,
          deposit_flexible: true,
          deposit_notes: 'Can split over two months',
          application_fee: 0,
          tour_type: 'landlord_led',
          tour_process: 'Text Ana a day ahead',
        },
        'update',
      ),
    ).toEqual({
      ok: true,
      fields: {
        no_evictions_on_program: true,
        evictions_notes: 'None in the last 5 years',
        credit_requirements: '600+',
        income_requirements: '2.5x the tenant portion',
        qualifications: 'Background check\nNo prior landlord debt',
        no_pets: true,
        pets: 'Service animals only',
        pet_fee: '$300 one-time',
        deposit_one_month: true,
        deposit_flexible: true,
        deposit_notes: 'Can split over two months',
        application_fee: 0,
        tour_type: 'landlord_led',
        tour_process: 'Text Ana a day ahead',
      },
    });
  });

  it('a checkbox stores true; false and null REMOVE (a null patch value); anything else is a 400', () => {
    for (const key of ['no_evictions_on_program', 'no_pets', 'deposit_one_month', 'deposit_flexible']) {
      expect(validateUnitBody({ [key]: true }, 'update'), key).toEqual({ ok: true, fields: { [key]: true } });
      expect(validateUnitBody({ [key]: false }, 'update'), key).toEqual({ ok: true, fields: { [key]: null } });
      expect(validateUnitBody({ [key]: null }, 'update'), key).toEqual({ ok: true, fields: { [key]: null } });
      expect(validateUnitBody({ [key]: 'yes' }, 'update'), key).toEqual({
        ok: false,
        error: `${key} must be true, false or null`,
      });
    }
  });

  it('text is trimmed; "", whitespace and null REMOVE; a non-string is a 400', () => {
    for (const key of [
      'evictions_notes',
      'credit_requirements',
      'income_requirements',
      'qualifications',
      'pet_fee',
      'deposit_notes',
      'tour_process',
    ]) {
      expect(validateUnitBody({ [key]: '  Call first  ' }, 'update'), key).toEqual({
        ok: true,
        fields: { [key]: 'Call first' },
      });
      expect(validateUnitBody({ [key]: '' }, 'update'), key).toEqual({ ok: true, fields: { [key]: null } });
      expect(validateUnitBody({ [key]: '   ' }, 'update'), key).toEqual({ ok: true, fields: { [key]: null } });
      expect(validateUnitBody({ [key]: null }, 'update'), key).toEqual({ ok: true, fields: { [key]: null } });
      expect(validateUnitBody({ [key]: 42 }, 'update'), key).toEqual({
        ok: false,
        error: `${key} must be a string or null`,
      });
    }
  });

  it('money: deposit and application_fee now CLEAR on null; 0 stays a value', () => {
    for (const key of ['deposit', 'application_fee']) {
      expect(validateUnitBody({ [key]: 1400 }, 'update'), key).toEqual({ ok: true, fields: { [key]: 1400 } });
      expect(validateUnitBody({ [key]: 0 }, 'update'), key).toEqual({ ok: true, fields: { [key]: 0 } });
      expect(validateUnitBody({ [key]: null }, 'update'), key).toEqual({ ok: true, fields: { [key]: null } });
      expect(validateUnitBody({ [key]: '1400' }, 'update'), key).toEqual({ ok: false, error: `${key} must be a number` });
      expect(validateUnitBody({ [key]: -1 }, 'update'), key).toEqual({ ok: false, error: `${key} must be >= 0` });
    }
  });

  it('does NOT check the deposit conflict - that needs the stored record (the route does it)', () => {
    expect(validateUnitBody({ deposit_one_month: true, deposit: 1400 }, 'update')).toEqual({
      ok: true,
      fields: { deposit_one_month: true, deposit: 1400 },
    });
  });

  it('requirement keys are writable on create too', () => {
    expect(validateUnitBody({ landlordId: 'contact-ll', no_pets: true, pet_fee: ' $300 ' }, 'create')).toEqual({
      ok: true,
      fields: { landlordId: 'contact-ll', no_pets: true, pet_fee: '$300' },
    });
  });

  it('every registry unit key is writable (the allowlist and the registry agree)', () => {
    for (const key of REQUIREMENT_UNIT_KEYS) {
      expect(validateUnitBody({ [key]: null }, 'update'), key).toEqual({ ok: true, fields: { [key]: null } });
    }
  });

  it('(PIN) requirement_sources is server-written only - a body carrying it is refused', () => {
    expect(validateUnitBody({ requirement_sources: { pets: 'copied' } }, 'update')).toEqual({
      ok: false,
      error: 'unknown field: requirement_sources',
    });
  });
});

describe('validateUnitBody - pets: the details text and the legacy boolean (spec 2026-10-20 D1)', () => {
  it('a string is the details text: trimmed; "" and null REMOVE', () => {
    expect(validateUnitBody({ pets: '  Cats OK ' }, 'update')).toEqual({ ok: true, fields: { pets: 'Cats OK' } });
    expect(validateUnitBody({ pets: '' }, 'update')).toEqual({ ok: true, fields: { pets: null } });
    expect(validateUnitBody({ pets: null }, 'update')).toEqual({ ok: true, fields: { pets: null } });
    // Free text is never parsed: "No pets" stays details text.
    expect(validateUnitBody({ pets: 'No pets' }, 'update')).toEqual({ ok: true, fields: { pets: 'No pets' } });
  });

  it('pets: false MEANS No pets checked and details blank - stored in the new shape at once', () => {
    expect(validateUnitBody({ pets: false }, 'update')).toEqual({ ok: true, fields: { no_pets: true, pets: null } });
  });

  it('pets: true MEANS No pets unchecked and details "Allowed"', () => {
    expect(validateUnitBody({ pets: true }, 'update')).toEqual({ ok: true, fields: { no_pets: null, pets: 'Allowed' } });
  });

  it('a boolean beside pet_fee keeps the fee', () => {
    expect(validateUnitBody({ pets: false, pet_fee: ' $300 ' }, 'update')).toEqual({
      ok: true,
      fields: { no_pets: true, pets: null, pet_fee: '$300' },
    });
  });

  it('a boolean pets beside no_pets is a 400, in either key order and for a null no_pets', () => {
    for (const body of [{ pets: false, no_pets: true }, { no_pets: null, pets: true }, { no_pets: false, pets: false }]) {
      expect(validateUnitBody(body, 'update'), JSON.stringify(body)).toEqual({
        ok: false,
        error: 'pets: a boolean pets cannot be combined with no_pets',
      });
    }
  });

  it('a string pets beside no_pets is the new shape and fine', () => {
    expect(validateUnitBody({ no_pets: true, pets: 'Service animals only' }, 'update')).toEqual({
      ok: true,
      fields: { no_pets: true, pets: 'Service animals only' },
    });
  });

  it('rejects a pets that is not a string, a boolean or null', () => {
    for (const bad of [42, {}, ['cats']]) {
      expect(validateUnitBody({ pets: bad }, 'update')).toEqual({
        ok: false,
        error: 'pets must be a string, a boolean or null',
      });
    }
  });
});

describe('validateUnitBody - subzone and washer_dryer (spec 2026-10-20 D3)', () => {
  it('subzone is clearable text: trimmed; "", whitespace and null REMOVE', () => {
    expect(validateUnitBody({ subzone: ' SE11 ' }, 'update')).toEqual({ ok: true, fields: { subzone: 'SE11' } });
    expect(validateUnitBody({ subzone: '' }, 'update')).toEqual({ ok: true, fields: { subzone: null } });
    expect(validateUnitBody({ subzone: '  ' }, 'update')).toEqual({ ok: true, fields: { subzone: null } });
    expect(validateUnitBody({ subzone: null }, 'update')).toEqual({ ok: true, fields: { subzone: null } });
  });

  it('subzone rejects a non-string', () => {
    expect(validateUnitBody({ subzone: 11 }, 'update')).toEqual({ ok: false, error: 'subzone must be a string or null' });
  });

  it('washer_dryer takes hookups, included or none; "" and null REMOVE', () => {
    for (const v of ['hookups', 'included', 'none']) {
      expect(validateUnitBody({ washer_dryer: v }, 'update')).toEqual({ ok: true, fields: { washer_dryer: v } });
    }
    expect(validateUnitBody({ washer_dryer: '' }, 'update')).toEqual({ ok: true, fields: { washer_dryer: null } });
    expect(validateUnitBody({ washer_dryer: null }, 'update')).toEqual({ ok: true, fields: { washer_dryer: null } });
  });

  it('washer_dryer rejects anything else', () => {
    for (const bad of ['yes', 'Hookups', 'in-unit', true, 1, {}]) {
      expect(validateUnitBody({ washer_dryer: bad }, 'update')).toEqual({
        ok: false,
        error: 'washer_dryer must be one of: hookups, included, none',
      });
    }
  });
});

describe('validateUnitBody - the other kinds are unchanged', () => {
  it('(PIN) area, notes, lease_terms, utilities and accessibility keep the plain string kind', () => {
    for (const key of ['area', 'notes', 'lease_terms', 'utilities', 'accessibility']) {
      expect(validateUnitBody({ [key]: '' }, 'update'), key).toEqual({ ok: true, fields: { [key]: '' } });
      expect(validateUnitBody({ [key]: null }, 'update'), key).toEqual({ ok: false, error: `${key} must be a string` });
    }
  });
});

describe('acceptedVoucherSizes', () => {
  // THE one reader of "which voucher sizes does this unit take" (Cameron,
  // 2026-10-04): the recorded `voucher_size_accepted` when there is one - ONE
  // number today, a multi-select LIST with tracker #12 (the `full` demo seed
  // already stores [2, 3]) - otherwise the bedroom count; nothing only when
  // BOTH are missing. The SAME cases as the dashboard mirror's suite
  // (dashboard/src/routes/listing/listingFormat.test.ts) - keep them in step.
  it('a recorded single size wins, even over a different bedroom count', () => {
    expect(acceptedVoucherSizes({ voucher_size_accepted: 2 })).toEqual([2]);
    expect(acceptedVoucherSizes({ voucher_size_accepted: 2, beds: 3 })).toEqual([2]);
    expect(acceptedVoucherSizes({ voucher_size_accepted: 0, beds: 1 })).toEqual([0]);
  });
  it('a recorded list wins, keeping every finite number in order', () => {
    expect(acceptedVoucherSizes({ voucher_size_accepted: [2, 3], beds: 4 })).toEqual([2, 3]);
    expect(acceptedVoucherSizes({ voucher_size_accepted: [2, 'x', null, Number.NaN, 3] })).toEqual([2, 3]);
  });
  it('falls back to the bedroom count when no voucher size is recorded', () => {
    expect(acceptedVoucherSizes({ beds: 3 })).toEqual([3]);
    expect(acceptedVoucherSizes({ beds: 0 })).toEqual([0]);
    // An empty or unusable recorded value records nothing, so beds still decide.
    expect(acceptedVoucherSizes({ voucher_size_accepted: [], beds: 2 })).toEqual([2]);
    expect(acceptedVoucherSizes({ voucher_size_accepted: ['x', null], beds: 2 })).toEqual([2]);
    expect(acceptedVoucherSizes({ voucher_size_accepted: Number.NaN, beds: 2 })).toEqual([2]);
    expect(acceptedVoucherSizes({ voucher_size_accepted: '2', beds: 1 })).toEqual([1]);
  });
  it('is empty (Not recorded) only when BOTH are missing or unusable', () => {
    expect(acceptedVoucherSizes({})).toEqual([]);
    expect(acceptedVoucherSizes({ voucher_size_accepted: null, beds: null })).toEqual([]);
    expect(acceptedVoucherSizes({ voucher_size_accepted: [], beds: Number.NaN })).toEqual([]);
    expect(acceptedVoucherSizes({ beds: '3' })).toEqual([]);
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

  it('voucher_size states the RECORDED size over the bedroom count; the key stays off', () => {
    // The reported prod bug (2026-10-12): a unit whose recorded voucher size
    // differed from its bedrooms showed the bedroom count, because the flyer read
    // beds alone.
    const flyer = toUnitFlyer(fullUnit({ beds: 2, voucher_size_accepted: 3 }));
    expect(flyer.voucher_size).toBe(3);
    expect(flyer.beds).toBe(2);
    // The VALUE ships as voucher_size; the internal KEY never does.
    expect(Object.keys(flyer)).not.toContain('voucher_size_accepted');
  });

  it('voucher_size falls back to beds, and is null only when both are missing', () => {
    expect(toUnitFlyer(fullUnit({ beds: 3 })).voucher_size).toBe(3);
    expect(toUnitFlyer({ unitId: 'x', landlordId: 'll', status: 'available' }).voucher_size).toBeNull();
    expect(
      toUnitFlyer({ unitId: 'x', landlordId: 'll', status: 'available', voucher_size_accepted: 1 }).voucher_size,
    ).toBe(1);
  });

  it('voucher_size takes the first size of a recorded list (demo seed only until #12)', () => {
    const listed = fullUnit({ beds: 4, voucher_size_accepted: [2, 3] as unknown as number });
    expect(toUnitFlyer(listed).voucher_size).toBe(2);
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
