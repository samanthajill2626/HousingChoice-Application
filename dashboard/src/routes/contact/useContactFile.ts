// useContactFile — fetches the data the contact detail right pane needs from
// EXISTING endpoints (/api/placements, /api/units, /api/tours) plus the C4/C5
// slice that may not be live yet (listings-sent). Placements/units/tours
// always load; the C4/C5 calls resolve to a 'pending' marker on a 404 so their
// panels render an honest "arrives with the backend" state rather than an error.
// The page derives the per-pane lists with buildContactFile's pure helpers.
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  getAllPlacements,
  getAllUnits,
  getContactListingsSent,
  getContactGroupThreads,
  getContactRelayGroups,
  getTours,
  type ListingSendRow,
  type PlacementItem,
  type GroupThreadRow,
  type RelayGroupRow,
  type Tour,
  type UnitItem,
} from '../../api/index.js';

/** A slice that may not be live yet: 'loading' → 'pending' (404) | T[] (ready). */
export type Slice<T> =
  | { status: 'loading' }
  | { status: 'pending' }
  | { status: 'ready'; rows: T[] }
  | { status: 'error' };

export interface ContactFileState {
  status: 'loading' | 'ready' | 'error';
  placements: PlacementItem[];
  units: UnitItem[];
  /** Tours for this contact — tenant tours (tenantId=contactId) OR landlord tours
   *  fetched per-unit (unitId=...) from /api/tours. An empty array while loading
   *  or when there are no tours. */
  tours: Tour[];
  listingsSent: Slice<ListingSendRow>;
  /** The contact's relay-group memberships - the "Relay groups" card.
   *  404 (a backend without the route) → 'pending', mirroring the C4/C5 slices. */
  relayGroups: Slice<RelayGroupRow>;
  /** The contact's NATIVE group texts - the "Group threads" card. Same
   *  degrade-on-404 posture as the sibling slices. */
  groupThreads: Slice<GroupThreadRow>;
  /** The group-threads read is BOUNDED (no member->thread index), so this says
   *  older threads may not have been considered. The card shows it. */
  groupThreadsTruncated: boolean;
}

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

/** The "nothing loaded yet" state, reused for the initial value and the
 *  derived loading state shown while a new contactId's fetch is in flight. */
const FILE_LOADING: ContactFileState = {
  status: 'loading',
  placements: [],
  units: [],
  tours: [],
  listingsSent: { status: 'loading' },
  relayGroups: { status: 'loading' },
  groupThreads: { status: 'loading' },
  groupThreadsTruncated: false,
};

/**
 * Options for useContactFile. Pass `contactType` to enable the tours fetch:
 * - `'tenant'` → GET /api/tours?tenantId=contactId
 * - `'landlord'` → tours are fetched per owned unit after units load; pass
 *   an empty array until the unit IDs are known (the landlord case is deferred
 *   to a follow-up — file loads units first, then a useEffect re-fetches tours).
 * - `undefined` → tours are not fetched (unknown file type or not yet known).
 */
export interface UseContactFileOpts {
  /** Contact type hint — drives which tours query to use. */
  contactType?: 'tenant' | 'landlord' | 'unknown' | string;
}

/** The file, plus the one imperative affordance it exposes. */
export type ContactFile = ContactFileState & {
  /** Read every slice again for the SAME contact. The committed state stays on
   *  screen while the new fetch is in flight (no loading flash), so a pane that
   *  already has rows keeps showing them. For a write made ELSEWHERE on the page
   *  that no SSE event covers - the standalone relay-group create, whose
   *  `connecting` outcome deliberately does not navigate away - the same gap
   *  `useContactTimeline.refetch` fills for the timeline.
   *
   *  A refetch that FAILS keeps the committed state too (`status` stays
   *  `'ready'`): the pane goes stale rather than collapsing to "We couldn't load
   *  this file." over rows that are still good. Only a load with nothing
   *  committed for this contact reports `'error'`. */
  refetch: () => void;
};

