// tourListPage - the All tab's paging loop (spec docs/superpowers/specs/
// 2026-10-06-tour-list-design.md section 5.4): read the planned phases in
// order until the page holds `limit` rows, every phase is exhausted, or the
// per-request Query budget is spent, and say exactly where the next page
// resumes. DynamoDB semantics it relies on (proven against DynamoDB Local in
// toursRepo.integration.test.ts): Limit counts EVALUATED items before any
// FilterExpression, and a LastEvaluatedKey comes back whenever the Query
// stopped at its Limit - even when nothing follows - and never when the key
// range ran out first.
import {
  isUnfilteredPhase,
  tourListKeyOf,
  type TourListCursor,
  type TourListFilters,
  type TourListPhase,
} from '../lib/tourListQuery.js';
import type { TourItem } from '../repos/toursRepo.js';

/** Items one FILTERED Query evaluates (spec 5.4). */
export const QUERY_PAGE_LIMIT = 200;
/** Queries per HTTP request (spec 5.4): one per possible phase (D + the five
 *  U statuses), so a sparse unfiltered list completes in ONE request. A
 *  smaller budget would spend itself before the last phase on every first
 *  page that does not fill - a phantom Load more over every small table. The
 *  budget bites only when a FILTERED phase needs more than one Query. */
export const MAX_QUERY_CALLS = 6;

export type QueryListPhase = (
  phase: TourListPhase,
  opts: { limit: number; startKey?: Record<string, string>; forward: boolean },
) => Promise<{ items: TourItem[]; lastEvaluatedKey?: Record<string, string>; scannedCount: number }>;

export interface TourListPageInput {
  phases: TourListPhase[];
  filters: TourListFilters;
  fingerprint: string;
  pinnedNow: string;
  limit: number;
  /** Where to resume (from locateTourListCursor); absent = the first page. */
  start?: { phaseIndex: number; startKey?: Record<string, string> };
}

export interface TourListPageResult {
  items: TourItem[];
  nextCursor: TourListCursor | null;
  /** Counts for the route's one log line (never ids). */
  calls: number;
  /** Items the Queries evaluated (summed ScannedCount). */
  evaluated: number;
  phasesTouched: number;
}

export async function listTourPage(
  queryListPhase: QueryListPhase,
  input: TourListPageInput,
  opts: { queryPageLimit?: number; maxQueryCalls?: number } = {},
): Promise<TourListPageResult> {
  const queryPageLimit = opts.queryPageLimit ?? QUERY_PAGE_LIMIT;
  const maxQueryCalls = opts.maxQueryCalls ?? MAX_QUERY_CALLS;
  const forward = input.filters.sort === 'earliest';
  const items: TourItem[] = [];
  let p = input.start?.phaseIndex ?? 0;
  let startKey = input.start?.startKey;
  let calls = 0;
  let evaluated = 0;
  const touched = new Set<number>();

  const cursorAt = (phaseIndex: number, k: Record<string, string> | undefined): TourListCursor | null => {
    const phase = input.phases[phaseIndex];
    if (phase === undefined) return null;
    return {
      v: 1,
      f: input.fingerprint,
      n: input.pinnedNow,
      ph: phase.kind,
      ...(phase.kind === 'u' && { i: phase.index }),
      ...(k !== undefined && { k }),
    };
  };
  const done = (nextCursor: TourListCursor | null): TourListPageResult => ({
    items,
    nextCursor,
    calls,
    evaluated,
    phasesTouched: touched.size,
  });

  while (p < input.phases.length) {
    const phase = input.phases[p];
    if (phase === undefined) break;
    // Budget spent: resume HERE. With no startKey this is the k-less "start
    // of" form - only ever a U phase: phase D, when present, is phase 0, and
    // a page reaches a later phase only after spending a call on D.
    if (calls >= maxQueryCalls) return done(cursorAt(p, startKey));
    const needed = input.limit - items.length;
    const limit = isUnfilteredPhase(phase) ? needed + 1 : queryPageLimit;
    const batch = await queryListPhase(phase, { limit, ...(startKey !== undefined && { startKey }), forward });
    calls += 1;
    evaluated += batch.scannedCount;
    touched.add(p);
    for (const item of batch.items) {
      if (items.length < input.limit) {
        items.push(item);
        continue;
      }
      // Page full and this batch holds more MATCHED rows (the peek row, or
      // leftover matches of a filtered batch): resume right after the last
      // row SENT - rows after it were read but never sent.
      const last = items[items.length - 1];
      return done(cursorAt(p, last === undefined ? startKey : tourListKeyOf(last, phase)));
    }
    if (batch.lastEvaluatedKey !== undefined) {
      if (items.length >= input.limit) return done(cursorAt(p, batch.lastEvaluatedKey));
      startKey = batch.lastEvaluatedKey;
      continue;
    }
    // This phase is exhausted.
    p += 1;
    startKey = undefined;
    if (items.length >= input.limit) return done(p < input.phases.length ? cursorAt(p, undefined) : null);
  }
  return done(null);
}
