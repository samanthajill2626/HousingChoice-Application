// resolveTemplate tests (Task 7) - the client-side mirror of the backend's
// renderBody (app/src/lib/mergeFields.ts) so the single-recipient editor can
// show EXACTLY what will send. Literal token replacement; unresolvable tokens
// (and a missing first name -> "there") never leak a raw id/phone.
import { describe, it, expect } from 'vitest';
import type { UnitItem } from '../../api/index.js';
import { resolveTemplateForTenant, DEFAULT_SEND_TEMPLATE } from './resolveTemplate.js';

/** A minimal, properly-typed UnitItem fixture (only unitId/landlordId/status are
 *  required; the rest feed the merge tokens under test). */
function makeUnit(over: Partial<UnitItem> = {}): UnitItem {
  return {
    unitId: 'u1',
    landlordId: 'll1',
    status: 'available',
    beds: 2,
    address: '44 Clifton Rd NE, Atlanta, GA 30307',
    rent_min: 1600,
    rent_max: 1600,
    ...over,
  };
}

describe('resolveTemplateForTenant', () => {
  it('resolves every token for a known tenant + unit + link', () => {
    const out = resolveTemplateForTenant(DEFAULT_SEND_TEMPLATE, makeUnit(), 'Brianna', 'https://x/p/u1');
    expect(out).toContain('Hi Brianna,');
    // [Beds] mirrors the backend: String(beds) -> "2" (so "a 2 home at ...").
    expect(out).toContain('a 2 home at');
    expect(out).toContain('44 Clifton Rd NE');
    // [Rent] mirrors mergeFields.formatRent: min===max -> "$1600" (no separator).
    expect(out).toContain('$1600/mo');
    expect(out).toContain('https://x/p/u1');
  });

  it('renders a rent range when min and max differ', () => {
    const out = resolveTemplateForTenant(
      DEFAULT_SEND_TEMPLATE,
      makeUnit({ rent_min: 1400, rent_max: 1600 }),
      'Sam',
      'https://x/p/u1',
    );
    expect(out).toContain('$1400-$1600/mo');
  });

  it('falls back to "there" with no first name and drops unit tokens with no unit', () => {
    const out = resolveTemplateForTenant(DEFAULT_SEND_TEMPLATE, null, undefined, undefined);
    expect(out).toContain('Hi there,');
    expect(out).not.toContain('[Beds]');
    expect(out).not.toContain('[Address]');
    expect(out).not.toContain('[Rent]');
    expect(out).not.toContain('[FlyerLink]');
  });

  it('formats a structured address object EXACTLY like the backend formatAddress', () => {
    const out = resolveTemplateForTenant(
      DEFAULT_SEND_TEMPLATE,
      makeUnit({ address: { line1: '1450 Joseph E. Boone Blvd NW', city: 'Atlanta', state: 'GA', zip: '30314' } }),
      'Tasha',
      'https://x/p/u1',
    );
    // Server parity (app/src/lib/address.ts formatAddress): "city, state zip" -
    // a SPACE between state and zip, not a comma.
    expect(out).toContain('1450 Joseph E. Boone Blvd NW, Atlanta, GA 30314');
  });

  it('joins line1 + line2 with a space, like the backend', () => {
    const out = resolveTemplateForTenant(
      DEFAULT_SEND_TEMPLATE,
      makeUnit({ address: { line1: '77 Peachtree St', line2: 'Apt 4', city: 'Atlanta' } }),
      'Tasha',
      'https://x/p/u1',
    );
    expect(out).toContain('77 Peachtree St Apt 4, Atlanta');
  });

  it('drops non-finite beds/rent like the backend (Number.isFinite guards)', () => {
    const out = resolveTemplateForTenant(
      DEFAULT_SEND_TEMPLATE,
      makeUnit({ beds: Number.NaN, rent_min: Number.POSITIVE_INFINITY, rent_max: Number.NaN }),
      'Tasha',
      'https://x/p/u1',
    );
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('Infinity');
  });
});
