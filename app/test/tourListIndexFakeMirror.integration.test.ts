// Does the All-tab phase FAKE actually agree with DynamoDB?
//
// `app/test/helpers/tourListIndexFake.ts` is the ONE in-memory model of
// toursRepo.queryListPhase (spec docs/superpowers/specs/2026-10-06-tour-list-design.md
// 5.3-5.4). The harness fake and the paging engine's tests read through it, so
// the engine's fill, peek-row and phantom-page logic is calibrated against it;
// only this file can catch it drifting from the service (the lesson of
// unreadIndexFakeMirror.integration.test.ts, whose fake once modelled
// LastEvaluatedKey wrongly and every call-count assertion agreed with it).
//
// THE SHAPE. Every read below runs the SAME inputs through the real repo
// (against DynamoDB Local) and the fake, and requires the same answer: rows,
// order, scannedCount, and the presence AND value of lastEvaluatedKey. Where
// the two must differ, that is written down here as an explicit exception.
// The one known divergence - range-key TIES - never reaches the service here:
// the fixture has none, and the fake refuses a tied start key (last case
// before the key-position one).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { tourListKeyOf, type TourListPhase } from '../src/lib/tourListQuery.js';
import { createToursRepo, type CreateTourInput, type TourItem, type TourType } from '../src/repos/toursRepo.js';
import { createLogCapture } from './helpers/logCapture.js';
import { queryListPhaseFromItems } from './helpers/tourListIndexFake.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(`[tourListIndexFakeMirror] SKIPPED - no DynamoDB Local at ${endpoint}.`);
}

type ReadOpts = { limit: number; startKey?: Record<string, string>; forward: boolean };

/** What one read did, in a form both sides can be compared on. */
type Outcome =
  | { rejected: { name: string; message: string } }
  | { ids: string[]; scannedCount: number; lastEvaluatedKey?: Record<string, string> };

