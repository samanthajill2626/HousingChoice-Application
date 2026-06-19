// useListing — fetches everything the listing detail page (B4) needs and
// assembles the right-pane panels, degrading gracefully where the C3/C4/C6
// backend slices aren't live yet. Mirrors useContactFile's pattern:
//   - unit (GET /api/units/:id) is REQUIRED → status 'error' on failure.
//   - landlord contact (GET /api/contacts/:landlordId) backs the roster
//     fallback; a 404/error there is non-fatal (the roster degrades id-only).
//   - units + cases (existing) back relatedByLandlord + casesOnUnit (REAL).
//   - related (C3): try the live endpoint; on 404 fall back to the derived
//     same-landlord list (still 'ready' — it's real data, just our derivation).
//   - recipients (C4) + similar (C6): degrade to 'pending' on 404.
import { useEffect, useState } from 'react';
import {
  ApiError,
  getCases,
  getContact,
  getUnit,
  getUnitRecipients,
  getUnitRelated,
  getUnits,
  getUnitSimilar,
  type Contact,
  type ListingSendRow,
  type RelatedUnit,
  type SimilarUnit,
  type UnitItem,
} from '../../api/index.js';
import { casesOnUnit, listingRoster, relatedByLandlord, type RosterRow } from './buildListingFile.js';

/** A slice that may not be live yet: 'loading' → 'pending' (404) | rows (ready). */
export type Slice<T> =
  | { status: 'loading' }
  | { status: 'pending' }
  | { status: 'ready'; rows: T[] }
  | { status: 'error' };

export interface ListingState {
  status: 'loading' | 'ready' | 'error';
  unit: UnitItem | null;
  /** The resolved landlord contact (for the roster fallback), or null. */
  landlord: Contact | null;
  roster: RosterRow[];
  casesOnUnit: ReturnType<typeof casesOnUnit>;
  /** Related listings: the live C3 endpoint, else the same-landlord fallback. */
  related: Slice<RelatedUnit>;
  /** Sent-to-tenants (C4) — 'pending' until BE4. */
  recipients: Slice<ListingSendRow>;
  /** Similar comps (C6) — 'pending' until BE6. */
  similar: Slice<SimilarUnit>;
}

const LOADING: ListingState = {
  status: 'loading',
  unit: null,
  landlord: null,
  roster: [],
  casesOnUnit: [],
  related: { status: 'loading' },
  recipients: { status: 'loading' },
  similar: { status: 'loading' },
};

/** Resolve a maybe-not-live slice: a 404 → 'pending'; other errors → 'error'. */
async function loadSlice<T>(
  fetcher: (signal: AbortSignal) => Promise<T[]>,
  signal: AbortSignal,
): Promise<Slice<T>> {
  try {
    return { status: 'ready', rows: await fetcher(signal) };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (err instanceof ApiError && err.status === 404) return { status: 'pending' };
    return { status: 'error' };
  }
}

/** Best-effort fetch of the landlord contact — never throws; a missing/404
 *  contact just means the roster falls back to an id-only row. */
async function loadLandlord(
  landlordId: string | undefined,
  signal: AbortSignal,
): Promise<Contact | null> {
  if (!landlordId) return null;
  try {
    return await getContact(landlordId, signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return null;
  }
}

export function useListing(unitId: string): ListingState {
  // `forId` records which unitId the committed state describes. On a unitId
  // change we DERIVE loading during render until the new fetch commits, rather
  // than resetting with a synchronous setState in the effect (which the React
  // Compiler flags as a cascading render — set-state-in-effect).
  const [state, setState] = useState<ListingState & { forId: string }>({
    ...LOADING,
    forId: unitId,
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        // The unit is required; everything else assembles around it.
        const unit = await getUnit(unitId, signal);
        if (signal.aborted) return;

        const [landlord, units, cases, relatedSlice, recipients, similar] = await Promise.all([
          loadLandlord(unit.landlordId, signal),
          // NOTE: first inbox page only (nextCursor not paged) for the
          // same-landlord Related + cases-on-unit derivations — a transitional
          // limitation matching the project-wide pattern; BE3's /related and a
          // unit-scoped cases query supersede it.
          getUnits(signal),
          getCases(signal),
          loadSlice((s) => getUnitRelated(unitId, s), signal),
          loadSlice((s) => getUnitRecipients(unitId, s), signal),
          loadSlice((s) => getUnitSimilar(unitId, s), signal),
        ]);
        if (signal.aborted) return;

        // Related: prefer the live endpoint; on pending (404), fall back to the
        // derived same-landlord list (real data → 'ready', not 'pending').
        const related: Slice<RelatedUnit> =
          relatedSlice.status === 'pending'
            ? { status: 'ready', rows: relatedByLandlord(units.units, unit) }
            : relatedSlice;

        setState({
          status: 'ready',
          unit,
          landlord,
          roster: listingRoster(unit, landlord),
          casesOnUnit: casesOnUnit(cases.cases, unitId),
          related,
          recipients,
          similar,
          forId: unitId,
        });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({ ...LOADING, status: 'error', forId: unitId });
      }
    })();

    return () => controller.abort();
  }, [unitId]);

  // Committed state is for the previous unitId → the new fetch is in flight.
  if (state.forId !== unitId) return LOADING;
  return state;
}
