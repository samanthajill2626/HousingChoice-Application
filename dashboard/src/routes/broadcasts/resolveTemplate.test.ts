// resolveTemplate tests (Task 7) - the client-side mirror of the backend's
// renderBody (app/src/lib/mergeFields.ts) so the composer can show EXACTLY
// what will send. Literal token replacement of the unit-derived tokens;
// [TenantName] stays a token for the backend (the dashboard no longer resolves
// it - share-skip-fix D8 moved the one-recipient editor to a template with no
// name); unresolvable tokens never leak a raw id/phone.
import { describe, it, expect } from 'vitest';
import type { UnitItem } from '../../api/index.js';
import {
  resolveTemplateForUnit,
  DEFAULT_SEND_TEMPLATE,
  ONE_TO_ONE_SEND_TEMPLATE,
} from './resolveTemplate.js';

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

describe('resolveTemplateForUnit', () => {
  it('resolves the unit tokens + flyer but PRESERVES [TenantName] for per-recipient rendering', () => {
    const out = resolveTemplateForUnit(DEFAULT_SEND_TEMPLATE, makeUnit(), 'https://x/p/u1');
    expect(out).toContain('Hi [TenantName],');
    expect(out).toContain('a 2-bedroom home at');
    expect(out).toContain('44 Clifton Rd NE');
    expect(out).toContain('$1600/mo');
    expect(out).toContain('https://x/p/u1');
    expect(out).not.toContain('[Beds]');
    expect(out).not.toContain('[FlyerLink]');
  });
});

describe('resolveTemplateForUnit - backend parity of the unit tokens', () => {
  it('renders a rent range when min and max differ', () => {
    const out = resolveTemplateForUnit(
      DEFAULT_SEND_TEMPLATE,
      makeUnit({ rent_min: 1400, rent_max: 1600 }),
      'https://x/p/u1',
    );
    expect(out).toContain('$1400-$1600/mo');
  });

  it('drops the unit tokens with no unit and keeps [TenantName] for the backend', () => {
    const out = resolveTemplateForUnit(DEFAULT_SEND_TEMPLATE, null, undefined);
    expect(out).toContain('Hi [TenantName],');
    expect(out).not.toContain('[Beds]');
    expect(out).not.toContain('[Address]');
    expect(out).not.toContain('[Rent]');
    expect(out).not.toContain('[FlyerLink]');
  });

  it('formats a structured address object EXACTLY like the backend formatAddress', () => {
    const out = resolveTemplateForUnit(
      DEFAULT_SEND_TEMPLATE,
      makeUnit({ address: { line1: '1450 Joseph E. Boone Blvd NW', city: 'Atlanta', state: 'GA', zip: '30314' } }),
      'https://x/p/u1',
    );
    // Server parity (app/src/lib/address.ts formatAddress): "city, state zip" -
    // a SPACE between state and zip, not a comma.
    expect(out).toContain('1450 Joseph E. Boone Blvd NW, Atlanta, GA 30314');
  });

  it('joins line1 + line2 with a space, like the backend', () => {
    const out = resolveTemplateForUnit(
      DEFAULT_SEND_TEMPLATE,
      makeUnit({ address: { line1: '77 Peachtree St', line2: 'Apt 4', city: 'Atlanta' } }),
      'https://x/p/u1',
    );
    expect(out).toContain('77 Peachtree St Apt 4, Atlanta');
  });

  it('drops non-finite beds/rent like the backend (Number.isFinite guards)', () => {
    const out = resolveTemplateForUnit(
      DEFAULT_SEND_TEMPLATE,
      makeUnit({ beds: Number.NaN, rent_min: Number.POSITIVE_INFINITY, rent_max: Number.NaN }),
      'https://x/p/u1',
    );
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('Infinity');
  });
});

describe('ONE_TO_ONE_SEND_TEMPLATE (share-skip-fix D8)', () => {
  it('is the one-line address, ONE space, the flyer link - nothing else', () => {
    expect(ONE_TO_ONE_SEND_TEMPLATE).toBe('[Address] [FlyerLink]');
    expect(resolveTemplateForUnit(ONE_TO_ONE_SEND_TEMPLATE, makeUnit(), 'https://x/p/u1?cta=text')).toBe(
      '44 Clifton Rd NE, Atlanta, GA 30307 https://x/p/u1?cta=text',
    );
    // A structured address renders the server's one-line form.
    expect(
      resolveTemplateForUnit(
        ONE_TO_ONE_SEND_TEMPLATE,
        makeUnit({ address: { line1: '77 Peachtree St', line2: 'Apt 4', city: 'Atlanta', state: 'GA', zip: '30303' } }),
        'https://x/p/u1?cta=text',
      ),
    ).toBe('77 Peachtree St Apt 4, Atlanta, GA 30303 https://x/p/u1?cta=text');
  });

  it('the blast template is unchanged', () => {
    expect(DEFAULT_SEND_TEMPLATE).toBe(
      'Hi [TenantName], a [Beds]-bedroom home at [Address] is available for [Rent]/mo. Details: [FlyerLink]',
    );
  });
});
