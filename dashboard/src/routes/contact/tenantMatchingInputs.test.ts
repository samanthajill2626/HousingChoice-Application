// WP1 B1 (spec 2026-10-26 D1, D2): the dashboard mirror's pure helpers -
// the record's display value ($1,200 / month), the edit form's values and
// its PATCH (trimmed, a clear is null, the server's copy on a bad value) -
// and SUGGESTION_TARGET_LABEL iterating the mirror.
import { describe, expect, it } from 'vitest';
import { SUGGESTION_TARGET_LABEL } from './suggestionTargets.js';
import {
  TENANT_MATCHING_INPUTS,
  buildTenantMatchingPatch,
  formatTenantMatchingValue,
  tenantMatchingFormValues,
} from './tenantMatchingInputs.js';

const DOLLARS = { kind: 'dollars' } as const;
const TEXT = { kind: 'text' } as const;
const PORTION_ERROR = 'Maximum tenant portion must be a whole dollar amount from 0 to 20000.';

describe('formatTenantMatchingValue', () => {
  it('shows a portion as $1,200 / month - a stored number or a digits-only suggestion', () => {
    expect(formatTenantMatchingValue(DOLLARS, 1200)).toBe('$1,200 / month');
    expect(formatTenantMatchingValue(DOLLARS, 0)).toBe('$0 / month');
    expect(formatTenantMatchingValue(DOLLARS, '1200')).toBe('$1,200 / month');
    expect(formatTenantMatchingValue(DOLLARS, ' 950 ')).toBe('$950 / month');
  });

  it('shows any other portion value raw (trimmed), and nothing for absent', () => {
    expect(formatTenantMatchingValue(DOLLARS, 'about 900')).toBe('about 900');
    expect(formatTenantMatchingValue(DOLLARS, undefined)).toBe('');
    expect(formatTenantMatchingValue(DOLLARS, 12.5)).toBe('');
  });

  it('shows text trimmed, and nothing for a non-string', () => {
    expect(formatTenantMatchingValue(TEXT, '  Decatur  ')).toBe('Decatur');
    expect(formatTenantMatchingValue(TEXT, 5)).toBe('');
    expect(formatTenantMatchingValue(TEXT, undefined)).toBe('');
  });
});

describe('tenantMatchingFormValues', () => {
  it('one string per entry: stored text as is, the portion as digits, absent as empty', () => {
    expect(tenantMatchingFormValues({ area_preference: 'Decatur', max_tenant_portion: 900 })).toEqual({
      area_preference: 'Decatur',
      max_tenant_portion: '900',
      accessibility_need: '',
      preferences_constraints: '',
    });
  });
});

describe('buildTenantMatchingPatch (the edit form, spec D2)', () => {
  const STORED = { area_preference: 'Decatur', max_tenant_portion: 900, accessibility_need: 'No stairs' };

  it('sends nothing for untouched values, or for a change only in surrounding spaces', () => {
    expect(buildTenantMatchingPatch(tenantMatchingFormValues(STORED), STORED)).toEqual({ ok: true, patch: {} });
    expect(
      buildTenantMatchingPatch({ ...tenantMatchingFormValues(STORED), area_preference: ' Decatur  ' }, STORED),
    ).toEqual({ ok: true, patch: {} });
  });

  it('sends changed values trimmed and the portion as a number; a cleared value is null', () => {
    expect(
      buildTenantMatchingPatch(
        {
          area_preference: '',
          max_tenant_portion: ' 1200 ',
          accessibility_need: 'No stairs',
          preferences_constraints: '  Needs a yard ',
        },
        STORED,
      ),
    ).toEqual({
      ok: true,
      patch: { area_preference: null, max_tenant_portion: 1200, preferences_constraints: 'Needs a yard' },
    });
    expect(buildTenantMatchingPatch({ max_tenant_portion: '' }, STORED)).toEqual({
      ok: true,
      patch: { max_tenant_portion: null, area_preference: null, accessibility_need: null },
    });
  });

  it("refuses a bad portion with the server's copy", () => {
    for (const bad of ['12.5', '-3', '20001', '1e3', 'abc']) {
      expect(buildTenantMatchingPatch({ max_tenant_portion: bad }, {}), bad).toEqual({
        ok: false,
        error: PORTION_ERROR,
      });
    }
  });

  // FW-11 (code review R1 CONF-1): a number input reports an entry it cannot
  // parse as '' (validity.badInput) - never read as a clear, stored or not.
  it("refuses an entry the control could not parse with the server's copy, never as a clear", () => {
    const unparseable = new Set(['max_tenant_portion']);
    for (const stored of [STORED, {}]) {
      expect(buildTenantMatchingPatch({ ...tenantMatchingFormValues(stored), max_tenant_portion: '' }, stored, unparseable)).toEqual({
        ok: false,
        error: PORTION_ERROR,
      });
    }
  });

  it("refuses text over 500 characters after the trim with the server's copy", () => {
    expect(buildTenantMatchingPatch({ preferences_constraints: 'x'.repeat(501) }, {})).toEqual({
      ok: false,
      error: 'Preferences and constraints must be 500 characters or fewer.',
    });
    expect(buildTenantMatchingPatch({ preferences_constraints: ` ${'x'.repeat(500)} ` }, {})).toEqual({
      ok: true,
      patch: { preferences_constraints: 'x'.repeat(500) },
    });
  });
});

describe('SUGGESTION_TARGET_LABEL iterates the mirror (spec D1)', () => {
  it("carries every input's chip label and keeps the existing targets", () => {
    for (const input of TENANT_MATCHING_INPUTS) {
      expect(SUGGESTION_TARGET_LABEL[input.key], input.key).toBe(input.chipLabel);
    }
    expect(SUGGESTION_TARGET_LABEL['status']).toBe('status');
    expect(SUGGESTION_TARGET_LABEL['pets']).toBe('pets');
    expect(SUGGESTION_TARGET_LABEL['address']).toBe('current address');
  });
});
