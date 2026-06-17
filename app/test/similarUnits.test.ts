// BE5/C6 unit tests — the PURE ranking fn rankSimilarUnits(target, candidates).
// Determinism (same inputs → same order + matchPct), exclusion of self +
// non-available, beds/area/rent/programs scoring, top-N cap, stable tie-break.
import { describe, expect, it } from 'vitest';
import { rankSimilarUnits } from '../src/lib/similarUnits.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';

function unit(unitId: string, overrides: Partial<UnitItem> = {}): UnitItem {
  return {
    unitId,
    landlordId: 'L',
    status: 'available',
    ...overrides,
  };
}

const target = unit('target', {
  beds: 2,
  baths: 1,
  area: 'North',
  subzone: 'North-A',
  payment_standard: 1500,
  accepted_programs: ['HCV', 'VASH'],
});

describe('rankSimilarUnits (BE5/C6)', () => {
  it('excludes the target itself', () => {
    const out = rankSimilarUnits(target, [target, unit('other', { beds: 2 })]);
    expect(out.map((u) => u.unitId)).not.toContain('target');
  });

  it('excludes non-available candidates (defensive)', () => {
    const out = rankSimilarUnits(target, [
      unit('placed', { status: 'placed', beds: 2, area: 'North', subzone: 'North-A' }),
      unit('inactive', { status: 'inactive', beds: 2 }),
      unit('avail', { status: 'available', beds: 2 }),
    ]);
    expect(out.map((u) => u.unitId)).toEqual(['avail']);
  });

  it('a unit matching ALL dimensions outranks one matching few', () => {
    const all = unit('all', {
      beds: 2,
      area: 'North',
      subzone: 'North-A',
      payment_standard: 1500,
      accepted_programs: ['HCV', 'VASH'],
    });
    // `few` matches only ONE dimension (off-by-one beds → 0.5) so it scores
    // >0% (still rankable after the 0%-drop) but far below `all`.
    const few = unit('few', {
      beds: 3,
      area: 'South',
      subzone: 'South-Z',
      payment_standard: 3000,
      accepted_programs: ['OTHER'],
    });
    const out = rankSimilarUnits(target, [few, all]);
    expect(out[0]!.unitId).toBe('all');
    expect(out[0]!.matchPct).toBeGreaterThan(out[1]!.matchPct);
    // A perfect match across all weighted dims is 100%.
    expect(out[0]!.matchPct).toBe(100);
  });

  it('off-by-one beds scores between an exact and a far match', () => {
    // Give all three a shared `area` (a non-zero baseline) so the far-beds one
    // still scores >0% (rankable after the 0%-drop); the BEDS contribution is
    // the only thing that varies, so it drives the ordering.
    const exact = unit('beds-exact', { beds: 2, area: 'North' });
    const off = unit('beds-off', { beds: 3, area: 'North' });
    const far = unit('beds-far', { beds: 6, area: 'North' });
    const bare = unit('beds-bare', { beds: 2 }); // for reference
    void bare;
    const out = rankSimilarUnits(target, [far, off, exact]);
    const pct = Object.fromEntries(out.map((u) => [u.unitId, u.matchPct]));
    expect(pct['beds-exact']!).toBeGreaterThan(pct['beds-off']!);
    expect(pct['beds-off']!).toBeGreaterThan(pct['beds-far']!);
  });

  it('same subzone outranks same area (different subzone) outranks neither', () => {
    const sub = unit('sub', { beds: 2, area: 'North', subzone: 'North-A' });
    const areaOnly = unit('area', { beds: 2, area: 'North', subzone: 'North-B' });
    const neither = unit('neither', { beds: 2, area: 'South', subzone: 'South-Z' });
    const out = rankSimilarUnits(target, [neither, areaOnly, sub]);
    expect(out.map((u) => u.unitId)).toEqual(['sub', 'area', 'neither']);
  });

  it('rent proximity: within ~10% scores higher than far-off rent', () => {
    const near = unit('rent-near', { beds: 2, payment_standard: 1550 }); // ~3%
    const far = unit('rent-far', { beds: 2, payment_standard: 2400 }); // ~60%
    const out = rankSimilarUnits(target, [far, near]);
    const pct = Object.fromEntries(out.map((u) => [u.unitId, u.matchPct]));
    expect(pct['rent-near']!).toBeGreaterThan(pct['rent-far']!);
  });

  it('rent band uses the midpoint of rent_min..rent_max when payment_standard is absent', () => {
    const near = unit('rent-mid', { beds: 2, rent_min: 1400, rent_max: 1600 }); // mid 1500 == target
    const far = unit('rent-mid-far', { beds: 2, rent_min: 2800, rent_max: 3200 }); // mid 3000
    const out = rankSimilarUnits(target, [far, near]);
    const pct = Object.fromEntries(out.map((u) => [u.unitId, u.matchPct]));
    expect(pct['rent-mid']!).toBeGreaterThan(pct['rent-mid-far']!);
  });

  it('accepted_programs uses Jaccard overlap', () => {
    const full = unit('prog-full', { beds: 2, accepted_programs: ['HCV', 'VASH'] }); // 1.0
    const half = unit('prog-half', { beds: 2, accepted_programs: ['HCV', 'OTHER'] }); // 1/3
    const none = unit('prog-none', { beds: 2, accepted_programs: ['X', 'Y'] }); // 0
    const out = rankSimilarUnits(target, [none, half, full]);
    expect(out.map((u) => u.unitId)).toEqual(['prog-full', 'prog-half', 'prog-none']);
  });

  it('caps to top N (default 5) and respects opts.limit', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      unit(`u-${i}`, { beds: 2, area: 'North', subzone: 'North-A' }),
    );
    expect(rankSimilarUnits(target, candidates)).toHaveLength(5);
    expect(rankSimilarUnits(target, candidates, { limit: 3 })).toHaveLength(3);
  });

  it('is deterministic: same inputs → same order + matchPct (stable tie-break by unitId asc)', () => {
    // Two equally-scoring candidates → tie-break by unitId ascending.
    const a = unit('z-unit', { beds: 2, area: 'North', subzone: 'North-A' });
    const b = unit('a-unit', { beds: 2, area: 'North', subzone: 'North-A' });
    const run1 = rankSimilarUnits(target, [a, b]);
    const run2 = rankSimilarUnits(target, [b, a]);
    expect(run1).toEqual(run2);
    // Equal score → ascending unitId.
    expect(run1.map((u) => u.unitId)).toEqual(['a-unit', 'z-unit']);
    expect(run1[0]!.matchPct).toBe(run1[1]!.matchPct);
  });

  it('tie-break gives a TOTAL order: N≥4 equal-matchPct candidates sort identically regardless of input order', () => {
    // Several candidates that ALL score identically (same beds/area/subzone) —
    // a coincidental 2-element stability wouldn't prove the unitId tie-break is
    // a total order, so use 4+ and shuffle the input across two runs.
    const ids = ['m', 'b', 'q', 'a', 'z'];
    const make = () =>
      ids.map((id) => unit(id, { beds: 2, area: 'North', subzone: 'North-A' }));
    const run1 = rankSimilarUnits(target, make(), { limit: 10 });
    // A different input order (reversed) must yield the IDENTICAL output order.
    const run2 = rankSimilarUnits(target, [...make()].reverse(), { limit: 10 });
    expect(run1).toEqual(run2);
    // All equal matchPct → fully ascending unitId order (a total order).
    expect(run1.map((u) => u.matchPct).every((p) => p === run1[0]!.matchPct)).toBe(true);
    expect(run1.map((u) => u.unitId)).toEqual([...ids].sort());
  });

  it('drops 0%-match candidates (no empty-summary noise card)', () => {
    // Shares NO scored dimension with the target: beds far off (≥2), different
    // area/subzone, far rent, disjoint programs → final matchPct 0 → excluded.
    const zero = unit('zero-match', {
      beds: 9,
      area: 'South',
      subzone: 'South-Z',
      payment_standard: 9000,
      accepted_programs: ['NONE'],
    });
    const real = unit('real-match', { beds: 2, area: 'North', subzone: 'North-A' });
    const out = rankSimilarUnits(target, [zero, real]);
    const ids = out.map((u) => u.unitId);
    expect(ids).not.toContain('zero-match'); // 0% is not "similar"
    expect(ids).toContain('real-match');
  });

  it('every returned summary is non-empty across a mixed candidate set', () => {
    const out = rankSimilarUnits(
      target,
      [
        unit('full', {
          beds: 2,
          area: 'North',
          subzone: 'North-A',
          payment_standard: 1500,
          accepted_programs: ['HCV', 'VASH'],
        }),
        unit('beds-only', { beds: 2 }), // no area/rent/programs scored, but beds led
        unit('off-beds', { beds: 3 }), // off-by-one beds only
        unit('area-only', { beds: 2, area: 'North', subzone: 'North-B' }),
      ],
      { limit: 10 },
    );
    expect(out.length).toBeGreaterThan(0);
    for (const item of out) {
      expect(typeof item.summary).toBe('string');
      expect(item.summary.length).toBeGreaterThan(0);
    }
  });

  it('builds a deterministic, human summary from the high-scoring dimensions', () => {
    const out = rankSimilarUnits(target, [
      unit('s', {
        beds: 2,
        area: 'North',
        subzone: 'North-A',
        payment_standard: 1500,
        accepted_programs: ['HCV', 'VASH'],
      }),
    ]);
    expect(out[0]!.summary).toContain('2 bed');
    expect(typeof out[0]!.summary).toBe('string');
    expect(out[0]!.summary.length).toBeGreaterThan(0);
  });

  it('projects the SimilarUnit wire shape (unitId, address, status, matchPct, summary)', () => {
    const out = rankSimilarUnits(target, [
      unit('shape', { beds: 2, address: { line1: '1 Main St', city: 'Town' } }),
    ]);
    const item = out[0]!;
    expect(item.unitId).toBe('shape');
    expect(item.address).toEqual({ line1: '1 Main St', city: 'Town' });
    expect(item.status).toBe('available');
    expect(typeof item.matchPct).toBe('number');
    expect(typeof item.summary).toBe('string');
  });
});
