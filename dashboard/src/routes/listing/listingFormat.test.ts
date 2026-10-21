import { describe, expect, it } from 'vitest';
import type { ListingSendRow, UnitActivityEvent, UnitItem } from '../../api/index.js';
import {
  acceptedVoucherSizes,
  authoritiesOf,
  buildListingFacts,
  formatBedsBaths,
  formatMoney,
  formatRent,
  formatVoucherSizes,
  describeUnitActivity,
  groupSendRows,
  isMediaUrl,
  recordedVoucherSizes,
  sendRowKindLabel,
  shortAddress,
  statusLabel,
  washerDryerLabel,
} from './listingFormat.js';
import { WASHER_DRYER_LABELS } from './requirements.js';

describe('formatMoney', () => {
  it('formats whole dollars with separators', () => {
    expect(formatMoney(1550)).toBe('$1,550');
    expect(formatMoney(0)).toBe('$0');
  });
  it('returns "" for undefined', () => {
    expect(formatMoney(undefined)).toBe('');
  });
});

describe('formatRent', () => {
  it('renders a range when min != max', () => {
    expect(formatRent(1400, 1600)).toBe('$1,400-1,600');
  });
  it('renders a single value when only one side or equal', () => {
    expect(formatRent(1400, undefined)).toBe('$1,400');
    expect(formatRent(undefined, 1600)).toBe('$1,600');
    expect(formatRent(1500, 1500)).toBe('$1,500');
  });
  it('returns "" when neither set', () => {
    expect(formatRent(undefined, undefined)).toBe('');
  });
});

describe('formatBedsBaths', () => {
  it('joins beds / baths with em-dash for missing', () => {
    expect(formatBedsBaths(2, 1)).toBe('2 / 1');
    expect(formatBedsBaths(2, undefined)).toBe('2 / —');
  });
  it('returns "" when both absent', () => {
    expect(formatBedsBaths(undefined, undefined)).toBe('');
  });
});

describe('statusLabel', () => {
  it('uses the listing-status label map (multi-word statuses do not break)', () => {
    expect(statusLabel('available')).toBe('Available');
    expect(statusLabel('under_application')).toBe('Under application');
    expect(statusLabel('off_market')).toBe('Off market');
  });
  it('falls back to a naive capitalize for an unknown status', () => {
    expect(statusLabel('mystery')).toBe('Mystery');
  });
});

describe('authoritiesOf', () => {
  // Hand-mirror of app/src/lib/unitFields.ts authoritiesOf - these assertions are
  // the app suite's (app/test/unitFields.test.ts) restated on the dashboard copy,
  // because no cross-workspace import exists to guard the two mechanically.
  it('prefers the new list, synthesizes a legacy jurisdiction, else []', () => {
    expect(authoritiesOf({ accepted_authorities: ['DCA'], jurisdiction: 'old' })).toEqual(['DCA']);
    expect(authoritiesOf({ jurisdiction: 'atlanta_housing' })).toEqual(['atlanta_housing']);
    expect(authoritiesOf({})).toEqual([]);
  });
  it('a STORED empty list means "cleared" and still wins over the legacy value', () => {
    expect(authoritiesOf({ accepted_authorities: [], jurisdiction: 'legacy' })).toEqual([]);
  });
  it('keeps only string members; a malformed value falls back to the legacy string', () => {
    expect(authoritiesOf({ accepted_authorities: ['DCA', 7, null] })).toEqual(['DCA']);
    expect(authoritiesOf({ accepted_authorities: 'not-a-list', jurisdiction: 'j' })).toEqual(['j']);
    expect(authoritiesOf({ jurisdiction: '' })).toEqual([]);
  });
});

