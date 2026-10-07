// useAllTours.test.ts - the All tab's data hook (spec docs/superpowers/specs/
// 2026-10-06-tour-list-design.md sections 4.5, 4.9 and 6; plan Task 11.1).
//
// listTours is mocked through the api barrel (an importActual spread, so
// ApiError is the real class the hook checks). Every request is RECORDED with
// its params, options and signal. Its reply comes from a script keyed by
// cursor ('' = a first page); a request with nothing scripted stays IN FLIGHT
// until the test lands or fails it, so the in-flight states can be observed.
// The mock never settles a request on abort by itself: a test that wants the
// AbortError path rejects with one, and a late answer can still arrive after
// its abort (the hook must ignore both). Real timers throughout: settle() lets
// every scripted reply run to rest inside act.
import { act, renderHook, waitFor } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type TourListPage, type TourListParams, type TourListRow } from '../../api/index.js';

const listToursMock = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, listTours: (...args: unknown[]) => listToursMock(...args) as unknown };
});

import { DEFAULT_TOUR_LIST_SELECTION, tourListApiKey } from './tourListSelection.js';
import {
  BIG_PAGE_LIMIT,
  FIRST_PAGE_LIMIT,
  FOLLOW_CAP,
  RESTORE_REQUEST_CAP,
  WALK_REQUEST_CAP,
  useAllTours,
  type AllToursData,
  type UseAllToursInput,
} from './useAllTours.js';

// ---------------------------------------------------------------------------
// The scripted server
// ---------------------------------------------------------------------------

interface Call {
  params: TourListParams;
  opts: { cursor?: string; limit?: number };
  signal: AbortSignal | undefined;
  resolve: (page: TourListPage) => void;
  reject: (err: unknown) => void;
}

type Reply = TourListPage | Error;

let calls: Call[] = [];
let script = new Map<string, Reply[]>();

/** Queue replies for the next requests from `cursor` ('' = a first page). */
function reply(cursor: string, ...replies: Reply[]): void {
  script.set(cursor, [...(script.get(cursor) ?? []), ...replies]);
}

function call(i: number): Call {
  const c = calls[i];
  if (c === undefined) throw new Error(`no request #${i} (${calls.length} made)`);
  return c;
}

