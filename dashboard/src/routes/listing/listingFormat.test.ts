import { describe, expect, it } from 'vitest';
import type { UnitActivityEvent, UnitItem } from '../../api/index.js';
import {
  buildListingFacts,
  formatBedsBaths,
  formatMoney,
  formatRent,
  describeUnitActivity,
  isMediaUrl,
  shortAddress,
  statusLabel,
} from './listingFormat.js';

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
      jurisdiction: 'Atlanta',
    };
    expect(buildListingFacts(u, 'Porter Properties')).toBe(
      '2 BR - 1 BA - $1,400-1,600/mo - West End, Atlanta - Porter Properties',
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

  it('lists the humanized changed fields on an edit', () => {
    expect(describeUnitActivity(evt({ type: 'unit_updated', fields: ['rent_min', 'deposit'] }))).toEqual({
      label: 'Property updated',
      sub: 'Rent min, Deposit',
    });
    // No recorded fields → no sub-line (never an empty one).
    expect(describeUnitActivity(evt({ type: 'unit_updated' }))).toEqual({ label: 'Property updated' });
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

  it('describes a tenant response with the response in the label', () => {
    expect(
      describeUnitActivity(
        evt({ type: 'listing_response_set', contactId: 'c1', contactName: 'Tina Renter', response: 'not_a_fit' }),
      ),
    ).toEqual({ label: 'Tenant response - Not a fit', sub: 'Tina Renter', to: '/contacts/c1' });
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

  it('describes broadcast_sent with a recipient count and a broadcast deep-link', () => {
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', broadcastId: 'b1', tenantCount: 5 }))).toEqual({
      label: 'Broadcast to 5 tenants',
      to: '/broadcasts/b1',
    });
  });

  it('pluralizes the recipient count (1 → tenant) and omits the link when no broadcastId', () => {
    expect(describeUnitActivity(evt({ type: 'broadcast_sent', tenantCount: 1 }))).toEqual({
      label: 'Broadcast to 1 tenant',
    });
    expect(describeUnitActivity(evt({ type: 'broadcast_sent' }))).toEqual({ label: 'Broadcast to 0 tenants' });
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

  it('humanizes an unknown event type (open set — never a blank row)', () => {
    expect(describeUnitActivity(evt({ type: 'unit_frobnicated' }))).toEqual({ label: 'Unit frobnicated' });
  });
});
