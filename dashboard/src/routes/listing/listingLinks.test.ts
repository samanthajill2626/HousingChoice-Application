import { describe, expect, it } from 'vitest';
import { flyerPath } from './listingLinks.js';

describe('flyerPath', () => {
  it('builds the public flyer route', () => {
    expect(flyerPath('u1')).toBe('/public/units/u1/flyer');
  });
  it('encodes the unit id', () => {
    expect(flyerPath('a/b c')).toBe('/public/units/a%2Fb%20c/flyer');
  });
});
