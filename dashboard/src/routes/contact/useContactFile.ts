// useContactFile — fetches the data the contact detail right pane needs from
// EXISTING endpoints (/api/cases, /api/units) plus the C4/C5 slices that may not
// be live yet (listings-sent, media). Cases/units always load; the C4/C5 calls
// resolve to a 'pending' marker on a 404 so their panels render an honest
// "arrives with the backend" state rather than an error. The page derives the
// per-pane lists with buildContactFile's pure helpers.
import { useEffect, useState } from 'react';
import {
  ApiError,
  getCases,
  getContactListingsSent,
  getContactMedia,
  getUnits,
  type CaseItem,
  type ContactMediaItem,
  type ListingSendRow,
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
  cases: CaseItem[];
  units: UnitItem[];
  listingsSent: Slice<ListingSendRow>;
  // TODO(dead-code): `media` is no longer read by any consumer. The contact
  // file's "Media from comms" gallery now derives from the LIVE timeline
  // (commsMedia in media.ts → MediaGallery) so it updates on send; this C5 slice
  // (GET /api/contacts/:id/media) is a redundant once-on-mount fetch. Safe to
  // delete this field + its fetch below + getContactMedia usage + the media
  // assertions in useContactFile.test.tsx. Left in deliberately for now.
  media: Slice<ContactMediaItem>;
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

export function useContactFile(contactId: string): ContactFileState {
  const [state, setState] = useState<ContactFileState>({
    status: 'loading',
    cases: [],
    units: [],
    listingsSent: { status: 'loading' },
    media: { status: 'loading' },
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setState({
      status: 'loading',
      cases: [],
      units: [],
      listingsSent: { status: 'loading' },
      media: { status: 'loading' },
    });

    (async () => {
      try {
        // Cases + units back the REAL panels (Cases / Tours / Listings); both
        // exist today. The C4/C5 slices degrade independently.
        const [cases, units, listingsSent, media] = await Promise.all([
          getCases(signal),
          getUnits(signal),
          loadSlice((s) => getContactListingsSent(contactId, s), signal),
          // TODO(dead-code): unused — see the `media` field above. The gallery
          // now derives from the live timeline; this fetch can be removed.
          loadSlice((s) => getContactMedia(contactId, s), signal),
        ]);
        if (signal.aborted) return;
        setState({
          status: 'ready',
          cases: cases.cases,
          units: units.units,
          listingsSent,
          media,
        });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState((prev) => ({ ...prev, status: 'error' }));
      }
    })();

    return () => controller.abort();
  }, [contactId]);

  return state;
}