beforeEach(() => {
  calls = [];
  script = new Map();
  listToursMock.mockReset();
  listToursMock.mockImplementation(
    (params: TourListParams, opts: { cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
      new Promise<TourListPage>((resolve, reject) => {
        calls.push({ params, opts, signal, resolve, reject });
        const next = script.get(opts.cursor ?? '')?.shift();
        if (next === undefined) return;
        if (next instanceof Error) reject(next);
        else resolve(next);
      }),
  );
});

/** Let every scripted reply and the renders it causes run to rest. act keeps
 *  flushing work scheduled from microtasks until a macrotask passes idle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function land(c: Call, page: TourListPage): Promise<void> {
  await act(async () => {
    c.resolve(page);
  });
}

async function fail(c: Call, err: unknown): Promise<void> {
  await act(async () => {
    c.reject(err);
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PARAMS_A: TourListParams = { when: 'any', sort: 'latest' };
const KEY_A = JSON.stringify(PARAMS_A);
const PARAMS_B: TourListParams = { when: 'past', status: 'toured,no_show', sort: 'latest' };
const KEY_B = JSON.stringify(PARAMS_B);

function row(id: string, over: Partial<TourListRow> = {}): TourListRow {
  return {
    tourId: id,
    tenantId: `tenant-${id}`,
    unitId: `unit-${id}`,
    scheduledAt: '2026-07-10T14:00:00.000Z',
    tourType: 'self_guided',
    status: 'scheduled',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

function rowsOf(prefix: string, n: number): TourListRow[] {
  return Array.from({ length: n }, (_, i) => row(`${prefix}${i}`));
}

/** A page whose name maps carry every row's tenant and property. */
function page(tours: TourListRow[], nextCursor: string | null): TourListPage {
  return {
    tours,
    contacts: Object.fromEntries(tours.map((t) => [t.tenantId, { firstName: `First ${t.tourId}` }])),
    units: Object.fromEntries(tours.map((t) => [t.unitId, { address: `${t.tourId} Main St` }])),
    nextCursor,
  };
}

const ids = (d: AllToursData): string[] => d.rows.map((r) => r.tourId);
const optsOf = (): Array<Call['opts']> => calls.map((c) => c.opts);

const BASE: UseAllToursInput = { listKey: KEY_A, walk: false, restoreDepth: null };

function mount(over: Partial<UseAllToursInput> = {}) {
  return renderHook((props: UseAllToursInput) => useAllTours(props), {
    initialProps: { ...BASE, ...over },
  });
}

const cursor400 = (): ApiError => new ApiError(400, 'invalid cursor', 'invalid cursor');
const mismatch400 = (): ApiError => new ApiError(400, 'cursor_mismatch', 'cursor_mismatch');
const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

// ---------------------------------------------------------------------------

describe('useAllTours', () => {
  it('the page sizes and caps are the spec numbers', () => {
    expect([FIRST_PAGE_LIMIT, BIG_PAGE_LIMIT, FOLLOW_CAP, WALK_REQUEST_CAP, RESTORE_REQUEST_CAP]).toEqual([
      50, 100, 10, 50, 10,
    ]);
  });

  // 1
  describe('the first page', () => {
    it('requests limit 50 with the params parsed from listKey; loading until it lands, then ready with rows and names', async () => {
      const { result } = mount({ listKey: tourListApiKey(DEFAULT_TOUR_LIST_SELECTION) });
      expect(calls).toHaveLength(1);
      expect(call(0).params).toStrictEqual({ when: 'any', sort: 'latest' });
      expect(call(0).opts).toStrictEqual({ limit: 50 });
      expect(call(0).signal?.aborted).toBe(false);
      expect(result.current.status).toBe('loading');
      expect(result.current.loader).toBe('first');
      expect(result.current.rows).toEqual([]);

      const first = page([row('t1'), row('t2')], 'c1');
      await land(call(0), first);
      expect(result.current.status).toBe('ready');
      expect(ids(result.current)).toEqual(['t1', 't2']);
      expect(result.current.contacts).toEqual(first.contacts);
      expect(result.current.units).toEqual(first.units);
      expect(result.current.complete).toBe(false);
      expect(result.current.loader).toBe('none');
      expect(result.current.restoreOutcome).toBe('none');
      await settle();
      expect(calls).toHaveLength(1);
    });

    it('a page with nextCursor null completes the list - an EMPTY one too, with no follow', async () => {
      reply('', page([], null));
      const { result } = mount();
      await settle();
      expect(result.current.status).toBe('ready');
      expect(result.current.complete).toBe(true);
      expect(result.current.rows).toEqual([]);
      expect(result.current.followCapped).toBe(false);
      expect(calls).toHaveLength(1);
    });

    it('a first page that lists a tour twice keeps ONE row: the later copy, in the first copy position', async () => {
      // Planner review SC-F2: a tour in two phases of ONE request (spec 5.3 -
      // a dated `requested` tour) comes back twice in the same page; the
      // first page de-duplicates exactly as an appended page does.
      const later = row('t2', { status: 'toured', updatedAt: '2026-06-02T00:00:00.000Z' });
      reply('', page([row('t1'), row('t2'), row('t3'), later], null));
      const { result } = mount();
      await settle();
      expect(ids(result.current)).toEqual(['t1', 't2', 't3']);
      expect(result.current.rows[1]).toEqual(later);
      expect(result.current.complete).toBe(true);
    });
  });

  // 2
  it("listKey 'null' (an invalid date range) sends nothing and reads idle; leaving it loads", async () => {
    const { result, rerender } = mount({ listKey: 'null' });
    await settle();
    expect(calls).toHaveLength(0);
    expect(result.current.status).toBe('idle');
    expect(result.current.loader).toBe('none');
    expect(result.current.rows).toEqual([]);

    rerender({ ...BASE, listKey: KEY_A });
    expect(calls).toHaveLength(1);
    expect(result.current.status).toBe('loading');
    // Back to 'null' while that page loads: it is aborted and nothing replaces it.
    rerender({ ...BASE, listKey: 'null' });
    expect(call(0).signal?.aborted).toBe(true);
    expect(result.current.status).toBe('idle');
    await settle();
    expect(calls).toHaveLength(1);
  });

  // 3
  describe('a new listKey', () => {
    it('aborts the in-flight first page and loads the new list; the old answer never shows', async () => {
      const { result, rerender } = mount();
      rerender({ ...BASE, listKey: KEY_B });
      expect(call(0).signal?.aborted).toBe(true);
      expect(calls).toHaveLength(2);
      expect(call(1).params).toStrictEqual(PARAMS_B);
      expect(call(1).opts).toStrictEqual({ limit: 50 });
      expect(result.current.status).toBe('loading');

      await land(call(0), page([row('old')], 'c-old'));
      expect(result.current.status).toBe('loading');
      expect(result.current.rows).toEqual([]);
      await land(call(1), page([row('b1')], null));
      expect(ids(result.current)).toEqual(['b1']);
    });

    it('reads loading at once (derived) and never the old list rows', async () => {
      reply('', page([row('a1')], 'c1'));
      const { result, rerender } = mount();
      await settle();
      expect(ids(result.current)).toEqual(['a1']);
      rerender({ ...BASE, listKey: KEY_B });
      expect(result.current.status).toBe('loading');
      expect(result.current.loader).toBe('first');
      expect(result.current.rows).toEqual([]);
      expect(result.current.contacts).toEqual({});
      expect(result.current.complete).toBe(false);
    });
  });

  // 4
  it('loadMore requests the cursor with limit 50, appends, merges the names, and ignores a second call in flight', async () => {
    const first = page([row('t1'), row('t2')], 'c1');
    reply('', first);
    const { result } = mount();
    await settle();

    act(() => result.current.loadMore());
    expect(calls).toHaveLength(2);
    expect(call(1).params).toStrictEqual(PARAMS_A);
    expect(call(1).opts).toStrictEqual({ cursor: 'c1', limit: 50 });
    expect(result.current.loader).toBe('more');
    act(() => result.current.loadMore());
    expect(calls).toHaveLength(2);

    const second = page([row('t3')], 'c2');
    await land(call(1), second);
    expect(ids(result.current)).toEqual(['t1', 't2', 't3']);
    expect(result.current.contacts).toEqual({ ...first.contacts, ...second.contacts });
    expect(result.current.units).toEqual({ ...first.units, ...second.units });
    expect(Object.keys(result.current.contacts)).toHaveLength(3);
    expect(result.current.loader).toBe('none');
    expect(result.current.complete).toBe(false);
    await settle();
    expect(calls).toHaveLength(2);
  });

  // 5
  it('a later copy of a listed tour replaces that row in place', async () => {
    const moved = row('t2', { status: 'toured', scheduledAt: '2026-07-12T15:00:00.000Z' });
    reply('', page([row('t1'), row('t2'), row('t3')], 'c1'));
    reply('c1', page([moved, row('t4')], null));
    const { result } = mount();
    await settle();
    act(() => result.current.loadMore());
    await settle();
    expect(ids(result.current)).toEqual(['t1', 't2', 't3', 't4']);
    expect(result.current.rows[1]).toEqual(moved);
    expect(result.current.complete).toBe(true);
  });

  // 6
  it('follows empty pages automatically, stops after 10 in a row (followCapped), and Keep checking follows again', async () => {
    reply('', page([], 'f0'));
    const { result } = mount();
    await settle();
    expect(calls).toHaveLength(2);
    expect(call(1).opts).toStrictEqual({ cursor: 'f0', limit: 50 });
    expect(result.current.status).toBe('ready');
    expect(result.current.loader).toBe('follow');
    expect(result.current.followCapped).toBe(false);

    for (let i = 1; i < 10; i += 1) reply(`f${i}`, page([], `f${i + 1}`));
    await land(call(1), page([], 'f1'));
    // The first page + 10 follows, each from the last cursor.
    expect(calls).toHaveLength(11);
    for (let i = 1; i <= 10; i += 1) expect(call(i).opts).toStrictEqual({ cursor: `f${i - 1}`, limit: 50 });
    expect(result.current.followCapped).toBe(true);
    expect(result.current.loader).toBe('none');
    expect(result.current.complete).toBe(false);

    // Keep checking: one request from the last cursor, then the follow runs
    // again with a fresh count, until a non-empty page ends it.
    reply('k1', page([], 'k2'));
    reply('k2', page([row('x')], 'k3'));
    act(() => result.current.loadMore());
    expect(call(11).opts).toStrictEqual({ cursor: 'f10', limit: 50 });
    expect(result.current.loader).toBe('more');
    expect(result.current.followCapped).toBe(false);
    await land(call(11), page([], 'k1'));
    expect(optsOf().slice(12)).toStrictEqual([
      { cursor: 'k1', limit: 50 },
      { cursor: 'k2', limit: 50 },
    ]);
    expect(ids(result.current)).toEqual(['x']);
    expect(result.current.loader).toBe('none');
    expect(result.current.followCapped).toBe(false);
    expect(result.current.complete).toBe(false);
    await settle();
    expect(calls).toHaveLength(14);
  });

  it('the follow cap counts empty pages IN A ROW: a non-empty followed page resets it', async () => {
    reply('', page([], 'f0'));
    for (let i = 0; i < 9; i += 1) reply(`f${i}`, page([], `f${i + 1}`));
    reply('f9', page([row('x')], 'g0'));
    const { result, rerender } = mount();
    await settle();
    // Nine empty follows, then a tenth that is NOT empty: the follow ends.
    expect(calls).toHaveLength(11);
    expect(ids(result.current)).toEqual(['x']);
    expect(result.current.loader).toBe('none');

    // A walk page comes back empty with a cursor (walk pages are not follows)...
    reply('g0', page([], 'g1'));
    rerender({ ...BASE, walk: true });
    await settle();
    expect(call(11).opts).toStrictEqual({ cursor: 'g0', limit: 100 });
    expect(call(12).opts).toStrictEqual({ cursor: 'g1', limit: 100 });
    // ...and with the search cleared that empty last page is followed: nine
    // empty pages and a full one were never ten in a row.
    rerender({ ...BASE, walk: false });
    expect(call(12).signal?.aborted).toBe(true);
    expect(calls).toHaveLength(14);
    expect(call(13).opts).toStrictEqual({ cursor: 'g1', limit: 50 });
    expect(result.current.loader).toBe('follow');
    expect(result.current.followCapped).toBe(false);
  });

  // 7
  describe('the search walk', () => {
    it('after the first page, walks with limit 100 until nextCursor is null - through an empty page too', async () => {
      reply('', page([row('a0')], 'w0'));
      reply('w0', page([row('a1')], 'w1'));
      reply('w1', page([], 'w2'));
      reply('w2', page([row('a2')], null));
      const { result } = mount({ walk: true });
      await settle();
      expect(optsOf()).toStrictEqual([
        { limit: 50 },
        { cursor: 'w0', limit: 100 },
        { cursor: 'w1', limit: 100 },
        { cursor: 'w2', limit: 100 },
      ]);
      expect(ids(result.current)).toEqual(['a0', 'a1', 'a2']);
      expect(result.current.complete).toBe(true);
      expect(result.current.loader).toBe('none');
      expect(result.current.walkCapped).toBe(false);
    });

    it('reads loader walk in flight; loadMore is a no-op; walk off aborts the request, keeps the rows, and Load more resumes there', async () => {
      reply('', page([row('a0')], 'w0'));
      const { result, rerender } = mount();
      await settle();
      expect(calls).toHaveLength(1);

      rerender({ ...BASE, walk: true });
      expect(calls).toHaveLength(2);
      expect(call(1).opts).toStrictEqual({ cursor: 'w0', limit: 100 });
      expect(result.current.loader).toBe('walk');
      act(() => result.current.loadMore());
      expect(calls).toHaveLength(2);

      rerender({ ...BASE, walk: false });
      expect(call(1).signal?.aborted).toBe(true);
      expect(ids(result.current)).toEqual(['a0']);
      expect(result.current.loader).toBe('none');
      await land(call(1), page([row('late')], 'w1'));
      expect(ids(result.current)).toEqual(['a0']);
      expect(calls).toHaveLength(2);

      act(() => result.current.loadMore());
      expect(call(2).opts).toStrictEqual({ cursor: 'w0', limit: 50 });
    });

    it('a follow in flight is aborted and re-requested from the SAME cursor as a walk page', async () => {
      reply('', page([], 'f0'));
      const { result, rerender } = mount();
      await settle();
      expect(call(1).opts).toStrictEqual({ cursor: 'f0', limit: 50 });
      rerender({ ...BASE, walk: true });
      expect(call(1).signal?.aborted).toBe(true);
      expect(call(2).opts).toStrictEqual({ cursor: 'f0', limit: 100 });
      expect(result.current.loader).toBe('walk');
    });

    it('the 50th walk request with a cursor still pending sets walkCapped and stops', async () => {
      reply('', page([row('a')], 'w0'));
      for (let i = 0; i < 50; i += 1) reply(`w${i}`, page([row(`w${i}`)], `w${i + 1}`));
      const { result } = mount({ walk: true });
      await settle();
      expect(calls).toHaveLength(51);
      expect(call(50).opts).toStrictEqual({ cursor: 'w49', limit: 100 });
      expect(result.current.walkCapped).toBe(true);
      expect(result.current.loader).toBe('none');
      expect(result.current.complete).toBe(false);
      expect(result.current.rows).toHaveLength(51);
    });

    // Build ruling D-7: the cap is per WALK - spec 6 walks "whenever the
    // search is non-empty and the list is not complete".
    it('the cap is per WALK: the search cleared and typed again walks again from the kept cursor (D-7)', async () => {
      reply('', page([row('a')], 'w0'));
      for (let i = 0; i < 50; i += 1) reply(`w${i}`, page([row(`w${i}`)], `w${i + 1}`));
      const { result, rerender } = mount({ walk: true });
      await settle();
      expect(calls).toHaveLength(51);
      expect(result.current.walkCapped).toBe(true);

      rerender({ ...BASE, walk: false });
      await settle();
      expect(calls).toHaveLength(51);

      rerender({ ...BASE, walk: true });
      expect(calls).toHaveLength(52);
      expect(call(51).opts).toStrictEqual({ cursor: 'w50', limit: 100 });
      expect(result.current.walkCapped).toBe(false);
      expect(result.current.loader).toBe('walk');
      // The new walk counts from zero: a page with a cursor walks on.
      await land(call(51), page([row('n0')], 'n1'));
      expect(calls).toHaveLength(53);
      expect(call(52).opts).toStrictEqual({ cursor: 'n1', limit: 100 });
      expect(result.current.walkCapped).toBe(false);
    });
  });

  // 8
  it('walk turning on while a Load more is in flight waits for it, then walks from its cursor', async () => {
    reply('', page([row('a0')], 'c1'));
    const { result, rerender } = mount();
    await settle();
    act(() => result.current.loadMore());
    rerender({ ...BASE, walk: true });
    expect(calls).toHaveLength(2);
    expect(call(1).signal?.aborted).toBe(false);
    expect(result.current.loader).toBe('more');

    await land(call(1), page([row('a1')], 'c2'));
    expect(calls).toHaveLength(3);
    expect(call(2).opts).toStrictEqual({ cursor: 'c2', limit: 100 });
    expect(result.current.loader).toBe('walk');
  });

  // 9
  describe('the return restore', () => {
    it('loads the usual first page, then limit-100 restore pages until it holds the depth', async () => {
      reply('', page(rowsOf('p', 50), 'r1'));
      const { result } = mount({ restoreDepth: 120 });
      await settle();
      expect(optsOf()).toStrictEqual([{ limit: 50 }, { cursor: 'r1', limit: 100 }]);
      expect(result.current.loader).toBe('restore');
      expect(result.current.restoreOutcome).toBe('pending');
      act(() => result.current.loadMore());
      expect(calls).toHaveLength(2);

      await land(call(1), page(rowsOf('q', 100), 'r2'));
      expect(result.current.rows).toHaveLength(150);
      expect(result.current.restoreOutcome).toBe('reached');
      expect(result.current.loader).toBe('none');
      await settle();
      expect(calls).toHaveLength(2);
    });

    it('is reached when the list ends short of the depth', async () => {
      reply('', page(rowsOf('p', 50), 'r1'));
      reply('r1', page(rowsOf('q', 7), null));
      const { result } = mount({ restoreDepth: 120 });
      await settle();
      expect(result.current.rows).toHaveLength(57);
      expect(result.current.complete).toBe(true);
      expect(result.current.restoreOutcome).toBe('reached');
    });

    it('caps after the first page + 10 restore requests: no further automatic request, not even a follow; Load more then works', async () => {
      reply('', page(rowsOf('p', 50), 'x0'));
      for (let i = 0; i < 9; i += 1) reply(`x${i}`, page(rowsOf(`x${i}-`, 100), `x${i + 1}`));
      reply('x9', page([], 'x10'));
      const { result } = mount({ restoreDepth: 2000 });
      await settle();
      expect(calls).toHaveLength(11);
      for (let i = 1; i <= 10; i += 1) expect(call(i).opts).toStrictEqual({ cursor: `x${i - 1}`, limit: 100 });
      expect(result.current.rows).toHaveLength(950);
      expect(result.current.restoreOutcome).toBe('capped');
      expect(result.current.loader).toBe('none');
      expect(result.current.followCapped).toBe(false);

      act(() => result.current.loadMore());
      expect(calls).toHaveLength(12);
      expect(call(11).opts).toStrictEqual({ cursor: 'x10', limit: 50 });
    });

    it('walk turning on mid-restore aborts the restore request and walks from the same cursor', async () => {
      reply('', page(rowsOf('p', 50), 'r1'));
      const { result, rerender } = mount({ restoreDepth: 120 });
      await settle();
      expect(result.current.loader).toBe('restore');

      rerender({ ...BASE, restoreDepth: 120, walk: true });
      expect(call(1).signal?.aborted).toBe(true);
      expect(calls).toHaveLength(3);
      expect(call(2).opts).toStrictEqual({ cursor: 'r1', limit: 100 });
      expect(result.current.loader).toBe('walk');
      expect(result.current.restoreOutcome).toBe('pending');

      await land(call(1), page([row('late')], 'zz'));
      expect(result.current.rows).toHaveLength(50);
      await land(call(2), page(rowsOf('w', 10), null));
      expect(result.current.rows).toHaveLength(60);
      expect(result.current.complete).toBe(true);
      expect(result.current.restoreOutcome).toBe('reached');
    });

    it('a failed first page reads reached (P2-3); retry loads page 1 and the restore then runs to its depth', async () => {
      reply('', new ApiError(500, 'http_500', 'Request failed (500)'));
      const { result } = mount({ restoreDepth: 120 });
      await settle();
      expect(result.current.status).toBe('error');
      expect(result.current.restoreOutcome).toBe('reached');

      reply('', page(rowsOf('p', 50), 'r1'));
      reply('r1', page(rowsOf('q', 100), 'r2'));
      act(() => result.current.retry());
      expect(result.current.status).toBe('loading');
      await settle();
      expect(optsOf()).toStrictEqual([{ limit: 50 }, { limit: 50 }, { cursor: 'r1', limit: 100 }]);
      expect(result.current.rows).toHaveLength(150);
      expect(result.current.restoreOutcome).toBe('reached');
    });
  });

  // 10
  describe('a cursor 400', () => {
    it('the first one restarts the list at page 1; refreshed while that page loads and is the latest, false after the next', async () => {
      reply('', page([row('a1'), row('a2')], 'c1'));
      const { result } = mount();
      await settle();
      act(() => result.current.loadMore());
      await fail(call(1), cursor400());
      expect(calls).toHaveLength(3);
      expect(call(2).params).toStrictEqual(PARAMS_A);
      expect(call(2).opts).toStrictEqual({ limit: 50 });
      expect(result.current.status).toBe('loading');
      expect(result.current.refreshed).toBe(true);
      expect(result.current.rows).toEqual([]);

      await land(call(2), page([row('n1'), row('n2')], 'd1'));
      expect(result.current.status).toBe('ready');
      expect(ids(result.current)).toEqual(['n1', 'n2']);
      expect(result.current.refreshed).toBe(true);
      expect(result.current.dead).toBe(false);

      act(() => result.current.loadMore());
      expect(result.current.refreshed).toBe(true);
      await land(call(3), page([row('n3')], 'd2'));
      expect(result.current.refreshed).toBe(false);
      expect(ids(result.current)).toEqual(['n1', 'n2', 'n3']);
    });

    it('a second one in the same list is dead: no more requests; Start over begins a NEW list with a fresh allowance', async () => {
      reply('', page([row('a1')], 'c1'), page([row('n1')], 'd1'));
      reply('c1', cursor400());
      reply('d1', mismatch400());
      const { result } = mount();
      await settle();
      act(() => result.current.loadMore());
      await settle();
      expect(ids(result.current)).toEqual(['n1']);
      expect(result.current.refreshed).toBe(true);

      act(() => result.current.loadMore());
      await settle();
      expect(calls).toHaveLength(4);
      expect(result.current.dead).toBe(true);
      expect(result.current.loader).toBe('none');
      expect(ids(result.current)).toEqual(['n1']);
      act(() => result.current.loadMore());
      await settle();
      expect(calls).toHaveLength(4);

      reply('', page([row('s1')], 'e1'));
      reply('e1', cursor400());
      act(() => result.current.startOver());
      expect(result.current.status).toBe('loading');
      expect(result.current.dead).toBe(false);
      expect(result.current.refreshed).toBe(false);
      await settle();
      expect(call(4).opts).toStrictEqual({ limit: 50 });
      expect(ids(result.current)).toEqual(['s1']);
      expect(result.current.refreshed).toBe(false);

      act(() => result.current.loadMore());
      await settle();
      expect(calls).toHaveLength(7);
      expect(call(6).opts).toStrictEqual({ limit: 50 });
      expect(result.current.dead).toBe(false);
      expect(result.current.refreshed).toBe(true);
    });

    it('a second one while the restarted page 1 is still the latest is dead, and refreshed is then false (F-s11 O1)', async () => {
      reply('', page([row('a1')], 'c1'), page([row('n1')], 'd1'));
      reply('c1', cursor400());
      reply('d1', mismatch400());
      const { result } = mount();
      await settle();
      act(() => result.current.loadMore());
      await settle();
      expect(ids(result.current)).toEqual(['n1']);
      expect(result.current.refreshed).toBe(true);

      act(() => result.current.loadMore());
      await settle();
      expect(result.current.dead).toBe(true);
      // Never "The list was refreshed." beside "We couldn't load more tours.".
      expect(result.current.refreshed).toBe(false);
    });

    it('a new listKey - even back to an earlier one (A -> B -> A) - is a new list: refreshed false and a fresh allowance', async () => {
      reply('', page([row('a1')], 'c1'), page([row('a1')], 'c2'));
      reply('c1', cursor400());
      const { result, rerender } = mount();
      await settle();
      act(() => result.current.loadMore());
      await settle();
      expect(calls).toHaveLength(3);
      expect(result.current.refreshed).toBe(true);

      reply('', page([row('b1')], 'b-c1'));
      rerender({ ...BASE, listKey: KEY_B });
      expect(result.current.refreshed).toBe(false);
      await settle();
      expect(ids(result.current)).toEqual(['b1']);

      reply('', page([row('a1')], 'c3'));
      reply('c3', mismatch400());
      rerender({ ...BASE, listKey: KEY_A });
      expect(result.current.status).toBe('loading');
      expect(result.current.refreshed).toBe(false);
      await settle();
      expect(result.current.refreshed).toBe(false);

      act(() => result.current.loadMore());
      await settle();
      expect(calls).toHaveLength(7);
      expect(call(6).opts).toStrictEqual({ limit: 50 });
      expect(result.current.dead).toBe(false);
      expect(result.current.refreshed).toBe(true);
    });

    it('during a restore it ends the restore: page 1 only, then capped', async () => {
      reply('', page(rowsOf('p', 50), 'r1'), page(rowsOf('n', 50), 'n-c1'));
      reply('r1', cursor400());
      const { result } = mount({ restoreDepth: 120 });
      await settle();
      expect(optsOf()).toStrictEqual([{ limit: 50 }, { cursor: 'r1', limit: 100 }, { limit: 50 }]);
      expect(result.current.rows).toHaveLength(50);
      expect(result.current.refreshed).toBe(true);
      expect(result.current.loader).toBe('none');
      expect(result.current.restoreOutcome).toBe('capped');
    });

    it('during a restore it ends the restore: reached when the restarted page 1 ends the list', async () => {
      reply('', page(rowsOf('p', 50), 'r1'), page(rowsOf('n', 30), null));
      reply('r1', mismatch400());
      const { result } = mount({ restoreDepth: 120 });
      await settle();
      expect(calls).toHaveLength(3);
      expect(result.current.rows).toHaveLength(30);
      expect(result.current.restoreOutcome).toBe('reached');
    });

    it('during a walk it restarts and the walk goes on over the new list; a second one stops it (dead)', async () => {
      reply('', page([row('a1')], 'w0'), page([row('n1')], 'v0'));
      reply('w0', cursor400());
      reply('v0', page([row('n2')], 'v1'));
      reply('v1', mismatch400());
      const { result } = mount({ walk: true });
      await settle();
      expect(optsOf()).toStrictEqual([
        { limit: 50 },
        { cursor: 'w0', limit: 100 },
        { limit: 50 },
        { cursor: 'v0', limit: 100 },
        { cursor: 'v1', limit: 100 },
      ]);
      expect(result.current.dead).toBe(true);
      expect(result.current.loader).toBe('none');
      expect(ids(result.current)).toEqual(['n1', 'n2']);
    });
  });

  // 11
  describe('other failures', () => {
    it('a failed first page reads error; retry loads it again', async () => {
      reply('', new ApiError(500, 'http_500', 'Request failed (500)'));
      const { result } = mount();
      await settle();
      expect(result.current.status).toBe('error');
      expect(result.current.rows).toEqual([]);
      expect(result.current.loader).toBe('none');
      expect(calls).toHaveLength(1);

      reply('', page([row('a1')], null));
      act(() => result.current.retry());
      expect(result.current.status).toBe('loading');
      await settle();
      expect(calls).toHaveLength(2);
      expect(call(1).opts).toStrictEqual({ limit: 50 });
      expect(result.current.status).toBe('ready');
      expect(ids(result.current)).toEqual(['a1']);
    });

    it('a failed Load more keeps the rows and sets moreFailed with no automatic request; loadMore (Retry) clears it', async () => {
      reply('', page([row('a1')], 'c1'));
      reply('c1', new ApiError(0, 'network_error', 'Network request failed'));
      const { result } = mount();
      await settle();
      act(() => result.current.loadMore());
      await settle();
      expect(result.current.moreFailed).toBe(true);
      expect(result.current.status).toBe('ready');
      expect(ids(result.current)).toEqual(['a1']);
      expect(result.current.loader).toBe('none');
      expect(calls).toHaveLength(2);

      act(() => result.current.loadMore());
      expect(result.current.moreFailed).toBe(false);
      expect(result.current.loader).toBe('more');
      expect(call(2).opts).toStrictEqual({ cursor: 'c1', limit: 50 });
      await land(call(2), page([row('a2')], null));
      expect(ids(result.current)).toEqual(['a1', 'a2']);
      expect(result.current.complete).toBe(true);
    });

    it('a failed automatic page (a follow) sets moreFailed with no automatic retry; loadMore clears it', async () => {
      reply('', page([], 'f0'));
      reply('f0', new ApiError(503, 'http_503', 'Request failed (503)'));
      const { result } = mount();
      await settle();
      expect(calls).toHaveLength(2);
      expect(result.current.moreFailed).toBe(true);
      expect(result.current.loader).toBe('none');

      act(() => result.current.loadMore());
      expect(result.current.moreFailed).toBe(false);
      expect(call(2).opts).toStrictEqual({ cursor: 'f0', limit: 50 });
    });

    it('a failed walk page stops the walk; after Retry lands, the walk goes on', async () => {
      reply('', page([row('a0')], 'w0'));
      reply('w0', new ApiError(503, 'http_503', 'Request failed (503)'), page([row('a1')], 'w1'));
      const { result } = mount({ walk: true });
      await settle();
      expect(calls).toHaveLength(2);
      expect(result.current.moreFailed).toBe(true);
      expect(result.current.loader).toBe('none');

      act(() => result.current.loadMore());
      expect(call(2).opts).toStrictEqual({ cursor: 'w0', limit: 50 });
      await settle();
      expect(call(3).opts).toStrictEqual({ cursor: 'w1', limit: 100 });
      expect(result.current.loader).toBe('walk');
    });
  });

  // 12
  describe('stale answers', () => {
    it('an AbortError never writes state (a first page, a walk page)', async () => {
      const { result, rerender } = mount();
      rerender({ ...BASE, listKey: KEY_B });
      await fail(call(0), abortError());
      expect(result.current.status).toBe('loading');
      await land(call(1), page([row('b1')], 'w0'));
      expect(result.current.status).toBe('ready');

      rerender({ ...BASE, listKey: KEY_B, walk: true });
      expect(call(2).opts).toStrictEqual({ cursor: 'w0', limit: 100 });
      rerender({ ...BASE, listKey: KEY_B, walk: false });
      expect(call(2).signal?.aborted).toBe(true);
      await fail(call(2), abortError());
      expect(result.current.moreFailed).toBe(false);
      expect(result.current.status).toBe('ready');
      expect(ids(result.current)).toEqual(['b1']);
    });

    it('a request answered after its list was replaced never writes state (a first page, a Load more)', async () => {
      const { result, rerender } = mount();
      rerender({ ...BASE, listKey: KEY_B });
      await land(call(1), page([row('b1')], 'b-c1'));
      await land(call(0), page([row('a-late')], 'a-c1'));
      expect(result.current.status).toBe('ready');
      expect(ids(result.current)).toEqual(['b1']);

      act(() => result.current.loadMore());
      expect(call(2).opts).toStrictEqual({ cursor: 'b-c1', limit: 50 });
      rerender({ ...BASE, listKey: KEY_A });
      expect(call(2).signal?.aborted).toBe(true);
      await land(call(3), page([row('a1')], null));
      await land(call(2), page([row('b-late')], null));
      expect(ids(result.current)).toEqual(['a1']);
      expect(result.current.loader).toBe('none');
      expect(result.current.complete).toBe(true);
    });

    // The automatic write's `s.cursor !== cursor` guard only matters in the
    // window React leaves between a default-lane COMMIT and its passive
    // effects (react-dom schedules those as a separate task; only a sync lane
    // flushes them at commit): an answer that lands there is written before
    // the new run's cleanup aborts it, and the new run starts from the cursor
    // that answer is about to move past. act() flushes render, commit and
    // effects in one loop and can never open that window, so this test runs
    // OUTSIDE act, on React's real scheduler: the follow's answer lands from a
    // layout effect of the very commit that turns the walk on.
    it('a page answered for a cursor the list already moved past is dropped (the commit-to-effects window)', async () => {
      const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const actEnv = env.IS_REACT_ACT_ENVIRONMENT;
      let onWalkCommit: (() => void) | null = null;
      reply('', page([], 'f0'));
      const { result } = renderHook(() => {
        const [walk, setWalk] = useState(false);
        const data = useAllTours({ listKey: KEY_A, walk, restoreDepth: null });
        useLayoutEffect(() => {
          if (walk) onWalkCommit?.();
        }, [walk]);
        return { data, setWalk };
      });
      await settle();
      expect(calls).toHaveLength(2);
      expect(call(1).opts).toStrictEqual({ cursor: 'f0', limit: 50 });

      // A second request from f0 answers a DIFFERENT page: written, it shows.
      reply('f0', page([row('stale')], 'y1'));
      reply('f1', page([row('x2')], null));
      reply('y1', page([], null));
      onWalkCommit = () => call(1).resolve(page([row('x1')], 'f1'));
      env.IS_REACT_ACT_ENVIRONMENT = false;
      try {
        result.current.setWalk(true);
        await waitFor(() => expect(result.current.data.complete).toBe(true));
      } finally {
        env.IS_REACT_ACT_ENVIRONMENT = actEnv;
      }
      // The window was hit: the walk's first run started from the stale f0.
      expect(call(2).opts).toStrictEqual({ cursor: 'f0', limit: 100 });
      expect(ids(result.current.data)).toEqual(['x1', 'x2']);
    });
  });

  // 13
  it('a search typed while the first page loads lets that request finish, then walks from its cursor', async () => {
    const { result, rerender } = mount();
    rerender({ ...BASE, walk: true });
    expect(calls).toHaveLength(1);
    expect(call(0).signal?.aborted).toBe(false);
    expect(result.current.status).toBe('loading');

    await land(call(0), page([row('a1')], 'c1'));
    expect(call(0).signal?.aborted).toBe(false);
    expect(calls).toHaveLength(2);
    expect(call(1).opts).toStrictEqual({ cursor: 'c1', limit: 100 });
    expect(result.current.loader).toBe('walk');
  });
});
