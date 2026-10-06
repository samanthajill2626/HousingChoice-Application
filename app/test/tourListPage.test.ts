// Unit tests for services/tourListPage.ts - the All tab's paging loop (spec
// docs/superpowers/specs/2026-10-06-tour-list-design.md section 5.4): the call
// budget, the peek row, the stop rules and the cursor each stop leaves.
//
// The engine is driven through the ONE shared phase model
// (helpers/tourListIndexFake.ts), which tourListIndexFakeMirror.integration.test.ts
// pins to DynamoDB Local: Limit counts EVALUATED rows BEFORE the filter, and a
// lastEvaluatedKey comes back whenever a read stopped AT its Limit - even when
// nothing follows - and never when the key range ran out first. Pure - no I/O.
//
// Fixtures: `_schedPartition: 'tours'` on every row, every instant a full
// toISOString() value, and NO two rows share a scheduledAt or a createdAt (the
// fake refuses a resume inside a range-key tie, where DynamoDB's order is
// opaque).
import { describe, expect, it } from 'vitest';
import {
  decodeTourListCursor,
  encodeTourListCursor,
  locateTourListCursor,
  planTourListPhases,
  tourListFingerprint,
  tourListKeyOf,
  U_ORDER,
  type TourListCursor,
  type TourListFilters,
  type TourListPhase,
} from '../src/lib/tourListQuery.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import {
  listTourPage,
  MAX_QUERY_CALLS,
  QUERY_PAGE_LIMIT,
  type QueryListPhase,
  type TourListPageResult,
} from '../src/services/tourListPage.js';
import { queryListPhaseFromItems } from './helpers/tourListIndexFake.js';

const PINNED = '2026-10-06T16:00:00.000Z';
const HOUR = 3_600_000;
/** `h` hours after (negative: before) the pinned instant, canonical ISO. */
const at = (h: number): string => new Date(Date.parse(PINNED) + h * HOUR).toISOString();
let createdSeq = 0;
/** A createdAt no other row in this file holds (one minute apart, canonical). */
const nextCreatedAt = (): string => new Date(Date.UTC(2026, 0, 1) + ++createdSeq * 60_000).toISOString();

function tour(tourId: string, status: string, scheduledAt?: string): TourItem {
  const createdAt = nextCreatedAt();
  return {
    tourId,
    tenantId: `contact-${tourId}`,
    unitId: `unit-${tourId}`,
    _schedPartition: 'tours',
    tourType: 'self_guided',
    status,
    createdAt,
    updatedAt: createdAt,
    ...(scheduledAt !== undefined && { scheduledAt }),
  };
}

/** Every call the engine made: { kind, index, limit, startKey, forward }. */
interface RecordedCall {
  kind: 'd' | 'u';
  index?: number;
  limit: number;
  startKey?: Record<string, string>;
  forward: boolean;
}

function recorder(rows: readonly TourItem[]): { query: QueryListPhase; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const query: QueryListPhase = async (phase, opts) => {
    calls.push({
      kind: phase.kind,
      ...(phase.kind === 'u' && { index: phase.index }),
      limit: opts.limit,
      ...(opts.startKey !== undefined && { startKey: opts.startKey }),
      forward: opts.forward,
    });
    return queryListPhaseFromItems(rows, phase, opts);
  };
  return { query, calls };
}

interface ListContext {
  filters: TourListFilters;
  phases: TourListPhase[];
  fingerprint: string;
  pinnedNow: string;
}

/** The phases and fingerprint exactly as the route builds them (S4). */
function listOf(filters: TourListFilters, pinnedNow = PINNED): ListContext {
  return { filters, phases: planTourListPhases(filters, pinnedNow), fingerprint: tourListFingerprint(filters), pinnedNow };
}

function phaseAt(list: ListContext, index: number): TourListPhase {
  const phase = list.phases[index];
  if (phase === undefined) throw new Error(`no phase ${index}`);
  return phase;
}

function rowOf(rows: readonly TourItem[], tourId: string): TourItem {
  const row = rows.find((t) => t.tourId === tourId);
  if (row === undefined) throw new Error(`no fixture row ${tourId}`);
  return row;
}

