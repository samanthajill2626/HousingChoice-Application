import { describe, expect, it } from 'vitest';
import {
  TEAM_SENDER_KEY,
  TEAM_SENDER_LABEL,
  findMemberByKey,
  memberLabel,
  memberLabelForKey,
  relayMemberKey,
} from './relay';
import type { ConversationParticipant } from '../../api';

const withContact: ConversationParticipant = {
  contactId: 'c-keisha',
  phone: '+13135551234',
  name: 'Keisha Jones',
};
const phoneOnly: ConversationParticipant = { contactId: '', phone: '+14155550100' };

describe('relayMemberKey', () => {
  it('uses the contactId when present', () => {
    expect(relayMemberKey(withContact)).toBe('c-keisha');
  });

  it('falls back to phone#<E164> when there is no contactId', () => {
    expect(relayMemberKey(phoneOnly)).toBe('phone#+14155550100');
    expect(relayMemberKey({ phone: '+14155550100' })).toBe('phone#+14155550100');
  });
});

describe('findMemberByKey', () => {
  const roster = [withContact, phoneOnly];
  it('resolves a contactId key', () => {
    expect(findMemberByKey(roster, 'c-keisha')).toBe(withContact);
  });
  it('resolves a phone# key', () => {
    expect(findMemberByKey(roster, 'phone#+14155550100')).toBe(phoneOnly);
  });
  it('returns undefined for an unknown key', () => {
    expect(findMemberByKey(roster, 'c-nobody')).toBeUndefined();
  });
});

describe('memberLabelForKey (honest identity)', () => {
  const roster = [withContact, phoneOnly];

  it('shows the member name when known', () => {
    expect(memberLabelForKey(roster, 'c-keisha')).toBe('Keisha Jones');
  });

  it('shows the formatted phone when the member has no name', () => {
    expect(memberLabelForKey(roster, 'phone#+14155550100')).toBe('(415) 555-0100');
  });

  it('recovers the formatted phone from a phone# key for a member no longer on the roster', () => {
    expect(memberLabelForKey([], 'phone#+14155550100')).toBe('(415) 555-0100');
  });

  it('maps the team sentinel to the neutral team label', () => {
    expect(memberLabelForKey(roster, TEAM_SENDER_KEY)).toBe(TEAM_SENDER_LABEL);
  });

  it('never fabricates a name for an unresolvable contactId key', () => {
    expect(memberLabelForKey([], 'c-gone')).toBe('Unknown sender');
  });
});

describe('memberLabel', () => {
  it('prefers the name, else the formatted phone', () => {
    expect(memberLabel(withContact)).toBe('Keisha Jones');
    expect(memberLabel(phoneOnly)).toBe('(415) 555-0100');
  });
});
