// useContact — fetches a single contact (GET /api/contacts/:id) for the detail
// page header + file. getContact exists today (legacy Contact, single phone);
// C1's phones[] is handled downstream by contactPhones(). Loading/error/ready.
import { useEffect, useState } from 'react';
import { getContact, type Contact } from '../../api/index.js';

export interface ContactState {
  status: 'loading' | 'ready' | 'error';
  contact: Contact | null;
}

export function useContact(contactId: string): ContactState {
  const [state, setState] = useState<ContactState>({ status: 'loading', contact: null });

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

  return state;
}