const dCursor = (list: ListContext, k: Record<string, string>): TourListCursor => ({
  v: 1,
  f: list.fingerprint,
  n: list.pinnedNow,
  ph: 'd',
  k,
});
const uCursor = (list: ListContext, i: number, k?: Record<string, string>): TourListCursor => ({
  v: 1,
  f: list.fingerprint,
  n: list.pinnedNow,
  ph: 'u',
  i,
  ...(k !== undefined && { k }),
});

const ids = (items: TourItem[]): string[] => items.map((t) => t.tourId);
const TINY = { queryPageLimit: 3, maxQueryCalls: 3 };
const EVERY_LATEST: TourListFilters = { when: 'any', statuses: [], sort: 'latest' };
const PAST: TourListFilters = { when: 'past', statuses: [], sort: 'latest' };

type Budget = { queryPageLimit?: number; maxQueryCalls?: number };
type Start = { phaseIndex: number; startKey?: Record<string, string> };

/** One page. Case 12 rides on EVERY page of every case: a d cursor carries k. */
async function page(
  query: QueryListPhase,
  list: ListContext,
  limit: number,
  start?: Start,
  budget: Budget = TINY,
): Promise<TourListPageResult> {
  const result = await listTourPage(query, { ...list, limit, ...(start !== undefined && { start }) }, budget);
  if (result.nextCursor?.ph === 'd') expect(result.nextCursor.k, 'a d cursor without k').toBeDefined();
  return result;
}

/** Where a cursor resumes - through its WIRE form, as the route reads it. */
function resume(cursor: TourListCursor | null, list: ListContext): Start {
  if (cursor === null) throw new Error('expected a cursor');
  const decoded = decodeTourListCursor(encodeTourListCursor(cursor));
  if (decoded === undefined) throw new Error(`cursor does not survive its wire form: ${JSON.stringify(cursor)}`);
  const start = locateTourListCursor(decoded, list.phases);
  if (start === undefined) throw new Error(`cursor does not fit its own plan: ${JSON.stringify(cursor)}`);
  return start;
}

/** Follow nextCursor to null; every page kept. */
async function walk(
  query: QueryListPhase,
  list: ListContext,
  limit: number,
  budget: Budget = TINY,
): Promise<TourListPageResult[]> {
  const pages: TourListPageResult[] = [];
  let start: Start | undefined;
  for (let i = 0; i < 200; i++) {
    const result = await page(query, list, limit, start, budget);
    pages.push(result);
    if (result.nextCursor === null) return pages;
    start = resume(result.nextCursor, list);
  }
  throw new Error('the walk did not end within 200 pages');
}

