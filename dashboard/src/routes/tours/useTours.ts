// useTours — the /tours page data hook. Fetches:
//   1. Upcoming tours: GET /api/tours?from=<start-of-today>&to=<+30 days>
//      (scheduled future window, grouped by local date on the view layer).
//   2. Needs-booking tours: GET /api/tours?status=requested
//      (time-less tours awaiting a scheduled time, oldest first).
//
// Both fetches run in parallel, each with its own AbortController so the caller
// (useEffect cleanup) can cancel both together. Mirrors useContacts / useListings:
// - A single status field drives loading/ready/error.
// - AbortError / signal-aborted responses are silently swallowed.
// - Any other error sets status to 'error'.
import { useEffect, useState } from 'react';
import { getTours, type Tour } from '../../api/index.js';

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

        // Sort upcoming ascending by scheduledAt (soonest first).
        const sortedUpcoming = [...upcoming].sort((a, b) => {
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