describe('acceptedVoucherSizes', () => {
  // THE one reader of "which voucher sizes does this property take" (Cameron,
  // 2026-10-04): the recorded `voucher_size_accepted` when there is one - a
  // LIST since tracker #12 (D4: the write API stores the sizes de-duplicated
  // and ascending), or a single number stored before it (still read, never
  // backfilled) - otherwise the bedroom count; nothing only when BOTH are
  // missing. The property page's "Voucher sizes accepted" row is NOT this
  // reader: it shows only what was recorded (recordedVoucherSizes, below).
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

describe('buildListingFacts', () => {
  it('joins present facts plus the landlord name last', () => {
    const u: UnitItem = {
      unitId: 'u1',
      landlordId: 'll1',
      status: 'available',
      beds: 2,
      baths: 1,
      rent_min: 1400,
      rent_max: 1600,
      area: 'West End',
      // Deliberately still stored: `jurisdiction` is an issuer name, so it no
      // longer joins the AREA phrase (spec section 8). `unit.area` alone carries
      // the area, and this fixture proves the legacy value is ignored here.
      jurisdiction: 'Atlanta',
    };
    expect(buildListingFacts(u, 'Porter Properties')).toBe(
      '2 BR - 1 BA - $1,400-1,600/mo - West End - Porter Properties',
    );
  });
  it('omits absent parts and the landlord when unknown', () => {
    const u: UnitItem = { unitId: 'u1', landlordId: 'll1', status: 'available', beds: 3 };
    expect(buildListingFacts(u)).toBe('3 BR');
  });
});

describe('isMediaUrl', () => {
  it('accepts http(s)/blob urls + root-relative paths', () => {
    expect(isMediaUrl('https://x/y.jpg')).toBe(true);
    expect(isMediaUrl('http://x/y.jpg')).toBe(true);
    expect(isMediaUrl('blob:https://x/abc')).toBe(true);
    expect(isMediaUrl('/media/y.jpg')).toBe(true);
  });
  it('rejects a bare S3 key and data: URIs (hardening)', () => {
    expect(isMediaUrl('units/u1/photo-1.jpg')).toBe(false);
    expect(isMediaUrl('data:image/png;base64,AAA')).toBe(false);
  });
});

describe('shortAddress', () => {
  it('formats an address, falling back to the unitId', () => {
    expect(shortAddress({ line1: '1450 Joseph Blvd NW' }, 'u1')).toBe('1450 Joseph Blvd NW');
    expect(shortAddress(undefined, 'u1')).toBe('u1');
  });
});

describe('describeUnitActivity', () => {
  const evt = (over: Partial<UnitActivityEvent>): UnitActivityEvent => ({
    id: '2026-07-01T09:00:00.000Z#000001',
    at: '2026-07-01T09:00:00.000Z',
    type: 'unit_created',
    ...over,
  });

  it('uses staff copy ("property") for the lifecycle events', () => {
    expect(describeUnitActivity(evt({ type: 'unit_created' }))).toEqual({ label: 'Property created' });
    expect(describeUnitActivity(evt({ type: 'unit_deleted' }))).toEqual({ label: 'Property deleted' });
    expect(describeUnitActivity(evt({ type: 'unit_restored' }))).toEqual({ label: 'Property restored' });
  });

  it('describes the send-outcome rows with the contact (name -> id) and links (spec 5.4)', () => {
    expect(describeUnitActivity(evt({ type: 'listing_declined', contactId: 'c1', contactName: 'Tia Moss' }))).toEqual({
      label: 'Tia Moss not interested',
      to: '/contacts/c1',
    });
    expect(describeUnitActivity(evt({ type: 'listing_decline_cleared', contactId: 'c1' }))).toEqual({
      label: 'c1 not interested cleared',
      to: '/contacts/c1',
    });
    // Interested links the tour it created.
    expect(describeUnitActivity(evt({ type: 'listing_interested', contactId: 'c1', contactName: 'Tia Moss', tourId: 't9' }))).toEqual({
      label: 'Tia Moss interested - tour requested',
      to: '/tours/t9',
    });
    // No tourId -> the contact link.
    expect(describeUnitActivity(evt({ type: 'listing_interested', contactId: 'c1' }))).toEqual({
      label: 'c1 interested - tour requested',
      to: '/contacts/c1',
    });
  });

  it('lists the humanized changed fields on an edit', () => {
    expect(describeUnitActivity(evt({ type: 'unit_updated', fields: ['rent_min', 'deposit'] }))).toEqual({
      label: 'Property updated',
      sub: 'Rent min, Deposit',
    });
    // No recorded fields → no sub-line (never an empty one).
    expect(describeUnitActivity(evt({ type: 'unit_updated' }))).toEqual({ label: 'Property updated' });
  });

  it('labels an Apply from the landlord (D13), keeping the field list', () => {
    expect(
      describeUnitActivity(
        evt({ type: 'unit_updated', reason: 'requirements_applied', fields: ['no_pets', 'pets', 'pet_fee'] }),
      ),
    ).toEqual({ label: 'Requirements applied from the landlord', sub: 'No pets, Pets, Pet fee' });
    expect(describeUnitActivity(evt({ type: 'unit_updated', reason: 'requirements_applied' }))).toEqual({
      label: 'Requirements applied from the landlord',
    });
    // Any other reason keeps the staff-edit label: only the one value is lifted.
    expect(describeUnitActivity(evt({ type: 'unit_updated', reason: 'something_else', fields: ['deposit'] }))).toEqual({
      label: 'Property updated',
      sub: 'Deposit',
    });
  });

  it('describes roster changes with name → id fallback, role label, and a contact link', () => {
    expect(
      describeUnitActivity(
        evt({ type: 'unit_contact_added', contactId: 'c1', contactName: 'Pat Manager', role: 'pm' }),
      ),
    ).toEqual({ label: 'Contact added', sub: 'Pat Manager - Property manager', to: '/contacts/c1' });
    // Unresolved contact → the id stands in; unknown role humanizes.
    expect(
      describeUnitActivity(evt({ type: 'unit_contact_added', contactId: 'c2', role: 'site_agent' })),
    ).toEqual({ label: 'Contact added', sub: 'c2 - Site agent', to: '/contacts/c2' });
    expect(
      describeUnitActivity(evt({ type: 'unit_contact_removed', contactId: 'c1', contactName: 'Pat Manager' })),
    ).toEqual({ label: 'Contact removed', sub: 'Pat Manager', to: '/contacts/c1' });
  });

  it('describes status changes via the property-status labels, flagging derived ones', () => {
    expect(
      describeUnitActivity(
        evt({ type: 'listing_status_changed', from: 'setup', to: 'available', source: 'manual' }),
      ),
    ).toEqual({ label: 'Status changed to Available', sub: 'from Setup' });
    expect(
      describeUnitActivity(
        evt({ type: 'listing_status_changed', from: 'available', to: 'under_application', source: 'derived' }),
      ),
    ).toEqual({ label: 'Status changed to Under application', sub: 'from Available - automatic' });
    // No from recorded → no sub-line.
    expect(
      describeUnitActivity(evt({ type: 'listing_status_changed', to: 'available' })),
    ).toEqual({ label: 'Status changed to Available' });
  });

  it('describes the organization-list rewrites with a from -> to line (spec 2026-10-06 D11)', () => {
    expect(
      describeUnitActivity(evt({ type: 'org_name_rewrite', from: 'AHA, DCA', to: 'Atlanta Housing Authority, DCA' })),
    ).toEqual({ label: 'Housing authority updated', sub: 'AHA, DCA -> Atlanta Housing Authority, DCA' });
    expect(
      describeUnitActivity(evt({ type: 'org_name_cleanup', from: 'atlanta_housing', to: 'Atlanta Housing Authority' })),
    ).toEqual({ label: 'Housing authority cleaned up', sub: 'atlanta_housing -> Atlanta Housing Authority' });
    // A removed value reads as none, never as an empty side.
    expect(describeUnitActivity(evt({ type: 'org_name_rewrite', from: 'Step Up', to: '' }))).toEqual({
      label: 'Housing authority updated',
      sub: 'Step Up -> (none)',
    });
    // No recorded values -> no sub-line.
    expect(describeUnitActivity(evt({ type: 'org_name_cleanup' }))).toEqual({ label: 'Housing authority cleaned up' });
  });

  it('describes broadcast_sent with a recipient count and a broadcast deep-link', () => {
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', broadcastId: 'b1', tenantCount: 5 }))).toEqual({
      label: 'Sent to 5 recipients',
      to: '/broadcasts/b1',
    });
  });

  it('pluralizes the recipient count (1 -> recipient) and omits the link when no broadcastId', () => {
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', tenantCount: 1 }))).toEqual({
      label: 'Sent to 1 recipient',
    });
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', tenantCount: 2 }))).toEqual({
      label: 'Sent to 2 recipients',
    });
  });

  // share-sent-outcome D5: the count is the share's REACHED recipients (the app
  // recounts at read time) - a share that reached nobody says so, and still
  // links to the share, whose page explains why.
  it('a share that reached nobody reads "No recipients reached" (an absent count too), linking to the share', () => {
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', broadcastId: 'b1', tenantCount: 0 }))).toEqual({
      label: 'No recipients reached',
      to: '/broadcasts/b1',
    });
    expect(describeUnitActivity(evt({ type: 'broadcast_sent' }))).toEqual({ label: 'No recipients reached' });
  });

  it('describes tour lifecycle rows with tour deep-links', () => {
    expect(describeUnitActivity(evt({ type: 'tour_scheduled', tourId: 't2' }))).toEqual({
      label: 'Tour scheduled',
      to: '/tours/t2',
    });
    expect(describeUnitActivity(evt({ type: 'tour_rescheduled', tourId: 't2' }))).toMatchObject({
      label: 'Tour rescheduled',
      to: '/tours/t2',
    });
    expect(describeUnitActivity(evt({ type: 'tour_took_place', tourId: 't2' }))).toMatchObject({ label: 'Tour took place' });
    expect(describeUnitActivity(evt({ type: 'tour_no_show', tourId: 't2' }))).toMatchObject({ label: 'Tour no-show' });
    expect(describeUnitActivity(evt({ type: 'tour_canceled', tourId: 't2' }))).toMatchObject({ label: 'Tour canceled' });
    expect(describeUnitActivity(evt({ type: 'tour_outcome', tourId: 't2' }))).toMatchObject({ label: 'Tour outcome' });
    // No tourId → no deep-link.
    expect(describeUnitActivity(evt({ type: 'tour_canceled' }))).toEqual({ label: 'Tour canceled' });
  });

  it('describes an automatic primary-contact pick with who, why, and a contact link (primary-contact-integrity spec 8)', () => {
    const assigned = (reason?: string) =>
      describeUnitActivity(
        evt({
          type: 'unit_primary_contact_assigned',
          contactId: 'c1',
          contactName: 'Mark Passmore',
          ...(reason !== undefined && { reason }),
        }),
      );
    expect(assigned('auto_on_add')).toEqual({
      label: 'Primary contact set automatically',
      sub: 'Mark Passmore - the property had no primary contact',
      to: '/contacts/c1',
    });
    expect(assigned('handoff_on_remove').sub).toBe('Mark Passmore - the previous primary contact was removed');
    expect(assigned('handoff_on_delete').sub).toBe('Mark Passmore - the previous primary contact was deleted');
    expect(assigned('handoff_on_restore').sub).toBe(
      "Mark Passmore - the property's landlord changed when it was restored",
    );
    expect(assigned('backfill').sub).toBe('Mark Passmore - set by a one-time data repair');
    // An unknown reason humanizes; no reason leaves just who.
    expect(assigned('manual_fix').sub).toBe('Mark Passmore - Manual fix');
    expect(assigned()).toEqual({
      label: 'Primary contact set automatically',
      sub: 'Mark Passmore',
      to: '/contacts/c1',
    });
    // An unresolved contact: the id stands in.
    expect(
      describeUnitActivity(evt({ type: 'unit_primary_contact_assigned', contactId: 'c2', reason: 'backfill' })),
    ).toEqual({
      label: 'Primary contact set automatically',
      sub: 'c2 - set by a one-time data repair',
      to: '/contacts/c2',
    });
  });

  it('describes the auto-close and reopen rows (spec 9.5) with their tour deep-links', () => {
    expect(describeUnitActivity(evt({ type: 'tour_auto_closed', tourId: 't3' }))).toEqual({
      label: 'Tour closed automatically: no outcome recorded after two weeks',
      to: '/tours/t3',
    });
    expect(describeUnitActivity(evt({ type: 'tour_reopened', tourId: 't3' }))).toEqual({
      label: 'Tour reopened',
      to: '/tours/t3',
    });
  });

  it('humanizes an unknown event type (open set — never a blank row)', () => {
    expect(describeUnitActivity(evt({ type: 'unit_frobnicated' }))).toEqual({ label: 'Unit frobnicated' });
  });
});


