import { describe, expect, it } from 'vitest';
import { flyerPath } from './listingLinks.js';

describe('flyerPath', () => {
  it('builds the public flyer PAGE path (bare = the public form variant)', () => {
    expect(flyerPath('u1')).toBe('/p/u1');
  });
  it('URL-encodes the unitId', () => {
    expect(flyerPath('a/b c')).toBe('/p/a%2Fb%20c');
  });
});
