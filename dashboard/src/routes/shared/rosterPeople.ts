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
import type { RosterView, UnitContact } from '../../api/index.js';

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

// --- Edit-mode suggestions (spec 6.2) ---------------------------------------
// "The people who belong here but are not on the roster." This is what makes
// the motivating swap TWO clicks (add the PM, remove the owner) and a removed
// tenant ONE click to restore, instead of a contact search each time.

/** One inline "[+ Add]" suggestion row. `lead` is the WHY ("Also on this
 *  property" / "On this tour"); the card renders
 *  `<lead>: <name> - <roleLabel>[ - primary contact]`. */
export interface RosterSuggestion {
  contactId: string;
  name: string;
  lead: string;
  roleLabel: string;
  /** The property's primary contact - worth saying, it is who calls route to. */
  primaryContact?: boolean;
}

/** The unit-roster role words, matching the People card's own role column. */
const UNIT_ROLE_LABELS: Readonly<Record<UnitContact['role'], string>> = {
  landlord: 'landlord',
  pm: 'PM',
  owner: 'owner',
  other: 'contact',
};

export interface RosterSuggestionsInput {
  scope: 'tour' | 'placement';
  roster: RosterView | null;
  /** The property's own contact roster (`unit.contacts`). */
  unitContacts?: UnitContact[];
  /** The owner's tenant, for the missing-structural-party suggestion. */
  tenant?: { contactId: string; name: string };
}

/**
 * Who is missing from this roster and worth one click. The MISSING TENANT comes
 * first (D11 pauses their reminders while they are off, so restoring them is
 * the most urgent action), then the property's other roster members in their
 * stored order.
 *
 * Suggests NOTHING when the roster is unknown (`null` / `unavailable`): we do
 * not know who is on it, so we cannot know who is missing - and inviting an add
 * onto a roster we cannot read is exactly the wrongness Task 3's cardinal rule
 * forbids.
 */
export function rosterSuggestions(input: RosterSuggestionsInput): RosterSuggestion[] {
  const { scope, roster, unitContacts, tenant } = input;
  if (roster === null || roster.source === 'unavailable') return [];
  // A `removed_contact` row still OCCUPIES the roster - never suggest it back.
  const onRoster = new Set(
    roster.members.map((m) => m.contactId).filter((id): id is string => id !== undefined),
  );
  const out: RosterSuggestion[] = [];
  if (tenant !== undefined && tenant.contactId.length > 0 && !onRoster.has(tenant.contactId)) {
    out.push({
      contactId: tenant.contactId,
      name: tenant.name,
      lead: `On this ${scope}`,
      roleLabel: 'tenant',
    });
  }
  for (const c of unitContacts ?? []) {
    if (onRoster.has(c.contactId)) continue;
    if (out.some((s) => s.contactId === c.contactId)) continue;
    out.push({
      contactId: c.contactId,
      name: c.name ?? c.contactId,
      lead: 'Also on this property',
      roleLabel: UNIT_ROLE_LABELS[c.role],
      ...(c.primaryContact && { primaryContact: true }),
    });
  }
  return out;
}
