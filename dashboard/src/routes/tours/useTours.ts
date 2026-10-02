// useTours — the /tours page data hook. Fetches:
//   1. Upcoming tours: GET /api/tours?from=<start-of-today>&to=<+30 days>
//      (scheduled future window, grouped by local date on the view layer).
//      The window query matches on scheduledAt ALONE - canceled/closed/no-show
//      tours keep their scheduledAt, so the hook filters to status='scheduled'
//      (Upcoming = live future appointments; same status set as the Today
//      board's TOURS_TODAY_STATUSES - the leak Cameron caught 2026-07-15).
//   2. Needs-booking tours: GET /api/tours?status=requested
//      (time-less tours awaiting a scheduled time, oldest first).
// Plus useClosedTours(enabled) — the Closed view's fetch: closed + canceled
// tours (the two "not live" states staff may need to find - closed is
// terminal, canceled is revivable from its detail page), newest first.
// Nothing is fetched until the Closed view shows.
// Plus usePastTours(enabled) - the Past tab's fetch (spec 4.2, 4.2a): a range
// query over [start of the local day 90 days ago, end of today] AND a
// status=toured read for the undated toured tours listed last, selected
// on the client (the range GSI matches on scheduledAt alone, same as
// Upcoming): scheduled / toured / no_show only, minus a still-scheduled
// tour dated today (Active's Today group has it) and minus a toured tour
// whose outcome is recorded - unless that outcome is a move-forward whose
// placement was never created (Needs placement). Most recent first.
// `reload()` refetches after a bulk action while keeping the current rows
// on screen; a failed reload keeps them too and sets reloadFailed.
//
// Both fetches run in parallel, each with its own AbortController so the caller
// (useEffect cleanup) can cancel both together. Mirrors useContacts / useListings:
// - A single status field drives loading/ready/error.
// - AbortError / signal-aborted responses are silently swallowed.
// - Any other error sets status to 'error'.
import { useCallback, useEffect, useState } from 'react';
import { getTours, TOUR_STATUS_LABELS, type Tour, type TourStatus } from '../../api/index.js';

export type ToursPageStatus = 'loading' | 'ready' | 'error';

export interface ToursPageState {
  status: ToursPageStatus;
  /** Tours in the next 30 days (scheduled range). Sorted ascending by scheduledAt. */
  upcoming: Tour[];
  /** Time-less tours awaiting scheduling (status='requested'). Sorted ascending by
   *  createdAt (oldest first). */
  needsBooking: Tour[];
}

/** Return ISO 8601 strings for [start-of-today-local, +30 days] as a UTC range.
 *  The browser owns "today"; we convert the local midnight boundary to UTC so the
 *  API's BETWEEN query on the byScheduledAt GSI is correct. */
export function toursDateRange(now: Date = new Date()): { from: string; to: string } {
  // Start of today in local time → UTC ISO string.
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  // +30 days from start of today.
  const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function useTours(): ToursPageState {
  const [state, setState] = useState<ToursPageState>({
    status: 'loading',
    upcoming: [],
    needsBooking: [],
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const { from, to } = toursDateRange();
        const [upcoming, needsBooking] = await Promise.all([
          getTours({ from, to }, signal),
          getTours({ status: 'requested' }, signal),
        ]);
        if (signal.aborted) return;

        // Upcoming = LIVE future appointments only. The window query returns
        // every tour whose scheduledAt is in range regardless of status, and
        // canceling/closing never clears scheduledAt - unfiltered, a canceled
        // or early-closed tour leaked into Upcoming.
        const scheduledUpcoming = upcoming.filter((t) => t.status === 'scheduled');

        // Sort upcoming ascending by scheduledAt (soonest first).
        const sortedUpcoming = [...scheduledUpcoming].sort((a, b) => {
          const aAt = a.scheduledAt ?? '';
          const bAt = b.scheduledAt ?? '';
          return aAt < bAt ? -1 : aAt > bAt ? 1 : 0;
        });

        // Sort needs-booking ascending by createdAt (oldest first).
        const sortedNeedsBooking = [...needsBooking].sort((a, b) => {
          const aAt = a.createdAt ?? '';
          const bAt = b.createdAt ?? '';
          return aAt < bAt ? -1 : aAt > bAt ? 1 : 0;
        });

        setState({ status: 'ready', upcoming: sortedUpcoming, needsBooking: sortedNeedsBooking });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({ status: 'error', upcoming: [], needsBooking: [] });
      }
    })();

    return () => controller.abort();
  }, []);

  return state;
}

export interface ClosedToursState {
  /** 'idle' until the Closed view enables the fetch (nothing loads by default). */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Closed + canceled tours, newest activity first (updatedAt desc — the
   *  close/cancel is the last write in practice — falling back to createdAt). */
  closed: Tour[];
}

/** LAZY fetch for the Closed view: the "not live" tours - status closed
 *  (reopenable from its tour page unless it became a placement) AND canceled
 *  (revivable) - fetched only while `enabled` is true (re-fetching fresh each
 *  time the view shows). An auto-closed tour is one of them. */
