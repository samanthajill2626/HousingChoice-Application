// useListings — the Listings list view's data hook. Fetches the unit records
// (GET /api/units) and returns a small { status, units } state. First page only
// (the server pages via nextCursor) — a transitional limitation the list view
// notes. Mirrors useContacts / useToday's abort-safe fetch pattern.
import { useEffect, useState } from 'react';
import { getUnits, type UnitItem } from '../../api/index.js';

export type ListingsStatus = 'loading' | 'ready' | 'error';

export interface ListingsState {
  status: ListingsStatus;
  units: UnitItem[];
}

export function useListings(deleted = false): ListingsState {
  // `forDeleted` records which view the committed state describes. On a view
  // change (active vs deleted) we DERIVE loading during render until the new fetch
  // commits, rather than resetting with a synchronous setState in the effect
  // (which the React Compiler flags as a cascading render) — same pattern as
  // useContacts.
  const [state, setState] = useState<ListingsState & { forDeleted: boolean }>({
    status: 'loading',
    units: [],
    forDeleted: deleted,
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const page = await getUnits({ deleted }, signal);
        if (signal.aborted) return;
        setState({ status: 'ready', units: page.units, forDeleted: deleted });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({ status: 'error', units: [], forDeleted: deleted });
      }
    })();

    return () => controller.abort();
  }, [deleted]);

  // Committed state is for the previous view → the new fetch is in flight.
  if (state.forDeleted !== deleted) return { status: 'loading', units: [] };
  return { status: state.status, units: state.units };
}
