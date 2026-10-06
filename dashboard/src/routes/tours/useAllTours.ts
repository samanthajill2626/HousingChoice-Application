// useAllTours - the Tours page All tab's data (spec docs/superpowers/specs/
// 2026-10-06-tour-list-design.md sections 4.5, 4.9 and 6): ONE server-
// filtered list from GET /api/tours/list, read a page at a time, with Load
// more / Keep checking, the automatic follow of empty pages, the search walk
// and the return restore.
//
// ONE LOADER AT A TIME. The first page loads while the committed state belongs
// to another list (derived, never set in an effect). Load more is an event
// chain (moreInFlight). Everything automatic is ONE effect whose mode is
// derived - walk (searching), restore (a restore record, not searching), or
// follow (the last page came back empty with a cursor) - and which fetches ONE
// page per run; the state it writes (a new cursor) triggers the next run, and
// its cleanup aborts the request when the mode changes.
//
// Lint (react-hooks 7, React Compiler rules): no setState in an effect body -
// every write is in an async callback or an event handler.
import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  listTours,
  type TourListContactName,
  type TourListPage,
  type TourListParams,
  type TourListRow,
  type TourListUnitAddress,
} from '../../api/index.js';

export const FIRST_PAGE_LIMIT = 50;
export const BIG_PAGE_LIMIT = 100;
export const FOLLOW_CAP = 10;
export const WALK_REQUEST_CAP = 50;
export const RESTORE_REQUEST_CAP = 10;

export type AllToursLoader = 'none' | 'first' | 'more' | 'walk' | 'restore' | 'follow';
export type RestoreOutcome = 'none' | 'pending' | 'reached' | 'capped';

export interface UseAllToursInput {
  /** tourListApiKey(selection): the JSON of the API params, or 'null'. */
  listKey: string;
  /** The (debounced or adopted) search is non-empty: walk the rest. */
  walk: boolean;
  /** The restore record's depth when the record belongs to THIS list (the
   *  view binds it, Task 12.2), else null. */
  restoreDepth: number | null;
}

export interface AllToursData {
  status: 'idle' | 'loading' | 'ready' | 'error';
  rows: TourListRow[];
  contacts: Record<string, TourListContactName>;
  units: Record<string, TourListUnitAddress>;
  /** nextCursor is null: every row of this list is loaded. */
  complete: boolean;
  loader: AllToursLoader;
  followCapped: boolean;
  /** The CURRENT walk (D-7: a walk, not the list) stopped at its request cap. */
  walkCapped: boolean;
  moreFailed: boolean;
  /** A second cursor 400 in this list: only Start over continues. */
  dead: boolean;
  /** This list was restarted after a cursor 400 and its first page is still
   *  the latest (false once the next page lands, or the list changes). */
  refreshed: boolean;
  restoreOutcome: RestoreOutcome;
  /** Load more, Keep checking, and Retry after a failed page. */
  loadMore: () => void;
  /** Retry a failed FIRST page. */
  retry: () => void;
  /** After a dead list: page 1 of a new list. */
  startOver: () => void;
}

interface ListState {
  /** The load (listKey#gen#epoch) this state describes. */
  forKey: string;
  status: 'ready' | 'error';
  rows: TourListRow[];
  contacts: Record<string, TourListContactName>;
  units: Record<string, TourListUnitAddress>;
  cursor: string | null;
  lastPageEmpty: boolean;
  /** Pages committed to this load (1 once the first page lands). */
  pages: number;
  followCount: number;
  moreInFlight: boolean;
  moreFailed: boolean;
  /** The walk session (see walkGen in the hook) walkRequests and walkCapped
   *  count for; another session's count reads as zero (ruling D-7). */
  walkFor: number;
  walkRequests: number;
  walkCapped: boolean;
  restoreRequests: number;
  dead: boolean;
}

function freshState(forKey: string, page: TourListPage | null): ListState {
  return {
    forKey,
    status: page === null ? 'error' : 'ready',
    rows: page?.tours ?? [],
    contacts: page?.contacts ?? {},
    units: page?.units ?? {},
    cursor: page?.nextCursor ?? null,
    lastPageEmpty: page !== null && page.tours.length === 0,
    pages: page === null ? 0 : 1,
    followCount: 0,
    moreInFlight: false,
    moreFailed: false,
    walkFor: 0,
    walkRequests: 0,
    walkCapped: false,
    restoreRequests: 0,
    dead: false,
  };
}

/** Append a page: a row already listed is REPLACED IN PLACE by the later copy
 *  (a tour rescheduled between two pages can come back); names merge. */
