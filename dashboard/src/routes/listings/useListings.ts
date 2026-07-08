// useListings — the Listings list view's data hook. Fetches the unit records
// (GET /api/units) and returns a small { status, units } state. EVERY page is
// walked (the server pages via nextCursor): this hook also feeds the id→unit
// lookup maps (Tours rows, the property page's cross-references), where a
// first-page-only load rendered raw unit IDs for anything past page one.
// Mirrors useContacts / useToday's abort-safe fetch pattern.
import { useEffect, useState } from 'react';
import { getUnits, type UnitItem } from '../../api/index.js';

/** Page-walk bound: a hard stop so a pathological/looping cursor can never spin
 *  forever (40 pages × the server's 50/page = 2000 units — far past Phase-1
 *  scale). Hitting it WARNS — never a silent truncation. */
const MAX_PAGES = 40;

/** Fetch every page of the unit records (nextCursor walk, bounded). */
async function getAllUnitPages(deleted: boolean, signal: AbortSignal): Promise<UnitItem[]> {
  const out: UnitItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await getUnits({ deleted, ...(cursor !== undefined && { cursor }) }, signal);
    out.push(...res.units);
    if (!res.nextCursor) return out;
    cursor = res.nextCursor;
  }
  console.warn(`useListings: page cap (${MAX_PAGES}) hit — list truncated`);
  return out;
}

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
        const units = await getAllUnitPages(deleted, signal);
        if (signal.aborted) return;
        setState({ status: 'ready', units, forDeleted: deleted });
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
