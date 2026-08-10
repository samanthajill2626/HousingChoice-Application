// useRosterContacts - the contact RECORDS behind the 1:1 tabs the ROSTER grew.
//
// Each hub page fetches exactly two contacts for itself: the tenant and the
// unit's landlord-of-record (useTour's joins / PlacementDetail's load). The
// roster is a DIFFERENT set: on a PM-managed property the default roster is
// [tenant, PM] while `landlordId` is the owner, and any contact can be added by
// hand. A tab keyed on such a member would have no Contact to hand its pane -
// and the pane needs a LOADED record (it derives numbers, addresses and the
// send gates from it), so the tab would dead-end on "We could not load ..."
// forever. Spec D6 is explicit that being on the roster means a 1:1 tab.
//
// So: whoever the roster names and the page did not already ask for, this hook
// asks for. Per id (there is no batch contacts endpoint), best-effort - a read
// that fails leaves that one tab's honest dead-end note - and asked ONCE per id
// for the hook's lifetime, so switching tabs never re-fetches. Records
// accumulate by contactId and are only ever LOOKED UP by the pane, so a record
// for someone since removed from the roster is inert, never a membership claim.
import { useEffect, useRef, useState } from 'react';
import { getContact, type Contact } from '../../api/index.js';
import type { RosterPersonInput } from './rosterPeople.js';

/**
 * @param people the roster-derived 1:1 tab inputs (`rosterPersonInputs`).
 * @param ownIds the ids the PAGE fetches itself (tenant, landlord-of-record) -
 *   passed as IDS, not records, so the fast path holds while those records are
 *   still in flight and we never duplicate a fetch the page is already making.
 * @returns the extra records, for the pane to look up alongside the page's own.
 */
export function useRosterContacts(
  people: RosterPersonInput[],
  ownIds: readonly (string | undefined)[],
): Contact[] {
  const [records, setRecords] = useState<Contact[]>([]);
  // Every id we have already ASKED for (resolved or failed). A record that
  // cannot be read must not be re-requested on every render.
  const askedRef = useRef<Set<string>>(new Set());

  // Both deps are STRINGS: the arrays are rebuilt every render, so keying the
  // effect on their identity would re-run it forever.
  const ownKey = ownIds.filter((id) => id !== undefined && id.length > 0).join(',');
  const peopleKey = people.map((p) => p.contactId).join(',');

  useEffect(() => {
    const own = new Set(ownKey.split(',').filter((id) => id.length > 0));
    const missing = peopleKey
      .split(',')
      .filter((id) => id.length > 0 && !own.has(id) && !askedRef.current.has(id));
    if (missing.length === 0) return;
    for (const contactId of missing) {
      askedRef.current.add(contactId);
      void getContact(contactId)
        .then((contact) => {
          setRecords((prev) =>
            prev.some((c) => c.contactId === contact.contactId) ? prev : [...prev, contact],
          );
        })
        .catch(() => {
          // Best-effort, exactly like the page's own joins: this member's tab
          // keeps the "could not load their contact record" note.
        });
    }
    // Deliberately NO abort on cleanup: these fetches are keyed by id and merged
    // by id, so a late answer is never stale - and aborting one because the tab
    // set changed would strand an id that is already marked asked.
  }, [peopleKey, ownKey]);

  return records;
}
