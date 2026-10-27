// WP1 B1 (spec 2026-10-26 D1, D2; plan PR8, WI11, WI13): the ONE list of the
// tenant matching inputs and its staff value parser. Pure - no I/O. The
// dashboard mirror's drift test
// (dashboard/src/routes/contact/tenantMatchingInputsMirror.test.ts) compares
// the mirror against this module.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TENANT_MATCHING_DOLLARS_MAX,
  TENANT_MATCHING_INPUTS,
  TENANT_MATCHING_TEXT_MAX,
  parseTenantMatchingInputs,
  tenantMatchingDollarsInvalid,
  tenantMatchingNotText,
  tenantMatchingTextTooLong,
} from '../src/lib/tenantMatchingInputs.js';

// path.dirname(fileURLToPath(...)), never new URL(...).pathname (a leading
// slash on win32) - the idiom every source-reading test here uses.
const SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'lib',
  'tenantMatchingInputs.ts',
);

/** Labels a tenant's edit dialog and Eligibility intake card already carry,
 *  which e2e and component tests select WITHOUT exact matching
 *  (e2e/scenarios/steps.ts:841, :930-934, :1184; contact-detail.spec.ts:63;
 *  ContactEditForm.test.tsx /role/i, /Phone/i, /Voucher size/i). */
const EXISTING_LABELS = [
  'Pets',
  'Evictions',
  'Time at current address',
  'LIF eligible',
  'Voucher expires',
  'Voucher size',
  'Notes',
  'Street address',
  'City',
  'Status',
  'Phone',
  'Role',
  'First name',
  'Last name',
];

/** The chip nouns already in SUGGESTION_TARGET_LABEL
 *  (dashboard/src/routes/contact/suggestionTargets.ts:9-22); a chip group is
 *  found by `AI suggestion for <noun>`, and Playwright's name match is a
 *  substring match. */
const EXISTING_CHIP_LABELS = [
  'first name',
  'last name',
  'voucher size',
  'housing authority',
  'pets',
  'evictions',
  'time at current address',
  'porting',
  'status',
  'phone',
  'type',
  'current address',
];

function neitherContains(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return !x.includes(y) && !y.includes(x);
}

describe('TENANT_MATCHING_INPUTS - the one list (spec D1)', () => {
  it('holds the four inputs in the D1 order with their labels, chip labels, kinds, controls and sources', () => {
    expect(
      TENANT_MATCHING_INPUTS.map((i) => [i.key, i.label, i.chipLabel, i.kind, i.control, i.source]),
    ).toEqual([
      ['area_preference', 'Area preference', 'area preference', 'text', 'input', 'field'],
      ['max_tenant_portion', 'Maximum tenant portion', 'maximum tenant portion', 'dollars', 'dollars', 'field'],
      ['accessibility_need', 'Accessibility need', 'accessibility need', 'text', 'input', 'field'],
      ['preferences_constraints', 'Preferences and constraints', 'preferences and constraints', 'text', 'textarea', 'field'],
    ]);
  });

  it('every entry carries one line of ASCII prompt guidance (spec D3)', () => {
    for (const input of TENANT_MATCHING_INPUTS) {
      expect(input.promptGuidance.trim().length, input.key).toBeGreaterThan(20);
      expect(input.promptGuidance, input.key).not.toMatch(/[\r\n]/);
      expect(input.promptGuidance, input.key).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('caps text at 500 characters and the portion at 20000 dollars (spec D2)', () => {
    expect(TENANT_MATCHING_TEXT_MAX).toBe(500);
    expect(TENANT_MATCHING_DOLLARS_MAX).toBe(20000);
  });

  it('labels and chip labels are distinct and never contain, or sit inside, an existing one (WI11)', () => {
    const labels = TENANT_MATCHING_INPUTS.map((i) => i.label);
    const chips = TENANT_MATCHING_INPUTS.map((i) => i.chipLabel);
    for (const label of labels) {
      for (const other of [...EXISTING_LABELS, ...labels.filter((l) => l !== label)]) {
        expect(neitherContains(label, other), `${label} vs ${other}`).toBe(true);
      }
    }
    for (const chip of chips) {
      for (const other of [...EXISTING_CHIP_LABELS, ...chips.filter((c) => c !== chip)]) {
        expect(neitherContains(chip, other), `${chip} vs ${other}`).toBe(true);
      }
    }
  });

  it('is a leaf: the module imports nothing (spec D1; WI13)', () => {
    const source = readFileSync(SOURCE, 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\(|\brequire\(/);
  });
});

describe('parseTenantMatchingInputs - the staff value rule (spec D2)', () => {
  it('trims text and returns only the keys present', () => {
    expect(parseTenantMatchingInputs({ area_preference: '  Decatur or Tucker  ', firstName: 'Pat' })).toEqual({
      ok: true,
      fields: { area_preference: 'Decatur or Tucker' },
    });
    expect(parseTenantMatchingInputs({})).toEqual({ ok: true, fields: {} });
    expect(parseTenantMatchingInputs({ area_preference: undefined })).toEqual({ ok: true, fields: {} });
  });

  it("'' (after the trim) or null CLEARS a text input - null, never a stored ''", () => {
    expect(
      parseTenantMatchingInputs({ accessibility_need: '', preferences_constraints: '   ', area_preference: null }),
    ).toEqual({
      ok: true,
      fields: { accessibility_need: null, preferences_constraints: null, area_preference: null },
    });
  });

  it('allows 500 characters after the trim and refuses 501 with the spec copy', () => {
    const atCap = 'x'.repeat(TENANT_MATCHING_TEXT_MAX);
    expect(parseTenantMatchingInputs({ preferences_constraints: `  ${atCap}  ` })).toEqual({
      ok: true,
      fields: { preferences_constraints: atCap },
    });
    expect(parseTenantMatchingInputs({ preferences_constraints: `${atCap}y` })).toEqual({
      ok: false,
      error: 'Preferences and constraints must be 500 characters or fewer.',
    });
  });

  it('refuses a text value that is not a string', () => {
    for (const bad of [5, true, {}, []]) {
      expect(parseTenantMatchingInputs({ area_preference: bad }), JSON.stringify(bad)).toEqual({
        ok: false,
        error: 'Area preference must be a string.',
      });
    }
  });

  it('stores a whole-dollar portion 0..20000; null and empty clear it', () => {
    for (const ok of [0, 1200, 20000]) {
      expect(parseTenantMatchingInputs({ max_tenant_portion: ok })).toEqual({
        ok: true,
        fields: { max_tenant_portion: ok },
      });
    }
    for (const clear of [null, '']) {
      expect(parseTenantMatchingInputs({ max_tenant_portion: clear })).toEqual({
        ok: true,
        fields: { max_tenant_portion: null },
      });
    }
  });

  it('refuses any other portion with the spec copy (never rounded, never parsed from a string)', () => {
    for (const bad of [20001, -1, 1200.5, '1200', '$1,200', ' ', true, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseTenantMatchingInputs({ max_tenant_portion: bad }), String(bad)).toEqual({
        ok: false,
        error: 'Maximum tenant portion must be a whole dollar amount from 0 to 20000.',
      });
    }
  });

  it('the copy helpers say exactly what spec D2 says', () => {
    expect(tenantMatchingTextTooLong('Area preference')).toBe('Area preference must be 500 characters or fewer.');
    expect(tenantMatchingDollarsInvalid('Maximum tenant portion')).toBe(
      'Maximum tenant portion must be a whole dollar amount from 0 to 20000.',
    );
    expect(tenantMatchingNotText('Accessibility need')).toBe('Accessibility need must be a string.');
  });
});
