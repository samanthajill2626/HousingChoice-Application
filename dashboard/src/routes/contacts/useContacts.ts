// useContacts — the Contacts list views' data hook. Fetches the contact records
// for the active filter and returns a small { status, contacts } state. The
// server REQUIRES a `type` filter on GET /api/contacts (unless an exact phone
// lookup), so:
//   - 'tenant' / 'landlord' / 'unknown' fetch that type directly;
//   - 'all' fans out across every audience type and merges.
// EVERY page per type is walked (the server pages via nextCursor): this hook
// also feeds the id→contact lookup maps (Tours rows, the property page's
// placements card, edit-form relationship candidates), where a first-page-only
// load rendered raw contact IDs for anything past page one.
import { useEffect, useState } from 'react';
import { getContacts, type Contact, type ContactType } from '../../api/index.js';

/** Page-walk bound: a hard stop so a pathological/looping cursor can never spin
 *  forever (40 pages × the server's 50/page = 2000 records per type — far past
 *  Phase-1 scale). Hitting it WARNS — never a silent truncation. */
const MAX_PAGES = 40;

/** Fetch every page of one contact type (nextCursor walk, bounded). */
async function getAllContactPages(
  params: { type: ContactType; deleted: boolean },
  signal: AbortSignal,
): Promise<Contact[]> {
  const out: Contact[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await getContacts({ ...params, ...(cursor !== undefined && { cursor }) }, signal);
    out.push(...res.contacts);
    if (!res.nextCursor) return out;
    cursor = res.nextCursor;
  }
  console.warn(`useContacts: page cap (${MAX_PAGES}) hit for type=${params.type} — list truncated`);
  return out;
}

/** The route-driven filter. 'all' = the Contacts parent; tenant/landlord/unknown
 *  are the audience children; 'deleted' is the soft-deleted ("Deleted") view. */
export type ContactsFilter = 'all' | 'tenant' | 'landlord' | 'unknown' | 'deleted';

export type ContactsStatus = 'loading' | 'ready' | 'error';

export interface ContactsState {
  status: ContactsStatus;
  contacts: Contact[];
}

/** The contact `type`s to fetch for a given filter. Property managers are
 *  `landlord`-typed (role "Property Manager"), so the Landlords filter covers
 *  them; 'all' fans out across every audience type (team members excluded). */
const TYPES_FOR: Record<ContactsFilter, ContactType[]> = {
  all: ['tenant', 'landlord', 'unknown'],
  tenant: ['tenant'],
  landlord: ['landlord'],
  unknown: ['unknown'],
  // The Deleted view fans out across the same audience types, asking for ONLY
  // soft-deleted records (deleted=true below).
  deleted: ['tenant', 'landlord', 'unknown'],
};

export function useContacts(filter: ContactsFilter): ContactsState {
  // `forFilter` records which filter the committed state describes. On a filter
  // change we DERIVE "loading" during render until the new fetch commits, rather
  // than resetting to loading with a synchronous setState in the effect (which
  // the React Compiler flags as a cascading render — set-state-in-effect). Same
  // observed UX: the previous list is hidden and the spinner shows immediately.
  const [state, setState] = useState<ContactsState & { forFilter: ContactsFilter }>({
    status: 'loading',
    contacts: [],
    forFilter: filter,
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const deleted = filter === 'deleted';
        const perType = await Promise.all(
          TYPES_FOR[filter].map((type) => getAllContactPages({ type, deleted }, signal)),
        );
        if (signal.aborted) return;
        // Merge the per-type lists, de-duping on contactId (a contact only ever
        // has one type, but a defensive de-dupe keeps the list keys unique).
        const byId = new Map<string, Contact>();
        for (const list of perType) {
          for (const contact of list) byId.set(contact.contactId, contact);
        }
        setState({ status: 'ready', contacts: [...byId.values()], forFilter: filter });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({ status: 'error', contacts: [], forFilter: filter });
      }
    })();

    return () => controller.abort();
  }, [filter]);

  // Committed state is for the previous filter → the new fetch is in flight.
  if (state.forFilter !== filter) return { status: 'loading', contacts: [] };
  return { status: state.status, contacts: state.contacts };
}
