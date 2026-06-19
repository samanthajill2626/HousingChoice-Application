import { describe, expect, it } from 'vitest';
import type { UnitItem } from '../../api/index.js';
import {
  buildListingFacts,
  formatBedsBaths,
  formatMoney,
  formatRent,
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
    expect(formatRent(1400, 1600)).toBe('$1,400–1,600');
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
      '2 BR · 1 BA · $1,400–1,600/mo · West End, Atlanta · Porter Properties',
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
