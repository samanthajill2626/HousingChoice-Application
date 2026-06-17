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

export function useListings(): ListingsState {
  const [state, setState] = useState<ListingsState>({ status: 'loading', units: [] });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setState({ status: 'loading', units: [] });

    (async () => {
      try {
        const page = await getUnits(signal);
        if (signal.aborted) return;
        setState({ status: 'ready', units: page.units });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({ status: 'error', units: [] });
      }
    })();

    return () => controller.abort();
  }, []);

  return state;
}
