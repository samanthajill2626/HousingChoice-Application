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

export function useContact(contactId: string): ContactState {
  const [state, setState] = useState<Omit<ContactState, 'setContact'>>({
    status: 'loading',
    contact: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', contact: null });
    (async () => {
      try {
        const contact = await getContact(contactId, controller.signal);
        if (controller.signal.aborted) return;
        setState({ status: 'ready', contact });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        setState({ status: 'error', contact: null });
      }
    })();
    return () => controller.abort();
  }, [contactId]);

  const setContact = useCallback((contact: Contact) => {
    setState({ status: 'ready', contact });
  }, []);

  return { ...state, setContact };
}
