// WP1 B2a spec D8 (plan WI10): no seed writes a match row. The lean world's
// legacy row (fit_score / rank / status - a shape no reader understands) is
// removed with no replacement: its pair is in no pool, and a seeded match
// could be neither byte-stable nor current. e2e specs build their own ranking
// fixtures through the API.
import { describe, expect, it } from 'vitest';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import { SEED } from '../src/lib/seedData.js';

describe('no seed writes a match row (WP1 B2a spec D8)', () => {
  it('the lean world carries no matches table at all', () => {
    expect(Object.keys(SEED)).not.toContain('matches');
  });

  it('the full profile adds none either (cast and matrix)', () => {
    expect(Object.keys(castItems())).not.toContain('matches');
    expect(Object.keys(matrixItems(new Date('2026-10-28T12:00:00.000Z')))).not.toContain('matches');
  });
});