export function useClosedTours(enabled: boolean): ClosedToursState {
  const [state, setState] = useState<ClosedToursState>({ status: 'idle', closed: [] });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    setState({ status: 'loading', closed: [] });

    (async () => {
      try {
        const [closedRows, canceledRows] = await Promise.all([
          getTours({ status: 'closed' }, signal),
          getTours({ status: 'canceled' }, signal),
        ]);
        if (signal.aborted) return;
        const sorted = [...closedRows, ...canceledRows].sort((a, b) => {
          const aAt = a.updatedAt ?? a.createdAt ?? '';
          const bAt = b.updatedAt ?? b.createdAt ?? '';
          return aAt > bAt ? -1 : aAt < bAt ? 1 : 0;
        });
        setState({ status: 'ready', closed: sorted });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({ status: 'error', closed: [] });
      }
    })();

    return () => controller.abort();
  }, [enabled]);

  return state;
}

// ---------------------------------------------------------------------------
// Past tab (spec 4.2 / 4.3)
// ---------------------------------------------------------------------------

/** How far back the Past tab looks. Said aloud in the tab's intro line. */
export const PAST_TAB_DAYS = 90;

/** The Past tab's statuses: a tour whose time has passed and that still needs a
 *  human decision. Canceled and closed belong to Closed; requested has no time. */
export const PAST_TAB_STATUSES: ReadonlySet<TourStatus> = new Set<TourStatus>([
  'scheduled',
  'toured',
  'no_show',
]);

/** Start of `now`'s LOCAL calendar day. */
function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

/** [start of the local day 90 calendar days ago, end of today local] as UTC
 *  ISO strings. Calendar arithmetic, not a millisecond subtraction: across a
 *  DST change the two differ by an hour and the window would start at 23:00
 *  or 01:00. The window runs THROUGH today (not to `now`) so a tour marked
 *  toured or no-show before its time today is listed; selectPastTours drops
 *  today's still-scheduled rows, which Active's Today group already shows. */
