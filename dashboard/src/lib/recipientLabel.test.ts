import { describe, expect, it } from 'vitest';
import type { ConversationParticipant } from '../api/index.js';
import { findRosterMember } from './memberAttribution.js';

function member(over: Partial<ConversationParticipant> = {}): ConversationParticipant {
  return { contactId: 'c1', phone: '+15555550111', name: 'Ann Tenant', ...over };
}

// S2.1. `findRosterMember` is EXTRACTED from senderLabel's loop, so the proof it
// is faithful is `memberAttribution.test.ts` passing UNCHANGED (24 tests, 19 of
// which drive the matcher). These tests exist for what that suite CANNOT reach:
// senderLabel returns early on an empty key and on the two sentinels, so those
// inputs never arrive at the matcher through it.
describe('findRosterMember (the extracted key matcher)', () => {
  const roster = [
    member(),
    member({ contactId: 'c2', phone: '+15555550222', name: 'Marcus Landlord' }),
  ];

  it('resolves a contactId key (clause A)', () => {
    expect(findRosterMember('c2', roster)).toBe(roster[1]);
  });

  it('resolves a phone-scoped key (clause B)', () => {
    expect(findRosterMember('phone#+15555550222', roster)).toBe(roster[1]);
  });

  it('matches the SUPERSET: a phone-scoped key resolves a member carrying a contactId', () => {
    expect(findRosterMember('phone#+15555550111', roster)).toBe(roster[0]);
  });

  it('keeps two numbers of ONE contact distinct, first match wins', () => {
    const twoNumbers = [
      member({ contactId: 'c9', phone: '+15555550333', name: 'Cell' }),
      member({ contactId: 'c9', phone: '+15555550444', name: 'Desk' }),
    ];
    expect(findRosterMember('phone#+15555550444', twoNumbers)).toBe(twoNumbers[1]);
  });

  it('is undefined for an unknown key and for an absent roster', () => {
    expect(findRosterMember('phone#+15555559999', roster)).toBeUndefined();
    expect(findRosterMember('c1', undefined)).toBeUndefined();
    expect(findRosterMember('c1', [])).toBeUndefined();
  });

  // THE HOLE THE EXISTING SUITE CANNOT CLOSE. `memberAttribution.test.ts:82`
  // records that two clauses defend this and either alone is sufficient: the
  // `senderKey.length === 0` early return, and `contactId.length > 0` inside the
  // match. Reaching the matcher DIRECTLY removes the first, so this is the only
  // assertion in the repo that holds the length check on its own. An extraction
  // that drops it turns this red and nothing else.
  it('does NOT resolve an empty key against an empty-contactId stub', () => {
    const stub = member({ contactId: '', phone: '+15555550777', name: 'Stub Member' });
    expect(findRosterMember('', [stub])).toBeUndefined();
    expect(findRosterMember('phone#+15555550777', [stub])).toBe(stub);
  });

  it('survives a roster member whose contactId is off-shape', () => {
    const shapeless = { phone: '+15555550888', name: 'Shapeless' } as unknown as ConversationParticipant;
    expect(() => findRosterMember('c1', [shapeless])).not.toThrow();
    expect(findRosterMember('c1', [shapeless])).toBeUndefined();
    expect(findRosterMember('phone#+15555550888', [shapeless])).toBe(shapeless);
  });

  // Pins the UNGUARDED phoneMemberKey the extraction must keep calling: a
  // phone-less member yields the literal key `phone#undefined`. No normalisation
  // was added during the extraction, so that quirk is preserved exactly.
  it('keeps the unguarded phone-scoped key form', () => {
    const phoneless = { contactId: 'c-nophone', name: 'No Number' } as unknown as ConversationParticipant;
    expect(() => findRosterMember('phone#+15555550999', [phoneless])).not.toThrow();
    expect(findRosterMember('phone#undefined', [phoneless])).toBe(phoneless);
  });
});