describe('listTourPage - the All tab paging loop', () => {
  it('1: unfiltered D asks for the rows needed + 1 peek, resumes after the last row SENT, and the peek ends the list with no phantom', async () => {
    // Latest first: p5 (newest) .. p1.
    const rows = [
      tour('tour-p1', 'toured', at(-50)),
      tour('tour-p2', 'no_show', at(-40)),
      tour('tour-p3', 'canceled', at(-30)),
      tour('tour-p4', 'closed', at(-20)),
      tour('tour-p5', 'scheduled', at(-10)),
    ];
    const { query, calls } = recorder(rows);
    const list = listOf(PAST);
    const d = phaseAt(list, 0);
    expect(list.phases).toHaveLength(1);

    const first = await page(query, list, 2);
    expect(ids(first.items)).toEqual(['tour-p5', 'tour-p4']);
    expect(first.nextCursor).toStrictEqual(dCursor(list, tourListKeyOf(rowOf(rows, 'tour-p4'), d)));
    expect(calls).toStrictEqual([{ kind: 'd', limit: 3, forward: false }]);
    expect(first.evaluated).toBe(3);

    const second = await page(query, list, 2, resume(first.nextCursor, list));
    expect(ids(second.items)).toEqual(['tour-p3', 'tour-p2']);
    expect(second.nextCursor).toStrictEqual(dCursor(list, tourListKeyOf(rowOf(rows, 'tour-p2'), d)));
    expect(calls[1]).toStrictEqual({
      kind: 'd',
      limit: 3,
      startKey: tourListKeyOf(rowOf(rows, 'tour-p4'), d),
      forward: false,
    });

    const third = await page(query, list, 2, resume(second.nextCursor, list));
    expect(ids(third.items)).toEqual(['tour-p1']);
    expect(third.nextCursor).toBeNull();
    expect(calls).toHaveLength(3);
    expect(third.calls).toBe(1);
  });

  it('2: exactly `limit` rows left in an unfiltered final phase -> both rows and nextCursor null', async () => {
    const rows = [tour('tour-e1', 'toured', at(-20)), tour('tour-e2', 'toured', at(-10))];
    const { query, calls } = recorder(rows);
    const result = await page(query, listOf(PAST), 2);
    expect(ids(result.items)).toEqual(['tour-e2', 'tour-e1']);
    expect(result.nextCursor).toBeNull();
    expect(calls).toStrictEqual([{ kind: 'd', limit: 3, forward: false }]);
    expect(result).toMatchObject({ calls: 1, evaluated: 2, phasesTouched: 1 });
  });

  it('3: filtered D spends the budget, returns both sparse matches, and leaves the accepted filtered phantom', async () => {
    // Latest first, positions 1..9; the no-shows sit at positions 2 and 8.
    const statusAt = (pos: number): string => (pos === 2 || pos === 8 ? 'no_show' : pos % 2 === 0 ? 'canceled' : 'toured');
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((pos) => tour(`tour-f${pos}`, statusAt(pos), at(-pos)));
    const { query, calls } = recorder(rows);
    const list = listOf({ when: 'past', statuses: ['no_show'], sort: 'latest' });
    const d = phaseAt(list, 0);
    const key = (pos: number) => tourListKeyOf(rowOf(rows, `tour-f${pos}`), d);

    const first = await page(query, list, 2);
    expect(ids(first.items)).toEqual(['tour-f2', 'tour-f8']);
    expect(calls).toStrictEqual([
      { kind: 'd', limit: 3, forward: false },
      { kind: 'd', limit: 3, startKey: key(3), forward: false },
      { kind: 'd', limit: 3, startKey: key(6), forward: false },
    ]);
    // Call 3 evaluated exactly its Limit, so it returned a key - the cursor.
    expect(first.nextCursor).toStrictEqual(dCursor(list, key(9)));
    expect(first).toMatchObject({ calls: 3, evaluated: 9, phasesTouched: 1 });

    const phantom = await page(query, list, 2, resume(first.nextCursor, list));
    expect(phantom.items).toEqual([]);
    expect(phantom.nextCursor).toBeNull();
    expect(calls[3]).toStrictEqual({ kind: 'd', limit: 3, startKey: key(9), forward: false });
  });

  it('4: the budget spent with ZERO rows -> an empty page whose d cursor is the 3rd call key', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => tour(`tour-z${i + 1}`, 'toured', at(-(i + 1))));
    const { query, calls } = recorder(rows);
    const list = listOf({ when: 'past', statuses: ['canceled'], sort: 'latest' });
    const result = await page(query, list, 2);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toStrictEqual(dCursor(list, tourListKeyOf(rowOf(rows, 'tour-z9'), phaseAt(list, 0))));
    expect(result).toMatchObject({ calls: 3, evaluated: 9, phasesTouched: 1 });
    expect(calls).toHaveLength(3);
  });

  it('5: D -> U inside one page: the dated tour, then the requests, and a u cursor at the last request sent', async () => {
    const rows = [
      tour('tour-r1', 'requested'),
      tour('tour-r2', 'requested'),
      tour('tour-r3', 'requested'),
      tour('tour-d1', 'scheduled', at(24)),
    ];
    const { query, calls } = recorder(rows);
    const list = listOf(EVERY_LATEST);
    const requested = phaseAt(list, 1);
    expect(requested).toMatchObject({ kind: 'u', index: 0, status: 'requested' });

    const first = await page(query, list, 3);
    expect(ids(first.items)).toEqual(['tour-d1', 'tour-r3', 'tour-r2']);
    expect(first.nextCursor).toStrictEqual(uCursor(list, 0, tourListKeyOf(rowOf(rows, 'tour-r2'), requested)));
    expect(calls).toStrictEqual([
      { kind: 'd', limit: 4, forward: false },
      { kind: 'u', index: 0, limit: 3, forward: false },
    ]);
    expect(first.phasesTouched).toBe(2);

    const second = await page(query, list, 3, resume(first.nextCursor, list));
    expect(ids(second.items)).toEqual(['tour-r1']);
  });

  it('6: the budget spent EXACTLY on the call that exhausts D, U remaining -> { ph: u, i: 0 } WITHOUT k; U then starts at its beginning', async () => {
    const rows = [tour('tour-b1', 'scheduled', at(5)), tour('tour-b2', 'requested'), tour('tour-b3', 'requested')];
    const { query, calls } = recorder(rows);
    const list = listOf(EVERY_LATEST);
    const one = { queryPageLimit: 3, maxQueryCalls: 1 };

    const first = await page(query, list, 2, undefined, one);
    expect(ids(first.items)).toEqual(['tour-b1']);
    expect(first.nextCursor).toStrictEqual(uCursor(list, 0));
    expect(first.nextCursor).not.toHaveProperty('k');

    const start = resume(first.nextCursor, list);
    expect(start).toStrictEqual({ phaseIndex: 1 });
    const second = await page(query, list, 2, start, one);
    expect(ids(second.items)).toEqual(['tour-b3', 'tour-b2']);
    expect(calls[1]).toStrictEqual({ kind: 'u', index: 0, limit: 3, forward: false });
    expect(calls[1]?.startKey).toBeUndefined();
  });

  it('7: the same at a U status boundary - requested exhausted on the last budget call -> { ph: u, i: 1 } without k', async () => {
    const rows = [
      tour('tour-s1', 'scheduled', at(5)),
      tour('tour-s2', 'requested'),
      tour('tour-s3', 'toured'),
    ];
    const { query, calls } = recorder(rows);
    const list = listOf(EVERY_LATEST);
    const two = { queryPageLimit: 3, maxQueryCalls: 2 };

    const first = await page(query, list, 5, undefined, two);
    expect(ids(first.items)).toEqual(['tour-s1', 'tour-s2']);
    expect(first.nextCursor).toStrictEqual(uCursor(list, 1));
    expect(first.nextCursor).not.toHaveProperty('k');

    const start = resume(first.nextCursor, list);
    // i is the U_ORDER index (toured = 1); the PHASE index is 2 (D, requested, toured).
    expect(start).toStrictEqual({ phaseIndex: 2 });
    const second = await page(query, list, 5, start, two);
    expect(ids(second.items)).toEqual(['tour-s3']);
    expect(calls[2]).toStrictEqual({ kind: 'u', index: 1, limit: 3, forward: false });
  });

  it('8: a page that fills mid-batch in a FILTERED phase resumes after the last row RETURNED - none skipped, none repeated', async () => {
    const rows = [tour('tour-t1', 'toured'), tour('tour-t2', 'toured'), tour('tour-t3', 'toured')];
    const { query, calls } = recorder(rows);
    const list = listOf({ when: 'any', statuses: ['toured'], sort: 'latest' });
    const touredPhase = phaseAt(list, 1);
    expect(touredPhase).toMatchObject({ kind: 'u', index: 1, notExists: true });

    const first = await page(query, list, 2);
    expect(ids(first.items)).toEqual(['tour-t3', 'tour-t2']);
    // The batch evaluated all three (its key would be t1's): the cursor is t2's.
    expect(calls[1]).toStrictEqual({ kind: 'u', index: 1, limit: 3, forward: false });
    expect(first.nextCursor).toStrictEqual(uCursor(list, 1, tourListKeyOf(rowOf(rows, 'tour-t2'), touredPhase)));

    const second = await page(query, list, 2, resume(first.nextCursor, list));
    expect(ids(second.items)).toEqual(['tour-t1']);
    expect(second.nextCursor).toBeNull();
  });

  it('9: a page that fills exactly at the end of D -> a k-less u cursor; the empty U phases still spend the budget', async () => {
    const rows = [tour('tour-x1', 'toured', at(-5)), tour('tour-x2', 'scheduled', at(5))];
    const { query, calls } = recorder(rows);
    const list = listOf(EVERY_LATEST);

    const first = await page(query, list, 2);
    expect(ids(first.items)).toEqual(['tour-x2', 'tour-x1']);
    expect(first.nextCursor).toStrictEqual(uCursor(list, U_ORDER.indexOf('requested')));
    expect(first.nextCursor).not.toHaveProperty('k');

    // Budget 10: five empty U phases, one call each -> the accepted boundary phantom.
    const before = calls.length;
    const roomy = await page(query, list, 2, resume(first.nextCursor, list), { queryPageLimit: 3, maxQueryCalls: 10 });
    expect(roomy.items).toEqual([]);
    expect(roomy.nextCursor).toBeNull();
    expect(roomy).toMatchObject({ calls: 5, phasesTouched: 5 });
    expect(calls.slice(before).map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);

    // Budget 3: an EMPTY call still counts -> stopped at canceled (i 3).
    const tight = await page(query, list, 2, resume(first.nextCursor, list));
    expect(tight.items).toEqual([]);
    expect(tight.nextCursor).toStrictEqual(uCursor(list, 3));
    expect(tight.calls).toBe(3);
  });

  it('10: sort earliest passes forward: true and latest forward: false, on EVERY call', async () => {
    const rows = [
      tour('tour-o1', 'scheduled', at(10)),
      tour('tour-o2', 'toured', at(-10)),
      tour('tour-o3', 'requested'),
      tour('tour-o4', 'requested'),
      tour('tour-o5', 'toured'),
      tour('tour-o6', 'closed'),
    ];
    for (const [sort, forward, expected] of [
      ['earliest', true, ['tour-o2', 'tour-o1', 'tour-o3', 'tour-o4', 'tour-o5', 'tour-o6']],
      ['latest', false, ['tour-o1', 'tour-o2', 'tour-o4', 'tour-o3', 'tour-o5', 'tour-o6']],
    ] as const) {
      const { query, calls } = recorder(rows);
      const pages = await walk(query, listOf({ when: 'any', statuses: [], sort }), 1);
      expect(pages.flatMap((p) => ids(p.items)), sort).toEqual(expected);
      expect(calls.length, sort).toBeGreaterThan(5);
      expect(calls.every((c) => c.forward === forward), sort).toBe(true);
    }
  });

  it('11: resuming from { phaseIndex, startKey } makes the first call with exactly that startKey on that phase', async () => {
    const rows = [
      tour('tour-k1', 'scheduled', at(1)),
      tour('tour-k2', 'scheduled', at(2)),
      tour('tour-k3', 'toured'),
      tour('tour-k4', 'toured'),
    ];
    const list = listOf(EVERY_LATEST);
    const toured = phaseAt(list, 2);
    expect(toured).toMatchObject({ kind: 'u', index: 1 });

    const fromU = recorder(rows);
    const uKey = tourListKeyOf(rowOf(rows, 'tour-k4'), toured);
    const uPage = await page(fromU.query, list, 5, { phaseIndex: 2, startKey: uKey });
    expect(fromU.calls[0]).toStrictEqual({ kind: 'u', index: 1, limit: 3, startKey: uKey, forward: false });
    expect(ids(uPage.items)).toEqual(['tour-k3']);

    const fromD = recorder(rows);
    const dKey = tourListKeyOf(rowOf(rows, 'tour-k2'), phaseAt(list, 0));
    const dPage = await page(fromD.query, list, 1, { phaseIndex: 0, startKey: dKey });
    expect(fromD.calls[0]).toStrictEqual({ kind: 'd', limit: 2, startKey: dKey, forward: false });
    expect(ids(dPage.items)).toEqual(['tour-k1']);
  });

  it('12: NEVER a d cursor without k - a sweep of filters x limits x budgets, every walk complete and in order', async () => {
    const rows = [
      tour('tour-w1', 'scheduled', at(30)),
      tour('tour-w2', 'scheduled', at(20)),
      tour('tour-w3', 'toured', at(-10)),
      tour('tour-w4', 'no_show', at(-20)),
      tour('tour-w5', 'canceled', at(-30)),
      tour('tour-w6', 'closed', at(-40)),
      tour('tour-w7', 'no_show', at(-50)),
      tour('tour-w8', 'requested'),
      tour('tour-w9', 'requested'),
      tour('tour-w10', 'toured'),
      tour('tour-w11', 'closed'),
      tour('tour-w12', 'no_show'),
      tour('tour-w13', 'requested'),
    ];
    const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    /** The list a complete walk must return: dated rows by scheduledAt, then
     *  each picked U_ORDER status's undated rows by createdAt. */
    function expectedIds(filters: TourListFilters): string[] {
      const picked = (s: string): boolean => filters.statuses.length === 0 || (filters.statuses as string[]).includes(s);
      const dir = filters.sort === 'earliest' ? 1 : -1;
      const inWhen = (t: string): boolean =>
        filters.when === 'upcoming' ? t >= PINNED : filters.when === 'past' ? t < PINNED : true;
      const dated = rows
        .filter((t) => typeof t.scheduledAt === 'string' && inWhen(t.scheduledAt) && picked(t.status))
        .sort((a, b) => dir * cmp(String(a.scheduledAt), String(b.scheduledAt)));
      const undated =
        filters.when !== 'any'
          ? []
          : U_ORDER.flatMap((s) =>
              rows
                .filter((t) => t.status === s && picked(s) && t.scheduledAt === undefined)
                .sort((a, b) => dir * cmp(a.createdAt, b.createdAt)),
            );
      return ids([...dated, ...undated]);
    }

    const filterSets: TourListFilters[] = [
      EVERY_LATEST,
      { when: 'any', statuses: [], sort: 'earliest' },
      { when: 'any', statuses: ['no_show'], sort: 'latest' },
      { when: 'any', statuses: ['requested', 'closed'], sort: 'earliest' },
      PAST,
      { when: 'upcoming', statuses: [], sort: 'earliest' },
    ];
    const budgets: Budget[] = [
      { queryPageLimit: 1, maxQueryCalls: 1 },
      { queryPageLimit: 2, maxQueryCalls: 2 },
      { queryPageLimit: 3, maxQueryCalls: 3 },
      { queryPageLimit: 2, maxQueryCalls: 5 },
    ];
    let dCursors = 0;
    let bareUCursors = 0;
    for (const filters of filterSets) {
      for (const limit of [1, 2, 3, 5]) {
        for (const budget of budgets) {
          const label = `${JSON.stringify(filters)} limit ${limit} ${JSON.stringify(budget)}`;
          const { query } = recorder(rows);
          const pages = await walk(query, listOf(filters), limit, budget);
          expect(pages.flatMap((p) => ids(p.items)), label).toEqual(expectedIds(filters));
          for (const p of pages) {
            expect(p.items.length, label).toBeLessThanOrEqual(limit);
            if (p.nextCursor?.ph === 'd') {
              expect(p.nextCursor.k, label).toBeDefined();
              dCursors += 1;
            }
            if (p.nextCursor?.ph === 'u' && p.nextCursor.k === undefined) bareUCursors += 1;
          }
        }
      }
    }
    // Not vacuous: the sweep produced both cursor forms it reasons about.
    expect(dCursors).toBeGreaterThan(20);
    expect(bareUCursors).toBeGreaterThan(5);
  });

  it('13: the route defaults - QUERY_PAGE_LIMIT 200 and MAX_QUERY_CALLS 5 when nothing is injected', async () => {
    expect(QUERY_PAGE_LIMIT).toBe(200);
    expect(MAX_QUERY_CALLS).toBe(5);
    const rows = Array.from({ length: 6 }, (_, i) => tour(`tour-q${i + 1}`, 'toured', at(-(i + 1))));
    const { query, calls } = recorder(rows);
    const list = listOf({ when: 'any', statuses: ['canceled'], sort: 'latest' });
    const result = await listTourPage(query, { ...list, limit: 50 });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(calls).toStrictEqual([
      { kind: 'd', limit: 200, forward: false },
      { kind: 'u', index: 3, limit: 200, forward: false },
    ]);
  });
});