export function pastToursDateRange(now: Date = new Date()): { from: string; to: string } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - PAST_TAB_DAYS, 0, 0, 0, 0);
  const to = new Date(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime() - 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** A toured tour whose move-forward decision never became a placement (a
 *  failed conversion - the tour page's "Start placement" is the retry). */
function needsPlacement(t: Tour): boolean {
  return t.status === 'toured' && t.convertible === true && t.convertedPlacementId === undefined;
}

/** Select and order the Past rows (spec 4.2). Pure; never mutates its input.
 *  1. keep scheduled / toured / no_show;
 *  2. drop a scheduled row dated today (Active's Today group shows it all day;
 *     it is not "past" until the day ends);
 *  3. drop a toured row that carries an outcome (its decision is recorded)
 *     UNLESS it still needs its placement;
 *  4. most recent scheduledAt first, ties by tourId. */
export function selectPastTours(tours: Tour[], now: Date = new Date()): Tour[] {
  const todayStart = startOfLocalDay(now).toISOString();
  return tours
    .filter((t) => PAST_TAB_STATUSES.has(t.status))
    .filter((t) => !(t.status === 'scheduled' && (t.scheduledAt ?? '') >= todayStart))
    .filter((t) => !(t.status === 'toured' && t.outcome !== undefined && !needsPlacement(t)))
    .sort((a, b) => {
      const aAt = a.scheduledAt ?? '';
      const bAt = b.scheduledAt ?? '';
      if (aAt !== bAt) return aAt > bAt ? -1 : 1;
      return a.tourId < b.tourId ? -1 : a.tourId > b.tourId ? 1 : 0;
    });
}

/** A tour with no scheduled time (the attribute is omitted, never '' - but
 *  treat an empty string the same, defensively). */
function isUndated(t: Tour): boolean {
  return typeof t.scheduledAt !== 'string' || t.scheduledAt.length === 0;
}

/** Toured tours the range read cannot reach (spec 4.2a), listed LAST. The
 *  Past view reads status=toured as well, for two kinds of row:
 *  - UNDATED: a requested tour marked "already toured" with the date left
 *    blank has no scheduledAt, so it is not in the byScheduledAt index at all
 *    (the row reads "Undated");
 *  - FUTURE-DATED: a tour marked toured before its day (Mark toured has no
 *    time gate; "Mark toured anyway" accepts a future time) is dated after the
 *    window's end, so the range read skips it until that day (the row shows
 *    its date).
 *  Pure; never mutates its input.
 *  1. keep status toured that is undated or dated AFTER the window's end - the
 *     same string order as the range read's BETWEEN, so the two reads are
 *     disjoint and together cover every dated toured tour up to 90 days old;
 *  2. keep only rows still needing a decision - no outcome, or a move-forward
 *     whose placement was never created (the same rule as 4.2 step 3);
 *  3. keep only rows last touched (updatedAt, else createdAt) inside the same
 *     90-day window - the tour date cannot place these rows, so the last touch
 *     is the clock;
 *  4. most recently touched first, ties by tourId. */
export function selectOffRangeTours(tours: Tour[], now: Date = new Date()): Tour[] {
  const { from, to } = pastToursDateRange(now);
  const touched = (t: Tour): string => t.updatedAt ?? t.createdAt ?? '';
  return tours
    .filter((t) => t.status === 'toured' && (isUndated(t) || (t.scheduledAt as string) > to))
    .filter((t) => t.outcome === undefined || needsPlacement(t))
    .filter((t) => touched(t) >= from)
    .sort((a, b) => {
      const aAt = touched(a);
      const bAt = touched(b);
      if (aAt !== bAt) return aAt > bAt ? -1 : 1;
      return a.tourId < b.tourId ? -1 : a.tourId > b.tourId ? 1 : 0;
    });
}

/** How many past tours the Today page lists before it points at the Past tab. */
export const TODAY_PAST_TOURS_CAP = 5;

/** The Past rows the Today page lists (Cameron 2026-09-30, Sam's item 18):
 *  the Past tab's own rows, in the Past tab's order, minus no-shows. A no-show
 *  has no way off the list yet (issue past-tab-no-show-rows-need-an-exit), so
 *  on the home page it would sit there for the whole window. Filtering the
 *  Past tab's SELECTED rows - never re-deriving them - keeps one rule: change
 *  the Past tab and Today follows. Pure; never mutates its input. */
export function selectTodayPastTours(past: Tour[]): Tour[] {
  return past.filter((t) => t.status !== 'no_show');
}

/** The plain-words state chip for a Past row (spec 4.3). Any other status
 *  falls back to its label so a mis-selected row is never blank. */
export function pastState(tour: Tour): string {
  if (tour.status === 'scheduled') return 'Not marked';
  if (tour.status === 'toured' && tour.outcome === undefined) return 'Needs outcome';
  if (needsPlacement(tour)) return 'Needs placement';
  if (tour.status === 'no_show') return 'No show';
  return TOUR_STATUS_LABELS[tour.status] ?? tour.status;
}

export interface PastToursState {
  /** 'idle' until the first result lands (the page shows its spinner for idle);
   *  'error' ONLY when the first load fails (a failed reload keeps the rows
   *  and sets reloadFailed). There is no 'loading' value: writing one
   *  synchronously in the effect is what react-hooks/set-state-in-effect
   *  forbids, and idle already means "nothing shown yet". */
  status: 'idle' | 'ready' | 'error';
  /** The selected Past rows: the range read's rows most recent first, then
   *  the off-range toured rows (undated or dated after today, spec 4.2a) most
   *  recently touched first. */
  past: Tour[];
  /** Refetch (after a bulk action). Keeps the current rows until the new page lands. */
  reload: () => void;
  /** The last reload failed; the rows on screen are stale. Cleared by the next
   *  successful load. Never true alongside status 'error'. */
  reloadFailed: boolean;
}

/** LAZY fetch for the Past view - the range read plus the status=toured read
 *  (for toured tours the range cannot reach, spec 4.2a), in parallel,
 *  client-selected. The two succeed or fail as one load. */
export function usePastTours(enabled: boolean): PastToursState {
  const [state, setState] = useState<{
    status: PastToursState['status'];
    past: Tour[];
    reloadFailed: boolean;
  }>({ status: 'idle', past: [], reloadFailed: false });
  const [epoch, setEpoch] = useState(0);
  const reload = useCallback(() => setEpoch((e) => e + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    // NO synchronous setState here (react-hooks/set-state-in-effect is an
    // error in this workspace): the first load leaves status 'idle', which
    // the page renders as its spinner; a reload keeps the rows on screen (no
    // spinner flash under a bulk result). Every write below is in the async
    // callback.

    (async () => {
      try {
        const now = new Date();
        const { from, to } = pastToursDateRange(now);
        const [rows, toured] = await Promise.all([
          getTours({ from, to }, signal),
          getTours({ status: 'toured' }, signal),
        ]);
        if (signal.aborted) return;
        // Range rows first, off-range toured rows after (spec 4.2a). The two
        // sets are disjoint: a range row carries a scheduledAt inside
        // [from, to]; an off-range row has none, or one after `to`.
        const past = [...selectPastTours(rows, now), ...selectOffRangeTours(toured, now)];
        setState({ status: 'ready', past, reloadFailed: false });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        // A failed RELOAD must not wipe the rows and the per-row results under
        // them (spec 4.2): stay ready, flag it. A failed FIRST load is an error.
        setState((s) =>
          s.status === 'ready' ? { ...s, reloadFailed: true } : { status: 'error', past: [], reloadFailed: false },
        );
      }
    })();

    return () => controller.abort();
  }, [enabled, epoch]);

  return { status: state.status, past: state.past, reload, reloadFailed: state.reloadFailed };
}