describe.skipIf(!reachable)('tourListIndexFake agrees with toursRepo.queryListPhase on DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-tourlistmirror-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const tours = createToursRepo({ doc, env: testEnv, logger });

  // Every instant a full toISOString() value (the repo stores scheduledAt raw);
  // no two rows share a scheduledAt or a createdAt.
  const at = (day: number): string => `2028-01-0${day}T10:00:00.000Z`;
  function tour(tourId: string, status: string, tourType: TourType, createdAt: string, scheduledAt?: string) {
    const input: CreateTourInput = {
      tourId,
      tenantId: `contact-${tourId}`,
      unitId: `unit-${tourId}`,
      tourType,
      status,
      createdAt,
      ...(scheduledAt !== undefined && { scheduledAt }),
    };
    return input;
  }
  const FIXTURE: CreateTourInput[] = [
    tour('tour-qlm-d1', 'scheduled', 'self_guided', '2027-12-01T09:00:00.000Z', at(1)),
    tour('tour-qlm-d2', 'toured', 'landlord_led', '2027-12-02T09:00:00.000Z', at(2)),
    tour('tour-qlm-d3', 'no_show', 'pm_team', '2027-12-03T09:00:00.000Z', at(3)),
    tour('tour-qlm-d4', 'canceled', 'self_guided', '2027-12-04T09:00:00.000Z', at(4)),
    tour('tour-qlm-d5', 'closed', 'landlord_led', '2027-12-05T09:00:00.000Z', at(5)),
    tour('tour-qlm-d6', 'scheduled', 'self_guided', '2027-12-06T09:00:00.000Z', at(6)),
    tour('tour-qlm-r1', 'requested', 'pm_team', '2027-12-07T09:00:00.000Z'),
    tour('tour-qlm-r2', 'requested', 'self_guided', '2027-12-08T09:00:00.000Z'),
    tour('tour-qlm-u3', 'toured', 'landlord_led', '2027-12-09T09:00:00.000Z'),
  ];
  const ALL: TourListPhase = { kind: 'd', range: { op: 'all' } };
  const REQUESTED: TourListPhase = { kind: 'u', index: 0, status: 'requested', notExists: false };
  const UNDATED_TOURED: TourListPhase = { kind: 'u', index: 1, status: 'toured', notExists: true };

  /** The rows exactly as stored - what the fake is given. */
  const stored = new Map<string, TourItem>();
  function row(tourId: string): TourItem {
    const item = stored.get(tourId);
    if (item === undefined) throw new Error(`no stored row ${tourId}`);
    return item;
  }
  const ids = (items: TourItem[]): string[] => items.map((t) => t.tourId);

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('tours'), tableName('tours', testEnv));
    for (const input of FIXTURE) {
      const item = await tours.create(input);
      stored.set(item.tourId, item);
    }
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, tableName('tours', testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  async function realOutcome(phase: TourListPhase, opts: ReadOpts): Promise<Outcome> {
    try {
      const page = await tours.queryListPhase(phase, opts);
      return {
        ids: ids(page.items),
        scannedCount: page.scannedCount,
        ...(page.lastEvaluatedKey !== undefined && { lastEvaluatedKey: page.lastEvaluatedKey }),
      };
    } catch (err) {
      const e = err as Error;
      return { rejected: { name: e.name, message: e.message } };
    }
  }

  function fakeOutcome(phase: TourListPhase, opts: ReadOpts): Outcome {
    try {
      const page = queryListPhaseFromItems([...stored.values()], phase, opts);
      return {
        ids: ids(page.items),
        scannedCount: page.scannedCount,
        ...(page.lastEvaluatedKey !== undefined && { lastEvaluatedKey: page.lastEvaluatedKey }),
      };
    } catch (err) {
      const e = err as Error;
      return { rejected: { name: e.name, message: e.message } };
    }
  }

  /** One read through both sides; they must agree on everything. Returns the real page. */
  async function bothAgree(phase: TourListPhase, opts: ReadOpts, label: string) {
    const real = await tours.queryListPhase(phase, opts);
    const fake = queryListPhaseFromItems([...stored.values()], phase, opts);
    expect(ids(fake.items), `${label}: ids`).toEqual(ids(real.items));
    expect(fake.items, `${label}: whole rows`).toEqual(real.items);
    expect(fake.scannedCount, `${label}: scannedCount`).toBe(real.scannedCount);
    expect(fake.lastEvaluatedKey, `${label}: lastEvaluatedKey`).toStrictEqual(real.lastEvaluatedKey);
    return real;
  }

  /**
   * Walk a phase to its end through both sides, resuming from every returned
   * lastEvaluatedKey; then resume once from the key of every row the walk
   * returned (a key built from an ITEM, the engine's "page full" path).
   */
  async function walkBoth(phase: TourListPhase, limit: number, forward: boolean, label: string): Promise<string[]> {
    const seen: TourItem[] = [];
    let startKey: Record<string, string> | undefined;
    for (let page = 0; page < 20; page++) {
      const real = await bothAgree(phase, { limit, forward, ...(startKey !== undefined && { startKey }) }, `${label} page ${page}`);
      seen.push(...real.items);
      if (real.lastEvaluatedKey === undefined) {
        for (const item of seen) {
          await bothAgree(phase, { limit, forward, startKey: tourListKeyOf(item, phase) }, `${label} after ${item.tourId}`);
        }
        return ids(seen);
      }
      startKey = real.lastEvaluatedKey;
    }
    throw new Error(`${label}: the walk did not end`);
  }

  const DATED = ['tour-qlm-d1', 'tour-qlm-d2', 'tour-qlm-d3', 'tour-qlm-d4', 'tour-qlm-d5', 'tour-qlm-d6'];

  it('D over the whole partition, both directions, limits 1, 2, 3 and 100', async () => {
    for (const limit of [1, 2, 3, 100]) {
      expect(await walkBoth(ALL, limit, true, `D all up limit ${limit}`)).toEqual(DATED);
      expect(await walkBoth(ALL, limit, false, `D all down limit ${limit}`)).toEqual([...DATED].reverse());
    }
  });

  it('D with a status filter at limit 2 (filtered pages, some empty, still carry a key)', async () => {
    const phase: TourListPhase = { kind: 'd', range: { op: 'all' }, statusFilter: ['toured', 'closed'] };
    expect(await walkBoth(phase, 2, true, 'D status up')).toEqual(['tour-qlm-d2', 'tour-qlm-d5']);
    expect(await walkBoth(phase, 2, false, 'D status down')).toEqual(['tour-qlm-d5', 'tour-qlm-d2']);
  });

  it('D with a key range and a type filter at limit 2', async () => {
    const phase: TourListPhase = { kind: 'd', range: { op: 'gte', value: at(2) }, type: 'self_guided' };
    expect(await walkBoth(phase, 2, true, 'D gte+type up')).toEqual(['tour-qlm-d4', 'tour-qlm-d6']);
    expect(await walkBoth(phase, 2, false, 'D gte+type down')).toEqual(['tour-qlm-d6', 'tour-qlm-d4']);
  });

  it('U toured with notExists at limit 1, and U requested (unfiltered) at limit 1', async () => {
    expect(await walkBoth(UNDATED_TOURED, 1, true, 'U toured up')).toEqual(['tour-qlm-u3']);
    expect(await walkBoth(UNDATED_TOURED, 1, false, 'U toured down')).toEqual(['tour-qlm-u3']);
    expect(await walkBoth(REQUESTED, 1, true, 'U requested up')).toEqual(['tour-qlm-r1', 'tour-qlm-r2']);
    expect(await walkBoth(REQUESTED, 1, false, 'U requested down')).toEqual(['tour-qlm-r2', 'tour-qlm-r1']);
  });

  // DynamoDB Local's wording, not the "outside query boundaries" text the plan
  // quoted for AWS. Nothing keys on the text - the route matches the NAME.
  const OUT_OF_BOUNDS = {
    rejected: { name: 'ValidationException', message: 'The provided starting key does not match the range key predicate' },
  };

  it('OUT-OF-BOUNDS: a start key outside the key range is REJECTED by both, as a ValidationException', async () => {
    // A gte bound above the 2nd ascending dated row, resumed from that row's key.
    const above: TourListPhase = { kind: 'd', range: { op: 'gte', value: '2028-01-02T12:00:00.000Z' } };
    const opts: ReadOpts = { limit: 100, forward: true, startKey: tourListKeyOf(row('tour-qlm-d2'), above) };
    const real = await realOutcome(above, opts);
    expect(real).toStrictEqual(OUT_OF_BOUNDS);
    expect(fakeOutcome(above, opts)).toStrictEqual(real);
  });

  it('OUT-OF-BOUNDS: every shape - each range op, both directions, a wrong partition, a wrong status', async () => {
    const gte: TourListPhase = { kind: 'd', range: { op: 'gte', value: '2028-01-02T12:00:00.000Z' } };
    const lt: TourListPhase = { kind: 'd', range: { op: 'lt', value: at(4) } };
    const lte: TourListPhase = { kind: 'd', range: { op: 'lte', value: at(4) } };
    const between: TourListPhase = { kind: 'd', range: { op: 'between', from: at(2), to: at(4) } };
    const shapes: Array<[string, TourListPhase, Record<string, string>]> = [
      ['gte, key below', gte, tourListKeyOf(row('tour-qlm-d2'), gte)],
      ['lt, key above', lt, tourListKeyOf(row('tour-qlm-d5'), lt)],
      ['lt, key AT the exclusive bound', lt, tourListKeyOf(row('tour-qlm-d4'), lt)],
      ['lte, key above', lte, tourListKeyOf(row('tour-qlm-d5'), lte)],
      ['between, key below', between, tourListKeyOf(row('tour-qlm-d1'), between)],
      ['between, key above', between, tourListKeyOf(row('tour-qlm-d6'), between)],
      ['all, another partition', ALL, { ...tourListKeyOf(row('tour-qlm-d3'), ALL), _schedPartition: 'other' }],
      ['U requested, a toured key', REQUESTED, tourListKeyOf(row('tour-qlm-u3'), UNDATED_TOURED)],
    ];
    for (const [label, phase, startKey] of shapes) {
      for (const forward of [true, false]) {
        const opts: ReadOpts = { limit: 100, forward, startKey };
        const real = await realOutcome(phase, opts);
        expect(real, `${label} forward=${forward}: real`).toStrictEqual(OUT_OF_BOUNDS);
        expect(fakeOutcome(phase, opts), `${label} forward=${forward}: fake`).toStrictEqual(real);
      }
    }
  });

  it('TIE GUARD: the fake refuses a start key inside a createdAt tie with a PLAIN Error (fake only)', () => {
    const base = row('tour-qlm-r1');
    const tied: TourItem[] = [
      { ...base, tourId: 'tour-tie-a', createdAt: '2027-12-20T09:00:00.000Z' },
      { ...base, tourId: 'tour-tie-b', createdAt: '2027-12-20T09:00:00.000Z' },
    ];
    const first = tied[0];
    if (first === undefined) throw new Error('expected a tied row');
    const opts: ReadOpts = { limit: 10, forward: true, startKey: tourListKeyOf(first, REQUESTED) };

    let caught: unknown;
    try {
      queryListPhaseFromItems(tied, REQUESTED, opts);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // Never ValidationException-named: a route test must see a 500, not a 400 'invalid cursor'.
    expect((caught as Error).name).toBe('Error');
    expect((caught as Error).message).toContain('range-key TIE');

    // The explicit opt-in (a cursor-MECHANISM test) resumes by tourId.
    const page = queryListPhaseFromItems(tied, REQUESTED, { ...opts, allowTieResume: true });
    expect(ids(page.items)).toEqual(['tour-tie-b']);
  });

  // RUNS LAST: it moves a row.
  it('KEY POSITION: a resume key whose row has moved resumes by key position, not by finding the row', async () => {
    const original = tourListKeyOf(row('tour-qlm-d2'), ALL);
    const moved = await tours.patch('tour-qlm-d2', { scheduledAt: '2028-02-01T10:00:00.000Z' });
    stored.set(moved.tourId, moved);

    const real = await bothAgree(ALL, { limit: 100, forward: true, startKey: original }, 'key position');
    expect(ids(real.items)).toEqual(['tour-qlm-d3', 'tour-qlm-d4', 'tour-qlm-d5', 'tour-qlm-d6', 'tour-qlm-d2']);
  });
});