export function useContactFile(contactId: string, opts: UseContactFileOpts = {}): ContactFile {
  // `forId` records which contactId the committed state describes. On an id
  // change we DERIVE loading during render until the new fetch commits, rather
  // than resetting with a synchronous setState in the effect (which the React
  // Compiler flags as a cascading render — set-state-in-effect).
  const [state, setState] = useState<ContactFileState & { forId: string }>({
    ...FILE_LOADING,
    forId: contactId,
  });
  // Bumping this re-runs the fetch effect for the SAME contactId - a nonce
  // rather than an extracted async function because the whole fetch body is the
  // effect, and pulling it out would change the abort/ordering shape.
  const [reloadNonce, setReloadNonce] = useState(0);
  const refetch = useCallback(() => setReloadNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        // Placements + units back the REAL panels (Placements / Tours / Properties); both
        // exist today. The C4/C5 slices degrade independently.
        // The group-threads read reports a truncation flag alongside its rows;
        // loadSlice carries rows only, so the flag is captured here (assigned
        // before Promise.all resolves).
        let groupThreadsTruncated = false;
        const [placements, units, listingsSent, relayGroups, groupThreads] =
          await Promise.all([
          // EVERY page: this backs the Placements panel, so a first-page-only
          // read dropped this person's deals once the board outgrew one page.
          getAllPlacements(signal),
          // EVERY page (the server pages /api/units at 50): these units back the
          // landlord's Properties panel AND the per-unit tours fan-out below, so
          // a first-page-only read silently dropped both for anyone whose
          // properties sat later in the scan.
          getAllUnits({}, signal),
          loadSlice((s) => getContactListingsSent(contactId, s), signal),
          loadSlice((s) => getContactRelayGroups(contactId, s), signal),
          loadSlice(async (s) => {
            const page = await getContactGroupThreads(contactId, s);
            groupThreadsTruncated = page.truncated;
            return page.groups;
          }, signal),
        ]);
        if (signal.aborted) return;

        // Fetch tours based on contact type.
        // Tenant: GET /api/tours?tenantId= (all tours for this tenant).
        // Landlord: GET /api/tours?unitId= per owned unit, then concatenate.
        //   We have the units at this point so we can fan out.
        // Unknown / other: no tours fetch (empty).
        let tours: import('../../api/index.js').Tour[] = [];
        if (opts.contactType === 'tenant') {
          try {
            tours = await getTours({ tenantId: contactId }, signal);
          } catch {
            // Best-effort — tours degrade to empty if the API is unavailable
          }
        } else if (opts.contactType === 'landlord') {
          const myUnitIds = units.items
            .filter((u) => u.landlordId === contactId)
            .map((u) => u.unitId);
          try {
            const tourArrays = await Promise.all(
              myUnitIds.map((uid) => getTours({ unitId: uid }, signal)),
            );
            tours = tourArrays.flat();
          } catch {
            // Best-effort
          }
        }

        if (signal.aborted) return;
        setState({
          status: 'ready',
          placements: placements.items,
          units: units.items,
          tours,
          listingsSent,
          relayGroups,
          groupThreads,
          groupThreadsTruncated,
          forId: contactId,
        });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        // A RELOAD is not a LOAD. `status: 'error'` replaces every card in the
        // right pane (placements, tours, properties, relay groups, group
        // threads) with one sentence and no retry affordance. That is the
        // honest answer when nothing has ever loaded - and a wipe of good rows
        // when a refetch over committed state fails. Keep what is on screen: the
        // pane is then STALE, which is exactly what it was before refetch
        // existed. Only a first load for THIS contact (or a contact switch,
        // whose committed state describes someone else) still errors.
        setState((prev) =>
          prev.status === 'ready' && prev.forId === contactId
            ? prev
            : { ...prev, status: 'error', forId: contactId },
        );
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, opts.contactType, reloadNonce]);

  // Committed state is for the previous contactId → the new fetch is in flight.
  if (state.forId !== contactId) return { ...FILE_LOADING, refetch };
  return { ...state, refetch };
}
