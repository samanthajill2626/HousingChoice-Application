// useTour - the tour detail page's bundle hook. Mirrors PlacementDetail's load()
// and useListing's derive-loading-on-id-change pattern:
//   - GET /api/tours/:tourId is REQUIRED. A 404 -> 'notfound' (the page shows a
//     not-found panel); any other failure -> 'error'.
//   - unit (GET /api/units/:unitId), tenant contact, and landlord contact
//     (unit.landlordId) are best-effort JOINS - each degrades to null, the page
//     never hard-fails because a join 404'd.
//
// Activity, the reminder ladder, and the three conversation channels are NOT
// bundled here - each has its own dedicated hook (useTourActivity /
// RemindersPanel / useTourChannels), exactly as PlacementDetail delegates its
// history to usePlacementHistory. This hook owns the tour + its entity joins.
//
// LIVE: a mutation on THIS tour (here, another tab, another user, or the from-tour
// conversion) emits a `tour.updated` SSE event; we subscribe and refetch the
// bundle so the header + facts line reflect it. A local mutation applies its
// returned tour instantly via setTour (no wait for the round-trip).
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getContact,
  getTour,
  getUnit,
  useEventStream,
  type Contact,
  type Tour,
  type TourUpdatedEvent,
  type UnitItem,
} from '../../api/index.js';

export type TourLoadStatus = 'loading' | 'ready' | 'notfound' | 'error';

export interface TourState {
  status: TourLoadStatus;
  tour: Tour | null;
  /** Apply a mutation's returned tour in place (no refetch) - mirrors
   *  useContact.setContact / PlacementDetail.setPlacement. */
  setTour: (tour: Tour) => void;
  unit: UnitItem | null;
  tenant: Contact | null;
  landlord: Contact | null;
}

interface Committed {
  status: TourLoadStatus;
  tour: Tour | null;
  unit: UnitItem | null;
  tenant: Contact | null;
  landlord: Contact | null;
  /** Which tourId the committed state describes (derive loading until it matches). */
  forId: string;
}

const LOADING: Omit<Committed, 'forId'> = {
  status: 'loading',
  tour: null,
  unit: null,
  tenant: null,
  landlord: null,
};

export function useTour(tourId: string): TourState {
  const [state, setState] = useState<Committed>({ ...LOADING, forId: tourId });

  // Track the in-flight load so a refetch (SSE-driven or tourId change) supersedes
  // the previous one and a late response can't clobber fresher state.
  const abortRef = useRef<AbortController | null>(null);

  // Apply an updated tour in place (a mutation returned it), keeping the resolved
  // joins - instant feedback before any tour.updated refetch reconciles.
  const setTour = useCallback(
    (tour: Tour) => {
      setState((prev) => ({ ...prev, status: 'ready', tour, forId: tourId }));
    },
    [tourId],
  );

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    try {
      // The tour is required; everything else assembles around it.
      const tour = await getTour(tourId, signal);
      if (signal.aborted) return;
      // Best-effort joins: the unit (address/beds/rent) + the tenant contact (name)
      // in parallel; a failure on either is non-fatal (degrades to null).
      const [unit, tenant] = await Promise.all([
        getUnit(tour.unitId, signal).catch(() => null),
        getContact(tour.tenantId, signal).catch(() => null),
      ]);
      if (signal.aborted) return;
      // The landlord is the unit's landlordId contact (also the group/PM slot).
      const landlord =
        unit && typeof unit.landlordId === 'string' && unit.landlordId.length > 0
          ? await getContact(unit.landlordId, signal).catch(() => null)
          : null;
      if (signal.aborted) return;
      setState({ status: 'ready', tour, unit, tenant, landlord, forId: tourId });
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      const notFound = err instanceof ApiError && err.status === 404;
      setState({ ...LOADING, status: notFound ? 'notfound' : 'error', forId: tourId });
    }
  }, [tourId]);

  useEffect(() => {
    // load sets state only after an await (never synchronously) - a fetch-on-mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Live: refetch the bundle when THIS tour changes.
  const onTourUpdated = useCallback(
    (ev: TourUpdatedEvent) => {
      if (ev.tourId === tourId) void load();
    },
    [tourId, load],
  );
  useEventStream({ onTourUpdated });

  // Committed state is for a previous tourId -> the new fetch is in flight.
  if (state.forId !== tourId) return { ...LOADING, setTour };
  return {
    status: state.status,
    tour: state.tour,
    setTour,
    unit: state.unit,
    tenant: state.tenant,
    landlord: state.landlord,
  };
}
