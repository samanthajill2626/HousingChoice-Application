// Merge-field rendering (M1.8a) — the pure share-broadcast template helper.
// Asserts every token renders, the unit context is derived correctly, and a
// missing first name falls back to a neutral label (NEVER a phone).
import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_TENANT_NAME,
  buildUnitMergeContext,
  flyerUrl,
  formatRent,
  renderBody,
} from '../src/lib/mergeFields.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';

const BASE = 'https://dxxxx.cloudfront.example';

function unit(overrides: Partial<UnitItem> = {}): UnitItem {
  return {
    unitId: 'unit-7',
    landlordId: 'c-landlord',
    status: 'available',
    beds: 2,
    rent_min: 1200,
    rent_max: 1500,
    address: { line1: '123 Main St', city: 'Springfield', state: 'IL', zip: '60000' },
    ...overrides,
  };
}

describe('mergeFields (M1.8a)', () => {
  it('flyerUrl builds ${PUBLIC_BASE_URL}/p/${unitId}, trimming a trailing slash', () => {
    expect(flyerUrl(BASE, 'unit-7')).toBe(`${BASE}/p/unit-7`);
    expect(flyerUrl(`${BASE}/`, 'unit-7')).toBe(`${BASE}/p/unit-7`);
    expect(flyerUrl(undefined, 'unit-7')).toBe('/p/unit-7');
  });

  it('formatRent renders a range, a single value, or empty', () => {
    expect(formatRent(unit({ rent_min: 1200, rent_max: 1500 }))).toBe('$1200–$1500');
    expect(formatRent(unit({ rent_min: 1200, rent_max: 1200 }))).toBe('$1200');
    expect(formatRent(unit({ rent_min: 1200, rent_max: undefined }))).toBe('$1200');
    expect(formatRent(unit({ rent_min: undefined, rent_max: undefined }))).toBe('');
  });

  it('renders every token from the unit context + per-recipient name', () => {
    const ctx = buildUnitMergeContext(unit(), BASE);
    const out = renderBody(
      'Hi [TenantName]! A [Beds]bd at [Address] for [Rent]. See [FlyerLink]',
      ctx,
      'Maria',
    );
    expect(out).toBe(
      `Hi Maria! A 2bd at 123 Main St, Springfield, IL 60000 for $1200–$1500. See ${BASE}/p/unit-7`,
    );
  });

  it('a missing firstName renders the neutral fallback — NEVER a phone', () => {
    const ctx = buildUnitMergeContext(unit(), BASE);
    const out = renderBody('Hi [TenantName], check this out', ctx, undefined);
    expect(out).toBe(`Hi ${NEUTRAL_TENANT_NAME}, check this out`);
    expect(out).not.toMatch(/\+?\d{7,}/); // no phone-looking digits
  });

  it('a whitespace-only firstName falls back too', () => {
    const ctx = buildUnitMergeContext(unit(), BASE);
    expect(renderBody('[TenantName]', ctx, '   ')).toBe(NEUTRAL_TENANT_NAME);
  });

  it('a unit-less broadcast renders the unit tokens empty (no flyer link)', () => {
    const ctx = buildUnitMergeContext(undefined, BASE);
    expect(renderBody('[Beds]/[Address]/[Rent]/[FlyerLink]', ctx, 'Sam')).toBe('///');
  });

  it('repeats a token everywhere it appears', () => {
    const ctx = buildUnitMergeContext(unit(), BASE);
    expect(renderBody('[TenantName] [TenantName]', ctx, 'Lee')).toBe('Lee Lee');
  });
});
