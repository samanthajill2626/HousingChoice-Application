// useContact — fetches a single contact (GET /api/contacts/:id) for the detail
// page header + file. getContact exists today (legacy Contact, single phone);
// C1's phones[] is handled downstream by contactPhones(). Loading/error/ready.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getContact, useEventStream, type Contact } from '../../api/index.js';

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

  // Bound to THIS contactId: a caller still holding the setter it got for an
  // earlier id (a save on contact A that resolves after the page moved to B -
  // this component re-renders, not remounts, on that navigation) is a no-op,
  // never a write of A over B that would leave B deriving "loading" forever.
  const setContact = useCallback((contact: Contact) => {
    setState((prev) => (prev.forId === contactId ? { status: 'ready', contact, forId: contactId } : prev));
  }, [contactId]);

  // Live IN-PLACE refresh (suggestion-event-no-contact-refetch): when an
  // extraction run touches this contact (`suggestion.updated` names it), the
  // run may have DIRECT-written fields - re-fetch in the background and swap
  // the committed state. Deliberately no status flip: the page keeps rendering
  // the current contact until the fresh one lands (no spinner, no reload).
  // contact.updated (unknown-inactive spec D2, AR3) re-reads the same way: a
  // status or type change made elsewhere (the edit form, another tab or
  // operator) lands without a reload. Both events name the contact; only the
  // open one is re-read. The event follows its write by moments, so the
  // re-read is CONSISTENT (planner ruling PR-3, plan round 1 P2) - an
  // eventually consistent GET could hand back the pre-write contact and
  // overwrite the fresh one.
  //
  // LATEST WINS (unknown-inactive WORKLIST OR-5): every re-read takes the next
  // sequence number and a response that is no longer the latest is dropped.
  // A type change to tenant whose shown status is not Onboarding emits
  // contact.updated twice (the PATCH, then setTenantStatus); two GETs
  // answering out of order would otherwise leave the intermediate contact on
  // screen. The initial-load fetch above is not part of the sequence.
  const refetchSeqRef = useRef(0);
  const refetchInPlace = (eventContactId: string): void => {
    if (eventContactId !== contactId) return;
    refetchSeqRef.current += 1;
    const seq = refetchSeqRef.current;
    void getContact(contactId, undefined, { consistent: true })
      .then((contact) => {
        if (seq !== refetchSeqRef.current) return;
        setState((prev) => (prev.forId === contactId ? { status: 'ready', contact, forId: contactId } : prev));
      })
      .catch(() => {
        /* best-effort: keep the current contact on a fetch hiccup */
      });
  };
  useEventStream({
    onSuggestionUpdated: (event) => refetchInPlace(event.contactId),
    onContactUpdated: (event) => refetchInPlace(event.contactId),
  });

  // The committed state is for the previous id → the new fetch is in flight.
  if (state.forId !== contactId) {
    return { status: 'loading', contact: null, setContact };
  }
  return { status: state.status, contact: state.contact, setContact };
}
