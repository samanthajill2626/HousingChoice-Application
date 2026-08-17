// Unit test for the pure stale-container check in scripts/db.mjs.
// (The docker lifecycle itself is exercised by the boot verification gates.)
import { describe, expect, it } from 'vitest';
import { containerArgsAreStale, staleUptimeDays } from '../../scripts/db.mjs';

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

// The per-run teardowns reclaim tables for keys we still hold. They CANNOT
// reclaim the databases of deleted worktrees / abandoned lanes - DynamoDB Local
// exposes no way to enumerate or drop a database - so long uptime is the one
// accumulation only an operator can clear. This is the warning's trigger; it
// only ever warns, because restarting wipes every live lane.
const DAY = 86_400_000;

describe('staleUptimeDays', () => {
  it('stays quiet for a container younger than the threshold', () => {
    const now = Date.UTC(2026, 7, 16, 12, 0, 0);
    expect(staleUptimeDays(now - 2.9 * DAY, now)).toBeNull();
  });

  it('reports the age once the container is old enough to be worth flagging', () => {
    const now = Date.UTC(2026, 7, 16, 12, 0, 0);
    // The 8-day container behind the 2026-08-16 timeout wave.
    expect(staleUptimeDays(now - 8 * DAY, now)).toBeCloseTo(8, 5);
  });

  it('fires exactly AT the threshold, not just past it', () => {
    const now = Date.UTC(2026, 7, 16, 12, 0, 0);
    expect(staleUptimeDays(now - 3 * DAY, now)).toBeCloseTo(3, 5);
  });

  it('stays quiet when docker inspect gave us no start time', () => {
    expect(staleUptimeDays(null, Date.now())).toBeNull();
  });
});
