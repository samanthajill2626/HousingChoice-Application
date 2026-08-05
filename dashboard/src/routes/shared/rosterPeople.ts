// rosterPeople - the ONE rule that turns a roster payload into the 1:1 tab set,
// shared by both hubs so tours and placements cannot drift (spec 6.6).
//
// Tabs are contact-keyed panes over a person's whole comms timeline, so a member
// with no contact record gets none: BARE-PHONE participants (`phone:<E164>`
// members) have no contact page, and a REMOVED_CONTACT row points at a record
// that is gone. Both still render on the People card - they are on the roster -
// they just have nowhere for a tab to go.
//
// The label is the person's DISPLAY NAME and nothing else (never a role word);
// it degrades to the contactId only when the server could not resolve a name.
// Order is the payload's order, which puts the tenant first.
import type { RosterView } from '../../api/index.js';

/** Structurally the `PersonChannelInput` of BOTH channel hooks (twin shapes). */
export interface RosterPersonInput {
  contactId: string;
  label: string;
}

export function rosterPersonInputs(roster: RosterView | null): RosterPersonInput[] {
  if (roster === null) return [];
  const out: RosterPersonInput[] = [];
  for (const m of roster.members) {
    if (m.role === 'removed_contact') continue;
    const contactId = m.contactId;
    if (contactId === undefined || contactId.length === 0) continue;
    out.push({ contactId, label: m.name ?? contactId });
  }
  return out;
}

/** Is this payload a roster we can KEY THE TABS ON? A failed fetch and an
 *  `unavailable` source both mean "we do not know who is on this roster" - the
 *  card says so, but the tabs keep the page's own people rather than blinking
 *  out mid-conversation. A 1:1 tab is a view of someone's comms, never a send
 *  decision, so falling back there is safe in a way the card's rows are not. */
export function rosterDrivesTabs(
  status: 'loading' | 'ready' | 'error',
  roster: RosterView | null,
): boolean {
  return status === 'ready' && roster !== null && roster.source !== 'unavailable';
}
