// WP1 B2a S3.4 (spec D1; charter 5): the pool's eligibility rules, pure.
// mapAuthorities maps a property's recorded authorities with the EXISTING
// server rule (orgNames.checkScalarWrite for an audience filter member); the
// parity block runs the dashboard prefill's own cases
// (dashboard/src/routes/broadcasts/authorityPrefill.test.ts) through it - keep
// the two in step by hand. The list-unknown case has no server twin: an
// unreadable list fails the pool (rankingPool.test.ts).
import { describe, expect, it } from 'vitest';
import { voucherSizeMatches } from '../src/lib/blastAudienceRules.js';
import {
  authorityAllows,
  authorityFilters,
  inPoolWindow,
  isSendable,
  mapAuthorities,
  mapWithConcurrency,
  pairAuthorityFact,
  poolRecencyAt,
  recordedVoucherSizes,
  sortRecencyAt,
  tenantAnchorNotes,
  tenantVoucherSize,
  unitAnchorNotes,
  unitVoucherSizes,
} from '../src/services/ranking/pool.js';
import { orgEntry } from './helpers/orgFixtures.js';
import { NOW, daysAgo, tenant } from './helpers/rankingFixtures.js';

// The dashboard prefill test's entries, verbatim.
const P_ATLANTA = orgEntry({ orgId: 'o-atl', kind: 'housing_authority', name: 'Atlanta Housing Authority', spellings: ['AHA', 'Atlanta Housing'] });
const P_AUGUSTA = orgEntry({ orgId: 'o-aug', kind: 'housing_authority', name: 'Augusta Housing Authority', spellings: ['AHA'] });
const P_DEKALB = orgEntry({ orgId: 'o-dek', kind: 'housing_authority', name: 'DeKalb County Housing Authority', spellings: ['HADC'] });
const P_HOPE = orgEntry({ orgId: 'o-hope', kind: 'agency', name: 'Hope Atlanta', spellings: ['HOPE'] });
const PARITY = [P_ATLANTA, P_AUGUSTA, P_DEKALB, P_HOPE];

describe('mapAuthorities - parity with the composer prefill (spec D1)', () => {
  it('keeps an exact list name', () => {
    expect(mapAuthorities(PARITY, ['DeKalb County Housing Authority'])).toEqual({
      mapped: ['DeKalb County Housing Authority'],
      unmapped: [],
    });
  });

  it('maps a spelling exactly one entry carries, and a name written differently, to the entry name', () => {
    expect(mapAuthorities(PARITY, ['HADC', 'atlanta housing authority'])).toEqual({
      mapped: ['DeKalb County Housing Authority', 'Atlanta Housing Authority'],
      unmapped: [],
    });
  });

  it('leaves a shared spelling, an unknown name and an agency unmapped, in the property order', () => {
    expect(mapAuthorities(PARITY, ['AHA', 'Nowhere Board', 'Hope Atlanta'])).toEqual({
      mapped: [],
      unmapped: ['AHA', 'Nowhere Board', 'Hope Atlanta'],
    });
  });

  it('keeps the property order and drops duplicates and blanks', () => {
    expect(
      mapAuthorities(PARITY, ['HADC', 'Atlanta Housing Authority', 'DeKalb County Housing Authority', 'Nowhere', ' Nowhere ', '  ']),
    ).toEqual({ mapped: ['DeKalb County Housing Authority', 'Atlanta Housing Authority'], unmapped: ['Nowhere'] });
  });

  it('a property with no recorded authority maps nothing', () => {
    expect(mapAuthorities(PARITY, [])).toEqual({ mapped: [], unmapped: [] });
  });
});

describe('authorityAllows - none recorded or none mapped: every authority; some mapped: those only', () => {
  const limited = { mapped: ['Atlanta Housing Authority'], unmapped: ['Nowhere'] };

  it('an empty mapped list limits nothing, a tenant with no authority included', () => {
    expect(authorityAllows({ mapped: [], unmapped: [] }, undefined)).toBe(true);
    expect(authorityAllows({ mapped: [], unmapped: ['AHA'] }, 'Georgia Department of Community Affairs')).toBe(true);
  });

  it('a mapped list admits its names with case and spacing folded, never fuzzy', () => {
    expect(authorityAllows(limited, 'Atlanta Housing Authority')).toBe(true);
    expect(authorityAllows(limited, '  atlanta   HOUSING authority ')).toBe(true);
    expect(authorityAllows(limited, 'AHA')).toBe(false);
    expect(authorityAllows(limited, 'Augusta Housing Authority')).toBe(false);
    expect(authorityAllows(limited, undefined)).toBe(false);
    expect(authorityAllows(limited, '')).toBe(false);
  });
});

