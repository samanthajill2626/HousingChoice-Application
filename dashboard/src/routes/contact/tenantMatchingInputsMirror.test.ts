// Cross-workspace tenant-matching-inputs MIRROR DRIFT GUARD (WP1 B1 spec
// 2026-10-26 D1; plan PR8).
//
// routes/contact/tenantMatchingInputs.ts HAND-COPIES
// app/src/lib/tenantMatchingInputs.ts minus promptGuidance and source (the
// dashboard is a separate package and cannot import app code at runtime).
// The mechanism is requirementsMirror.test.ts's: import both and compare.
// The app module is a LEAF (it imports nothing), so the dashboard typecheck
// compiles it alone. Import nothing else from app/ here. When this fails, the
// APP module is the source of truth: change the mirror, never the app.
import { describe, expect, it } from 'vitest';
import * as app from '../../../../app/src/lib/tenantMatchingInputs.js';
import * as mirror from './tenantMatchingInputs.js';

const MIRRORED = ['key', 'label', 'chipLabel', 'kind', 'control', 'completeness'] as const;

function mirrored(entry: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(MIRRORED.map((field) => [field, entry[field]]));
}

describe('dashboard tenant matching inputs mirror app/src/lib/tenantMatchingInputs.ts', () => {
  it('carries the same entries - key, label, chipLabel, kind, control, completeness - in the same order', () => {
    expect(mirror.TENANT_MATCHING_INPUTS.map(mirrored)).toEqual(app.TENANT_MATCHING_INPUTS.map(mirrored));
    expect(mirror.TENANT_MATCHING_INPUTS.length).toBeGreaterThan(0);
  });

  it('carries nothing else: no promptGuidance, no source (PR8)', () => {
    for (const entry of mirror.TENANT_MATCHING_INPUTS) {
      expect(Object.keys(entry).sort()).toEqual([...MIRRORED].sort());
    }
  });

  it('the caps are identical', () => {
    expect(mirror.TENANT_MATCHING_TEXT_MAX).toBe(app.TENANT_MATCHING_TEXT_MAX);
    expect(mirror.TENANT_MATCHING_DOLLARS_MAX).toBe(app.TENANT_MATCHING_DOLLARS_MAX);
  });

  it("the client's error copy is the server's, for every entry (spec D2)", () => {
    for (const input of app.TENANT_MATCHING_INPUTS) {
      expect(mirror.tenantMatchingTextTooLong(input.label)).toBe(app.tenantMatchingTextTooLong(input.label));
      expect(mirror.tenantMatchingDollarsInvalid(input.label)).toBe(app.tenantMatchingDollarsInvalid(input.label));
    }
  });

  it('every patch the edit form builds is one the server stores unchanged', () => {
    const stored = { area_preference: 'Decatur', max_tenant_portion: 900 };
    const typed: Record<string, string>[] = [
      { area_preference: '  Tucker  ', max_tenant_portion: '0' },
      { area_preference: '', max_tenant_portion: '20000', accessibility_need: ' No stairs ' },
      { max_tenant_portion: '', preferences_constraints: 'x'.repeat(500) },
      { max_tenant_portion: '1200', preferences_constraints: 'Needs a yard\nNo apartments' },
    ];
    for (const values of typed) {
      const built = mirror.buildTenantMatchingPatch(values, stored);
      if (!built.ok) throw new Error(`the client refused ${JSON.stringify(values)}: ${built.error}`);
      expect(app.parseTenantMatchingInputs(built.patch), JSON.stringify(values)).toEqual({
        ok: true,
        fields: built.patch,
      });
    }
  });
});