function withPage(s: ListState, page: TourListPage): ListState {
  const index = new Map(s.rows.map((r, i) => [r.tourId, i] as const));
  const rows = [...s.rows];
  for (const r of page.tours) {
    const at = index.get(r.tourId);
    if (at !== undefined) rows[at] = r;
    else {
      index.set(r.tourId, rows.length);
      rows.push(r);
    }
  }
  return {
    ...s,
    rows,
    contacts: { ...s.contacts, ...page.contacts },
    units: { ...s.units, ...page.units },
    cursor: page.nextCursor,
    lastPageEmpty: page.tours.length === 0,
    pages: s.pages + 1,
  };
}

function isAborted(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof DOMException && err.name === 'AbortError');
}

function isCursorRejection(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400 && (err.code === 'invalid cursor' || err.code === 'cursor_mismatch');
}

function paramsOf(listKey: string): TourListParams | null {
  return JSON.parse(listKey) as TourListParams | null;
}

export function useAllTours(input: UseAllToursInput): AllToursData {
  const { listKey, walk, restoreDepth } = input;
  // A NEW LIST whenever listKey changes - even back to an earlier key
  // (A -> B -> A) - and on Start over: the one-restart allowance and the
  // refreshed notice belong to a list, not to a filter string. React's
  // "storing information from previous renders" pattern: a CONDITIONAL
  // setState in render is legal (react-hooks flags only an unconditional one).
  const [listGen, setListGen] = useState({ listKey, n: 0 });
  if (listGen.listKey !== listKey) setListGen({ listKey, n: listGen.n + 1 });
  const listId = `${listKey}#${listGen.n}`;
  // The walk cap counts per WALK, not per list (build ruling D-7; spec 6
  // walks "whenever the search is non-empty and the list is not complete"): a
  // new walk SESSION starts on every false -> true edge of `walk` - the search
  // cleared and typed again - so a list whose earlier walk capped walks again.
  // The same conditional setState-in-render pattern as listGen.
  const [walkGen, setWalkGen] = useState({ walk, n: 0 });
  if (walkGen.walk !== walk) setWalkGen({ walk, n: walk ? walkGen.n + 1 : walkGen.n });
  const walkSession = walkGen.n;
  const [epoch, setEpoch] = useState(0);
  const key = `${listId}#${epoch}`;
  const [state, setState] = useState<ListState>(() => ({ ...freshState('', null), status: 'ready' }));
  // The one automatic restart per list (spec 4.5): written only in async
  // callbacks, never read during render.
  const restartUsedFor = useRef<string | null>(null);
  const [refreshedFor, setRefreshedFor] = useState<string | null>(null);
  const moreAbort = useRef<AbortController | null>(null);

  const valid = listKey !== 'null';
  const ready = valid && state.forKey === key && state.status === 'ready';
  // This list was restarted after a cursor 400 (spec 4.5).
  const restarted = refreshedFor === listId;
  // The walk counters as they apply to the CURRENT walk session (D-7).
  const walkCapped = state.walkFor === walkSession && state.walkCapped;

  /** A request WITH a cursor was refused: restart once per list, then die. */
  const rejectCursor = (forKey: string, forListId: string): void => {
    if (restartUsedFor.current !== forListId) {
      restartUsedFor.current = forListId;
      setRefreshedFor(forListId);
      setEpoch((e) => e + 1);
      return;
    }
    setState((s) => (s.forKey !== forKey ? s : { ...s, dead: true, moreInFlight: false }));
  };

  // The first page of a (new) list.
  useEffect(() => {
    const params = paramsOf(listKey);
    if (params === null) return;
    const controller = new AbortController();
    const forKey = key;
    void (async () => {
      try {
        const page = await listTours(params, { limit: FIRST_PAGE_LIMIT }, controller.signal);
        if (controller.signal.aborted) return;
        setState(freshState(forKey, page));
      } catch (err) {
        if (isAborted(err, controller.signal)) return;
        setState(freshState(forKey, null));
      }
    })();
    return () => controller.abort();
  }, [key, listKey]);

  // A Load more in flight belongs to its list: abort it when the list changes.
  useEffect(() => () => moreAbort.current?.abort(), [key]);

  const blocked = !ready || state.moreInFlight || state.dead || state.moreFailed || state.cursor === null;
  // The list is still short of the return depth. The automatic restart ends
  // the restore (spec 4.5: the refreshed list starts at page 1).
  const restoreShort = restoreDepth !== null && !restarted && state.rows.length < restoreDepth;
  const autoMode: 'walk' | 'restore' | 'follow' | null = blocked
    ? null
    : walk
      ? walkCapped
        ? null
        : 'walk'
      : restoreShort
        ? // Capped: keep what it has - no follow either (spec 4.9).
          state.restoreRequests < RESTORE_REQUEST_CAP
          ? 'restore'
          : null
        : state.lastPageEmpty && state.followCount < FOLLOW_CAP
          ? 'follow'
          : null;
  const cursor = state.cursor;

  useEffect(() => {
    if (autoMode === null || cursor === null) return;
    const params = paramsOf(listKey);
    if (params === null) return;
    const controller = new AbortController();
    const forKey = key;
    const forListId = listId;
    const forWalk = walkSession;
    const mode = autoMode;
    const limit = mode === 'follow' ? FIRST_PAGE_LIMIT : BIG_PAGE_LIMIT;
    void (async () => {
      try {
        const page = await listTours(params, { cursor, limit }, controller.signal);
        if (controller.signal.aborted) return;
        setState((s) => {
          if (s.forKey !== forKey || s.cursor !== cursor) return s;
          const next = withPage(s, page);
          if (mode === 'walk') {
            // Another walk session's count reads as zero (D-7).
            const walkRequests = (s.walkFor === forWalk ? s.walkRequests : 0) + 1;
            return {
              ...next,
              walkFor: forWalk,
              walkRequests,
              walkCapped: walkRequests >= WALK_REQUEST_CAP && page.nextCursor !== null,
            };
          }
          if (mode === 'restore') return { ...next, restoreRequests: s.restoreRequests + 1 };
          return { ...next, followCount: page.tours.length === 0 ? s.followCount + 1 : 0 };
        });
      } catch (err) {
        if (isAborted(err, controller.signal)) return;
        if (isCursorRejection(err)) {
          rejectCursor(forKey, forListId);
          return;
        }
        setState((s) => (s.forKey !== forKey ? s : { ...s, moreFailed: true }));
      }
    })();
    return () => controller.abort();
  }, [autoMode, cursor, key, listKey, listId, walkSession]);

  const loadMore = (): void => {
    // One loader at a time (spec 4.5): Load more and Keep checking are hidden
    // while an automatic mode runs, and a stray call then is a no-op.
    if (!ready || state.cursor === null || state.moreInFlight || state.dead || autoMode !== null) return;
    const params = paramsOf(listKey);
    if (params === null) return;
    const forKey = key;
    const forListId = listId;
    const from = state.cursor;
    const controller = new AbortController();
    moreAbort.current = controller;
    setState((s) => ({ ...s, moreInFlight: true, moreFailed: false, followCount: 0 }));
    void (async () => {
      try {
        const page = await listTours(params, { cursor: from, limit: FIRST_PAGE_LIMIT }, controller.signal);
        if (controller.signal.aborted) return;
        setState((s) => (s.forKey !== forKey ? s : { ...withPage(s, page), moreInFlight: false }));
      } catch (err) {
        if (isAborted(err, controller.signal)) return;
        if (isCursorRejection(err)) {
          rejectCursor(forKey, forListId);
          return;
        }
        setState((s) => (s.forKey !== forKey ? s : { ...s, moreInFlight: false, moreFailed: true }));
      }
    })();
  };

  /** Load the same list again (a failed first page). */
  const retry = (): void => setEpoch((e) => e + 1);
  /** A NEW list (spec 4.5): page 1, a fresh restart allowance, no notice. */
  const startOver = (): void => setListGen((g) => ({ listKey: g.listKey, n: g.n + 1 }));

  if (!valid) {
    return { ...EMPTY, status: 'idle', loadMore, retry, startOver };
  }
  if (state.forKey !== key) {
    return { ...EMPTY, status: 'loading', loader: 'first', refreshed: restarted, loadMore, retry, startOver };
  }
  const restoreOutcome: RestoreOutcome =
    restoreDepth === null
      ? 'none'
      : autoMode === 'restore' || autoMode === 'walk'
        ? 'pending'
        : state.rows.length >= restoreDepth || state.cursor === null
          ? 'reached'
          : 'capped';
  return {
    status: state.status,
    rows: state.rows,
    contacts: state.contacts,
    units: state.units,
    complete: state.cursor === null,
    loader: state.moreInFlight ? 'more' : (autoMode ?? 'none'),
    followCapped:
      !walk && state.cursor !== null && state.lastPageEmpty && state.followCount >= FOLLOW_CAP,
    walkCapped,
    moreFailed: state.moreFailed,
    dead: state.dead,
    // Only while the restarted list's first page is the latest: role="status"
    // is atomic, so a lasting notice would be re-announced with every count.
    refreshed: restarted && state.pages <= 1,
    restoreOutcome,
    loadMore,
    retry,
    startOver,
  };
}

const EMPTY: Omit<AllToursData, 'status' | 'loadMore' | 'retry' | 'startOver'> = {
  rows: [],
  contacts: {},
  units: {},
  complete: false,
  loader: 'none',
  followCapped: false,
  walkCapped: false,
  moreFailed: false,
  dead: false,
  refreshed: false,
  restoreOutcome: 'none',
};
