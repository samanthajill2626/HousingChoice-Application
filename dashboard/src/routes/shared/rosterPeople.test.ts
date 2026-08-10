// rosterSuggestions - the ONE rule for "who belongs here but is not on this
// roster" (contact-rosters spec 6.2, Task 11), shared by both hubs so the tour
// and placement cards cannot drift. This is what makes the motivating swap two
// clicks and a removed tenant one click to restore.
import { describe, expect, it } from 'vitest';
import type { RosterView, UnitContact } from '../../api/index.js';
import { rosterSuggestions } from './rosterPeople.js';

function view(over: Partial<RosterView> = {}): RosterView {
  return {
    source: 'default',
    members: [
      { memberKey: 'c-t', contactId: 'c-t', name: 'Tasha Nguyen', role: 'tenant', reachability: 'reachable' },
    ],
    customized: false,
    tenantOnRoster: true,
    canOpenGroup: true,
    threadExists: false,
    pending: [],
    skipped: [],
    ...over,
  };
}

const PM: UnitContact = {
  contactId: 'c-pm',
  role: 'pm',
  primaryContact: true,
  name: 'Alicia Grant',
};
const OWNER: UnitContact = {
  contactId: 'c-own',
  role: 'owner',
  primaryContact: false,
  name: 'Marcus Webb',
};

describe('rosterSuggestions', () => {
  it("suggests the property's other roster members, naming role and the primary marker", () => {
    expect(
      rosterSuggestions({ scope: 'tour', roster: view(), unitContacts: [PM, OWNER] }),
    ).toEqual([
      { contactId: 'c-pm', name: 'Alicia Grant', lead: 'Also on this property', roleLabel: 'PM', primaryContact: true },
      { contactId: 'c-own', name: 'Marcus Webb', lead: 'Also on this property', roleLabel: 'owner' },
    ]);
  });

  it('never suggests someone already on the roster - including a dead contact row', () => {
    const roster = view({
      members: [
        ...view().members,
        { memberKey: 'c-pm', contactId: 'c-pm', name: 'Alicia Grant', role: 'pm', reachability: 'reachable' },
        { memberKey: 'c-own', contactId: 'c-own', role: 'removed_contact', reachability: 'no_phone' },
      ],
    });
    expect(rosterSuggestions({ scope: 'tour', roster, unitContacts: [PM, OWNER] })).toEqual([]);
  });

  it('suggests the MISSING TENANT first, with the owner-scoped lead', () => {
    const roster = view({
      members: [
        { memberKey: 'c-pm', contactId: 'c-pm', name: 'Alicia Grant', role: 'pm', reachability: 'reachable' },
      ],
      tenantOnRoster: false,
    });
    expect(
      rosterSuggestions({
        scope: 'placement',
        roster,
        unitContacts: [PM, OWNER],
        tenant: { contactId: 'c-t', name: 'Tasha Nguyen' },
      }),
    ).toEqual([
      { contactId: 'c-t', name: 'Tasha Nguyen', lead: 'On this placement', roleLabel: 'tenant' },
      { contactId: 'c-own', name: 'Marcus Webb', lead: 'Also on this property', roleLabel: 'owner' },
    ]);
  });

  it('suggests NOTHING when the roster is unknown (never guess who is missing)', () => {
    expect(rosterSuggestions({ scope: 'tour', roster: null, unitContacts: [PM] })).toEqual([]);
    expect(
      rosterSuggestions({
        scope: 'tour',
        roster: view({ source: 'unavailable', members: [] }),
        unitContacts: [PM],
        tenant: { contactId: 'c-t', name: 'Tasha Nguyen' },
      }),
    ).toEqual([]);
  });
});
