// useContacts — the Contacts list views' data hook. Fetches the contact records
// for the active filter and returns a small { status, contacts } state. The
// server REQUIRES a `type` filter on GET /api/contacts (unless an exact phone
// lookup), so:
//   - 'tenant' / 'landlord' / 'unknown' fetch that type directly;
//   - 'landlord' also pulls 'pm' (the design groups property-managers under
//     Landlords) and merges them;
//   - 'all' fans out across every audience type and merges.
// First page per type only (the server pages via nextCursor) — a transitional
// limitation the list view notes; the type-specific slices supersede it later.
import { useEffect, useState } from 'react';
import { getContacts, type Contact, type ContactType } from '../../api/index.js';

/** The route-driven filter. 'all' = the Contacts parent; the rest are the
 *  Tenants / Landlords / Unknown children. */
export type ContactsFilter = 'all' | 'tenant' | 'landlord' | 'unknown';

export type ContactsStatus = 'loading' | 'ready' | 'error';

export interface ContactsState {
  status: ContactsStatus;
  contacts: Contact[];
}

/** The contact `type`s to fetch for a given filter. Landlords include property
 *  managers; 'all' fans out across every audience type (team members excluded —
 *  they aren't part of the navigator's contact roster). */
const TYPES_FOR: Record<ContactsFilter, ContactType[]> = {
  all: ['tenant', 'landlord', 'pm', 'unknown'],
  tenant: ['tenant'],
  landlord: ['landlord', 'pm'],
  unknown: ['unknown'],
};

export function useContacts(filter: ContactsFilter): ContactsState {
  const [state, setState] = useState<ContactsState>({ status: 'loading', contacts: [] });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setState({ status: 'loading', contacts: [] });

    (async () => {
      try {
        const pages = await Promise.all(
          TYPES_FOR[filter].map((type) => getContacts({ type }, signal)),
        );
        if (signal.aborted) return;
        // Merge the per-type pages, de-duping on contactId (a contact only ever
        // has one type, but a defensive de-dupe keeps the list keys unique).
        const byId = new Map<string, Contact>();
        for (const page of pages) {
          for (const contact of page.contacts) byId.set(contact.contactId, contact);
        }
        setState({ status: 'ready', contacts: [...byId.values()] });
      } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({ status: 'error', contacts: [] });
      }
    })();

    return () => controller.abort();
  }, [filter]);

  return state;
}