describe('sendRowKindLabel (caseworkers D20/D22)', () => {
  it('labels a resolved non-tenant row by displayKind: the role, else the type label', () => {
    expect(sendRowKindLabel({ type: 'partner', role: 'Caseworker' })).toBe('Caseworker');
    expect(sendRowKindLabel({ type: 'partner' })).toBe('Partner');
    expect(sendRowKindLabel({ type: 'partner', role: '   ' })).toBe('Partner');
    expect(sendRowKindLabel({ type: 'landlord' })).toBe('Landlord');
    expect(sendRowKindLabel({ type: 'team_member' })).toBe('Team');
    expect(sendRowKindLabel({ type: 'unknown' })).toBe('Unknown');
  });

  it('leaves a tenant row and an unresolved row (no type) unlabelled', () => {
    expect(sendRowKindLabel({ type: 'tenant' })).toBeUndefined();
    expect(sendRowKindLabel({ type: 'tenant', role: 'Case worker' })).toBeUndefined();
    expect(sendRowKindLabel({})).toBeUndefined();
  });
});

describe('groupSendRows - the four groups that cover every row (spec 5.5)', () => {
  const row = (contactId: string, sentAt: string, over: Partial<ListingSendRow>): ListingSendRow => ({
    contactId,
    unitId: 'u1',
    sentAt,
    via: 'broadcast',
    outcome: 'no_reply',
    interestedSupported: true,
    eligible: true,
    ...over,
  });

  it('Waiting (eligible, newest first), Interested, Not interested, Not eligible - always four, in order', () => {
    const rows = [
      row('ne-waiting', '2026-10-09T00:00:00.000Z', { eligible: false }),
      row('w-old', '2026-10-01T00:00:00.000Z', { outcome: 'replied' }),
      row('ni', '2026-10-08T00:00:00.000Z', { outcome: 'not_interested' }),
      row('missing-ni', '2026-10-10T00:00:00.000Z', { outcome: 'not_interested', recipientMissing: true, eligible: false }),
      row('int', '2026-10-02T00:00:00.000Z', { outcome: 'interested' }),
      row('w-new', '2026-10-05T00:00:00.000Z', {}),
    ];
    const groups = groupSendRows(rows);
    expect(groups.map((g) => [g.key, g.label, g.rows.map((r) => r.contactId)])).toEqual([
      ['waiting', 'Waiting', ['w-new', 'w-old']],
      ['interested', 'Interested', ['int']],
      ['not_interested', 'Not interested', ['ni']],
      ['not_eligible', 'Not eligible', ['missing-ni', 'ne-waiting']],
    ]);
    // A cover: every row exactly once.
    expect(groups.flatMap((g) => g.rows.map((r) => r.contactId)).sort()).toEqual(rows.map((r) => r.contactId).sort());
  });

  it('a row with no eligible flag is Not eligible (only the units route sets it); empty groups stay empty', () => {
    const groups = groupSendRows([row('a', '2026-10-01T00:00:00.000Z', { eligible: undefined })]);
    expect(groups.map((g) => g.rows.length)).toEqual([0, 0, 0, 1]);
  });
});