describe('pairAuthorityFact - charter section 20 item 18, the same decision the pool fences with', () => {
  it('matched exactly when the pool fences on authority (some recorded name mapped)', () => {
    const limited = { mapped: ['Atlanta Housing Authority'], unmapped: ['Nowhere'] };
    expect(authorityFilters(limited)).toBe(true);
    expect(pairAuthorityFact(limited)).toBe('matched');
  });

  it('unconfirmed when the pool did not fence: every recorded name unmapped (or none recorded)', () => {
    for (const mapping of [{ mapped: [], unmapped: ['AHA', 'Nowhere'] }, { mapped: [], unmapped: [] }]) {
      expect(authorityFilters(mapping)).toBe(false);
      expect(pairAuthorityFact(mapping)).toBe('unconfirmed');
      // The pool admitted every tenant for this property, so nothing was confirmed.
      expect(authorityAllows(mapping, 'Augusta Housing Authority')).toBe(true);
    }
  });
});

describe('voucher sizes - acceptedVoucherSizes, clamped to 0-4 and de-duplicated as the prefill does', () => {
  it('reads the recorded list, a legacy single number, or the beds; 4 means 4 or more', () => {
    expect(unitVoucherSizes({ voucher_size_accepted: [3, 2, 3] })).toEqual([2, 3]);
    expect(unitVoucherSizes({ voucher_size_accepted: [6, 1] })).toEqual([1, 4]);
    expect(unitVoucherSizes({ voucher_size_accepted: 3 })).toEqual([3]);
    expect(unitVoucherSizes({ beds: 5 })).toEqual([4]);
    expect(unitVoucherSizes({ voucher_size_accepted: [], beds: 2 })).toEqual([2]);
    expect(unitVoucherSizes({})).toEqual([]);
  });

  it('compares with the server twin: 4 or more matches the 4, no size never matches a non-empty list', () => {
    expect(voucherSizeMatches(unitVoucherSizes({ beds: 5 }), tenantVoucherSize(tenant('t1', { voucherSize: 6 })))).toBe(true);
    expect(voucherSizeMatches([2, 3], tenantVoucherSize(tenant('t1', { voucherSize: 4 })))).toBe(false);
    expect(voucherSizeMatches([2, 3], tenantVoucherSize(tenant('t1', { voucherSize: undefined })))).toBe(false);
    expect(voucherSizeMatches([], tenantVoucherSize(tenant('t1', { voucherSize: undefined })))).toBe(true);
  });

  it("reads a tenant's size only as a whole number", () => {
    expect(tenantVoucherSize(tenant('t1', { voucherSize: 2 }))).toBe(2);
    expect(tenantVoucherSize(tenant('t1', { voucherSize: '2' }))).toBeUndefined();
    expect(tenantVoucherSize(tenant('t1', { voucherSize: 2.5 }))).toBeUndefined();
  });
});

describe('isSendable - the three tests audienceResolution applies', () => {
  it('needs no opt-out, no unreachable flag and a phone', () => {
    expect(isSendable(tenant('t1'))).toBe(true);
    expect(isSendable(tenant('t1', { sms_opt_out: true }))).toBe(false);
    expect(isSendable(tenant('t1', { sms_unreachable: true }))).toBe(false);
    expect(isSendable(tenant('t1', { phone: '' }))).toBe(false);
    expect(isSendable(tenant('t1', { phone: undefined }))).toBe(false);
  });

  it('does not ask for SMS consent (a flag, not a pool rule)', () => {
    expect(isSendable(tenant('t1', { consent_method: undefined }))).toBe(true);
  });
});

