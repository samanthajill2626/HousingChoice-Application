// useContactFile — fetches the data the contact detail right pane needs from
// EXISTING endpoints (/api/placements, /api/units, /api/tours) plus the C4/C5
// slices that may not be live yet (listings-sent, media). Placements/units/tours
// always load; the C4/C5 calls resolve to a 'pending' marker on a 404 so their
// panels render an honest "arrives with the backend" state rather than an error.
// The page derives the per-pane lists with buildContactFile's pure helpers.
import { useEffect, useState } from 'react';
import {
  ApiError,
  getPlacements,
  getContactListingsSent,
  getContactMedia,
  getContactRelayGroups,
  getTours,
  getUnits,
  type ContactMediaItem,
  type ListingSendRow,
  type PlacementItem,
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
  // TODO(contact-file-dead-media-slice): `media` is no longer read by any consumer. The contact
  // file's "Media from comms" gallery now derives from the LIVE timeline
  // (commsMedia in media.ts → MediaGallery) so it updates on send; this C5 slice
  // (GET /api/contacts/:id/media) is a redundant once-on-mount fetch. Safe to
  // delete this field + its fetch below + getContactMedia usage + the media
  // assertions in useContactFile.test.tsx. Left in deliberately for now.
  media: Slice<ContactMediaItem>;
  /** The contact's group-text (relay) memberships — the "Group texts" card.
   *  404 (a backend without the route) → 'pending', mirroring the C4/C5 slices. */
  relayGroups: Slice<RelayGroupRow>;
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
  media: { status: 'loading' },
  relayGroups: { status: 'loading' },
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

export function useContactFile(contactId: string, opts: UseContactFileOpts = {}): ContactFileState {
  // `forId` records which contactId the committed state describes. On an id
  // change we DERIVE loading during render until the new fetch commits, rather
  // than resetting with a synchronous setState in the effect (which the React
  // Compiler flags as a cascading render — set-state-in-effect).
  const [state, setState] = useState<ContactFileState & { forId: string }>({
    ...FILE_LOADING,
    forId: contactId,
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        // Placements + units back the REAL panels (Placements / Tours / Properties); both
        // exist today. The C4/C5 slices degrade independently.
        const [placements, units, listingsSent, media, relayGroups] = await Promise.all([
          getPlacements(signal),
          getUnits({}, signal),
          loadSlice((s) => getContactListingsSent(contactId, s), signal),
          // TODO(contact-file-dead-media-slice): unused — see the `media` field above. The gallery
          // now derives from the live timeline; this fetch can be removed.
          loadSlice((s) => getContactMedia(contactId, s), signal),
          loadSlice((s) => getContactRelayGroups(contactId, s), signal),
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
          const myUnitIds = units.units
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
          placements: placements.placements,
          units: units.units,
          tours,
          listingsSent,
          media,
          relayGroups,
          forId: contactId,
        });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState((prev) => ({ ...prev, status: 'error', forId: contactId }));
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, opts.contactType]);

  // Committed state is for the previous contactId → the new fetch is in flight.
  if (state.forId !== contactId) return FILE_LOADING;
  return state;
}
