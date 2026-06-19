// useContact — fetches a single contact (GET /api/contacts/:id) for the detail
// page header + file. getContact exists today (legacy Contact, single phone);
// C1's phones[] is handled downstream by contactPhones(). Loading/error/ready.
import { useCallback, useEffect, useState } from 'react';
import { getContact, type Contact } from '../../api/index.js';

export interface ContactState {
  status: 'loading' | 'ready' | 'error';
  contact: Contact | null;
  /** Replace the in-memory contact after a mutation. The edit/phone/opt-out
   *  endpoints RETURN the updated contact, so callers apply it directly (instant,
   *  no refetch) — header + file + reply target all re-derive from it. */
  setContact: (contact: Contact) => void;
}

// Each committed state records which contactId it describes (`forId`). When the
// id prop changes we DERIVE "loading" during render until the new fetch commits,
// instead of resetting to loading with a synchronous setState in the effect
// (which the React Compiler flags as a cascading render — react-hooks/
// set-state-in-effect). Same observed UX: stale contact hidden, spinner shown.
type Loaded = Omit<ContactState, 'setContact'> & { forId: string };

export function useContact(contactId: string): ContactState {
  const [state, setState] = useState<Loaded>({
    status: 'loading',
    contact: null,
    forId: contactId,
  });

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const contact = await getContact(contactId, controller.signal);
        if (controller.signal.aborted) return;
        setState({ status: 'ready', contact, forId: contactId });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        setState({ status: 'error', contact: null, forId: contactId });
      }
    })();
    return () => controller.abort();
  }, [contactId]);

  const setContact = useCallback((contact: Contact) => {
    setState({ status: 'ready', contact, forId: contactId });
  }, [contactId]);

  // The committed state is for the previous id → the new fetch is in flight.
  if (state.forId !== contactId) {
    return { status: 'loading', contact: null, setContact };
  }
  return { status: state.status, contact: state.contact, setContact };
}