describe('recordedVoucherSizes + formatVoucherSizes (D4: the property page row)', () => {
  it('lists the RECORDED sizes ascending and de-duplicated - never the bedrooms fallback', () => {
    expect(recordedVoucherSizes({ voucher_size_accepted: [3, 0, 2, 3] })).toEqual([0, 2, 3]);
    // An older single stored number still reads (D4: not backfilled).
    expect(recordedVoucherSizes({ voucher_size_accepted: 2 })).toEqual([2]);
    // Variables, not literals, so the extra `beds` key is allowed: a property
    // with bedrooms but no recorded size records NOTHING here.
    const bedsOnly = { voucher_size_accepted: undefined, beds: 2 };
    expect(recordedVoucherSizes(bedsOnly)).toEqual([]);
    const emptyList = { voucher_size_accepted: [] as unknown[], beds: 3 };
    expect(recordedVoucherSizes(emptyList)).toEqual([]);
    expect(recordedVoucherSizes({ voucher_size_accepted: ['2', null, Number.NaN] })).toEqual([]);
  });

  it('formats Studio and "<n> BR", joined by ", "; nothing recorded is ""', () => {
    expect(formatVoucherSizes([0, 2, 3])).toBe('Studio, 2 BR, 3 BR');
    expect(formatVoucherSizes([4])).toBe('4 BR');
    expect(formatVoucherSizes([])).toBe('');
  });
});

describe('washerDryerLabel (D3)', () => {
  it('labels the three recorded values from the ONE label map, and nothing else', () => {
    expect(washerDryerLabel('hookups')).toBe('Hookups');
    expect(washerDryerLabel('included')).toBe('Washer and dryer included');
    expect(washerDryerLabel('none')).toBe('No hookups');
    // AR39: the labels are S5's map in requirements.ts, never a second copy.
    for (const value of ['hookups', 'included', 'none'] as const) {
      expect(washerDryerLabel(value)).toBe(WASHER_DRYER_LABELS[value]);
    }
    expect(washerDryerLabel(undefined)).toBeNull();
    expect(washerDryerLabel('')).toBeNull();
    expect(washerDryerLabel('stacked')).toBeNull();
  });
});
