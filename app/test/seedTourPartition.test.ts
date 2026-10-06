// Seed tour partition pin (tour list S2; spec 3.6, P10, invariant I2): EVERY
// seeded tour row carries `_schedPartition: 'tours'`, exactly as the repo's
// create stamps it on every tour, dated or not.
//
// Why it matters: the byScheduledAt GSI (hash _schedPartition, range
// scheduledAt) indexes a row only when it has BOTH. Seeds are raw puts, so
// nothing adds the partition for them, and PATCH - the writer that ADDS a date
// when a request is booked - never writes it. A seeded request without the
// partition, once booked, would be missing from every date read (the Tours
// tabs, Today, the All tab's dated phase). A requested tour stays off the index
// by having no scheduledAt, never by lacking the partition.
//
// Pure, across the pure seed builders (lean SEED, castItems, matrixItems). The
// live builder is not exported, so seedLive.test.ts pins its rows as it reads
// them back from DynamoDB Local.
import { describe, expect, it } from 'vitest';
import { SEED } from '../src/lib/seed/lean.js';
import { castItems } from '../src/lib/seed/cast.js';
import { matrixItems } from '../src/lib/seed/matrix.js';

// matrixItems is now-relative; any fixed instant makes it deterministic.
const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');

type Row = Record<string, unknown>;

const PROFILES: Record<string, Record<string, Row[]>> = {
  lean: SEED,
  cast: castItems(),
  matrix: matrixItems(FIXED_NOW),
};

describe('seed tours carry the date-index partition', () => {
  it("every seeded tour row has _schedPartition === 'tours'", () => {
    const unstamped: string[] = [];
    let seen = 0;
    for (const [profile, tables] of Object.entries(PROFILES)) {
      for (const tour of tables['tours'] ?? []) {
        seen += 1;
        if (tour['_schedPartition'] !== 'tours') unstamped.push(`${profile}:${String(tour['tourId'])}`);
      }
    }
    // Not vacuous: the cast and matrix profiles seed tours (lean seeds none).
    expect(seen).toBeGreaterThan(0);
    expect(unstamped, 'seeded tours without the byScheduledAt partition').toEqual([]);
  });
});
