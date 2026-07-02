// Unit test for the pure stale-container check in scripts/db.mjs.
// (The docker lifecycle itself is exercised by the boot verification gates.)
import { describe, expect, it } from 'vitest';
import { containerArgsAreStale } from '../../scripts/db.mjs';

describe('containerArgsAreStale', () => {
  it('flags the legacy -sharedDb container for recreation', () => {
    expect(containerArgsAreStale(['-jar', 'DynamoDBLocal.jar', '-sharedDb', '-inMemory'])).toBe(true);
  });

  it('accepts the new per-key container args', () => {
    expect(containerArgsAreStale(['-jar', 'DynamoDBLocal.jar', '-inMemory'])).toBe(false);
  });

  it('tolerates empty/unknown args (docker inspect edge cases)', () => {
    expect(containerArgsAreStale([])).toBe(false);
  });
});