describe('inPoolWindow - last heard from within the window, else created_at, never for an import', () => {
  it('counts last heard from, inclusive at the edge', () => {
    expect(inPoolWindow(tenant('t1', { last_heard_from_at: daysAgo(89) }), NOW, 90)).toBe(true);
    expect(inPoolWindow(tenant('t1', { last_heard_from_at: daysAgo(90) }), NOW, 90)).toBe(true);
    expect(inPoolWindow(tenant('t1', { last_heard_from_at: daysAgo(91) }), NOW, 90)).toBe(false);
  });

  it('a tenant never heard from counts from created_at', () => {
    expect(inPoolWindow(tenant('t1', { last_heard_from_at: undefined, created_at: daysAgo(10) }), NOW, 90)).toBe(true);
    expect(inPoolWindow(tenant('t1', { last_heard_from_at: undefined, created_at: daysAgo(100) }), NOW, 90)).toBe(false);
  });

  it('a contact carrying imported_from never uses the created_at fallback', () => {
    expect(
      inPoolWindow(tenant('t1', { last_heard_from_at: undefined, created_at: daysAgo(5), imported_from: 'quo-airtable-import' }), NOW, 90),
    ).toBe(false);
    expect(
      inPoolWindow(tenant('t1', { last_heard_from_at: daysAgo(5), imported_from: 'quo-airtable-import' }), NOW, 90),
    ).toBe(true);
  });
});

describe('sortRecencyAt - the read tie order, spec D9 (FB19)', () => {
  it('last heard from, else created_at - an import included; null when neither parses', () => {
    expect(sortRecencyAt(tenant('t1', { last_heard_from_at: daysAgo(4) }))).toBe(daysAgo(4));
    expect(
      sortRecencyAt(tenant('t1', { last_heard_from_at: undefined, created_at: daysAgo(12), imported_from: 'quo-airtable-import' })),
    ).toBe(daysAgo(12));
    expect(sortRecencyAt(tenant('t1', { last_heard_from_at: 'not a date', created_at: daysAgo(12) }))).toBe(daysAgo(12));
    expect(sortRecencyAt(tenant('t1', { last_heard_from_at: undefined, created_at: undefined }))).toBeNull();
  });
});

describe('recordedVoucherSizes - the recorded sizes through the one normalizer (FB20)', () => {
  it('ignores beds; drops fractions and negatives; clamps to 4', () => {
    expect(recordedVoucherSizes({ voucher_size_accepted: [6, 2] })).toEqual([2, 4]);
    expect(recordedVoucherSizes({ voucher_size_accepted: [2.5, -1] })).toEqual([]);
    expect(recordedVoucherSizes({})).toEqual([]);
  });
});

describe('poolRecencyAt - the window rule (IR8)', () => {
  it('last heard from, else created_at, never created_at for an import, null otherwise', () => {
    expect(poolRecencyAt(tenant('t1', { last_heard_from_at: daysAgo(4) }))).toBe(daysAgo(4));
    expect(poolRecencyAt(tenant('t1', { last_heard_from_at: undefined, created_at: daysAgo(12) }))).toBe(daysAgo(12));
    expect(poolRecencyAt(tenant('t1', { last_heard_from_at: 'not a date', created_at: daysAgo(12) }))).toBe(daysAgo(12));
    expect(
      poolRecencyAt(tenant('t1', { last_heard_from_at: undefined, created_at: daysAgo(12), imported_from: 'quo-airtable-import' })),
    ).toBeNull();
    expect(poolRecencyAt(tenant('t1', { last_heard_from_at: undefined, created_at: undefined }))).toBeNull();
  });
});

describe('anchor notes - for the banner, never a refusal (spec D1)', () => {
  it('a tenant anchor notes not searching and not sendable', () => {
    expect(tenantAnchorNotes(tenant('t1'))).toEqual([]);
    expect(tenantAnchorNotes(tenant('t1', { status: 'onboarding', sms_opt_out: true }))).toEqual(['not_searching', 'not_sendable']);
  });

  it('a property anchor notes not available', () => {
    expect(unitAnchorNotes({ status: 'available' })).toEqual([]);
    expect(unitAnchorNotes({ status: 'under_application' })).toEqual(['not_available']);
  });
});

describe('mapWithConcurrency - bounded reads', () => {
  it('keeps the input order and runs at most `limit` at once', async () => {
    let inFlight = 0;
    let most = 0;
    const out = await mapWithConcurrency([5, 1, 3, 2, 4], 2, async (n) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, n));
      inFlight -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(most).toBe(2);
  });

  it('an empty list does nothing', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
