// WP1 B1 (spec 2026-10-26 D6; plan PR3): no seed carries a Priority value -
// the switch defaults to off, and a seeded true would change the full world
// for no test. Lean and full alike.
import { describe, expect, it } from 'vitest';
import { SEED } from '../src/lib/seed/lean.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import { buildLiveStaticItems } from '../src/lib/seed/live.js';

type Row = Record<string, unknown>;
type Tables = Readonly<Record<string, readonly Row[]>>;

const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');
const FULL: readonly Tables[] = [SEED, castItems(), matrixItems(FIXED_NOW), buildLiveStaticItems(FIXED_NOW)];

describe('no seeded property holds priority (PR3)', () => {
  it('(PIN) lean and full', () => {
    const units = FULL.flatMap((tables) => [...(tables['units'] ?? [])]);
    expect(units.length).toBeGreaterThan(0);
    expect(units.filter((unit) => 'priority' in unit).map((unit) => unit['unitId'])).toEqual([]);
  });
});
